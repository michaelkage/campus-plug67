-- Prevent new refund initiation while a seller bank transfer is ambiguous.
-- Preserve the persisted request-reference idempotency contract from
-- 20261112100000_paystack_refund_idempotency_recovery.sql. The transaction
-- row lock serializes this claim against claim_seller_payout_transfers.

CREATE OR REPLACE FUNCTION public.claim_paystack_refund(p_transaction_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_tx public.transactions%ROWTYPE;
  v_reference text;
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
     AND NOT (
       v_tx.status = 'cancelled'
       AND v_tx.refund_status IN ('failed','pending','processing','needs-attention','processed')
     ) THEN
    RAISE EXCEPTION 'Transaction cannot be refunded from its current state';
  END IF;
  IF v_tx.paystack_ref IS NULL OR length(trim(v_tx.paystack_ref)) = 0 THEN
    RAISE EXCEPTION 'Paystack reference is missing; refund cannot be initiated safely';
  END IF;

  -- An existing refund claim remains safely replayable. Only a new claim
  -- is blocked while an external payout is ambiguous or awaiting review.
  IF v_tx.payout_status IN ('processing','needs_attention') THEN
    RAISE EXCEPTION 'Seller payout is still in flight or needs manual reconciliation; reconcile the Paystack transfer before refunding';
  END IF;

  IF v_tx.refund_status IN ('pending','processing','needs-attention','processed') THEN
    RETURN jsonb_build_object(
      'claimed', false,
      'status', v_tx.refund_status,
      'refund_id', v_tx.paystack_refund_id,
      'request_reference', v_tx.refund_request_reference
    );
  END IF;

  -- 38 characters, within Paystack's 8-64 character reference contract.
  -- Persist this before the network call so every retry is idempotent.
  v_reference := 'cp_rf_' || replace(gen_random_uuid()::text, '-', '');

  UPDATE public.transactions
     SET refund_status = 'processing',
         refund_initiated_at = clock_timestamp(),
         refund_request_reference = v_reference,
         paystack_refund_id = NULL,
         refund_processed_at = NULL,
         refund_failure_reason = NULL,
         updated_at = clock_timestamp()
   WHERE id = p_transaction_id;

  RETURN jsonb_build_object(
    'claimed', true,
    'status', 'processing',
    'refund_id', NULL,
    'request_reference', v_reference
  );
END;
$$;

REVOKE ALL ON FUNCTION public.claim_paystack_refund(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_paystack_refund(uuid) TO service_role;
