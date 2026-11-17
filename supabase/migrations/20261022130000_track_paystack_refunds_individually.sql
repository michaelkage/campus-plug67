-- Track each Paystack refund independently; transaction-level columns remain a legacy summary.
CREATE TABLE IF NOT EXISTS public.paystack_refund_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id uuid NOT NULL REFERENCES public.transactions(id) ON DELETE RESTRICT,
  transaction_reference text NOT NULL,
  refund_reference text NOT NULL UNIQUE,
  status text NOT NULL CHECK (status IN ('pending','processed','failed','cancelled','needs_attention')),
  processed_at timestamptz,
  failure_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT paystack_refund_records_reference_nonempty CHECK (length(trim(transaction_reference)) > 0 AND length(trim(refund_reference)) > 0)
);

CREATE INDEX IF NOT EXISTS paystack_refund_records_transaction_idx
  ON public.paystack_refund_records(transaction_id, created_at);

ALTER TABLE public.paystack_refund_records ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.paystack_refund_records FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.paystack_refund_records TO service_role;

CREATE OR REPLACE FUNCTION public.record_paystack_refund(
  p_transaction_reference text,
  p_refund_reference text,
  p_status text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  tx public.transactions%ROWTYPE;
  refund public.paystack_refund_records%ROWTYPE;
BEGIN
  IF p_transaction_reference IS NULL OR length(trim(p_transaction_reference)) = 0
     OR p_refund_reference IS NULL OR length(trim(p_refund_reference)) = 0 THEN
    RAISE EXCEPTION 'Refund and transaction references are required';
  END IF;
  IF p_status NOT IN ('pending','processed','failed','cancelled','needs_attention') THEN
    RAISE EXCEPTION 'Unsupported refund status';
  END IF;

  SELECT * INTO tx FROM public.transactions
   WHERE paystack_ref = p_transaction_reference FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Refund transaction not found'; END IF;

  INSERT INTO public.paystack_refund_records(transaction_id, transaction_reference, refund_reference, status, processed_at, failure_reason)
  VALUES (tx.id, p_transaction_reference, p_refund_reference, p_status,
          CASE WHEN p_status = 'processed' THEN now() ELSE NULL END,
          CASE WHEN p_status = 'failed' THEN 'Paystack reported refund.failed' ELSE NULL END)
  ON CONFLICT (refund_reference) DO NOTHING;

  SELECT * INTO refund FROM public.paystack_refund_records
   WHERE refund_reference = p_refund_reference FOR UPDATE;
  IF refund.transaction_id <> tx.id OR refund.transaction_reference <> p_transaction_reference THEN
    RAISE EXCEPTION 'Refund reference is already bound to another transaction';
  END IF;

  -- A completed refund is terminal; delayed older events cannot roll it back.
  IF refund.status = 'processed' AND p_status <> 'processed' THEN
    RETURN jsonb_build_object('success', true, 'duplicate_or_stale', true, 'refund_reference', p_refund_reference);
  END IF;

  UPDATE public.paystack_refund_records
     SET status = p_status,
         processed_at = CASE WHEN p_status = 'processed' THEN COALESCE(processed_at, now()) ELSE processed_at END,
         failure_reason = CASE WHEN p_status = 'failed' THEN 'Paystack reported refund.failed' ELSE NULL END,
         updated_at = now()
   WHERE id = refund.id;

  -- Preserve legacy summary fields only for the first/only refund associated with this transaction.
  IF tx.paystack_refund_id IS NULL OR tx.paystack_refund_id = p_refund_reference THEN
    UPDATE public.transactions
       SET refund_status = p_status,
           paystack_refund_id = p_refund_reference,
           refund_processed_at = CASE WHEN p_status = 'processed' THEN COALESCE(refund_processed_at, now()) ELSE refund_processed_at END,
           refund_failure_reason = CASE WHEN p_status = 'failed' THEN 'Paystack reported refund.failed' ELSE NULL END
     WHERE id = tx.id;
  END IF;

  RETURN jsonb_build_object('success', true, 'refund_reference', p_refund_reference, 'status', p_status);
END;
$$;

REVOKE ALL ON FUNCTION public.record_paystack_refund(text,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_paystack_refund(text,text,text) TO service_role;
