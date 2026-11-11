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
    IF FOUND AND v_refund.status IN ('processed','failed','cancelled') THEN
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
      processed_at, failure_reason
    ) VALUES (
      v_tx.id, p_transaction_reference, v_reference, v_status, p_amount, upper(p_currency),
      CASE WHEN v_status = 'processed' THEN now() ELSE NULL END,
      CASE WHEN v_status = 'failed' THEN 'Paystack reported refund.failed' ELSE NULL END
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
           processed_at = CASE WHEN v_status = 'processed' THEN COALESCE(processed_at, now()) ELSE processed_at END,
           failure_reason = CASE
             WHEN v_status = 'failed' THEN 'Paystack reported refund.failed'
             WHEN v_status = 'needs-attention' THEN 'Paystack requires customer bank details to continue the refund'
             ELSE NULL
           END,
           updated_at = now()
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
             WHEN v_refund.status = 'processed' THEN COALESCE(refund_processed_at, now())
             ELSE refund_processed_at
           END,
           refund_failure_reason = CASE
             WHEN v_refund.status = 'failed' THEN 'Paystack reported refund.failed'
             WHEN v_refund.status = 'needs-attention' THEN 'Paystack requires customer bank details to continue the refund'
             ELSE NULL
           END,
           updated_at = now()
     WHERE id = v_tx.id;
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
  IF v_tx.status NOT IN ('locked','meetup_initiated','release_requested','disputed') THEN
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
         refund_initiated_at = COALESCE(refund_initiated_at, now()),
         refund_failure_reason = NULL,
         updated_at = now()
   WHERE id = p_transaction_id;

  RETURN jsonb_build_object('claimed', true, 'status', 'processing', 'refund_id', NULL);
END;
$$;

REVOKE ALL ON FUNCTION public.claim_paystack_refund(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_paystack_refund(uuid) TO service_role;
