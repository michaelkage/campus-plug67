-- Keep offline handoff vouchers time-bounded without invalidating a QR
-- during ordinary seller refreshes. An active token keeps its original absolute
-- expiry; an expired token must be replaced with fresh cryptographic material.
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
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;
  IF p_transaction_id IS NULL
     OR p_token_hash IS NULL
     OR length(p_token_hash) <> 64
     OR p_token_hash ~ '[^0-9a-f]' THEN
    RAISE EXCEPTION 'Invalid offline handoff request';
  END IF;

  -- Preserve the global escrow lock order: transaction before voucher.
  SELECT *
    INTO v_tx
    FROM public.transactions
   WHERE id = p_transaction_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Transaction not found';
  END IF;
  IF v_actor <> v_tx.seller_id THEN
    RAISE EXCEPTION 'Only the seller can prepare the handoff QR';
  END IF;
  IF v_tx.status <> 'meetup_initiated' THEN
    RAISE EXCEPTION 'Transaction is not ready for handoff';
  END IF;
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
    SELECT 1
      FROM public.listings
     WHERE id = v_tx.listing_id
       AND status = 'reserved'
  ) THEN
    RAISE EXCEPTION 'Escrow listing is not reserved';
  END IF;

  SELECT *
    INTO v_voucher
    FROM public.offline_handoff_vouchers
   WHERE transaction_id = v_tx.id
   FOR UPDATE;

  IF FOUND THEN
    IF v_voucher.consumed_at IS NOT NULL THEN
      RAISE EXCEPTION 'An offline handoff voucher has already been consumed';
    END IF;

    IF v_voucher.expires_at > now() THEN
      IF v_voucher.buyer_id IS DISTINCT FROM v_tx.buyer_id
         OR v_voucher.seller_id IS DISTINCT FROM v_tx.seller_id
         OR v_voucher.amount IS DISTINCT FROM v_tx.amount
         OR v_voucher.safe_zone_id IS DISTINCT FROM v_tx.buyer_safe_zone_id THEN
        IF v_voucher.token_hash = p_token_hash THEN
          RAISE EXCEPTION 'Offline handoff context changed; a new QR token is required';
        END IF;

        -- A changed transaction binding invalidates the previous QR token.
        UPDATE public.offline_handoff_vouchers
           SET buyer_id = v_tx.buyer_id,
               seller_id = v_tx.seller_id,
               amount = v_tx.amount,
               safe_zone_id = v_tx.buyer_safe_zone_id,
               token_hash = p_token_hash,
               expires_at = now() + interval '24 hours',
               consumed_at = NULL,
               created_at = now()
         WHERE id = v_voucher.id
         RETURNING * INTO v_voucher;
      ELSIF v_voucher.token_hash <> p_token_hash THEN
        RAISE EXCEPTION 'An active offline handoff voucher already exists';
      END IF;
      -- Same active token and same transaction binding: preserve its expiry.
    ELSE
      IF v_voucher.token_hash = p_token_hash THEN
        RAISE EXCEPTION 'Expired offline handoff voucher requires a new QR token';
      END IF;

      UPDATE public.offline_handoff_vouchers
         SET buyer_id = v_tx.buyer_id,
             seller_id = v_tx.seller_id,
             amount = v_tx.amount,
             safe_zone_id = v_tx.buyer_safe_zone_id,
             token_hash = p_token_hash,
             expires_at = now() + interval '24 hours',
             consumed_at = NULL,
             created_at = now()
       WHERE id = v_voucher.id
       RETURNING * INTO v_voucher;
    END IF;
  ELSE
    INSERT INTO public.offline_handoff_vouchers (
      transaction_id,
      buyer_id,
      seller_id,
      amount,
      safe_zone_id,
      token_hash,
      expires_at,
      consumed_at
    )
    VALUES (
      v_tx.id,
      v_tx.buyer_id,
      v_tx.seller_id,
      v_tx.amount,
      v_tx.buyer_safe_zone_id,
      p_token_hash,
      now() + interval '24 hours',
      NULL
    )
    RETURNING * INTO v_voucher;
  END IF;

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
