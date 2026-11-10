-- One-time offline QR handoff vouchers.
-- The seller retains the random bearer token; the database stores only its
-- SHA-256 commitment. The buyer caches that commitment while online and can
-- verify the seller QR locally during a short network dead-zone. Settlement
-- remains server-authoritative and starts only after the buyer syncs the proof.
CREATE TABLE IF NOT EXISTS public.offline_handoff_vouchers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id uuid NOT NULL UNIQUE REFERENCES public.transactions(id) ON DELETE CASCADE,
  buyer_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  seller_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  token_hash text NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT offline_handoff_distinct_participants CHECK (buyer_id <> seller_id)
);

ALTER TABLE public.offline_handoff_vouchers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.offline_handoff_vouchers FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.offline_handoff_vouchers TO service_role;

CREATE INDEX IF NOT EXISTS offline_handoff_vouchers_expiry_idx
  ON public.offline_handoff_vouchers (expires_at)
  WHERE consumed_at IS NULL;

CREATE OR REPLACE FUNCTION public.prepare_offline_handoff(
  p_transaction_id uuid,
  p_token_hash text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_tx public.transactions%ROWTYPE;
  v_voucher public.offline_handoff_vouchers%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_transaction_id IS NULL OR p_token_hash IS NULL OR length(p_token_hash) <> 64 OR p_token_hash ~ '[^0-9a-f]' THEN
    RAISE EXCEPTION 'Invalid offline handoff request';
  END IF;

  SELECT * INTO v_tx
    FROM public.transactions
   WHERE id = p_transaction_id
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Transaction not found'; END IF;
  IF v_actor <> v_tx.seller_id THEN RAISE EXCEPTION 'Only the seller can prepare the handoff QR'; END IF;
  IF v_tx.status <> 'meetup_initiated' THEN RAISE EXCEPTION 'Transaction is not ready for handoff'; END IF;
  IF v_tx.buyer_arrived IS DISTINCT FROM true
     OR v_tx.buyer_safe_zone_id IS NULL
     OR v_tx.mobile_release_ready_at IS NULL
     OR v_tx.mobile_release_ready_at < now() - interval '10 minutes' THEN
    RAISE EXCEPTION 'Fresh buyer Safe Swap Zone verification is required';
  END IF;
  IF v_tx.seller_arrived IS DISTINCT FROM true
     OR v_tx.seller_safe_zone_id IS NULL
     OR v_tx.seller_safe_zone_id IS DISTINCT FROM v_tx.buyer_safe_zone_id
     OR v_tx.seller_location_captured_at IS NULL
     OR v_tx.seller_location_captured_at < now() - interval '30 minutes' THEN
    RAISE EXCEPTION 'Seller must verify arrival in the same Safe Swap Zone within 30 minutes';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.listings
     WHERE id = v_tx.listing_id AND status = 'reserved'
  ) THEN
    RAISE EXCEPTION 'Escrow listing is not reserved';
  END IF;

  SELECT * INTO v_voucher
    FROM public.offline_handoff_vouchers
   WHERE transaction_id = v_tx.id
   FOR UPDATE;

  IF FOUND AND v_voucher.consumed_at IS NOT NULL THEN
    RAISE EXCEPTION 'An offline handoff voucher has already been consumed';
  END IF;
  INSERT INTO public.offline_handoff_vouchers (
    transaction_id, buyer_id, seller_id, token_hash, expires_at, consumed_at
  )
  VALUES (
    v_tx.id, v_tx.buyer_id, v_tx.seller_id, p_token_hash, now() + interval '10 minutes', NULL
  )
  ON CONFLICT (transaction_id) DO UPDATE
    SET buyer_id = EXCLUDED.buyer_id,
        seller_id = EXCLUDED.seller_id,
        token_hash = EXCLUDED.token_hash,
        expires_at = EXCLUDED.expires_at,
        consumed_at = NULL,
        created_at = now()
    WHERE public.offline_handoff_vouchers.consumed_at IS NULL
      AND public.offline_handoff_vouchers.expires_at <= now()
  RETURNING * INTO v_voucher;

  IF NOT FOUND THEN RAISE EXCEPTION 'Unable to rotate offline handoff voucher'; END IF;

  RETURN jsonb_build_object(
    'success', true,
    'voucher_id', v_voucher.id,
    'transaction_id', v_tx.id,
    'expires_at', v_voucher.expires_at,
    'buyer_id', v_tx.buyer_id,
    'seller_id', v_tx.seller_id,
    'amount', v_tx.amount,
    'safe_zone_id', v_tx.buyer_safe_zone_id
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_offline_handoff_commitment(p_transaction_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_tx public.transactions%ROWTYPE;
  v_voucher public.offline_handoff_vouchers%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  SELECT * INTO v_tx FROM public.transactions WHERE id = p_transaction_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Transaction not found'; END IF;
  IF v_actor <> v_tx.buyer_id THEN RAISE EXCEPTION 'Only the buyer can retrieve the handoff commitment'; END IF;
  IF v_tx.status <> 'meetup_initiated' THEN RAISE EXCEPTION 'Transaction is not ready for handoff'; END IF;

  SELECT * INTO v_voucher
    FROM public.offline_handoff_vouchers
   WHERE transaction_id = p_transaction_id
     AND buyer_id = v_actor
     AND consumed_at IS NULL
     AND expires_at > now();
  IF NOT FOUND THEN RAISE EXCEPTION 'No active offline handoff QR is available'; END IF;

  RETURN jsonb_build_object(
    'success', true,
    'voucher_id', v_voucher.id,
    'transaction_id', v_tx.id,
    'token_hash', v_voucher.token_hash,
    'expires_at', v_voucher.expires_at,
    'buyer_id', v_voucher.buyer_id,
    'seller_id', v_voucher.seller_id,
    'amount', v_tx.amount,
    'safe_zone_id', v_tx.buyer_safe_zone_id
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.confirm_offline_handoff(
  p_transaction_id uuid,
  p_voucher_id uuid,
  p_token text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_tx public.transactions%ROWTYPE;
  v_voucher public.offline_handoff_vouchers%ROWTYPE;
  v_hash text;
  v_expiry timestamptz;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_transaction_id IS NULL OR p_voucher_id IS NULL
     OR p_token IS NULL OR length(p_token) < 32 OR length(p_token) > 128 THEN
    RAISE EXCEPTION 'Invalid offline handoff proof';
  END IF;

  -- Keep the global escrow lock order: transaction first, voucher second.
  SELECT * INTO v_tx
    FROM public.transactions
   WHERE id = p_transaction_id
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Transaction not found'; END IF;
  IF v_actor <> v_tx.buyer_id THEN RAISE EXCEPTION 'Only the buyer can confirm handoff'; END IF;

  SELECT * INTO v_voucher
    FROM public.offline_handoff_vouchers
   WHERE id = p_voucher_id AND transaction_id = p_transaction_id
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Offline handoff voucher not found'; END IF;
  IF v_actor <> v_voucher.buyer_id THEN RAISE EXCEPTION 'Only the buyer can confirm handoff'; END IF;

  v_hash := encode(extensions.digest(convert_to(p_token, 'UTF8'), 'sha256'), 'hex');
  IF v_hash <> v_voucher.token_hash THEN RAISE EXCEPTION 'Invalid offline handoff proof'; END IF;

  IF v_voucher.consumed_at IS NOT NULL THEN
    IF v_tx.status IN ('release_requested', 'released')
       AND v_tx.handshake_receipt_buffer IS NOT NULL THEN
      RETURN jsonb_build_object(
        'success', true,
        'status', CASE WHEN v_tx.status = 'released' THEN 'released' ELSE 'inspection_pending' END,
        'transaction_id', v_tx.id,
        'inspection_expires_at', v_tx.auto_release_at,
        'already_confirmed', true,
        'funds_released', v_tx.status = 'released'
      );
    END IF;
    RAISE EXCEPTION 'Offline handoff voucher has already been consumed';
  END IF;

  IF v_voucher.expires_at <= now() THEN RAISE EXCEPTION 'Offline handoff QR has expired'; END IF;
  IF v_tx.status <> 'meetup_initiated'
     OR v_tx.buyer_id <> v_voucher.buyer_id
     OR v_tx.seller_id <> v_voucher.seller_id THEN
    RAISE EXCEPTION 'Transaction participants or state changed';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.listings
     WHERE id = v_tx.listing_id AND status = 'reserved'
  ) THEN
    RAISE EXCEPTION 'Escrow listing is no longer reserved';
  END IF;
  IF COALESCE(v_tx.payment_method, '') = 'campus_wallet'
     AND NOT EXISTS (
       SELECT 1 FROM public.wallet_escrow_holds
        WHERE transaction_id = v_tx.id AND status = 'held'
     ) THEN
    RAISE EXCEPTION 'Campus Wallet escrow hold is not active';
  END IF;

  v_expiry := now() + interval '2 hours';
  UPDATE public.offline_handoff_vouchers
     SET consumed_at = now()
   WHERE id = v_voucher.id AND consumed_at IS NULL;

  PERFORM set_config('app.escrow_transition', 'true', true);
  UPDATE public.transactions
     SET status = 'release_requested',
         release_requested_at = now(),
         auto_release_at = v_expiry,
         handshake_receipt_buffer = now(),
         payout_status = CASE
           WHEN payment_method = 'campus_wallet' THEN 'not_applicable'
           ELSE payout_status
         END
   WHERE id = v_tx.id AND status = 'meetup_initiated';

  IF NOT FOUND THEN RAISE EXCEPTION 'Transaction changed during offline handoff confirmation'; END IF;

  RETURN jsonb_build_object(
    'success', true,
    'status', 'inspection_pending',
    'transaction_id', v_tx.id,
    'inspection_started_at', now(),
    'inspection_expires_at', v_expiry,
    'funds_released', false
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.prepare_offline_handoff(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_offline_handoff_commitment(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.confirm_offline_handoff(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.prepare_offline_handoff(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_offline_handoff_commitment(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_offline_handoff(uuid, uuid, text) TO authenticated;
 THEN
    RAISE EXCEPTION 'Invalid offline handoff request';
  END IF;

  SELECT * INTO v_tx
    FROM public.transactions
   WHERE id = p_transaction_id
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Transaction not found'; END IF;
  IF v_actor <> v_tx.seller_id THEN RAISE EXCEPTION 'Only the seller can prepare the handoff QR'; END IF;
  IF v_tx.status <> 'meetup_initiated' THEN RAISE EXCEPTION 'Transaction is not ready for handoff'; END IF;
  IF v_tx.buyer_arrived IS DISTINCT FROM true
     OR v_tx.buyer_safe_zone_id IS NULL
     OR v_tx.mobile_release_ready_at IS NULL
     OR v_tx.mobile_release_ready_at < now() - interval '10 minutes' THEN
    RAISE EXCEPTION 'Fresh buyer Safe Swap Zone verification is required';
  END IF;
  IF v_tx.seller_arrived IS DISTINCT FROM true
     OR v_tx.seller_safe_zone_id IS NULL
     OR v_tx.seller_safe_zone_id IS DISTINCT FROM v_tx.buyer_safe_zone_id
     OR v_tx.seller_location_captured_at IS NULL
     OR v_tx.seller_location_captured_at < now() - interval '30 minutes' THEN
    RAISE EXCEPTION 'Seller must verify arrival in the same Safe Swap Zone within 30 minutes';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.listings
     WHERE id = v_tx.listing_id AND status = 'reserved'
  ) THEN
    RAISE EXCEPTION 'Escrow listing is not reserved';
  END IF;

  SELECT * INTO v_voucher
    FROM public.offline_handoff_vouchers
   WHERE transaction_id = v_tx.id
   FOR UPDATE;

  IF FOUND AND v_voucher.consumed_at IS NOT NULL THEN
    RAISE EXCEPTION 'An offline handoff voucher has already been consumed';
  END IF;
  IF FOUND AND v_voucher.expires_at > now() THEN
    RAISE EXCEPTION 'An active offline handoff QR already exists';
  END IF;

  INSERT INTO public.offline_handoff_vouchers (
    transaction_id, buyer_id, seller_id, token_hash, expires_at, consumed_at
  )
  VALUES (
    v_tx.id, v_tx.buyer_id, v_tx.seller_id, p_token_hash, now() + interval '10 minutes', NULL
  )
  ON CONFLICT (transaction_id) DO UPDATE
    SET buyer_id = EXCLUDED.buyer_id,
        seller_id = EXCLUDED.seller_id,
        token_hash = EXCLUDED.token_hash,
        expires_at = EXCLUDED.expires_at,
        consumed_at = NULL,
        created_at = now()
    WHERE public.offline_handoff_vouchers.consumed_at IS NULL
      AND public.offline_handoff_vouchers.expires_at <= now()
  RETURNING * INTO v_voucher;

  IF NOT FOUND THEN RAISE EXCEPTION 'Unable to rotate offline handoff voucher'; END IF;

  RETURN jsonb_build_object(
    'success', true,
    'voucher_id', v_voucher.id,
    'transaction_id', v_tx.id,
    'expires_at', v_voucher.expires_at,
    'buyer_id', v_tx.buyer_id,
    'seller_id', v_tx.seller_id,
    'amount', v_tx.amount,
    'safe_zone_id', v_tx.buyer_safe_zone_id
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_offline_handoff_commitment(p_transaction_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_tx public.transactions%ROWTYPE;
  v_voucher public.offline_handoff_vouchers%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  SELECT * INTO v_tx FROM public.transactions WHERE id = p_transaction_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Transaction not found'; END IF;
  IF v_actor <> v_tx.buyer_id THEN RAISE EXCEPTION 'Only the buyer can retrieve the handoff commitment'; END IF;
  IF v_tx.status <> 'meetup_initiated' THEN RAISE EXCEPTION 'Transaction is not ready for handoff'; END IF;

  SELECT * INTO v_voucher
    FROM public.offline_handoff_vouchers
   WHERE transaction_id = p_transaction_id
     AND buyer_id = v_actor
     AND consumed_at IS NULL
     AND expires_at > now();
  IF NOT FOUND THEN RAISE EXCEPTION 'No active offline handoff QR is available'; END IF;

  RETURN jsonb_build_object(
    'success', true,
    'voucher_id', v_voucher.id,
    'transaction_id', v_tx.id,
    'token_hash', v_voucher.token_hash,
    'expires_at', v_voucher.expires_at,
    'buyer_id', v_voucher.buyer_id,
    'seller_id', v_voucher.seller_id,
    'amount', v_tx.amount,
    'safe_zone_id', v_tx.buyer_safe_zone_id
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.confirm_offline_handoff(
  p_transaction_id uuid,
  p_voucher_id uuid,
  p_token text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_tx public.transactions%ROWTYPE;
  v_voucher public.offline_handoff_vouchers%ROWTYPE;
  v_hash text;
  v_expiry timestamptz;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_transaction_id IS NULL OR p_voucher_id IS NULL
     OR p_token IS NULL OR length(p_token) < 32 OR length(p_token) > 128 THEN
    RAISE EXCEPTION 'Invalid offline handoff proof';
  END IF;

  SELECT * INTO v_voucher
    FROM public.offline_handoff_vouchers
   WHERE id = p_voucher_id AND transaction_id = p_transaction_id
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Offline handoff voucher not found'; END IF;
  IF v_actor <> v_voucher.buyer_id THEN RAISE EXCEPTION 'Only the buyer can confirm handoff'; END IF;

  IF v_voucher.consumed_at IS NOT NULL THEN
    IF v_tx.status = 'release_requested' AND v_tx.handshake_receipt_buffer IS NOT NULL THEN
      RETURN jsonb_build_object(
        'success', true, 'status', 'inspection_pending',
        'transaction_id', v_tx.id, 'inspection_expires_at', v_tx.auto_release_at,
        'already_confirmed', true, 'funds_released', false
      );
    END IF;
    RAISE EXCEPTION 'Offline handoff voucher has already been consumed';
  END IF;

  IF v_voucher.expires_at <= now() THEN RAISE EXCEPTION 'Offline handoff QR has expired'; END IF;
  v_hash := encode(extensions.digest(convert_to(p_token, 'UTF8'), 'sha256'), 'hex');
  IF v_hash <> v_voucher.token_hash THEN RAISE EXCEPTION 'Invalid offline handoff proof'; END IF;
  IF v_tx.status <> 'meetup_initiated'
     OR v_tx.buyer_id <> v_voucher.buyer_id
     OR v_tx.seller_id <> v_voucher.seller_id THEN
    RAISE EXCEPTION 'Transaction participants or state changed';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.listings
     WHERE id = v_tx.listing_id AND status = 'reserved'
  ) THEN
    RAISE EXCEPTION 'Escrow listing is no longer reserved';
  END IF;
  IF COALESCE(v_tx.payment_method, '') = 'campus_wallet'
     AND NOT EXISTS (
       SELECT 1 FROM public.wallet_escrow_holds
        WHERE transaction_id = v_tx.id AND status = 'held'
     ) THEN
    RAISE EXCEPTION 'Campus Wallet escrow hold is not active';
  END IF;

  v_expiry := now() + interval '2 hours';
  UPDATE public.offline_handoff_vouchers
     SET consumed_at = now()
   WHERE id = v_voucher.id AND consumed_at IS NULL;

  PERFORM set_config('app.escrow_transition', 'true', true);
  UPDATE public.transactions
     SET status = 'release_requested',
         release_requested_at = now(),
         auto_release_at = v_expiry,
         handshake_receipt_buffer = now(),
         payout_status = CASE
           WHEN payment_method = 'campus_wallet' THEN 'not_applicable'
           ELSE payout_status
         END
   WHERE id = v_tx.id AND status = 'meetup_initiated';

  IF NOT FOUND THEN RAISE EXCEPTION 'Transaction changed during offline handoff confirmation'; END IF;

  RETURN jsonb_build_object(
    'success', true,
    'status', 'inspection_pending',
    'transaction_id', v_tx.id,
    'inspection_started_at', now(),
    'inspection_expires_at', v_expiry,
    'funds_released', false
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.prepare_offline_handoff(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_offline_handoff_commitment(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.confirm_offline_handoff(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.prepare_offline_handoff(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_offline_handoff_commitment(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_offline_handoff(uuid, uuid, text) TO authenticated;
