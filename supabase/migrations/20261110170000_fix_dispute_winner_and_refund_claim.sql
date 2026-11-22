-- high_value is a generated column (amount threshold); do not insert it explicitly.
CREATE OR REPLACE FUNCTION public.open_escrow_dispute_case(
  p_transaction_id uuid,
  p_claimant_id uuid,
  p_reason text,
  p_dispute_campus text,
  p_evidence_messages jsonb DEFAULT '[]'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_tx public.transactions%ROWTYPE;
  v_case public.jury_cases%ROWTYPE;
  v_respondent_id uuid;
BEGIN
  IF COALESCE(auth.jwt() ->> 'role', '') <> 'service_role' THEN
    RAISE EXCEPTION 'Service role required';
  END IF;
  IF p_transaction_id IS NULL OR p_claimant_id IS NULL THEN
    RAISE EXCEPTION 'Transaction and claimant are required';
  END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) < 20 THEN
    RAISE EXCEPTION 'Dispute reason must be at least 20 characters';
  END IF;

  SELECT * INTO v_tx
    FROM public.transactions
   WHERE id = p_transaction_id
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Transaction not found'; END IF;
  IF p_claimant_id <> v_tx.buyer_id AND p_claimant_id <> v_tx.seller_id THEN
    RAISE EXCEPTION 'You are not a party to this transaction';
  END IF;

  SELECT * INTO v_case
    FROM public.jury_cases
   WHERE transaction_id = p_transaction_id;
  IF FOUND THEN
    IF v_case.status IN ('open', 'deliberating', 'appealed', 'escalated') THEN
      IF v_tx.status <> 'disputed' THEN
        IF v_tx.status NOT IN ('release_requested', 'meetup_initiated', 'locked') THEN
          RAISE EXCEPTION 'The transaction was settled before the existing dispute could be restored';
        END IF;
        PERFORM set_config('app.escrow_transition', 'true', true);
        UPDATE public.transactions
           SET status = 'disputed',
               disputed_at = COALESCE(disputed_at, now()),
               dispute_reason = COALESCE(dispute_reason, v_case.dispute_reason)
         WHERE id = v_tx.id
           AND status = v_tx.status;
        IF NOT FOUND THEN RAISE EXCEPTION 'Transaction state changed while restoring the dispute'; END IF;
      END IF;
      RETURN jsonb_build_object(
        'success', true,
        'case_id', v_case.id,
        'already_open', true,
        'jurors_assigned', COALESCE(v_case.jurors_assigned, '{}'::uuid[]),
        'high_value', COALESCE(v_case.high_value, false),
        'required_votes', v_case.required_votes,
        'dispute_campus', v_case.dispute_campus
      );
    END IF;
    RAISE EXCEPTION 'A dispute case has already been closed for this transaction';
  END IF;

  IF v_tx.status NOT IN ('release_requested', 'meetup_initiated', 'locked') THEN
    RAISE EXCEPTION 'Transaction is not in a disputable state';
  END IF;
  IF v_tx.status = 'release_requested'
     AND v_tx.auto_release_at IS NOT NULL
     AND v_tx.auto_release_at <= now() THEN
    RAISE EXCEPTION 'Dispute window has expired';
  END IF;

  v_respondent_id := CASE
    WHEN p_claimant_id = v_tx.buyer_id THEN v_tx.seller_id
    ELSE v_tx.buyer_id
  END;

  INSERT INTO public.jury_cases (
    transaction_id,
    claimant_id,
    respondent_id,
    dispute_reason,
    dispute_campus,
    evidence_messages,
    amount
  )
  VALUES (
    v_tx.id,
    p_claimant_id,
    v_respondent_id,
    trim(p_reason),
    COALESCE(p_dispute_campus, ''),
    COALESCE(p_evidence_messages, '[]'::jsonb),
    v_tx.amount
  )
  RETURNING * INTO v_case;

  PERFORM set_config('app.escrow_transition', 'true', true);
  UPDATE public.transactions
     SET status = 'disputed',
         disputed_at = now(),
         dispute_reason = trim(p_reason)
   WHERE id = v_tx.id
     AND status = v_tx.status;
  IF NOT FOUND THEN RAISE EXCEPTION 'Transaction state changed while opening the dispute'; END IF;

  INSERT INTO public.audit_logs(user_id, entity_type, entity_id, action, metadata)
  VALUES (
    p_claimant_id,
    'transaction',
    v_tx.id,
    'dispute_opened',
    jsonb_build_object('case_id', v_case.id, 'previous_status', v_tx.status)
  );

  RETURN jsonb_build_object(
    'success', true,
    'case_id', v_case.id,
    'already_open', false,
    'jurors_assigned', COALESCE(v_case.jurors_assigned, '{}'::uuid[]),
    'high_value', COALESCE(v_case.high_value, false),
    'required_votes', v_case.required_votes,
    'dispute_campus', v_case.dispute_campus
  );
END;
$function$;

-- A jury verdict is relative to the case participants, not hard-coded buyer/seller roles.
-- Also validate the Paystack reference as text before attempting an external refund.

CREATE OR REPLACE FUNCTION public.claim_paystack_refund(p_transaction_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_tx public.transactions%ROWTYPE;
BEGIN
  SELECT * INTO v_tx
    FROM public.transactions
   WHERE id = p_transaction_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Transaction % not found', p_transaction_id;
  END IF;

  IF COALESCE(v_tx.payment_method, 'paystack') = 'campus_wallet' THEN
    RAISE EXCEPTION 'Campus Wallet transactions do not use Paystack refunds';
  END IF;
  IF v_tx.status NOT IN ('locked', 'meetup_initiated', 'release_requested', 'disputed') THEN
    RAISE EXCEPTION 'Transaction cannot be refunded from its current state';
  END IF;
  IF v_tx.paystack_ref IS NULL OR length(btrim(v_tx.paystack_ref)) = 0 THEN
    RAISE EXCEPTION 'Paystack reference is missing; refund cannot be initiated safely';
  END IF;

  IF v_tx.refund_status IN ('pending', 'processing', 'processed') THEN
    RETURN jsonb_build_object(
      'claimed', false,
      'status', v_tx.refund_status,
      'refund_id', v_tx.paystack_refund_id
    );
  END IF;

  UPDATE public.transactions
     SET refund_status = 'processing',
         refund_initiated_at = COALESCE(refund_initiated_at, now()),
         refund_failure_reason = NULL,
         updated_at = now()
   WHERE id = p_transaction_id;

  RETURN jsonb_build_object('claimed', true, 'status', 'processing', 'refund_id', NULL);
END;
$function$;

REVOKE ALL ON FUNCTION public.claim_paystack_refund(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_paystack_refund(uuid) TO service_role;

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
  v_winner_id uuid;
  v_buyer_won boolean;
  v_reason text;
  v_payout_status text;
BEGIN
  IF p_admin_override THEN
    IF NOT public.is_platform_admin() THEN
      RAISE EXCEPTION 'Only platform admins can override dispute resolution';
    END IF;
  ELSIF COALESCE(auth.jwt()->>'role', '') <> 'service_role' THEN
    RAISE EXCEPTION 'Only service_role can execute resolve_dispute_verdict';
  END IF;

  IF p_verdict IS NULL OR p_verdict NOT IN ('claimant', 'respondent') THEN
    RAISE EXCEPTION 'Invalid verdict %. Must be claimant or respondent', p_verdict;
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

  v_winner_id := CASE
    WHEN p_verdict = 'claimant' THEN v_case.claimant_id
    ELSE v_case.respondent_id
  END;
  IF v_winner_id IS NULL OR v_winner_id NOT IN (v_tx.buyer_id, v_tx.seller_id) THEN
    RAISE EXCEPTION 'Dispute winner is not a participant in the transaction';
  END IF;
  v_buyer_won := v_winner_id = v_tx.buyer_id;
  v_reason := CASE
    WHEN v_buyer_won THEN 'Dispute refund: settled in favour of buyer'
    ELSE 'Dispute settlement: released to seller'
  END;

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

  IF v_buyer_won
     AND COALESCE(v_tx.payment_method, 'paystack') <> 'campus_wallet'
     AND COALESCE(v_tx.refund_status, '') NOT IN ('pending', 'processing', 'processed') THEN
    RAISE EXCEPTION 'External Paystack refund must be initiated before dispute refund settlement';
  END IF;

  PERFORM set_config('app.escrow_transition', 'true', true);

  IF v_buyer_won THEN
    -- Paystack refunds are handled by Paystack. Only Campus Wallet returns
    -- value through the internal ledger.
    IF COALESCE(v_tx.payment_method, 'paystack') = 'campus_wallet' THEN
      INSERT INTO public.plug_credit_ledger(user_id, amount, reason, reference_id)
      VALUES (v_tx.buyer_id, v_tx.amount, v_reason, v_tx.id);

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
           updated_at = now(),
           payout_status = 'not_applicable',
           payout_failure_reason = NULL
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
    v_payout_status := 'not_applicable';
  ELSE
    -- Campus Wallet seller proceeds move from the hold to PlugCredit.
    -- Paystack proceeds are approved for the external settlement pipeline.
    IF COALESCE(v_tx.payment_method, 'paystack') = 'campus_wallet' THEN
      INSERT INTO public.plug_credit_ledger(user_id, amount, reason, reference_id)
      VALUES (v_tx.seller_id, v_tx.amount, v_reason, v_tx.id);

      UPDATE public.wallet_escrow_holds
         SET status = 'released',
             resolved_at = now()
       WHERE id = v_hold.id AND status = 'held';
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Campus Wallet hold changed during dispute release';
      END IF;
      v_payout_status := 'paid';
    ELSE
      v_payout_status := 'approved_for_settlement';
    END IF;

    UPDATE public.transactions
       SET status = 'released',
           released_at = now(),
           completed_at = now(),
           updated_at = now(),
           payout_status = v_payout_status,
           payout_failure_reason = NULL
     WHERE id = v_tx.id;
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
    COALESCE(auth.uid(), v_winner_id),
    'dispute_resolved',
    jsonb_build_object(
      'verdict', p_verdict,
      'winner_id', v_winner_id,
      'winner_role', CASE WHEN v_buyer_won THEN 'buyer' ELSE 'seller' END,
      'transaction_id', v_tx.id,
      'amount', v_tx.amount,
      'recipient', v_winner_id,
      'payment_method', COALESCE(v_tx.payment_method, 'paystack'),
      'refund_status', v_tx.refund_status,
      'payout_status', v_payout_status
    )
  );

  RETURN jsonb_build_object(
    'success', true,
    'case_id', v_case.id,
    'transaction_id', v_tx.id,
    'verdict', p_verdict,
    'winner_id', v_winner_id,
    'winner_role', CASE WHEN v_buyer_won THEN 'buyer' ELSE 'seller' END,
    'recipient', v_winner_id,
    'amount', v_tx.amount,
    'payment_method', COALESCE(v_tx.payment_method, 'paystack'),
    'payout_status', v_payout_status
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.resolve_dispute_verdict(uuid, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_dispute_verdict(uuid, text, boolean) TO service_role;
