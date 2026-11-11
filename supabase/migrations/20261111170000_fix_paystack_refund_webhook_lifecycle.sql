-- Correctly ingest Paystack's asynchronous refund lifecycle.
-- refund.pending intentionally has a NULL refund_reference. Later events are
-- correlated by the original transaction reference and the single active
-- refund for that transaction. This application currently issues full refunds
-- only, and claim_paystack_refund serializes initiation per transaction.

ALTER TABLE public.paystack_refund_records
  ALTER COLUMN refund_reference DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS amount bigint,
  ADD COLUMN IF NOT EXISTS currency text;

ALTER TABLE public.paystack_refund_records
  DROP CONSTRAINT IF EXISTS paystack_refund_records_status_check,
  ADD CONSTRAINT paystack_refund_records_status_check
    CHECK (status IN ('pending','processing','needs-attention','processed','failed','cancelled','needs_attention'));

ALTER TABLE public.paystack_refund_records
  DROP CONSTRAINT IF EXISTS paystack_refund_records_amount_check,
  ADD CONSTRAINT paystack_refund_records_amount_check
    CHECK (amount IS NULL OR amount > 0);

ALTER TABLE public.paystack_refund_records
  DROP CONSTRAINT IF EXISTS paystack_refund_records_currency_check,
  ADD CONSTRAINT paystack_refund_records_currency_check
    CHECK (currency IS NULL OR currency = 'NGN');

DROP FUNCTION IF EXISTS public.record_paystack_refund(text,text,text);

CREATE OR REPLACE FUNCTION public.record_paystack_refund(
  p_transaction_reference text,
  p_refund_reference text,
  p_status text,
  p_amount bigint,
  p_currency text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_tx public.transactions%ROWTYPE;
  v_refund public.paystack_refund_records%ROWTYPE;
  v_status text := replace(lower(trim(COALESCE(p_status, ''))), '_', '-');
  v_reference text := NULLIF(trim(p_refund_reference), '');
  v_found boolean := false;
BEGIN
  IF NULLIF(trim(p_transaction_reference), '') IS NULL THEN
    RAISE EXCEPTION 'Refund transaction reference is required';
  END IF;
  IF v_status NOT IN ('pending','processing','needs-attention','processed','failed','cancelled') THEN
    RAISE EXCEPTION 'Unsupported refund status';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'A positive refund amount is required';
  END IF;
  IF upper(COALESCE(p_currency, '')) <> 'NGN' THEN
    RAISE EXCEPTION 'Unsupported refund currency';
  END IF;

  SELECT * INTO v_tx
    FROM public.transactions
   WHERE paystack_ref = p_transaction_reference
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Refund transaction not found';
  END IF;
  IF COALESCE(v_tx.payment_method, 'paystack') = 'campus_wallet' THEN
    RAISE EXCEPTION 'Campus Wallet transactions cannot receive Paystack refunds';
  END IF;
  IF p_amount <> v_tx.amount THEN
    RAISE EXCEPTION 'Refund amount does not match the full escrow amount';
  END IF;

  -- First correlate by provider refund id. A pending webhook has no id, so
  -- correlate it to the one active refund serialized for this transaction.
  IF v_reference IS NOT NULL THEN
    SELECT * INTO v_refund
      FROM public.paystack_refund_records
     WHERE refund_reference = v_reference
     FOR UPDATE;
    v_found := FOUND;
    IF v_found AND v_refund.transaction_id <> v_tx.id THEN
      RAISE EXCEPTION 'Refund reference is already bound to another transaction';
    END IF;
  END IF;

  IF NOT v_found THEN
    SELECT * INTO v_refund
      FROM public.paystack_refund_records
     WHERE transaction_id = v_tx.id
       AND status IN ('pending','processing','needs-attention','needs_attention')
     ORDER BY created_at DESC
     LIMIT 1
     FOR UPDATE;
    v_found := FOUND;
  END IF;

  IF NOT v_found AND v_reference IS NULL THEN
    -- A delayed pending event must not create a fresh pending row after a
    -- terminal event for the same full-refund transaction was already seen.
    SELECT * INTO v_refund
      FROM public.paystack_refund_records
     WHERE transaction_id = v_tx.id
     ORDER BY created_at DESC
     LIMIT 1
     FOR UPDATE;
    IF FOUND
       AND v_refund.status IN ('processed','failed','cancelled')
       AND (v_tx.refund_initiated_at IS NULL OR v_refund.updated_at >= v_tx.refund_initiated_at) THEN
      RETURN jsonb_build_object(
        'success', true,
        'duplicate_or_stale', true,
        'refund_reference', v_refund.refund_reference,
        'status', v_refund.status
      );
    END IF;
    v_found := false;
  END IF;

  IF NOT v_found THEN
    INSERT INTO public.paystack_refund_records(
      transaction_id, transaction_reference, refund_reference, status, amount, currency,
      processed_at, failure_reason, created_at, updated_at
    ) VALUES (
      v_tx.id, p_transaction_reference, v_reference, v_status, p_amount, upper(p_currency),
      CASE WHEN v_status = 'processed' THEN clock_timestamp() ELSE NULL END,
      CASE WHEN v_status = 'failed' THEN 'Paystack reported refund.failed' ELSE NULL END,
      clock_timestamp(), clock_timestamp()
    )
    RETURNING * INTO v_refund;
  ELSE
    IF v_reference IS NOT NULL
       AND v_refund.refund_reference IS NOT NULL
       AND v_refund.refund_reference <> v_reference THEN
      RAISE EXCEPTION 'Active refund is already bound to a different provider reference';
    END IF;

    -- Provider events can be delivered out of order. Terminal states never
    -- regress, and a delayed pending event cannot downgrade processing.
    IF v_refund.status IN ('processed','failed','cancelled')
       AND v_refund.status <> v_status THEN
      RETURN jsonb_build_object(
        'success', true,
        'duplicate_or_stale', true,
        'refund_reference', v_refund.refund_reference,
        'status', v_refund.status
      );
    END IF;
    IF v_refund.status IN ('processing','needs-attention','needs_attention')
       AND v_status = 'pending' THEN
      RETURN jsonb_build_object(
        'success', true,
        'duplicate_or_stale', true,
        'refund_reference', v_refund.refund_reference,
        'status', v_refund.status
      );
    END IF;

    UPDATE public.paystack_refund_records
       SET refund_reference = COALESCE(refund_reference, v_reference),
           status = v_status,
           amount = p_amount,
           currency = upper(p_currency),
           processed_at = CASE WHEN v_status = 'processed' THEN COALESCE(processed_at, clock_timestamp()) ELSE processed_at END,
           failure_reason = CASE
             WHEN v_status = 'failed' THEN 'Paystack reported refund.failed'
             WHEN v_status = 'needs-attention' THEN 'Paystack requires customer bank details to continue the refund'
             ELSE NULL
           END,
           updated_at = clock_timestamp()
     WHERE id = v_refund.id
     RETURNING * INTO v_refund;
  END IF;

  -- Keep the legacy transaction summary in sync without allowing an unrelated
  -- later refund id to overwrite an already-associated provider refund.
  IF v_tx.paystack_refund_id IS NULL
     OR v_reference IS NULL
     OR v_tx.paystack_refund_id = v_reference
     OR v_tx.paystack_refund_id = v_refund.refund_reference THEN
    UPDATE public.transactions
       SET refund_status = v_refund.status,
           paystack_refund_id = COALESCE(paystack_refund_id, v_refund.refund_reference),
           refund_processed_at = CASE
             WHEN v_refund.status = 'processed' THEN COALESCE(refund_processed_at, clock_timestamp())
             ELSE refund_processed_at
           END,
           refund_failure_reason = CASE
             WHEN v_refund.status = 'failed' THEN 'Paystack reported refund.failed'
             WHEN v_refund.status = 'needs-attention' THEN 'Paystack requires customer bank details to continue the refund'
             ELSE NULL
           END,
           updated_at = clock_timestamp()
     WHERE id = v_tx.id;
  END IF;

  -- Keep the listing unavailable while the refund is pending, processing, or
  -- needs-attention. Only a confirmed provider success may return inventory.
  IF v_refund.status = 'processed' AND v_tx.status = 'cancelled' THEN
    UPDATE public.listings AS listing
       SET status = 'active', updated_at = now()
     WHERE listing.id = v_tx.listing_id
       AND listing.status IN ('reserved', 'sold')
       AND NOT EXISTS (
         SELECT 1
           FROM public.transactions AS other
          WHERE other.listing_id = listing.id
            AND other.id <> v_tx.id
            AND other.status IN ('pending', 'locked', 'meetup_initiated', 'release_requested', 'disputed')
       );
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'refund_reference', v_refund.refund_reference,
    'status', v_refund.status,
    'duplicate_or_stale', false
  );
END;
$$;

REVOKE ALL ON FUNCTION public.record_paystack_refund(text,text,text,bigint,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_paystack_refund(text,text,text,bigint,text) TO service_role;

-- A needs-attention refund is still an outstanding provider operation. Do not
-- allow another refund request to race it; manual provider reconciliation is
-- required before a retry can be authorized.
CREATE OR REPLACE FUNCTION public.claim_paystack_refund(p_transaction_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
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
  IF v_tx.status NOT IN ('locked','meetup_initiated','release_requested','disputed')
     AND NOT (v_tx.status = 'cancelled' AND v_tx.refund_status = 'failed') THEN
    RAISE EXCEPTION 'Transaction cannot be refunded from its current state';
  END IF;
  IF v_tx.paystack_ref IS NULL OR length(trim(v_tx.paystack_ref)) = 0 THEN
    RAISE EXCEPTION 'Paystack reference is missing; refund cannot be initiated safely';
  END IF;
  IF v_tx.refund_status IN ('pending','processing','needs-attention','processed') THEN
    RETURN jsonb_build_object(
      'claimed', false,
      'status', v_tx.refund_status,
      'refund_id', v_tx.paystack_refund_id
    );
  END IF;

  UPDATE public.transactions
     SET refund_status = 'processing',
         refund_initiated_at = clock_timestamp(),
         paystack_refund_id = NULL,
         refund_processed_at = NULL,
         refund_failure_reason = NULL,
         updated_at = now()
   WHERE id = p_transaction_id;

  RETURN jsonb_build_object('claimed', true, 'status', 'processing', 'refund_id', NULL);
END;
$$;

REVOKE ALL ON FUNCTION public.claim_paystack_refund(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_paystack_refund(uuid) TO service_role;


-- A needs-attention refund has been accepted by Paystack but requires customer
-- bank details. It remains a visible outstanding provider refund, while the
-- escrow resolution follows the same pending-refund boundary as processing.
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
      IF tx.status NOT IN ('locked', 'meetup_initiated', 'release_requested', 'disputed')
         AND NOT (tx.status = 'cancelled' AND tx.refund_status IN ('pending', 'processing', 'needs-attention', 'processed')) THEN
        RAISE EXCEPTION 'Transaction cannot be refunded';
      END IF;
      IF COALESCE(tx.refund_status, '') NOT IN ('pending', 'processing', 'needs-attention', 'processed') THEN
        RAISE EXCEPTION 'A confirmed Paystack refund request is required before escrow cancellation';
      END IF;

      -- The provider refund is the buyer's financial credit. Do not also issue
      -- a PlugCredit ledger credit for an externally funded Paystack purchase.
      UPDATE public.transactions
         SET status = 'cancelled',
             cancelled_at = now(),
             updated_at = now()
       WHERE id = tx.id;
      IF tx.refund_status = 'processed' THEN
        UPDATE public.listings AS listing
           SET status = 'active', updated_at = now()
         WHERE listing.id = tx.listing_id
           AND listing.status IN ('reserved', 'sold')
           AND NOT EXISTS (
             SELECT 1
               FROM public.transactions AS other
              WHERE other.listing_id = listing.id
                AND other.id <> tx.id
                AND other.status IN ('pending', 'locked', 'meetup_initiated', 'release_requested', 'disputed')
           );
      END IF;

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

      -- The status trigger approves the Paystack payout for the existing
      -- external settlement pipeline. Do not credit PlugCredit here.
      UPDATE public.transactions
         SET status = 'released',
             released_at = now(),
             completed_at = now(),
             payout_failure_reason = NULL
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
    'seller_wallet_credited', false,
    'funds_released', false,
    'message', CASE
      WHEN p_action = 'release' THEN 'Handoff confirmed. Funds remain protected for a two-hour inspection window.'
      WHEN p_action = 'auto_release' THEN 'Escrow resolved. Seller payout is approved for external settlement.'
      ELSE 'Escrow action completed.'
    END
  );
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
       AND COALESCE(v_tx.refund_status, '') NOT IN ('pending', 'processing', 'needs-attention', 'processed') THEN
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

    IF v_tx.refund_status = 'processed' THEN
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
    END IF;

  ELSIF p_verdict = 'respondent' THEN
    v_recipient := v_tx.seller_id;
    v_reason := 'Dispute settlement: released to seller';
    PERFORM set_config('app.escrow_transition', 'true', true);

    -- Campus Wallet releases an already-held balance into seller PlugCredit.
    -- Paystack proceeds remain on the external payout pipeline.
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
