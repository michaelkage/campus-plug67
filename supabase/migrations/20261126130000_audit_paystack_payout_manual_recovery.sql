-- M17: immutable operator audit for ambiguous Paystack seller-payout recovery.
-- The operator identity is verified from a user JWT by the Edge Function; the
-- service-role-only RPC records that verified identity atomically with recovery.
CREATE TABLE IF NOT EXISTS public.seller_payout_operator_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_id uuid NOT NULL REFERENCES public.seller_payout_transfers(id) ON DELETE RESTRICT,
  transaction_id uuid NOT NULL REFERENCES public.transactions(id) ON DELETE RESTRICT,
  operator_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  action text NOT NULL CHECK (action IN ('confirmed_not_created')),
  provider_reference text NOT NULL,
  provider_http_status integer NOT NULL CHECK (provider_http_status = 404),
  note text NOT NULL CHECK (length(note) BETWEEN 20 AND 500),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.seller_payout_operator_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.seller_payout_operator_audit FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON public.seller_payout_operator_audit TO service_role;

CREATE OR REPLACE FUNCTION public.prevent_seller_payout_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'Seller payout operator audit is append-only';
END;
$$;
REVOKE ALL ON FUNCTION public.prevent_seller_payout_audit_mutation() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER seller_payout_operator_audit_immutable
BEFORE UPDATE OR DELETE ON public.seller_payout_operator_audit
FOR EACH ROW EXECUTE FUNCTION public.prevent_seller_payout_audit_mutation();

DROP FUNCTION IF EXISTS public.confirm_paystack_transfer_not_created(text,text);

CREATE FUNCTION public.confirm_paystack_transfer_not_created(
  p_reference text,
  p_note text,
  p_operator_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_transfer public.seller_payout_transfers%ROWTYPE;
  v_tx public.transactions%ROWTYPE;
  v_note text := trim(COALESCE(p_note, ''));
BEGIN
  IF COALESCE(auth.jwt() ->> 'role', '') <> 'service_role' THEN
    RAISE EXCEPTION 'Service role required';
  END IF;
  IF p_reference IS NULL OR length(v_note) < 20 OR length(v_note) > 500 OR p_operator_id IS NULL THEN
    RAISE EXCEPTION 'Reference, verified operator and a 20-500 character support note are required';
  END IF;

  SELECT * INTO v_transfer FROM public.seller_payout_transfers
   WHERE reference = p_reference FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown seller payout reference'; END IF;
  IF v_transfer.status <> 'needs_attention'
     OR v_transfer.provider_transfer_code IS NOT NULL
     OR v_transfer.provider_transfer_id IS NOT NULL
     OR v_transfer.created_at > now() - interval '30 minutes' THEN
    RAISE EXCEPTION 'Transfer is not eligible for manual not-created confirmation';
  END IF;

  SELECT * INTO v_tx FROM public.transactions
   WHERE id = v_transfer.transaction_id FOR UPDATE;
  IF NOT FOUND
     OR v_tx.seller_id <> v_transfer.seller_id
     OR v_tx.status NOT IN ('released','completed')
     OR v_tx.payment_verified IS DISTINCT FROM true
     OR v_tx.payout_status IS DISTINCT FROM 'needs_attention'
     OR v_tx.payout_reference IS DISTINCT FROM v_transfer.reference
     OR COALESCE(v_tx.payment_method, 'paystack') = 'campus_wallet'
     OR COALESCE(v_tx.refund_status, '') IN ('pending','processing','needs-attention','needs_attention','processed')
     OR EXISTS (
       SELECT 1 FROM public.jury_cases AS dispute
        WHERE dispute.transaction_id = v_tx.id
          AND COALESCE(dispute.status, 'open') NOT IN ('closed','decided')
     )
     OR EXISTS (
       SELECT 1 FROM public.seller_payout_transfers AS other
        WHERE other.transaction_id = v_tx.id
          AND other.id <> v_transfer.id
          AND other.status IN ('processing','pending','success')
     ) THEN
    RAISE EXCEPTION 'Seller payout is no longer eligible for manual recovery';
  END IF;

  UPDATE public.seller_payout_transfers
     SET status = 'failed',
         provider_status = 'manual-confirmed-not-created',
         failure_reason = left('Operator confirmed no provider transfer exists: ' || v_note, 500),
         lease_expires_at = NULL,
         completed_at = now(),
         updated_at = now()
   WHERE id = v_transfer.id;

  UPDATE public.transactions
     SET payout_status = 'failed',
         payout_reference = v_transfer.reference,
         payout_failure_reason = CASE
           WHEN v_transfer.attempt_number < 5 THEN 'Support confirmed no bank transfer was created. A new payout attempt is queued.'
           ELSE 'Support confirmed no bank transfer was created, but manual settlement is required.'
         END
   WHERE id = v_tx.id;

  INSERT INTO public.seller_payout_operator_audit (
    transfer_id, transaction_id, operator_id, action,
    provider_reference, provider_http_status, note
  ) VALUES (
    v_transfer.id, v_tx.id, p_operator_id, 'confirmed_not_created',
    v_transfer.reference, 404, v_note
  );

  INSERT INTO public.notifications(user_id, type, title, body, data)
  VALUES (
    v_tx.seller_id,
    CASE WHEN v_transfer.attempt_number < 5 THEN 'seller_payout_retry_queued' ELSE 'seller_payout_manual_review' END,
    CASE WHEN v_transfer.attempt_number < 5 THEN '🔄 Seller payout retry queued' ELSE '⚠️ Seller payout needs support review' END,
    CASE
      WHEN v_transfer.attempt_number < 5
        THEN 'Support verified that no bank transfer was created. Campus Plug will safely retry this payout using a new reference.'
      ELSE 'Support verified that no bank transfer was created, but the automatic retry limit has been reached. Contact Campus Plug support for manual settlement.'
    END,
    jsonb_build_object('transaction_id', v_tx.id, 'payout_reference', v_transfer.reference, 'payout_status', 'failed')
  );

  RETURN jsonb_build_object('success', true, 'status', 'failed',
    'retry_eligible', v_transfer.attempt_number < 5, 'audit_recorded', true);
END;
$function$;

REVOKE ALL ON FUNCTION public.confirm_paystack_transfer_not_created(text,text,uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_paystack_transfer_not_created(text,text,uuid)
  TO service_role;

COMMENT ON TABLE public.seller_payout_operator_audit IS
  'Append-only evidence of human platform-admin decisions during Paystack payout recovery. Provider 404 alone is not enough; the operator must also confirm the Paystack dashboard shows no transfer.';
