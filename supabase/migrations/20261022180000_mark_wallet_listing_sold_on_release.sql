-- Keep Campus Wallet listing state consistent with escrow settlement.
-- Wallet release pays the seller and completes the purchase; the reserved listing
-- must become sold atomically or the whole release is rolled back.
CREATE OR REPLACE FUNCTION public.resolve_wallet_micro_escrow(
  p_transaction_id uuid,
  p_action text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_hold public.wallet_escrow_holds%ROWTYPE;
  v_user uuid := auth.uid();
  v_reason text;
  v_listing_id uuid;
  v_tx public.transactions%ROWTYPE;
BEGIN
  SELECT *
    INTO v_hold
    FROM public.wallet_escrow_holds
   WHERE transaction_id = p_transaction_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Wallet escrow not found';
  END IF;

  IF v_user IS NULL OR (v_user <> v_hold.buyer_id AND v_user <> v_hold.seller_id) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  IF v_hold.status <> 'held' THEN
    RAISE EXCEPTION 'Wallet escrow already resolved';
  END IF;

  SELECT * INTO v_tx
    FROM public.transactions
   WHERE id = v_hold.transaction_id
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Wallet escrow transaction not found'; END IF;
  IF COALESCE(v_tx.payment_method, '') <> 'campus_wallet' THEN
    RAISE EXCEPTION 'Wallet escrow transaction payment method mismatch';
  END IF;
  IF v_tx.status <> 'locked' THEN
    RAISE EXCEPTION 'Wallet escrow transaction is not eligible for resolution';
  END IF;
  v_listing_id := v_tx.listing_id;

  IF p_action = 'release' THEN
    v_reason := 'Campus Wallet micro-escrow release';
    INSERT INTO public.plug_credit_ledger(user_id, amount, reason, reference_id)
    VALUES(v_hold.seller_id, v_hold.amount_kobo, v_reason, v_hold.transaction_id);

    UPDATE public.wallet_escrow_holds
       SET status = 'released', resolved_at = now()
     WHERE id = v_hold.id;

    UPDATE public.transactions
       SET status = 'released', released_at = now(), completed_at = now(), payout_status = 'paid'
     WHERE id = v_hold.transaction_id;

    UPDATE public.listings
       SET status = 'sold', updated_at = now()
     WHERE id = v_listing_id
       AND status = 'reserved';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Wallet escrow listing is not reserved';
    END IF;
  ELSIF p_action = 'refund' THEN
    IF v_user <> v_hold.buyer_id THEN
      RAISE EXCEPTION 'Only the buyer can request a wallet refund';
    END IF;

    INSERT INTO public.plug_credit_ledger(user_id, amount, reason, reference_id)
    VALUES(v_hold.buyer_id, v_hold.amount_kobo, 'Campus Wallet micro-escrow refund', v_hold.transaction_id);

    UPDATE public.wallet_escrow_holds
       SET status = 'refunded', resolved_at = now()
     WHERE id = v_hold.id;

    UPDATE public.transactions
       SET status = 'cancelled', payout_status = 'not_applicable'
     WHERE id = v_hold.transaction_id;

    UPDATE public.listings l
       SET status = 'active', updated_at = now()
     WHERE l.id = v_listing_id
       AND l.status = 'reserved'
       AND NOT EXISTS (
         SELECT 1
           FROM public.transactions t
          WHERE t.listing_id = l.id
            AND t.status IN ('pending', 'locked', 'meetup_initiated', 'release_requested', 'disputed')
       );
  ELSE
    RAISE EXCEPTION 'Invalid wallet escrow action';
  END IF;

  RETURN jsonb_build_object('success', true, 'status', p_action);
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_wallet_micro_escrow(uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_wallet_micro_escrow(uuid,text) TO authenticated;
