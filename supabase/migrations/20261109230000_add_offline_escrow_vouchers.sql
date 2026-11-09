-- Offline escrow vouchers are provisional handoff evidence, never settlement.
-- The server signs short-lived vouchers with an Ed25519 key held in Supabase Vault.
-- A seller passkey signs the offline receipt; either participant may later sync it.

CREATE TABLE IF NOT EXISTS public.escrow_voucher_signing_keys (
  key_id text PRIMARY KEY,
  public_key text NOT NULL,
  vault_secret_id uuid NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz
);

ALTER TABLE public.escrow_voucher_signing_keys ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.escrow_voucher_signing_keys FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS public.escrow_offline_vouchers (
  id uuid PRIMARY KEY,
  transaction_id uuid NOT NULL REFERENCES public.transactions(id) ON DELETE RESTRICT,
  buyer_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  seller_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  payment_method text NOT NULL CHECK (payment_method IN ('campus_wallet', 'paystack')),
  amount_kobo bigint NOT NULL CHECK (amount_kobo > 0),
  safe_zone_id uuid NOT NULL,
  key_id text NOT NULL REFERENCES public.escrow_voucher_signing_keys(key_id),
  nonce text NOT NULL UNIQUE,
  voucher_hash text NOT NULL UNIQUE CHECK (voucher_hash ~ '^[0-9a-f]{64}$'),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  sync_grace_until timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'issued'
    CHECK (status IN ('issued', 'redeemed', 'revoked', 'expired')),
  redeemed_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > issued_at),
  CHECK (expires_at <= issued_at + interval '30 minutes'),
  CHECK (sync_grace_until >= expires_at),
  CHECK (sync_grace_until <= expires_at + interval '6 hours')
);

CREATE INDEX IF NOT EXISTS escrow_offline_vouchers_transaction_status_idx
  ON public.escrow_offline_vouchers(transaction_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS public.escrow_offline_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  voucher_id uuid NOT NULL UNIQUE REFERENCES public.escrow_offline_vouchers(id) ON DELETE RESTRICT,
  transaction_id uuid NOT NULL REFERENCES public.transactions(id) ON DELETE RESTRICT,
  buyer_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  seller_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  receipt_nonce text NOT NULL UNIQUE,
  receipt_hash text NOT NULL UNIQUE CHECK (receipt_hash ~ '^[0-9a-f]{64}$'),
  seller_credential_id text NOT NULL,
  synced_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  scanned_at timestamptz NOT NULL,
  receipt_payload jsonb NOT NULL,
  reconciled_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (pg_column_size(receipt_payload) <= 16384)
);

CREATE INDEX IF NOT EXISTS escrow_offline_receipts_transaction_idx
  ON public.escrow_offline_receipts(transaction_id, reconciled_at DESC);

ALTER TABLE public.escrow_offline_vouchers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.escrow_offline_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.escrow_offline_vouchers FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.escrow_offline_receipts FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.store_escrow_voucher_signing_key(
  p_key_id text,
  p_public_key text,
  p_private_key_pkcs8 text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_existing public.escrow_voucher_signing_keys%ROWTYPE;
  v_secret_id uuid;
BEGIN
  IF COALESCE(auth.jwt() ->> 'role', '') <> 'service_role' THEN
    RAISE EXCEPTION 'Service role required';
  END IF;
  IF p_key_id IS NULL OR length(p_key_id) NOT BETWEEN 8 AND 96
     OR p_public_key IS NULL OR length(p_public_key) NOT BETWEEN 40 AND 128
     OR p_private_key_pkcs8 IS NULL OR length(p_private_key_pkcs8) NOT BETWEEN 48 AND 512 THEN
    RAISE EXCEPTION 'Invalid signing key material';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('campus-plug:offline-escrow-signing-key:' || p_key_id, 0)
  );

  SELECT * INTO v_existing
    FROM public.escrow_voucher_signing_keys
   WHERE key_id = p_key_id AND retired_at IS NULL
   FOR UPDATE;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'created', false,
      'key_id', v_existing.key_id,
      'public_key', v_existing.public_key
    );
  END IF;

  v_secret_id := vault.create_secret(
    p_private_key_pkcs8,
    'campus_plug_offline_escrow_' || p_key_id,
    'Ed25519 PKCS8 private key for signed offline escrow vouchers',
    NULL
  );

  INSERT INTO public.escrow_voucher_signing_keys(key_id, public_key, vault_secret_id)
  VALUES (p_key_id, p_public_key, v_secret_id);

  RETURN jsonb_build_object('created', true, 'key_id', p_key_id, 'public_key', p_public_key);
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_escrow_voucher_signing_key(p_key_id text)
RETURNS TABLE(key_id text, public_key text, private_key_pkcs8 text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
  IF COALESCE(auth.jwt() ->> 'role', '') <> 'service_role' THEN
    RAISE EXCEPTION 'Service role required';
  END IF;

  RETURN QUERY
  SELECT k.key_id, k.public_key, s.decrypted_secret
    FROM public.escrow_voucher_signing_keys k
    JOIN vault.decrypted_secrets s ON s.id = k.vault_secret_id
   WHERE k.key_id = p_key_id
     AND k.retired_at IS NULL
   LIMIT 1;
END;
$function$;

REVOKE ALL ON FUNCTION public.store_escrow_voucher_signing_key(text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_escrow_voucher_signing_key(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.store_escrow_voucher_signing_key(text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_escrow_voucher_signing_key(text) TO service_role;

CREATE OR REPLACE FUNCTION public.create_offline_escrow_voucher(
  p_voucher_id uuid,
  p_transaction_id uuid,
  p_buyer_id uuid,
  p_seller_id uuid,
  p_payment_method text,
  p_amount_kobo bigint,
  p_safe_zone_id uuid,
  p_key_id text,
  p_nonce text,
  p_voucher_hash text,
  p_issued_at timestamptz,
  p_expires_at timestamptz,
  p_sync_grace_until timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_tx public.transactions%ROWTYPE;
  v_hold public.wallet_escrow_holds%ROWTYPE;
  v_payment_method text;
BEGIN
  IF COALESCE(auth.jwt() ->> 'role', '') <> 'service_role' THEN
    RAISE EXCEPTION 'Service role required';
  END IF;

  IF p_voucher_id IS NULL OR p_transaction_id IS NULL
     OR p_buyer_id IS NULL OR p_seller_id IS NULL
     OR p_amount_kobo IS NULL OR p_amount_kobo <= 0
     OR p_nonce IS NULL OR length(p_nonce) NOT BETWEEN 24 AND 128
     OR p_voucher_hash IS NULL OR p_voucher_hash !~ '^[0-9a-f]{64}$'
     OR p_issued_at IS NULL OR p_expires_at IS NULL OR p_sync_grace_until IS NULL
     OR p_issued_at < now() - interval '1 minute'
     OR p_issued_at > now() + interval '1 minute'
     OR p_expires_at <= p_issued_at
     OR p_expires_at > p_issued_at + interval '30 minutes'
     OR p_sync_grace_until < p_expires_at
     OR p_sync_grace_until > p_expires_at + interval '6 hours' THEN
    RAISE EXCEPTION 'Invalid offline voucher claims';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.escrow_voucher_signing_keys
     WHERE key_id = p_key_id AND retired_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Offline voucher signing key is not registered';
  END IF;

  SELECT * INTO v_tx
    FROM public.transactions
   WHERE id = p_transaction_id
   FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'Transaction not found'; END IF;

  v_payment_method := COALESCE(v_tx.payment_method, 'paystack');
  IF v_tx.status <> 'meetup_initiated'
     OR v_tx.handshake_receipt_buffer IS NOT NULL
     OR v_tx.buyer_id <> p_buyer_id
     OR v_tx.seller_id <> p_seller_id
     OR v_payment_method <> p_payment_method
     OR v_tx.amount <> p_amount_kobo THEN
    RAISE EXCEPTION 'Transaction is not eligible for an offline voucher';
  END IF;

  IF v_tx.buyer_arrived IS DISTINCT FROM true
     OR v_tx.buyer_safe_zone_id IS NULL
     OR v_tx.buyer_safe_zone_id IS DISTINCT FROM p_safe_zone_id
     OR v_tx.mobile_release_ready_at IS NULL
     OR v_tx.mobile_release_ready_at < now() - interval '10 minutes' THEN
    RAISE EXCEPTION 'Fresh buyer Safe Swap Zone verification is required before issuing an offline voucher';
  END IF;

  IF v_tx.seller_arrived IS DISTINCT FROM true
     OR v_tx.seller_safe_zone_id IS NULL
     OR v_tx.seller_safe_zone_id IS DISTINCT FROM p_safe_zone_id
     OR v_tx.seller_location_captured_at IS NULL
     OR v_tx.seller_location_captured_at < now() - interval '30 minutes' THEN
    RAISE EXCEPTION 'Seller must verify arrival in the same Safe Swap Zone before issuing an offline voucher';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.listings
     WHERE id = v_tx.listing_id AND status = 'reserved'
  ) THEN
    RAISE EXCEPTION 'Escrow listing is not reserved';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.passkey_credentials
     WHERE user_id = p_seller_id
  ) THEN
    RAISE EXCEPTION 'Seller must register a passkey before offline handoff';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.escrow_offline_receipts
     WHERE transaction_id = p_transaction_id
  ) THEN
    RAISE EXCEPTION 'An offline handoff receipt has already been reconciled for this transaction';
  END IF;

  IF v_payment_method = 'campus_wallet' THEN
    SELECT * INTO v_hold
      FROM public.wallet_escrow_holds
     WHERE transaction_id = p_transaction_id
     FOR UPDATE;
    IF NOT FOUND
       OR v_hold.status <> 'held'
       OR v_hold.buyer_id <> p_buyer_id
       OR v_hold.seller_id <> p_seller_id
       OR v_hold.amount_kobo <> p_amount_kobo THEN
      RAISE EXCEPTION 'Campus Wallet escrow hold could not be verified';
    END IF;
  ELSIF v_payment_method <> 'paystack' THEN
    RAISE EXCEPTION 'Unsupported escrow payment method';
  END IF;

  UPDATE public.escrow_offline_vouchers
     SET status = 'expired'
   WHERE transaction_id = p_transaction_id
     AND status = 'issued'
     AND sync_grace_until <= now();

  IF EXISTS (
    SELECT 1
      FROM public.escrow_offline_vouchers
     WHERE transaction_id = p_transaction_id
       AND status IN ('issued', 'redeemed')
       AND sync_grace_until > now()
  ) THEN
    RAISE EXCEPTION 'An offline voucher is still active or awaiting receipt sync';
  END IF;

  INSERT INTO public.escrow_offline_vouchers(
    id, transaction_id, buyer_id, seller_id, payment_method, amount_kobo,
    safe_zone_id, key_id, nonce, voucher_hash, issued_at, expires_at, sync_grace_until
  )
  VALUES (
    p_voucher_id, p_transaction_id, p_buyer_id, p_seller_id, v_payment_method, p_amount_kobo,
    p_safe_zone_id, p_key_id, p_nonce, p_voucher_hash, p_issued_at, p_expires_at, p_sync_grace_until
  );

  RETURN jsonb_build_object(
    'success', true,
    'voucher_id', p_voucher_id,
    'expires_at', p_expires_at,
    'sync_grace_until', p_sync_grace_until
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.reconcile_offline_escrow_receipt(
  p_voucher_id uuid,
  p_transaction_id uuid,
  p_buyer_id uuid,
  p_seller_id uuid,
  p_nonce text,
  p_voucher_hash text,
  p_receipt_nonce text,
  p_receipt_hash text,
  p_seller_credential_id text,
  p_synced_by uuid,
  p_scanned_at timestamptz,
  p_receipt_payload jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_voucher public.escrow_offline_vouchers%ROWTYPE;
  v_existing public.escrow_offline_receipts%ROWTYPE;
  v_tx public.transactions%ROWTYPE;
  v_hold public.wallet_escrow_holds%ROWTYPE;
  v_inspection_expires_at timestamptz;
  v_current_status text;
BEGIN
  IF COALESCE(auth.jwt() ->> 'role', '') <> 'service_role' THEN
    RAISE EXCEPTION 'Service role required';
  END IF;

  IF p_receipt_nonce IS NULL OR length(p_receipt_nonce) NOT BETWEEN 16 AND 128
     OR p_receipt_hash IS NULL OR p_receipt_hash !~ '^[0-9a-f]{64}$'
     OR p_seller_credential_id IS NULL OR p_seller_credential_id = ''
     OR p_synced_by IS NULL OR p_scanned_at IS NULL
     OR p_receipt_payload IS NULL OR pg_column_size(p_receipt_payload) > 16384 THEN
    RAISE EXCEPTION 'Invalid offline receipt';
  END IF;

  SELECT * INTO v_voucher
    FROM public.escrow_offline_vouchers
   WHERE id = p_voucher_id
   FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'Offline voucher not found'; END IF;

  IF v_voucher.transaction_id <> p_transaction_id
     OR v_voucher.buyer_id <> p_buyer_id
     OR v_voucher.seller_id <> p_seller_id
     OR v_voucher.nonce <> p_nonce
     OR v_voucher.voucher_hash <> p_voucher_hash THEN
    RAISE EXCEPTION 'Offline receipt does not match its voucher';
  END IF;

  SELECT * INTO v_existing
    FROM public.escrow_offline_receipts
   WHERE voucher_id = p_voucher_id
   FOR UPDATE;

  IF FOUND THEN
    IF v_existing.receipt_hash = p_receipt_hash THEN
      SELECT status, auto_release_at
        INTO v_current_status, v_inspection_expires_at
        FROM public.transactions WHERE id = p_transaction_id;
      RETURN jsonb_build_object(
        'success', true,
        'already_reconciled', true,
        'status', v_current_status,
        'transaction_id', p_transaction_id,
        'inspection_expires_at', v_inspection_expires_at
      );
    END IF;
    RAISE EXCEPTION 'A different receipt has already been accepted for this voucher';
  END IF;

  IF v_voucher.status <> 'issued' THEN
    RAISE EXCEPTION 'Offline voucher is no longer redeemable';
  END IF;
  IF now() > v_voucher.sync_grace_until THEN
    RAISE EXCEPTION 'Offline receipt sync window has expired';
  END IF;
  IF p_scanned_at < v_voucher.issued_at - interval '5 minutes' OR p_scanned_at > v_voucher.expires_at + interval '5 minutes' THEN
    RAISE EXCEPTION 'Receipt timestamp is outside the voucher validity window';
  END IF;
  IF p_synced_by <> v_voucher.buyer_id AND p_synced_by <> v_voucher.seller_id THEN
    RAISE EXCEPTION 'Only a transaction participant can sync this receipt';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.passkey_credentials
     WHERE user_id = v_voucher.seller_id
       AND credential_id = p_seller_credential_id
  ) THEN
    RAISE EXCEPTION 'Seller passkey credential is no longer registered';
  END IF;

  SELECT * INTO v_tx
    FROM public.transactions
   WHERE id = v_voucher.transaction_id
   FOR UPDATE;

  IF NOT FOUND
     OR v_tx.status <> 'meetup_initiated'
     OR v_tx.handshake_receipt_buffer IS NOT NULL
     OR v_tx.buyer_id <> v_voucher.buyer_id
     OR v_tx.seller_id <> v_voucher.seller_id
     OR v_tx.amount <> v_voucher.amount_kobo
     OR COALESCE(v_tx.payment_method, 'paystack') <> v_voucher.payment_method
     OR v_tx.buyer_safe_zone_id IS DISTINCT FROM v_voucher.safe_zone_id
     OR v_tx.seller_safe_zone_id IS DISTINCT FROM v_voucher.safe_zone_id THEN
    RAISE EXCEPTION 'Transaction changed after the offline voucher was issued';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.listings
     WHERE id = v_tx.listing_id AND status = 'reserved'
  ) THEN
    RAISE EXCEPTION 'Escrow listing is no longer reserved';
  END IF;

  IF v_voucher.payment_method = 'campus_wallet' THEN
    SELECT * INTO v_hold
      FROM public.wallet_escrow_holds
     WHERE transaction_id = v_tx.id
     FOR UPDATE;
    IF NOT FOUND
       OR v_hold.status <> 'held'
       OR v_hold.buyer_id <> v_tx.buyer_id
       OR v_hold.seller_id <> v_tx.seller_id
       OR v_hold.amount_kobo <> v_tx.amount THEN
      RAISE EXCEPTION 'Campus Wallet escrow hold could not be verified';
    END IF;
  END IF;

  INSERT INTO public.escrow_offline_receipts(
    voucher_id, transaction_id, buyer_id, seller_id, receipt_nonce, receipt_hash,
    seller_credential_id, synced_by, scanned_at, receipt_payload
  )
  VALUES (
    p_voucher_id, v_tx.id, v_tx.buyer_id, v_tx.seller_id, p_receipt_nonce, p_receipt_hash,
    p_seller_credential_id, p_synced_by, p_scanned_at, p_receipt_payload
  );

  UPDATE public.escrow_offline_vouchers
     SET status = 'redeemed', redeemed_at = now()
   WHERE id = p_voucher_id AND status = 'issued';
  IF NOT FOUND THEN RAISE EXCEPTION 'Offline voucher was consumed concurrently'; END IF;

  v_inspection_expires_at := now() + interval '2 hours';
  PERFORM set_config('app.escrow_transition', 'true', true);
  UPDATE public.transactions
     SET status = 'release_requested',
         release_requested_at = now(),
         auto_release_at = v_inspection_expires_at,
         handshake_receipt_buffer = now(),
         payout_status = CASE WHEN v_voucher.payment_method = 'campus_wallet' THEN 'not_applicable' ELSE payout_status END
   WHERE id = v_tx.id
     AND status = 'meetup_initiated'
     AND handshake_receipt_buffer IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Transaction state changed during offline receipt reconciliation'; END IF;

  INSERT INTO public.audit_logs(user_id, entity_type, entity_id, action, metadata)
  VALUES (
    p_synced_by,
    'transaction',
    v_tx.id,
    'offline_escrow_receipt_reconciled',
    jsonb_build_object(
      'voucher_id', p_voucher_id,
      'receipt_hash', p_receipt_hash,
      'seller_credential_id', p_seller_credential_id,
      'inspection_expires_at', v_inspection_expires_at,
      'payment_method', v_voucher.payment_method
    )
  );

  RETURN jsonb_build_object(
    'success', true,
    'already_reconciled', false,
    'status', 'inspection_pending',
    'transaction_id', v_tx.id,
    'inspection_started_at', now(),
    'inspection_expires_at', v_inspection_expires_at,
    'funds_released', false
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.create_offline_escrow_voucher(uuid, uuid, uuid, uuid, text, bigint, uuid, text, text, text, timestamptz, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reconcile_offline_escrow_receipt(uuid, uuid, uuid, uuid, text, text, text, text, text, uuid, timestamptz, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_offline_escrow_voucher(uuid, uuid, uuid, uuid, text, bigint, uuid, text, text, text, timestamptz, timestamptz, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.reconcile_offline_escrow_receipt(uuid, uuid, uuid, uuid, text, text, text, text, text, uuid, timestamptz, jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.revoke_issued_offline_escrow_vouchers_on_state_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NEW.status <> 'meetup_initiated' THEN
    UPDATE public.escrow_offline_vouchers
       SET status = 'revoked',
           revoked_at = now()
     WHERE transaction_id = NEW.id
       AND status = 'issued';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.revoke_issued_offline_escrow_vouchers_on_state_change() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_revoke_offline_escrow_vouchers_on_state_change ON public.transactions;
CREATE TRIGGER trg_revoke_offline_escrow_vouchers_on_state_change
AFTER UPDATE OF status ON public.transactions
FOR EACH ROW
EXECUTE FUNCTION public.revoke_issued_offline_escrow_vouchers_on_state_change();
