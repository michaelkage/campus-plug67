-- Audited platform-operator reconciliation for Paystack seller transfers.
-- All operator mutations are performed by service-role Edge Functions after
-- validating the caller's user JWT and is_platform_admin() with the user client.

CREATE TABLE IF NOT EXISTS public.seller_payout_operator_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_id uuid NOT NULL REFERENCES public.seller_payout_transfers(id) ON DELETE RESTRICT,
  transaction_id uuid NOT NULL REFERENCES public.transactions(id) ON DELETE RESTRICT,
  operator_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  action text NOT NULL CHECK (action IN (
    'provider_reconciled',
    'provider_not_found',
    'confirm_not_created',
    'recovery_rejected'
  )),
  note text NOT NULL CHECK (length(trim(note)) BETWEEN 20 AND 500),
  support_ticket text CHECK (support_ticket IS NULL OR length(trim(support_ticket)) BETWEEN 1 AND 120),
  provider_status text,
  provider_http_status integer CHECK (provider_http_status IS NULL OR provider_http_status BETWEEN 100 AND 599),
  before_status text NOT NULL,
  after_status text NOT NULL,
  provider_verified_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS seller_payout_operator_audit_transfer_created_idx
  ON public.seller_payout_operator_audit(transfer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS seller_payout_operator_audit_operator_created_idx
  ON public.seller_payout_operator_audit(operator_id, created_at DESC);

ALTER TABLE public.seller_payout_operator_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.seller_payout_operator_audit FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.guard_seller_payout_operator_audit_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'Seller payout operator audit records are append-only';
END;
$$;

REVOKE ALL ON FUNCTION public.guard_seller_payout_operator_audit_immutable()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS seller_payout_operator_audit_immutable
  ON public.seller_payout_operator_audit;
CREATE TRIGGER seller_payout_operator_audit_immutable
BEFORE UPDATE OR DELETE ON public.seller_payout_operator_audit
FOR EACH ROW EXECUTE FUNCTION public.guard_seller_payout_operator_audit_immutable();

CREATE OR REPLACE FUNCTION public.write_seller_payout_operator_audit(
  p_operator_id uuid,
  p_reference text,
  p_action text,
  p_note text,
  p_support_ticket text,
  p_provider_status text,
  p_provider_http_status integer,
  p_provider_verified_at timestamptz
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_transfer public.seller_payout_transfers%ROWTYPE;
  v_id uuid;
BEGIN
  IF COALESCE(auth.jwt() ->> 'role', '') <> 'service_role' THEN
    RAISE EXCEPTION 'Service role required';
  END IF;
  IF p_operator_id IS NULL OR p_action NOT IN ('provider_not_found','recovery_rejected')
     OR p_provider_http_status IS DISTINCT FROM 404
     OR p_provider_verified_at IS NULL
     OR length(trim(COALESCE(p_note,''))) NOT BETWEEN 20 AND 500
     OR (p_support_ticket IS NOT NULL AND length(trim(p_support_ticket)) NOT BETWEEN 1 AND 120) THEN
    RAISE EXCEPTION 'Invalid payout operator audit input';
  END IF;

  SELECT * INTO v_transfer
    FROM public.seller_payout_transfers
   WHERE reference = p_reference
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown seller payout reference'; END IF;

  INSERT INTO public.seller_payout_operator_audit (
    transfer_id, transaction_id, operator_id, action, note, support_ticket,
    provider_status, provider_http_status, before_status, after_status, provider_verified_at
  ) VALUES (
    v_transfer.id, v_transfer.transaction_id, p_operator_id, p_action,
    trim(p_note), NULLIF(trim(COALESCE(p_support_ticket,'')), ''),
    COALESCE(NULLIF(trim(p_provider_status),''),'not_found'), 404,
    v_transfer.status, v_transfer.status, p_provider_verified_at
  ) RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.record_paystack_transfer_with_operator_audit(
  p_operator_id uuid,
  p_reference text,
  p_status text,
  p_amount bigint,
  p_currency text,
  p_recipient_code text,
  p_transfer_code text,
  p_provider_transfer_id text,
  p_message text,
  p_note text,
  p_support_ticket text,
  p_provider_http_status integer,
  p_provider_verified_at timestamptz
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_transfer public.seller_payout_transfers%ROWTYPE;
  v_after public.seller_payout_transfers%ROWTYPE;
  v_result jsonb;
  v_audit_id uuid;
BEGIN
  IF COALESCE(auth.jwt() ->> 'role', '') <> 'service_role' THEN
    RAISE EXCEPTION 'Service role required';
  END IF;
  IF p_operator_id IS NULL
     OR length(trim(COALESCE(p_note,''))) NOT BETWEEN 20 AND 500
     OR p_provider_http_status IS NULL OR p_provider_http_status NOT BETWEEN 200 AND 299
     OR p_provider_verified_at IS NULL
     OR (p_support_ticket IS NOT NULL AND length(trim(p_support_ticket)) NOT BETWEEN 1 AND 120) THEN
    RAISE EXCEPTION 'Invalid payout operator reconciliation input';
  END IF;

  SELECT * INTO v_transfer
    FROM public.seller_payout_transfers
   WHERE reference = p_reference
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown seller payout reference'; END IF;

  v_result := public.record_paystack_transfer(
    p_reference, p_status, p_amount, p_currency, p_recipient_code,
    p_transfer_code, p_provider_transfer_id, p_message
  );

  SELECT * INTO v_after
    FROM public.seller_payout_transfers
   WHERE id = v_transfer.id;

  INSERT INTO public.seller_payout_operator_audit (
    transfer_id, transaction_id, operator_id, action, note, support_ticket,
    provider_status, provider_http_status, before_status, after_status, provider_verified_at
  ) VALUES (
    v_transfer.id, v_transfer.transaction_id, p_operator_id, 'provider_reconciled',
    trim(p_note), NULLIF(trim(COALESCE(p_support_ticket,'')), ''),
    left(COALESCE(NULLIF(trim(p_status),''),'unknown'),80), p_provider_http_status,
    v_transfer.status, v_after.status, p_provider_verified_at
  ) RETURNING id INTO v_audit_id;

  RETURN jsonb_build_object('result',v_result,'audit_id',v_audit_id,'before_status',v_transfer.status,'after_status',v_after.status);
END;
$$;

CREATE OR REPLACE FUNCTION public.confirm_paystack_transfer_not_created_with_operator_audit(
  p_operator_id uuid,
  p_reference text,
  p_note text,
  p_support_ticket text,
  p_provider_http_status integer,
  p_provider_verified_at timestamptz
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_transfer public.seller_payout_transfers%ROWTYPE;
  v_after public.seller_payout_transfers%ROWTYPE;
  v_result jsonb;
  v_audit_id uuid;
BEGIN
  IF COALESCE(auth.jwt() ->> 'role', '') <> 'service_role' THEN
    RAISE EXCEPTION 'Service role required';
  END IF;
  IF p_operator_id IS NULL OR p_provider_http_status <> 404
     OR p_provider_verified_at IS NULL
     OR length(trim(COALESCE(p_note,''))) NOT BETWEEN 20 AND 500
     OR (p_support_ticket IS NOT NULL AND length(trim(p_support_ticket)) NOT BETWEEN 1 AND 120) THEN
    RAISE EXCEPTION 'Invalid payout not-created confirmation input';
  END IF;

  SELECT * INTO v_transfer
    FROM public.seller_payout_transfers
   WHERE reference = p_reference
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown seller payout reference'; END IF;

  v_result := public.confirm_paystack_transfer_not_created(p_reference,p_note);

  SELECT * INTO v_after
    FROM public.seller_payout_transfers
   WHERE id = v_transfer.id;

  INSERT INTO public.seller_payout_operator_audit (
    transfer_id, transaction_id, operator_id, action, note, support_ticket,
    provider_status, provider_http_status, before_status, after_status, provider_verified_at
  ) VALUES (
    v_transfer.id, v_transfer.transaction_id, p_operator_id, 'confirm_not_created',
    trim(p_note), NULLIF(trim(COALESCE(p_support_ticket,'')), ''),
    'not_found', 404, v_transfer.status, v_after.status, p_provider_verified_at
  ) RETURNING id INTO v_audit_id;

  RETURN jsonb_build_object('result',v_result,'audit_id',v_audit_id,'before_status',v_transfer.status,'after_status',v_after.status);
END;
$$;

REVOKE ALL ON FUNCTION public.write_seller_payout_operator_audit(uuid,text,text,text,text,text,integer,timestamptz)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_paystack_transfer_with_operator_audit(uuid,text,text,bigint,text,text,text,text,text,text,text,integer,timestamptz)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.confirm_paystack_transfer_not_created_with_operator_audit(uuid,text,text,text,integer,timestamptz)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.write_seller_payout_operator_audit(uuid,text,text,text,text,text,integer,timestamptz)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.record_paystack_transfer_with_operator_audit(uuid,text,text,bigint,text,text,text,text,text,text,text,integer,timestamptz)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.confirm_paystack_transfer_not_created_with_operator_audit(uuid,text,text,text,integer,timestamptz)
  TO service_role;

COMMENT ON TABLE public.seller_payout_operator_audit IS
  'Append-only platform operator audit trail for Paystack transfer reconciliation and manual not-created confirmations. Stores no bank account numbers, OTPs or provider secrets.';
