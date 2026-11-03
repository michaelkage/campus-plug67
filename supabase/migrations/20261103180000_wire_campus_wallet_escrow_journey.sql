-- Restore the trusted escrow-transition context in the strict transaction guard.
-- The parallel client-update guard already honors this transaction-local marker;
-- the stricter guard must do the same or every authenticated escrow RPC is blocked.
CREATE OR REPLACE FUNCTION public.guard_transaction_sensitive_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.role() = 'service_role'
     OR current_setting('app.escrow_transition', true) = 'true' THEN
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.buyer_id IS DISTINCT FROM OLD.buyer_id
     OR NEW.seller_id IS DISTINCT FROM OLD.seller_id
     OR NEW.listing_id IS DISTINCT FROM OLD.listing_id
     OR NEW.amount IS DISTINCT FROM OLD.amount
     OR NEW.status IS DISTINCT FROM OLD.status
     OR NEW.qr_secret IS DISTINCT FROM OLD.qr_secret
     OR NEW.release_code IS DISTINCT FROM OLD.release_code
     OR NEW.paystack_ref IS DISTINCT FROM OLD.paystack_ref
     OR NEW.payment_verified IS DISTINCT FROM OLD.payment_verified
     OR NEW.escrow_status IS DISTINCT FROM OLD.escrow_status
     OR NEW.locked_at IS DISTINCT FROM OLD.locked_at
     OR NEW.released_at IS DISTINCT FROM OLD.released_at
     OR NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at
     OR NEW.completed_at IS DISTINCT FROM OLD.completed_at
     OR NEW.release_requested_at IS DISTINCT FROM OLD.release_requested_at
     OR NEW.auto_release_at IS DISTINCT FROM OLD.auto_release_at
     OR NEW.disputed_at IS DISTINCT FROM OLD.disputed_at
     OR NEW.dispute_reason IS DISTINCT FROM OLD.dispute_reason
  THEN
    RAISE EXCEPTION 'Protected transaction fields are server-managed';
  END IF;

  RETURN NEW;
END;
$$;

-- Add the missing seller-starts-meetup transition and require the QR secret,
-- fresh buyer GPS authorization, and the server-enforced 24-hour gate at release.
DROP FUNCTION IF EXISTS public.resolve_wallet_micro_escrow(uuid, text);

CREATE FUNCTION public.resolve_wallet_micro_escrow(
  p_transaction_id uuid,
  p_action text,
  p_qr_secret text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_hold public.wallet_escrow_holds%ROWTYPE;
  v_user uuid := auth.uid();
  v_tx public.transactions%ROWTYPE;
  v_listing_id uuid;
  v_rows integer;
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

  SELECT *
    INTO v_tx
    FROM public.transactions
   WHERE id = v_hold.transaction_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Wallet escrow transaction not found';
  END IF;
  IF COALESCE(v_tx.payment_method, '') <> 'campus_wallet' THEN
    RAISE EXCEPTION 'Wallet escrow transaction payment method mismatch';
  END IF;
  IF v_tx.buyer_id <> v_hold.buyer_id
     OR v_tx.seller_id <> v_hold.seller_id
     OR v_tx.amount <> v_hold.amount_kobo THEN
    RAISE EXCEPTION 'Wallet escrow participant or amount mismatch';
  END IF;

  v_listing_id := v_tx.listing_id;

  IF p_action = 'initiate_meetup' THEN
    IF v_user <> v_hold.seller_id THEN
      RAISE EXCEPTION 'Only the seller can initiate the wallet meetup';
    END IF;
    IF v_tx.status <> 'locked' THEN
      RAISE EXCEPTION 'Wallet meetup can only start from locked state';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.listings
       WHERE id = v_listing_id AND status = 'reserved'
    ) THEN
      RAISE EXCEPTION 'Wallet escrow listing is not reserved';
    END IF;

    PERFORM set_config('app.escrow_transition', 'true', true);
    UPDATE public.transactions
       SET status = 'meetup_initiated',
           meetup_initiated_at = COALESCE(meetup_initiated_at, now())
     WHERE id = v_tx.id;

  ELSIF p_action = 'release' THEN
    IF v_user <> v_hold.buyer_id THEN
      RAISE EXCEPTION 'Only the buyer can release Campus Wallet escrow';
    END IF;
    IF v_tx.status <> 'meetup_initiated' THEN
      RAISE EXCEPTION 'Wallet escrow is not ready for buyer confirmation';
    END IF;
    IF v_tx.meetup_initiated_at IS NULL
       OR v_tx.meetup_initiated_at > now() - interval '24 hours' THEN
      RAISE EXCEPTION '24-hour release gate has not elapsed';
    END IF;
    IF v_tx.buyer_arrived IS DISTINCT FROM true
       OR v_tx.buyer_safe_zone_id IS NULL
       OR v_tx.mobile_release_ready_at IS NULL
       OR v_tx.mobile_release_ready_at < now() - interval '10 minutes' THEN
      RAISE EXCEPTION 'Fresh buyer Safe Swap Zone verification is required';
    END IF;
    IF p_qr_secret IS NULL
       OR COALESCE(v_tx.qr_secret, v_tx.release_code) IS NULL
       OR p_qr_secret IS DISTINCT FROM COALESCE(v_tx.qr_secret, v_tx.release_code) THEN
      RAISE EXCEPTION 'Invalid release credential';
    END IF;

    PERFORM set_config('app.escrow_transition', 'true', true);

    INSERT INTO public.plug_credit_ledger(user_id, amount, reason, reference_id)
    VALUES (
      v_hold.seller_id,
      v_hold.amount_kobo,
      'Campus Wallet micro-escrow release',
      v_hold.transaction_id
    );

    UPDATE public.wallet_escrow_holds
       SET status = 'released', resolved_at = now()
     WHERE id = v_hold.id AND status = 'held';

    UPDATE public.transactions
       SET status = 'released',
           released_at = now(),
           completed_at = now(),
           payout_status = 'paid'
     WHERE id = v_hold.transaction_id;

    UPDATE public.listings
       SET status = 'sold', updated_at = now()
     WHERE id = v_listing_id AND status = 'reserved';
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'Wallet escrow listing is not reserved';
    END IF;

  ELSIF p_action = 'refund' THEN
    IF v_user <> v_hold.buyer_id THEN
      RAISE EXCEPTION 'Only the buyer can request a wallet refund';
    END IF;
    IF v_tx.status <> 'locked' THEN
      RAISE EXCEPTION 'Wallet refund is only available before meetup initiation';
    END IF;

    PERFORM set_config('app.escrow_transition', 'true', true);

    INSERT INTO public.plug_credit_ledger(user_id, amount, reason, reference_id)
    VALUES (
      v_hold.buyer_id,
      v_hold.amount_kobo,
      'Campus Wallet micro-escrow refund',
      v_hold.transaction_id
    );

    UPDATE public.wallet_escrow_holds
       SET status = 'refunded', resolved_at = now()
     WHERE id = v_hold.id AND status = 'held';

    UPDATE public.transactions
       SET status = 'cancelled',
           payout_status = 'not_applicable'
     WHERE id = v_hold.transaction_id;

    UPDATE public.listings AS l
       SET status = 'active', updated_at = now()
     WHERE l.id = v_listing_id
       AND l.status = 'reserved'
       AND NOT EXISTS (
         SELECT 1
           FROM public.transactions AS other
          WHERE other.listing_id = l.id
            AND other.id <> v_tx.id
            AND other.status IN ('pending', 'locked', 'meetup_initiated', 'release_requested', 'disputed')
       );
  ELSE
    RAISE EXCEPTION 'Invalid wallet escrow action';
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'status', CASE WHEN p_action = 'initiate_meetup' THEN 'meetup_initiated' ELSE p_action END,
    'transaction_id', v_tx.id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_wallet_micro_escrow(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_wallet_micro_escrow(uuid, text, text) TO authenticated;

-- The service-role-only refund RPC is called only after the admin Edge Function
-- validates app_metadata.role. It keeps the wallet ledger and hold atomic.
CREATE OR REPLACE FUNCTION public.admin_refund_wallet_micro_escrow(p_transaction_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_hold public.wallet_escrow_holds%ROWTYPE;
  v_tx public.transactions%ROWTYPE;
  v_rows integer;
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'Service role required';
  END IF;

  SELECT *
    INTO v_hold
    FROM public.wallet_escrow_holds
   WHERE transaction_id = p_transaction_id
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Wallet escrow not found'; END IF;

  SELECT *
    INTO v_tx
    FROM public.transactions
   WHERE id = p_transaction_id
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Wallet escrow transaction not found'; END IF;

  IF COALESCE(v_tx.payment_method, '') <> 'campus_wallet'
     OR v_hold.buyer_id <> v_tx.buyer_id
     OR v_hold.seller_id <> v_tx.seller_id
     OR v_hold.amount_kobo <> v_tx.amount THEN
    RAISE EXCEPTION 'Wallet escrow integrity check failed';
  END IF;
  IF v_hold.status <> 'held'
     OR v_tx.status NOT IN ('locked', 'meetup_initiated', 'release_requested', 'disputed') THEN
    RAISE EXCEPTION 'Wallet escrow is not eligible for administrative refund';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM public.plug_credit_ledger AS p
     WHERE p.reference_id = v_tx.id
       AND p.user_id = v_tx.buyer_id
       AND p.amount = -v_tx.amount
       AND p.reason = 'Campus Wallet escrow hold'
  ) THEN
    RAISE EXCEPTION 'Original wallet debit could not be verified';
  END IF;

  INSERT INTO public.plug_credit_ledger(user_id, amount, reason, reference_id)
  VALUES (
    v_hold.buyer_id,
    v_hold.amount_kobo,
    'Campus Wallet micro-escrow refund',
    v_tx.id
  );

  PERFORM set_config('app.escrow_transition', 'true', true);
  UPDATE public.transactions
     SET status = 'cancelled',
         payout_status = 'not_applicable'
   WHERE id = v_tx.id;

  UPDATE public.wallet_escrow_holds
     SET status = 'refunded', resolved_at = COALESCE(resolved_at, now())
   WHERE id = v_hold.id AND status = 'held';

  UPDATE public.listings AS l
     SET status = 'active', updated_at = now()
   WHERE l.id = v_tx.listing_id
     AND l.status = 'reserved'
     AND NOT EXISTS (
       SELECT 1
         FROM public.transactions AS other
        WHERE other.listing_id = l.id
          AND other.id <> v_tx.id
          AND other.status IN ('pending', 'locked', 'meetup_initiated', 'release_requested', 'disputed')
     );

  RETURN jsonb_build_object('success', true, 'status', 'refunded', 'transaction_id', v_tx.id);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_refund_wallet_micro_escrow(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_refund_wallet_micro_escrow(uuid) TO service_role;

-- Safe arrival is only valid after a seller has actually initiated the meetup.
CREATE OR REPLACE FUNCTION public.record_safe_arrival_v2(
  p_transaction_id uuid,
  p_role text,
  p_lat numeric,
  p_lng numeric,
  p_user_id uuid,
  p_device_type text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  tx public.transactions%ROWTYPE;
  uni text;
  z record;
BEGIN
  IF p_device_type <> 'mobile' THEN
    RETURN jsonb_build_object('success', false, 'code', 'MOBILE_REQUIRED',
      'message', 'Meetup release must be completed on a phone with GPS.');
  END IF;
  IF p_user_id IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_role NOT IN ('buyer', 'seller') THEN RAISE EXCEPTION 'Invalid arrival role'; END IF;
  IF p_lat IS NULL OR p_lng IS NULL OR p_lat NOT BETWEEN -90 AND 90 OR p_lng NOT BETWEEN -180 AND 180 THEN
    RAISE EXCEPTION 'Invalid coordinates';
  END IF;

  SELECT * INTO tx
    FROM public.transactions
   WHERE id = p_transaction_id
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Transaction not found'; END IF;
  IF (p_role = 'buyer' AND tx.buyer_id <> p_user_id)
     OR (p_role = 'seller' AND tx.seller_id <> p_user_id) THEN
    RAISE EXCEPTION 'Not authorized for this transaction';
  END IF;
  IF tx.status NOT IN ('meetup_initiated', 'release_requested') THEN
    RAISE EXCEPTION 'Seller must initiate the meetup before arrival can be verified';
  END IF;

  SELECT university INTO uni FROM public.profiles WHERE id = p_user_id;
  IF uni IS NULL THEN RAISE EXCEPTION 'University is required for safe-zone validation'; END IF;
  SELECT * INTO z FROM public.is_in_safe_swap_zone(p_lat, p_lng, uni) LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'within_safe_zone', false,
      'message', 'Outside an approved 50m Safe Swap Zone');
  END IF;

  IF p_role = 'buyer' THEN
    UPDATE public.transactions
       SET buyer_arrived = true,
           buyer_arrival_time = now(),
           buyer_lat = p_lat,
           buyer_lng = p_lng,
           buyer_location_captured_at = now(),
           buyer_safe_zone_id = z.zone_id,
           mobile_release_ready_at = now()
     WHERE id = tx.id;
  ELSE
    UPDATE public.transactions
       SET seller_arrived = true,
           seller_arrival_time = now(),
           seller_lat = p_lat,
           seller_lng = p_lng,
           seller_location_captured_at = now(),
           seller_safe_zone_id = z.zone_id
     WHERE id = tx.id;
  END IF;

  RETURN jsonb_build_object('success', true, 'within_safe_zone', true,
    'zone_id', z.zone_id, 'zone_name', z.zone_name, 'distance_m', z.distance_m,
    'device_type', 'mobile');
END;
$$;

REVOKE ALL ON FUNCTION public.record_safe_arrival_v2(uuid, text, numeric, numeric, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_safe_arrival_v2(uuid, text, numeric, numeric, uuid, text) TO service_role;


-- Dispute verdict settlement must support reserved listings and must not use
-- ON CONFLICT inference against unrelated partial ledger indexes.
CREATE OR REPLACE FUNCTION public.resolve_dispute_verdict(
  p_case_id uuid,
  p_verdict text,
  p_admin_override boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_case public.jury_cases%ROWTYPE;
  v_tx public.transactions%ROWTYPE;
  v_recipient uuid;
  v_reason text;
BEGIN
  IF p_admin_override THEN
    IF NOT public.is_platform_admin() THEN
      RAISE EXCEPTION 'Only platform admins can override dispute resolution';
    END IF;
  ELSIF COALESCE(auth.jwt()->>'role', '') <> 'service_role' THEN
    RAISE EXCEPTION 'Only service_role can execute resolve_dispute_verdict';
  END IF;

  SELECT * INTO v_case
    FROM public.jury_cases
   WHERE id = p_case_id
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Jury case % not found', p_case_id; END IF;
  IF v_case.status IN ('closed', 'decided') THEN
    RETURN jsonb_build_object('success', true, 'already_resolved', true);
  END IF;

  SELECT * INTO v_tx
    FROM public.transactions
   WHERE id = v_case.transaction_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Associated transaction % not found', v_case.transaction_id;
  END IF;
  IF v_tx.status <> 'disputed' THEN
    RAISE EXCEPTION 'Transaction must be disputed before verdict settlement';
  END IF;

  IF p_verdict = 'claimant' THEN
    IF COALESCE(v_tx.payment_method, 'paystack') <> 'campus_wallet'
       AND COALESCE(v_tx.refund_status, '') NOT IN ('pending', 'processing', 'processed') THEN
      RAISE EXCEPTION 'External Paystack refund must be initiated before dispute refund settlement';
    END IF;

    v_recipient := v_tx.buyer_id;
    v_reason := 'Dispute refund: settled in favour of buyer';
    PERFORM set_config('app.escrow_transition', 'true', true);

    UPDATE public.transactions
       SET status = 'cancelled',
           cancelled_at = now(),
           updated_at = now()
     WHERE id = v_tx.id;

    UPDATE public.profiles
       SET plug_score = greatest(coalesce(plug_score, 500) - 50, 0)
     WHERE id = v_tx.seller_id;

    UPDATE public.listings AS l
       SET status = 'active', updated_at = now()
     WHERE l.id = v_tx.listing_id
       AND l.status IN ('reserved', 'sold')
       AND NOT EXISTS (
         SELECT 1
           FROM public.transactions AS other
          WHERE other.listing_id = l.id
            AND other.id <> v_tx.id
            AND other.status IN ('pending', 'locked', 'meetup_initiated', 'release_requested', 'disputed')
       );

    IF COALESCE(v_tx.payment_method, 'paystack') = 'campus_wallet' THEN
      INSERT INTO public.plug_credit_ledger(user_id, amount, reason, reference_id)
      VALUES (v_recipient, v_tx.amount, v_reason, v_tx.id);
    END IF;

  ELSIF p_verdict = 'respondent' THEN
    v_recipient := v_tx.seller_id;
    v_reason := 'Dispute settlement: released to seller';
    PERFORM set_config('app.escrow_transition', 'true', true);

    UPDATE public.transactions
       SET status = 'released',
           released_at = now(),
           completed_at = now(),
           updated_at = now()
     WHERE id = v_tx.id;

    INSERT INTO public.plug_credit_ledger(user_id, amount, reason, reference_id)
    VALUES (v_recipient, v_tx.amount, v_reason, v_tx.id);
  ELSE
    RAISE EXCEPTION 'Invalid verdict %. Must be claimant or respondent', p_verdict;
  END IF;

  UPDATE public.jury_cases
     SET status = 'decided',
         verdict = p_verdict,
         verdict_decided_at = now()
   WHERE id = v_case.id;

  INSERT INTO public.audit_logs(entity_type, entity_id, user_id, action, metadata)
  VALUES (
    'jury_case',
    v_case.id,
    COALESCE(auth.uid(), v_tx.seller_id),
    'dispute_resolved',
    jsonb_build_object(
      'verdict', p_verdict,
      'transaction_id', v_tx.id,
      'amount', v_tx.amount,
      'recipient', v_recipient,
      'refund_status', v_tx.refund_status
    )
  );

  RETURN jsonb_build_object(
    'success', true,
    'case_id', v_case.id,
    'transaction_id', v_tx.id,
    'verdict', p_verdict,
    'recipient', v_recipient,
    'amount', v_tx.amount
  );
END;
$$;
