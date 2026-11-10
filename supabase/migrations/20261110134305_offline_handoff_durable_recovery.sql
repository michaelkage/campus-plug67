-- Extend offline handoff vouchers for genuine campus dead-zones.
-- The server remains authoritative for expiry. Client wall clocks are never
-- used to authorize confirmation, and a seller may refresh the same active
-- token without invalidating the QR already displayed to the buyer.
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
    transaction_id, buyer_id, seller_id, amount, safe_zone_id, token_hash, expires_at, consumed_at
  )
  VALUES (
    v_tx.id, v_tx.buyer_id, v_tx.seller_id, v_tx.amount, v_tx.buyer_safe_zone_id, p_token_hash, now() + interval '24 hours', NULL
  )
  ON CONFLICT (transaction_id) DO UPDATE
    SET buyer_id = EXCLUDED.buyer_id,
        seller_id = EXCLUDED.seller_id,
        amount = EXCLUDED.amount,
        safe_zone_id = EXCLUDED.safe_zone_id,
        token_hash = EXCLUDED.token_hash,
        expires_at = now() + interval '24 hours',
        consumed_at = NULL,
        created_at = now()
    WHERE public.offline_handoff_vouchers.consumed_at IS NULL
      AND (public.offline_handoff_vouchers.expires_at <= now()
        OR public.offline_handoff_vouchers.token_hash = EXCLUDED.token_hash)
  RETURNING * INTO v_voucher;

  IF NOT FOUND THEN RAISE EXCEPTION 'Unable to rotate offline handoff voucher'; END IF;

  RETURN jsonb_build_object(
    'success', true,
    'voucher_id', v_voucher.id,
    'transaction_id', v_tx.id,
    'expires_at', v_voucher.expires_at,
    'buyer_id', v_tx.buyer_id,
    'seller_id', v_tx.seller_id,
    'amount', v_voucher.amount,
    'safe_zone_id', v_voucher.safe_zone_id
  );
END;
$function$;
