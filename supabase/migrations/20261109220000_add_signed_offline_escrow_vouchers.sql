-- Server-signed offline escrow vouchers. Offline scans are provisional;
-- only the atomic reconciliation RPC can start the existing inspection window.

CREATE TABLE IF NOT EXISTS public.offline_escrow_signing_keys (
  id smallint PRIMARY KEY CHECK (id = 1),
  key_id text NOT NULL UNIQUE,
  public_key_spki text NOT NULL,
  private_key_pkcs8 text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.offline_escrow_signing_keys ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.offline_escrow_signing_keys FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.offline_escrow_signing_keys TO service_role;

CREATE TABLE IF NOT EXISTS public.offline_escrow_vouchers (
  id uuid PRIMARY KEY,
  transaction_id uuid NOT NULL REFERENCES public.transactions(id) ON DELETE RESTRICT,
  nonce uuid NOT NULL UNIQUE,
  buyer_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  seller_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  amount_kobo bigint NOT NULL CHECK (amount_kobo > 0),
  payment_method text NOT NULL,
  key_id text NOT NULL,
  payload jsonb NOT NULL,
  signature text NOT NULL,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'issued' CHECK (status IN ('issued','consumed','revoked','expired')),
  receipt_id uuid UNIQUE,
  receipt_payload jsonb,
  consumed_at timestamptz,
  consumed_by uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > issued_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS offline_escrow_one_active_voucher_per_transaction
  ON public.offline_escrow_vouchers(transaction_id) WHERE status = 'issued';
CREATE INDEX IF NOT EXISTS offline_escrow_vouchers_expiry_idx
  ON public.offline_escrow_vouchers(expires_at) WHERE status = 'issued';
ALTER TABLE public.offline_escrow_vouchers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.offline_escrow_vouchers FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.offline_escrow_vouchers TO service_role;

CREATE OR REPLACE FUNCTION public.issue_offline_escrow_voucher(
  p_voucher_id uuid, p_transaction_id uuid, p_nonce uuid, p_buyer_id uuid,
  p_key_id text, p_payload jsonb, p_signature text,
  p_issued_at timestamptz, p_expires_at timestamptz
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE v_tx public.transactions%ROWTYPE; v_hold public.wallet_escrow_holds%ROWTYPE;
BEGIN
  IF COALESCE(auth.jwt()->>'role','') <> 'service_role' THEN RAISE EXCEPTION 'Service role required'; END IF;
  IF p_voucher_id IS NULL OR p_transaction_id IS NULL OR p_nonce IS NULL OR p_buyer_id IS NULL
     OR p_key_id IS NULL OR p_signature IS NULL OR p_payload IS NULL THEN
    RAISE EXCEPTION 'Voucher claims are incomplete';
  END IF;
  IF p_issued_at < now()-interval '2 minutes' OR p_issued_at > now()+interval '30 seconds'
     OR p_expires_at <= now() OR p_expires_at > now()+interval '24 hours'
     OR p_expires_at <= p_issued_at THEN RAISE EXCEPTION 'Voucher validity window is invalid'; END IF;

  SELECT * INTO v_tx FROM public.transactions WHERE id=p_transaction_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Transaction not found'; END IF;
  IF v_tx.buyer_id <> p_buyer_id THEN RAISE EXCEPTION 'Only the buyer can issue an offline voucher'; END IF;
  IF v_tx.status <> 'meetup_initiated' OR v_tx.payment_method IS NULL THEN
    RAISE EXCEPTION 'Transaction is not ready for offline handoff';
  END IF;
  IF v_tx.buyer_arrived IS DISTINCT FROM true OR v_tx.buyer_safe_zone_id IS NULL
     OR v_tx.mobile_release_ready_at IS NULL OR v_tx.mobile_release_ready_at < now()-interval '10 minutes' THEN
    RAISE EXCEPTION 'Fresh buyer Safe Swap verification is required before going offline';
  END IF;
  IF v_tx.seller_arrived IS DISTINCT FROM true OR v_tx.seller_safe_zone_id IS NULL
     OR v_tx.seller_safe_zone_id IS DISTINCT FROM v_tx.buyer_safe_zone_id
     OR v_tx.seller_location_captured_at IS NULL
     OR v_tx.seller_location_captured_at < now()-interval '30 minutes' THEN
    RAISE EXCEPTION 'Seller must have a fresh check-in in the same Safe Swap Zone';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.listings WHERE id=v_tx.listing_id AND status='reserved') THEN
    RAISE EXCEPTION 'Escrow listing is no longer reserved';
  END IF;
  IF v_tx.payment_method='campus_wallet' THEN
    SELECT * INTO v_hold FROM public.wallet_escrow_holds WHERE transaction_id=p_transaction_id FOR UPDATE;
    IF NOT FOUND OR v_hold.status<>'held' OR v_hold.buyer_id<>v_tx.buyer_id
       OR v_hold.seller_id<>v_tx.seller_id OR v_hold.amount_kobo<>v_tx.amount THEN
      RAISE EXCEPTION 'Wallet escrow hold is not valid';
    END IF;
  ELSIF v_tx.payment_verified IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'External payment has not been verified';
  END IF;
  IF p_payload->>'voucher_id' IS DISTINCT FROM p_voucher_id::text
     OR p_payload->>'transaction_id' IS DISTINCT FROM p_transaction_id::text
     OR p_payload->>'nonce' IS DISTINCT FROM p_nonce::text
     OR p_payload->>'buyer_id' IS DISTINCT FROM v_tx.buyer_id::text
     OR p_payload->>'seller_id' IS DISTINCT FROM v_tx.seller_id::text
     OR p_payload->>'amount_kobo' IS DISTINCT FROM v_tx.amount::text
     OR p_payload->>'payment_method' IS DISTINCT FROM v_tx.payment_method
     OR p_payload->>'key_id' IS DISTINCT FROM p_key_id
     OR (p_payload->>'issued_at')::timestamptz IS DISTINCT FROM p_issued_at
     OR (p_payload->>'expires_at')::timestamptz IS DISTINCT FROM p_expires_at THEN
    RAISE EXCEPTION 'Signed voucher claims do not match the transaction';
  END IF;
  UPDATE public.offline_escrow_vouchers SET status='revoked'
   WHERE transaction_id=p_transaction_id AND status='issued';
  INSERT INTO public.offline_escrow_vouchers(
    id,transaction_id,nonce,buyer_id,seller_id,amount_kobo,payment_method,key_id,
    payload,signature,issued_at,expires_at
  ) VALUES (
    p_voucher_id,p_transaction_id,p_nonce,v_tx.buyer_id,v_tx.seller_id,v_tx.amount,
    v_tx.payment_method,p_key_id,p_payload,p_signature,p_issued_at,p_expires_at
  );
  RETURN jsonb_build_object('success',true,'voucher_id',p_voucher_id,'expires_at',p_expires_at,'status','issued');
END;
$function$;

CREATE OR REPLACE FUNCTION public.reconcile_offline_escrow_voucher(
  p_voucher_id uuid,p_nonce uuid,p_seller_id uuid,p_receipt_id uuid,
  p_payload jsonb,p_signature text,p_qr_counter bigint,p_qr_code text,p_scanned_at timestamptz
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE
  v_voucher public.offline_escrow_vouchers%ROWTYPE;
  v_tx public.transactions%ROWTYPE;
  v_hold public.wallet_escrow_holds%ROWTYPE;
  v_expiry timestamptz;
BEGIN
  IF COALESCE(auth.jwt()->>'role','') <> 'service_role' THEN RAISE EXCEPTION 'Service role required'; END IF;
  IF p_voucher_id IS NULL OR p_nonce IS NULL OR p_seller_id IS NULL OR p_receipt_id IS NULL
     OR p_payload IS NULL OR p_signature IS NULL OR p_qr_counter IS NULL OR p_qr_code IS NULL THEN
    RAISE EXCEPTION 'Offline receipt is incomplete';
  END IF;
  -- Global lock order: transaction first, then voucher (same as issuance).
  SELECT * INTO v_voucher FROM public.offline_escrow_vouchers WHERE id=p_voucher_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Offline voucher not found'; END IF;
  SELECT * INTO v_tx FROM public.transactions WHERE id=v_voucher.transaction_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Transaction not found'; END IF;
  SELECT * INTO v_voucher FROM public.offline_escrow_vouchers WHERE id=p_voucher_id FOR UPDATE;
  IF v_voucher.status='consumed' THEN
    IF v_voucher.receipt_id=p_receipt_id AND v_voucher.consumed_by=p_seller_id THEN
      RETURN jsonb_build_object('success',true,'already_reconciled',true,'status','inspection_pending',
        'transaction_id',v_tx.id,'inspection_expires_at',v_tx.auto_release_at);
    END IF;
    RAISE EXCEPTION 'Offline voucher has already been consumed';
  END IF;
  IF v_voucher.status<>'issued' THEN RAISE EXCEPTION 'Offline voucher is no longer valid'; END IF;
  IF v_voucher.expires_at<=now() THEN RAISE EXCEPTION 'Offline voucher expired before synchronization'; END IF;
  IF v_voucher.nonce<>p_nonce OR v_voucher.seller_id<>p_seller_id
     OR v_voucher.payload<>p_payload OR v_voucher.signature<>p_signature
     OR v_tx.seller_id<>p_seller_id OR v_tx.buyer_id<>v_voucher.buyer_id
     OR v_tx.amount<>v_voucher.amount_kobo OR v_tx.payment_method<>v_voucher.payment_method THEN
    RAISE EXCEPTION 'Offline receipt does not match the issued voucher';
  END IF;
  IF v_tx.status<>'meetup_initiated' THEN RAISE EXCEPTION 'Transaction changed before receipt synchronization'; END IF;
  IF p_payload->>'transaction_id' IS DISTINCT FROM v_tx.id::text
     OR p_payload->>'voucher_id' IS DISTINCT FROM v_voucher.id::text
     OR p_payload->>'nonce' IS DISTINCT FROM v_voucher.nonce::text THEN
    RAISE EXCEPTION 'Offline voucher claims are inconsistent';
  END IF;
  IF p_qr_counter < floor(extract(epoch FROM v_voucher.issued_at)/30)::bigint
     OR p_qr_counter > floor(extract(epoch FROM v_voucher.expires_at)/30)::bigint THEN
    RAISE EXCEPTION 'Rotating QR counter is outside voucher validity';
  END IF;
  IF v_tx.payment_method='campus_wallet' THEN
    SELECT * INTO v_hold FROM public.wallet_escrow_holds WHERE transaction_id=v_tx.id FOR UPDATE;
    IF NOT FOUND OR v_hold.status<>'held' OR v_hold.buyer_id<>v_tx.buyer_id
       OR v_hold.seller_id<>v_tx.seller_id OR v_hold.amount_kobo<>v_tx.amount THEN
      RAISE EXCEPTION 'Wallet escrow hold is no longer valid';
    END IF;
  ELSIF v_tx.payment_verified IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'External payment is no longer verified';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.listings WHERE id=v_tx.listing_id AND status='reserved') THEN
    RAISE EXCEPTION 'Escrow listing is no longer reserved';
  END IF;
  v_expiry:=now()+interval '2 hours';
  UPDATE public.offline_escrow_vouchers SET status='consumed',receipt_id=p_receipt_id,
    receipt_payload=jsonb_build_object('qr_counter',p_qr_counter,'qr_code',p_qr_code,
      'scanned_at',p_scanned_at,'synced_at',now()),consumed_at=now(),consumed_by=p_seller_id
   WHERE id=v_voucher.id AND status='issued';
  IF NOT FOUND THEN RAISE EXCEPTION 'Offline voucher was consumed concurrently'; END IF;
  PERFORM set_config('app.escrow_transition','true',true);
  UPDATE public.transactions SET status='release_requested',release_requested_at=now(),
    auto_release_at=v_expiry,handshake_receipt_buffer=now(),
    payout_status=CASE WHEN payment_method='campus_wallet' THEN 'not_applicable' ELSE payout_status END
   WHERE id=v_tx.id AND status='meetup_initiated';
  IF NOT FOUND THEN RAISE EXCEPTION 'Transaction changed while synchronizing offline receipt'; END IF;
  RETURN jsonb_build_object('success',true,'status','inspection_pending','transaction_id',v_tx.id,
    'inspection_started_at',now(),'inspection_expires_at',v_expiry,'funds_released',false);
END;
$function$;

CREATE OR REPLACE FUNCTION public.revoke_offline_escrow_vouchers_on_transition()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
BEGIN
  IF OLD.status='meetup_initiated' AND NEW.status<>'meetup_initiated' THEN
    UPDATE public.offline_escrow_vouchers SET status='revoked'
     WHERE transaction_id=NEW.id AND status='issued';
  END IF;
  RETURN NEW;
END;
$function$;
DROP TRIGGER IF EXISTS revoke_offline_escrow_vouchers_on_transition ON public.transactions;
CREATE TRIGGER revoke_offline_escrow_vouchers_on_transition
AFTER UPDATE OF status ON public.transactions
FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
EXECUTE FUNCTION public.revoke_offline_escrow_vouchers_on_transition();

REVOKE ALL ON FUNCTION public.issue_offline_escrow_voucher(uuid,uuid,uuid,uuid,text,jsonb,text,timestamptz,timestamptz) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.reconcile_offline_escrow_voucher(uuid,uuid,uuid,uuid,jsonb,text,bigint,text,timestamptz) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.revoke_offline_escrow_vouchers_on_transition() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.issue_offline_escrow_voucher(uuid,uuid,uuid,uuid,text,jsonb,text,timestamptz,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.reconcile_offline_escrow_voucher(uuid,uuid,uuid,uuid,jsonb,text,bigint,text,timestamptz) TO service_role;
