-- Milestone 4, slice 1:
-- Keep the existing PlugCredit write path operational while atomically mirroring
-- every balance mutation into the platform financial ledger. The legacy ledger
-- remains the compatibility write interface until all callers are migrated.
--
-- The financial ledger is an immutable per-user journal, not yet a complete
-- double-entry general ledger. External Paystack clearing/settlement accounts
-- are deliberately not fabricated by this bridge.

CREATE OR REPLACE FUNCTION public.record_financial_ledger_entry(
  p_user_id uuid,
  p_amount bigint,
  p_currency text,
  p_direction text,
  p_source text,
  p_reference_type text DEFAULT NULL,
  p_reference_id uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_id uuid;
  v_existing public.financial_ledger%ROWTYPE;
  v_currency text := upper(coalesce(nullif(trim(p_currency), ''), 'NGN'));
  v_metadata jsonb := coalesce(p_metadata, '{}'::jsonb);
BEGIN
  IF p_user_id IS NULL THEN RAISE EXCEPTION 'ledger user is required'; END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN RAISE EXCEPTION 'ledger amount must be positive'; END IF;
  IF p_direction NOT IN ('credit', 'debit') THEN RAISE EXCEPTION 'invalid ledger direction'; END IF;
  IF p_source IS NULL OR length(trim(p_source)) = 0 THEN RAISE EXCEPTION 'ledger source is required'; END IF;
  IF p_idempotency_key IS NULL OR length(trim(p_idempotency_key)) = 0 THEN
    RAISE EXCEPTION 'ledger idempotency key is required';
  END IF;
  IF length(p_idempotency_key) > 200 THEN RAISE EXCEPTION 'ledger idempotency key is too long'; END IF;
  IF v_currency <> 'NGN' THEN RAISE EXCEPTION 'unsupported ledger currency: %', v_currency; END IF;

  INSERT INTO public.financial_ledger (
    user_id, amount, currency, direction, source, reference_type,
    reference_id, idempotency_key, metadata
  ) VALUES (
    p_user_id, p_amount, v_currency, p_direction, trim(p_source),
    p_reference_type, p_reference_id, trim(p_idempotency_key), v_metadata
  )
  ON CONFLICT (user_id, idempotency_key) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NOT NULL THEN RETURN v_id; END IF;

  SELECT * INTO v_existing
    FROM public.financial_ledger
   WHERE user_id = p_user_id
     AND idempotency_key = trim(p_idempotency_key);

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ledger idempotency conflict could not be resolved';
  END IF;

  IF v_existing.amount IS DISTINCT FROM p_amount
     OR v_existing.currency IS DISTINCT FROM v_currency
     OR v_existing.direction IS DISTINCT FROM p_direction
     OR v_existing.source IS DISTINCT FROM trim(p_source)
     OR v_existing.reference_type IS DISTINCT FROM p_reference_type
     OR v_existing.reference_id IS DISTINCT FROM p_reference_id
     OR v_existing.metadata IS DISTINCT FROM v_metadata THEN
    RAISE EXCEPTION 'ledger idempotency key reused with a different financial payload';
  END IF;

  RETURN v_existing.id;
END;
$function$;

REVOKE ALL ON FUNCTION public.record_financial_ledger_entry(uuid,bigint,text,text,text,text,uuid,text,jsonb)
  FROM PUBLIC, anon, authenticated, service_role;

-- Keep the legacy ledger readable for reconciliation but force every
-- new write through the trusted PlugCredit mirror/definer writer.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.financial_ledger FROM service_role;
GRANT SELECT ON public.financial_ledger TO service_role;

CREATE OR REPLACE FUNCTION public.guard_financial_ledger_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
BEGIN
  RAISE EXCEPTION 'financial_ledger is append-only; record a compensating entry instead';
END;
$function$;

DROP TRIGGER IF EXISTS financial_ledger_append_only_guard ON public.financial_ledger;
CREATE TRIGGER financial_ledger_append_only_guard
BEFORE UPDATE OR DELETE ON public.financial_ledger
FOR EACH ROW EXECUTE FUNCTION public.guard_financial_ledger_append_only();

CREATE OR REPLACE FUNCTION public.mirror_plug_credit_ledger_to_financial_ledger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF NEW.amount = 0 THEN
    RAISE EXCEPTION 'zero-value PlugCredit ledger entries are not supported';
  END IF;
  IF NEW.amount = '-9223372036854775808'::bigint THEN
    RAISE EXCEPTION 'PlugCredit ledger amount is outside the supported range';
  END IF;

  PERFORM public.record_financial_ledger_entry(
    NEW.user_id,
    abs(NEW.amount),
    'NGN',
    CASE WHEN NEW.amount > 0 THEN 'credit' ELSE 'debit' END,
    'plug_credit_ledger',
    'plug_credit_ledger',
    NEW.id,
    'plug-credit-ledger:' || NEW.id::text,
    jsonb_build_object(
      'legacy_reason', NEW.reason,
      'legacy_reference_id', NEW.reference_id,
      'legacy_balance_after', NEW.balance_after
    )
  );

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.mirror_plug_credit_ledger_to_financial_ledger()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS plug_credit_ledger_financial_mirror ON public.plug_credit_ledger;
CREATE TRIGGER plug_credit_ledger_financial_mirror
AFTER INSERT ON public.plug_credit_ledger
FOR EACH ROW EXECUTE FUNCTION public.mirror_plug_credit_ledger_to_financial_ledger();

-- Backfill historical wallet movements exactly once. The deterministic key
-- makes this safe to re-run after an interrupted deployment.
DO $backfill$
DECLARE
  v_row record;
BEGIN
  FOR v_row IN
    SELECT id, user_id, amount, reason, reference_id, balance_after
      FROM public.plug_credit_ledger
     ORDER BY created_at NULLS FIRST, id
  LOOP
    PERFORM public.record_financial_ledger_entry(
      v_row.user_id,
      abs(v_row.amount),
      'NGN',
      CASE WHEN v_row.amount > 0 THEN 'credit' ELSE 'debit' END,
      'plug_credit_ledger',
      'plug_credit_ledger',
      v_row.id,
      'plug-credit-ledger:' || v_row.id::text,
      jsonb_build_object(
        'legacy_reason', v_row.reason,
        'legacy_reference_id', v_row.reference_id,
        'legacy_balance_after', v_row.balance_after
      )
    );
  END LOOP;
END;
$backfill$;

COMMENT ON FUNCTION public.mirror_plug_credit_ledger_to_financial_ledger() IS
  'Atomically mirrors every legacy PlugCredit balance mutation into the append-only financial journal.';
COMMENT ON TABLE public.financial_ledger IS
  'Append-only per-user financial journal. PlugCredit movements are mirrored transactionally; external settlement accounts are not yet represented.';
