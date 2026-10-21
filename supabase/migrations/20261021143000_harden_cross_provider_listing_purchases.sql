-- Keep listing availability, wallet escrow, and Paystack checkout in one consistent state.
-- The listing row lock serializes both purchase paths; the partial unique index remains
-- the final safeguard against any writer that does not follow this protocol.

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

  -- Lock the listing even when it is no longer active so callers receive a useful
  -- conflict response for an already-locked purchase rather than a generic unavailable.
  SELECT *
    INTO v_listing
    FROM public.listings
   WHERE id = p_listing_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'listing_unavailable',
      'message', 'This listing is no longer available.'
    );
  END IF;

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

  -- Match Paystack's existing convention: a locked purchase is no longer for sale.
  -- This is in the same transaction as the debit/hold, so any later error rolls back
  -- the transaction, ledger write, hold, balance trigger, and listing state together.
  UPDATE public.listings
     SET status = 'sold', updated_at = now()
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

CREATE OR REPLACE FUNCTION public.create_pending_paystack_transaction(
  p_listing_id uuid,
  p_paystack_ref text
)
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
  v_constraint_name text;
BEGIN
  IF v_buyer IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF p_paystack_ref IS NULL
     OR length(p_paystack_ref) NOT BETWEEN 8 AND 100
     OR p_paystack_ref !~ '^CP-[A-Za-z0-9-]+$'
  THEN
    RAISE EXCEPTION 'Invalid payment reference';
  END IF;

  -- Both provider paths take this lock before checking for an active transaction.
  SELECT *
    INTO v_listing
    FROM public.listings
   WHERE id = p_listing_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'listing_unavailable',
      'message', 'This listing is no longer available.'
    );
  END IF;

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

  IF v_listing.price IS NULL OR v_listing.price <= 0 THEN
    RAISE EXCEPTION 'Invalid listing amount';
  END IF;

  IF EXISTS (SELECT 1 FROM public.transactions WHERE paystack_ref = p_paystack_ref) THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'duplicate_payment_reference',
      'message', 'This payment reference has already been used.'
    );
  END IF;

  -- Keep the unique index as the final backstop. Translate its rare race into the
  -- same structured response instead of leaking a raw PostgreSQL 409 to the client.
  BEGIN
    INSERT INTO public.transactions (
      listing_id, buyer_id, seller_id, amount, status, paystack_ref
    )
    VALUES (
      v_listing.id, v_buyer, v_listing.seller_id, v_listing.price, 'pending', p_paystack_ref
    )
    RETURNING * INTO v_tx;
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constraint_name = CONSTRAINT_NAME;

    IF v_constraint_name = 'transactions_one_active_per_listing' THEN
      SELECT t.id
        INTO v_existing_tx
        FROM public.transactions t
       WHERE t.listing_id = p_listing_id
         AND t.status IN ('pending', 'locked', 'meetup_initiated', 'release_requested', 'disputed')
       ORDER BY t.created_at DESC
       LIMIT 1;

      RETURN jsonb_build_object(
        'success', false,
        'code', 'active_transaction_exists',
        'transaction_id', v_existing_tx,
        'message', 'This listing already has an active purchase.'
      );
    ELSIF v_constraint_name = 'transactions_paystack_ref_key' THEN
      RETURN jsonb_build_object(
        'success', false,
        'code', 'duplicate_payment_reference',
        'message', 'This payment reference has already been used.'
      );
    ELSE
      RAISE;
    END IF;
  END;

  RETURN jsonb_build_object(
    'success', true,
    'id', v_tx.id,
    'listing_id', v_tx.listing_id,
    'buyer_id', v_tx.buyer_id,
    'seller_id', v_tx.seller_id,
    'amount', v_tx.amount,
    'status', v_tx.status,
    'paystack_ref', v_tx.paystack_ref
  );
END;
$$;

-- A refund releases the listing for resale. Explicitly require an authenticated
-- participant; SQL NULL comparisons alone are not an authorization check.
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
     WHERE l.id = v_hold.transaction_id::text::uuid -- replaced below with listing lookup
       AND l.status = 'sold';
  ELSE
    RAISE EXCEPTION 'Invalid wallet escrow action';
  END IF;

  RETURN jsonb_build_object('success', true, 'status', p_action);
END;
$$;

-- Replace the placeholder listing update with the transaction's actual listing ID and
-- only reopen when no other live purchase remains. (Kept separate to avoid trusting
-- client-supplied listing identifiers.)
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
BEGIN
  SELECT h.*, t.listing_id
    INTO v_hold, v_listing_id
    FROM public.wallet_escrow_holds h
    JOIN public.transactions t ON t.id = h.transaction_id
   WHERE h.transaction_id = p_transaction_id
   FOR UPDATE OF h, t;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Wallet escrow not found';
  END IF;

  IF v_user IS NULL OR (v_user <> v_hold.buyer_id AND v_user <> v_hold.seller_id) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  IF v_hold.status <> 'held' THEN
    RAISE EXCEPTION 'Wallet escrow already resolved';
  END IF;

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
       AND l.status = 'sold'
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

GRANT EXECUTE ON FUNCTION public.create_wallet_micro_escrow(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.create_pending_paystack_transaction(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_pending_paystack_transaction(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_wallet_micro_escrow(uuid, text) TO authenticated;
