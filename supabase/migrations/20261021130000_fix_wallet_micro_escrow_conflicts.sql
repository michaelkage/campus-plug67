-- Make Campus Wallet micro-escrow conflicts explicit and safe.
-- The listing row lock serializes competing wallet purchases for the same listing.
-- Keep transactions_one_active_per_listing as the final integrity backstop.

CREATE OR REPLACE FUNCTION public.create_wallet_micro_escrow(p_listing_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_buyer uuid := auth.uid();
  v_listing public.listings%ROWTYPE;
  v_tx public.transactions%ROWTYPE;
  v_existing_tx uuid;
  v_amount bigint;
  v_balance bigint;
BEGIN
  IF v_buyer IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  -- Serialize attempts for this listing before checking existing transactions.
  SELECT *
    INTO v_listing
    FROM public.listings
   WHERE id = p_listing_id
     AND status = 'active'
   FOR UPDATE;

  IF NOT FOUND THEN
    -- Distinguish a listing that has already been purchased from a missing/inactive listing.
    SELECT t.id
      INTO v_existing_tx
      FROM public.transactions t
     WHERE t.listing_id = p_listing_id
       AND t.status IN ('pending', 'locked', 'meetup_initiated', 'release_requested', 'disputed')
     ORDER BY t.created_at DESC
     LIMIT 1;

    IF v_existing_tx IS NOT NULL THEN
      RETURN jsonb_build_object(
        'success', false,
        'code', 'active_transaction_exists',
        'transaction_id', v_existing_tx,
        'message', 'This listing already has an active purchase.'
      );
    END IF;

    RETURN jsonb_build_object(
      'success', false,
      'code', 'listing_unavailable',
      'message', 'This listing is no longer available.'
    );
  END IF;

  IF v_listing.seller_id = v_buyer THEN
    RAISE EXCEPTION 'You cannot buy your own listing';
  END IF;

  -- Defensive check while holding the listing lock. This also handles legacy rows
  -- where the listing status was not updated when an active transaction was created.
  SELECT t.id
    INTO v_existing_tx
    FROM public.transactions t
   WHERE t.listing_id = p_listing_id
     AND t.status IN ('pending', 'locked', 'meetup_initiated', 'release_requested', 'disputed')
   ORDER BY t.created_at DESC
   LIMIT 1;

  IF v_existing_tx IS NOT NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'active_transaction_exists',
      'transaction_id', v_existing_tx,
      'message', 'This listing already has an active purchase.'
    );
  END IF;

  v_amount := v_listing.price;

  IF v_amount > 1000000 THEN
    RAISE EXCEPTION 'Campus Wallet is only for purchases up to ₦10,000';
  END IF;

  IF v_amount <= 0 THEN
    RAISE EXCEPTION 'Invalid listing amount';
  END IF;

  SELECT COALESCE(plug_credit_balance, 0)
    INTO v_balance
    FROM public.profiles
   WHERE id = v_buyer
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Buyer profile not found';
  END IF;

  IF v_balance < v_amount THEN
    RAISE EXCEPTION 'Insufficient Campus Wallet balance';
  END IF;

  INSERT INTO public.transactions (
    listing_id, buyer_id, seller_id, amount, status,
    payment_method, metadata, payout_status
  )
  VALUES (
    p_listing_id, v_buyer, v_listing.seller_id, v_amount, 'locked',
    'campus_wallet', jsonb_build_object('wallet_micro_escrow', true),
    'approved_for_settlement'
  )
  RETURNING * INTO v_tx;

  INSERT INTO public.plug_credit_ledger (user_id, amount, reason, reference_id)
  VALUES (v_buyer, -v_amount, 'Campus Wallet escrow hold', v_tx.id);

  INSERT INTO public.wallet_escrow_holds (transaction_id, buyer_id, seller_id, amount_kobo)
  VALUES (v_tx.id, v_buyer, v_listing.seller_id, v_amount);

  RETURN jsonb_build_object(
    'success', true,
    'transaction_id', v_tx.id,
    'amount_kobo', v_amount,
    'wallet_balance_after', v_balance - v_amount
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_wallet_micro_escrow(uuid) TO authenticated;
