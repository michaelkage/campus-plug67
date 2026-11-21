-- Prevent refund initiation while a seller bank transfer is ambiguous.
-- The transaction row lock in claim_paystack_refund serializes this against
-- claim_seller_payout_transfers, closing the race in both directions.

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
  -- An ambiguous outbound bank transfer must be reconciled before refunding.
  -- Once a transfer is confirmed paid, a refund is allowed and journaled as
  -- a seller recovery receivable instead of silently double-spending escrow.
  IF v_tx.payout_status IN ('processing','needs_attention') THEN
    RAISE EXCEPTION 'Seller payout is still in flight or needs manual reconciliation; reconcile the Paystack transfer before refunding';
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
