-- Make Campus Wallet micro-escrow retries idempotent after a committed purchase.
-- A lost RPC response must recover the existing buyer-owned escrow, never debit twice.
-- Conflicts involving another buyer, another payment provider, or inconsistent holds
-- remain structured conflicts. The active-per-listing unique index stays authoritative.

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
  v_existing_transaction public.transactions%ROWTYPE;
  v_existing_hold public.wallet_escrow_holds%ROWTYPE;
  v_amount bigint;
  v_balance bigint;
  v_constraint_name text;
BEGIN
  IF v_buyer IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  SELECT *
    INTO v_listing
    FROM public.listings
   WHERE id = p_listing_id
   FOR UPDATE;

  IF NOT FOUND THEN
    SELECT t.id INTO v_existing_tx
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

  -- Recover a prior committed wallet purchase if the client lost the response.
  -- Only the same buyer with a still-held, internally consistent wallet escrow
  -- may receive success. No transaction or ledger write occurs on this branch.
  SELECT t, h
    INTO v_existing_transaction, v_existing_hold
    FROM public.transactions t
    LEFT JOIN public.wallet_escrow_holds h
      ON h.transaction_id = t.id
   WHERE t.listing_id = p_listing_id
     AND t.status IN ('pending', 'locked', 'meetup_initiated', 'release_requested', 'disputed')
   ORDER BY t.created_at DESC
   LIMIT 1;

  IF FOUND THEN
    IF v_existing_transaction.buyer_id = v_buyer
       AND v_existing_transaction.payment_method = 'campus_wallet'
       AND v_existing_transaction.status IN ('locked', 'meetup_initiated', 'release_requested', 'disputed')
       AND v_existing_transaction.seller_id = v_listing.seller_id
       AND v_existing_hold.id IS NOT NULL
       AND v_existing_hold.status = 'held'
       AND v_existing_hold.buyer_id = v_buyer
       AND v_existing_hold.seller_id = v_existing_transaction.seller_id
       AND v_existing_hold.amount_kobo = v_existing_transaction.amount
       AND v_listing.status = 'reserved'
    THEN
      SELECT COALESCE(plug_credit_balance, 0)
        INTO v_balance
        FROM public.profiles
       WHERE id = v_buyer;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Buyer profile not found';
      END IF;

      RETURN jsonb_build_object(
        'success', true,
        'idempotent', true,
        'transaction_id', v_existing_transaction.id,
        'amount_kobo', v_existing_transaction.amount,
        'wallet_balance_after', v_balance
      );
    END IF;

    RETURN jsonb_build_object(
      'success', false,
      'code', 'active_transaction_exists',
      'transaction_id', v_existing_transaction.id,
      'message', 'This listing already has an active purchase.'
    );
  END IF;

  IF v_listing.status <> 'active' THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'listing_unavailable',
      'message', 'This listing is no longer available.'
    );
  END IF;

  IF v_listing.seller_id = v_buyer THEN
    RAISE EXCEPTION 'You cannot buy your own listing';
  END IF;

  v_amount := v_listing.price;
  IF v_amount > 1000000 THEN
    RAISE EXCEPTION 'Campus Wallet is only for purchases up to ₦10,000';
  END IF;
  IF v_amount IS NULL OR v_amount <= 0 THEN
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

  -- Catch only the expected active-listing index conflict. If the winner is
  -- this buyer's valid wallet escrow, recover it idempotently; otherwise conflict.
  BEGIN
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
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constraint_name = CONSTRAINT_NAME;

    IF v_constraint_name = 'transactions_one_active_per_listing' THEN
      SELECT t, h
        INTO v_existing_transaction, v_existing_hold
        FROM public.transactions t
        LEFT JOIN public.wallet_escrow_holds h
          ON h.transaction_id = t.id
       WHERE t.listing_id = p_listing_id
         AND t.status IN ('pending', 'locked', 'meetup_initiated', 'release_requested', 'disputed')
       ORDER BY t.created_at DESC
       LIMIT 1;

      IF NOT FOUND THEN
        RAISE;
      END IF;

      IF v_existing_transaction.buyer_id = v_buyer
         AND v_existing_transaction.payment_method = 'campus_wallet'
         AND v_existing_transaction.status IN ('locked', 'meetup_initiated', 'release_requested', 'disputed')
         AND v_existing_transaction.seller_id = v_listing.seller_id
         AND v_existing_hold.id IS NOT NULL
         AND v_existing_hold.status = 'held'
         AND v_existing_hold.buyer_id = v_buyer
         AND v_existing_hold.seller_id = v_existing_transaction.seller_id
         AND v_existing_hold.amount_kobo = v_existing_transaction.amount
         AND v_listing.status = 'reserved'
      THEN
        SELECT COALESCE(plug_credit_balance, 0)
          INTO v_balance
          FROM public.profiles
         WHERE id = v_buyer;

        IF NOT FOUND THEN
          RAISE EXCEPTION 'Buyer profile not found';
        END IF;

        RETURN jsonb_build_object(
          'success', true,
          'idempotent', true,
          'transaction_id', v_existing_transaction.id,
          'amount_kobo', v_existing_transaction.amount,
          'wallet_balance_after', v_balance
        );
      END IF;

      RETURN jsonb_build_object(
        'success', false,
        'code', 'active_transaction_exists',
        'transaction_id', v_existing_transaction.id,
        'message', 'This listing already has an active purchase.'
      );
    END IF;

    RAISE;
  END;

  INSERT INTO public.plug_credit_ledger (user_id, amount, reason, reference_id)
  VALUES (v_buyer, -v_amount, 'Campus Wallet escrow hold', v_tx.id);

  INSERT INTO public.wallet_escrow_holds (transaction_id, buyer_id, seller_id, amount_kobo)
  VALUES (v_tx.id, v_buyer, v_listing.seller_id, v_amount);

  UPDATE public.listings
     SET status = 'reserved', updated_at = now()
   WHERE id = p_listing_id
     AND status = 'active';

  RETURN jsonb_build_object(
    'success', true,
    'transaction_id', v_tx.id,
    'amount_kobo', v_amount,
    'wallet_balance_after', v_balance - v_amount
  );
END;
$$;

REVOKE ALL ON FUNCTION public.create_wallet_micro_escrow(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_wallet_micro_escrow(uuid) TO authenticated;
