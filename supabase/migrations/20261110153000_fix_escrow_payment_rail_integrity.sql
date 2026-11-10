-- Keep each payment rail on one settlement path.
-- Paystack money is settled through the external payout/refund lifecycle; only
-- Campus Wallet transactions may write the PlugCredit ledger during escrow
-- settlement. QR inspection expiry is owned by the dedicated inspection worker.

CREATE OR REPLACE FUNCTION public.process_escrow_action(
  p_transaction_id uuid,
  p_action text,
  p_qr_secret text DEFAULT NULL,
  p_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  tx public.transactions%ROWTYPE;
  actor uuid := auth.uid();
  privileged boolean := COALESCE(auth.jwt() ->> 'role', '') = 'service_role';
BEGIN
  IF actor IS NULL AND NOT privileged THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  SELECT * INTO tx
    FROM public.transactions
   WHERE id = p_transaction_id
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Transaction not found'; END IF;

  IF COALESCE(tx.payment_method, 'paystack') = 'campus_wallet' THEN
    RAISE EXCEPTION 'Campus Wallet escrow must be resolved through resolve_wallet_micro_escrow';
  END IF;
  IF NOT privileged AND actor <> tx.buyer_id AND actor <> tx.seller_id THEN
    RAISE EXCEPTION 'Not authorized for this transaction';
  END IF;

  PERFORM set_config('app.escrow_transition', 'true', true);

  CASE p_action
    WHEN 'initiate_meetup' THEN
      IF privileged OR actor <> tx.seller_id THEN
        RAISE EXCEPTION 'Only the seller can initiate the meetup';
      END IF;
      IF tx.status <> 'locked' THEN
        RAISE EXCEPTION 'Meetup can only start from locked state';
      END IF;
      UPDATE public.transactions
         SET status = 'meetup_initiated',
             meetup_initiated_at = COALESCE(meetup_initiated_at, now())
       WHERE id = tx.id;

    WHEN 'request_release' THEN
      IF privileged OR actor <> tx.seller_id THEN
        RAISE EXCEPTION 'Only the seller can request release';
      END IF;
      IF tx.status <> 'meetup_initiated' THEN
        RAISE EXCEPTION 'Release can only be requested after meetup initiation';
      END IF;
      IF tx.meetup_initiated_at IS NULL
         OR tx.meetup_initiated_at > now() - interval '24 hours' THEN
        RAISE EXCEPTION '24-hour release gate has not elapsed';
      END IF;
      UPDATE public.transactions
         SET status = 'release_requested',
             release_requested_at = COALESCE(release_requested_at, now()),
             auto_release_at = now() + interval '48 hours',
             handshake_receipt_buffer = NULL
       WHERE id = tx.id;

    WHEN 'release' THEN
      IF privileged OR actor <> tx.buyer_id THEN
        RAISE EXCEPTION 'Only the buyer can confirm handoff';
      END IF;
      IF tx.status = 'release_requested'
         AND tx.handshake_receipt_buffer IS NOT NULL THEN
        RETURN jsonb_build_object(
          'success', true,
          'transaction_id', tx.id,
          'action', p_action,
          'status', 'inspection_pending',
          'inspection_expires_at', tx.auto_release_at,
          'funds_released', false,
          'message', 'Handoff already confirmed. Funds remain protected for the two-hour inspection window.',
          'already_confirmed', true
        );
      END IF;
      IF tx.status <> 'meetup_initiated' THEN
        RAISE EXCEPTION 'Escrow is not ready for buyer handoff confirmation';
      END IF;
      IF tx.buyer_arrived IS DISTINCT FROM true
         OR tx.buyer_safe_zone_id IS NULL
         OR tx.mobile_release_ready_at IS NULL
         OR tx.mobile_release_ready_at < now() - interval '10 minutes' THEN
        RAISE EXCEPTION 'Fresh buyer Safe Swap Zone verification is required';
      END IF;
      IF tx.seller_arrived IS DISTINCT FROM true
         OR tx.seller_safe_zone_id IS NULL
         OR tx.seller_safe_zone_id IS DISTINCT FROM tx.buyer_safe_zone_id
         OR tx.seller_location_captured_at IS NULL
         OR tx.seller_location_captured_at < now() - interval '30 minutes' THEN
        RAISE EXCEPTION 'Seller must verify arrival in the same Safe Swap Zone within 30 minutes';
      END IF;
      IF p_qr_secret IS NULL
         OR p_qr_secret IS DISTINCT FROM COALESCE(tx.qr_secret, tx.release_code) THEN
        RAISE EXCEPTION 'Invalid release credential';
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM public.listings
         WHERE id = tx.listing_id AND status = 'reserved'
      ) THEN
        RAISE EXCEPTION 'Escrow listing is not reserved';
      END IF;

      UPDATE public.transactions
         SET status = 'release_requested',
             release_requested_at = now(),
             auto_release_at = now() + interval '2 hours',
             handshake_receipt_buffer = now()
       WHERE id = tx.id;

    WHEN 'dispute' THEN
      RAISE EXCEPTION 'Use process-dispute to open a jury case and freeze escrow atomically';

    WHEN 'refund' THEN
      IF NOT privileged THEN
        RAISE EXCEPTION 'Refund is an administrative action';
      END IF;
      IF tx.status NOT IN ('locked', 'meetup_initiated', 'release_requested', 'disputed') THEN
        RAISE EXCEPTION 'Transaction cannot be refunded';
      END IF;
      IF COALESCE(tx.refund_status, '') NOT IN ('pending', 'processing', 'processed') THEN
        RAISE EXCEPTION 'A confirmed Paystack refund request is required before escrow cancellation';
      END IF;

      -- The provider refund is the buyer's financial credit. Do not also issue
      -- a PlugCredit ledger credit for an externally funded Paystack purchase.
      UPDATE public.transactions
         SET status = 'cancelled',
             cancelled_at = now(),
             updated_at = now()
       WHERE id = tx.id;
      UPDATE public.listings
         SET status = 'active', updated_at = now()
       WHERE id = tx.listing_id AND status = 'sold';

    WHEN 'auto_release' THEN
      IF NOT privileged THEN
        RAISE EXCEPTION 'Auto-release is service-only';
      END IF;
      IF tx.status <> 'release_requested'
         OR tx.auto_release_at IS NULL
         OR tx.auto_release_at > now()
         OR tx.handshake_receipt_buffer IS NOT NULL
         OR COALESCE(tx.refund_status, '') IN ('pending', 'processing', 'processed', 'needs-attention', 'needs_attention') THEN
        RAISE EXCEPTION 'Transaction is not eligible for legacy auto-release';
      END IF;

      -- Paystack seller settlement is approved by the transaction trigger.
      -- Never credit the internal wallet from this external-payment path.
      UPDATE public.transactions
         SET status = 'released',
             released_at = now(),
             completed_at = now()
       WHERE id = tx.id;

    ELSE
      RAISE EXCEPTION 'Invalid escrow action: %', p_action;
  END CASE;

  INSERT INTO public.audit_logs(user_id, entity_type, entity_id, action, metadata)
  VALUES (
    COALESCE(actor, tx.seller_id),
    'transaction',
    tx.id,
    'escrow_' || p_action,
    jsonb_build_object(
      'previous_status', tx.status,
      'inspection_started', p_action = 'release',
      'inspection_expires_at', CASE WHEN p_action = 'release' THEN now() + interval '2 hours' ELSE NULL END,
      'payment_method', COALESCE(tx.payment_method, 'paystack')
    )
  );

  RETURN jsonb_build_object(
    'success', true,
    'transaction_id', tx.id,
    'action', p_action,
    'status', CASE WHEN p_action = 'release' THEN 'inspection_pending' ELSE p_action END,
    'escrow_resolved', p_action = 'auto_release',
    'funds_released', false,
    'message', CASE
      WHEN p_action = 'release' THEN 'Handoff confirmed. Funds remain protected for a two-hour inspection window.'
      WHEN p_action = 'auto_release' THEN 'Escrow resolved. Seller payout still requires settlement confirmation.'
      ELSE 'Escrow action completed.'
    END
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.settle_due_paystack_inspections(p_limit integer DEFAULT 100)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_candidate record;
  v_tx public.transactions%ROWTYPE;
  v_processed integer := 0;
  v_skipped integer := 0;
  v_error text;
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500);
BEGIN
  IF current_user <> 'postgres'
     AND COALESCE(auth.jwt() ->> 'role', '') <> 'service_role' THEN
    RAISE EXCEPTION 'Service role required';
  END IF;

  FOR v_candidate IN
    SELECT t.id
      FROM public.transactions t
     WHERE t.status = 'release_requested'
       AND t.handshake_receipt_buffer IS NOT NULL
       AND t.auto_release_at IS NOT NULL
       AND t.auto_release_at <= now()
       AND COALESCE(t.payment_method, 'paystack') <> 'campus_wallet'
       AND COALESCE(t.refund_status, '') NOT IN ('pending', 'processing', 'processed', 'needs-attention', 'needs_attention')
     ORDER BY t.auto_release_at, t.id
     FOR UPDATE OF t SKIP LOCKED
     LIMIT v_limit
  LOOP
    BEGIN
      SELECT * INTO v_tx
        FROM public.transactions
       WHERE id = v_candidate.id
       FOR UPDATE;

      IF NOT FOUND
         OR v_tx.status <> 'release_requested'
         OR v_tx.handshake_receipt_buffer IS NULL
         OR v_tx.auto_release_at IS NULL
         OR v_tx.auto_release_at > now()
         OR COALESCE(v_tx.payment_method, 'paystack') = 'campus_wallet'
         OR COALESCE(v_tx.refund_status, '') IN ('pending', 'processing', 'processed', 'needs-attention', 'needs_attention')
         OR v_tx.amount IS NULL
         OR v_tx.amount <= 0
         OR v_tx.buyer_id IS NULL
         OR v_tx.seller_id IS NULL THEN
        v_skipped := v_skipped + 1;
        CONTINUE;
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM public.listings
         WHERE id = v_tx.listing_id AND status = 'reserved'
      ) THEN
        RAISE EXCEPTION 'Reserved listing could not be verified';
      END IF;

      PERFORM 1 FROM public.profiles
       WHERE id = v_tx.seller_id
       FOR UPDATE;

      PERFORM set_config('app.escrow_transition', 'true', true);
      UPDATE public.transactions
         SET status = 'released',
             released_at = now(),
             completed_at = now()
       WHERE id = v_tx.id
         AND status = 'release_requested'
         AND handshake_receipt_buffer IS NOT NULL;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Transaction state changed during settlement';
      END IF;

      INSERT INTO public.audit_logs(user_id, entity_type, entity_id, action, metadata)
      VALUES (
        v_tx.seller_id,
        'transaction',
        v_tx.id,
        'escrow_auto_release_after_inspection',
        jsonb_build_object(
          'inspection_started_at', v_tx.handshake_receipt_buffer,
          'inspection_expires_at', v_tx.auto_release_at,
          'payment_method', COALESCE(v_tx.payment_method, 'paystack')
        )
      );

      v_processed := v_processed + 1;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_error = MESSAGE_TEXT;
      RAISE WARNING 'Paystack inspection settlement skipped for transaction %: %',
        v_candidate.id, v_error;
      v_skipped := v_skipped + 1;
    END;
  END LOOP;

  RETURN jsonb_build_object('success', true, 'processed', v_processed, 'skipped', v_skipped);
END;
$function$;

CREATE OR REPLACE FUNCTION public.resolve_dispute_verdict(
  p_case_id uuid,
  p_verdict text,
  p_admin_override boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_case public.jury_cases%ROWTYPE;
  v_tx public.transactions%ROWTYPE;
  v_hold public.wallet_escrow_holds%ROWTYPE;
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

  IF COALESCE(v_tx.payment_method, 'paystack') = 'campus_wallet' THEN
    SELECT * INTO v_hold
      FROM public.wallet_escrow_holds
     WHERE transaction_id = v_tx.id
     FOR UPDATE;
    IF NOT FOUND
       OR v_hold.status <> 'held'
       OR v_hold.buyer_id <> v_tx.buyer_id
       OR v_hold.seller_id <> v_tx.seller_id
       OR v_hold.amount_kobo <> v_tx.amount THEN
      RAISE EXCEPTION 'Campus Wallet dispute escrow integrity check failed';
    END IF;
    IF NOT EXISTS (
      SELECT 1
        FROM public.plug_credit_ledger AS debit
       WHERE debit.reference_id = v_tx.id
         AND debit.user_id = v_tx.buyer_id
         AND debit.amount = -v_tx.amount
         AND debit.reason = 'Campus Wallet escrow hold'
    ) THEN
      RAISE EXCEPTION 'Original Campus Wallet debit could not be verified';
    END IF;
  END IF;

  IF p_verdict = 'claimant' THEN
    IF COALESCE(v_tx.payment_method, 'paystack') <> 'campus_wallet'
       AND COALESCE(v_tx.refund_status, '') NOT IN ('pending', 'processing', 'processed') THEN
      RAISE EXCEPTION 'External Paystack refund must be initiated before dispute refund settlement';
    END IF;

    v_recipient := v_tx.buyer_id;
    v_reason := 'Dispute refund: settled in favour of buyer';
    PERFORM set_config('app.escrow_transition', 'true', true);

    -- Resolve the wallet hold before changing transaction status. The
    -- AFTER-status trigger also synchronizes holds, so updating it afterwards
    -- would incorrectly expect the row to remain held.
    IF COALESCE(v_tx.payment_method, 'paystack') = 'campus_wallet' THEN
      INSERT INTO public.plug_credit_ledger(user_id, amount, reason, reference_id)
      VALUES (v_recipient, v_tx.amount, v_reason, v_tx.id);

      UPDATE public.wallet_escrow_holds
         SET status = 'refunded',
             resolved_at = now()
       WHERE id = v_hold.id AND status = 'held';
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Campus Wallet hold changed during dispute refund';
      END IF;
    END IF;

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

  ELSIF p_verdict = 'respondent' THEN
    v_recipient := v_tx.seller_id;
    v_reason := 'Dispute settlement: released to seller';
    PERFORM set_config('app.escrow_transition', 'true', true);

    -- Only Campus Wallet is credited in the internal ledger. Paystack
    -- transactions are moved to approved_for_settlement by the status trigger.
    IF COALESCE(v_tx.payment_method, 'paystack') = 'campus_wallet' THEN
      INSERT INTO public.plug_credit_ledger(user_id, amount, reason, reference_id)
      VALUES (v_recipient, v_tx.amount, v_reason, v_tx.id);

      UPDATE public.wallet_escrow_holds
         SET status = 'released',
             resolved_at = now()
       WHERE id = v_hold.id AND status = 'held';
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Campus Wallet hold changed during dispute release';
      END IF;
    END IF;

    UPDATE public.transactions
       SET status = 'released',
           released_at = now(),
           completed_at = now(),
           updated_at = now()
     WHERE id = v_tx.id;
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
      'payment_method', COALESCE(v_tx.payment_method, 'paystack'),
      'refund_status', v_tx.refund_status
    )
  );

  RETURN jsonb_build_object(
    'success', true,
    'case_id', v_case.id,
    'transaction_id', v_tx.id,
    'verdict', p_verdict,
    'recipient', v_recipient,
    'amount', v_tx.amount,
    'payment_method', COALESCE(v_tx.payment_method, 'paystack'),
    'payout_status', CASE
      WHEN COALESCE(v_tx.payment_method, 'paystack') = 'campus_wallet' THEN 'paid'
      ELSE 'approved_for_settlement'
    END
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.process_escrow_action(uuid, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.process_escrow_action(uuid, text, text, text) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.settle_due_paystack_inspections(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.settle_due_paystack_inspections(integer) TO service_role;

REVOKE ALL ON FUNCTION public.resolve_dispute_verdict(uuid, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_dispute_verdict(uuid, text, boolean) TO service_role;
