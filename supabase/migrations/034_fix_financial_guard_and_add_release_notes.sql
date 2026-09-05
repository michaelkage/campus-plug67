-- The balance guard from 033 must permit the nested profile update performed by
-- the ledger trigger. Direct user profile updates remain blocked.
CREATE OR REPLACE FUNCTION public.guard_profile_balance_mutation()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF (NEW.balance IS DISTINCT FROM OLD.balance OR NEW.plug_credit_balance IS DISTINCT FROM OLD.plug_credit_balance)
     AND auth.role() <> 'service_role'
     AND pg_trigger_depth() <= 1
     AND COALESCE(current_setting('app.financial_write', true), '0') <> '1' THEN
    RAISE EXCEPTION 'Direct wallet balance mutation is not permitted';
  END IF;
  RETURN NEW;
END;
$$;

-- Never let a failed/unfinished idempotency claim live forever.
CREATE OR REPLACE FUNCTION public.cleanup_stale_idempotency_keys()
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE n bigint;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'Service role required'; END IF;
  DELETE FROM public.idempotency_keys
  WHERE status='processing' AND created_at < now()-interval '1 hour';
  GET DIAGNOSTICS n=ROW_COUNT;
  RETURN n;
END;
$$;
REVOKE ALL ON FUNCTION public.cleanup_stale_idempotency_keys() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_stale_idempotency_keys() TO service_role;
