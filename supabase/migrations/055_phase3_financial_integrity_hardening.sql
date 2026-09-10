-- Phase 3: Financial integrity hardening
-- Canonical Campus Plug balances live on profiles. Direct browser mutation is never
-- an authorized financial write; ledger/RPC/server paths remain authoritative.

CREATE OR REPLACE FUNCTION public.guard_profile_balance_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public AS $$
BEGIN
  IF (NEW.balance IS DISTINCT FROM OLD.balance
      OR NEW.plug_credit_balance IS DISTINCT FROM OLD.plug_credit_balance)
     AND auth.role() <> 'service_role'
     AND COALESCE(current_setting('app.financial_write', true), '0') <> '1'
     AND pg_trigger_depth() <= 1 THEN
    RAISE EXCEPTION 'Direct wallet balance mutation is not permitted';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_profile_balance_mutation ON public.profiles;
CREATE TRIGGER guard_profile_balance_mutation
BEFORE UPDATE OF balance, plug_credit_balance ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.guard_profile_balance_mutation();

-- Legacy wallets are not the canonical accounting store, but protecting their
-- balance prevents a stale client path from becoming an alternate money ledger.
CREATE OR REPLACE FUNCTION public.guard_legacy_wallet_balance_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public AS $$
BEGIN
  IF NEW.balance IS DISTINCT FROM OLD.balance
     AND auth.role() <> 'service_role'
     AND COALESCE(current_setting('app.financial_write', true), '0') <> '1'
     AND pg_trigger_depth() <= 1 THEN
    RAISE EXCEPTION 'Direct legacy wallet balance mutation is not permitted';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_legacy_wallet_balance_mutation ON public.wallets;
CREATE TRIGGER guard_legacy_wallet_balance_mutation
BEFORE UPDATE OF balance ON public.wallets
FOR EACH ROW EXECUTE FUNCTION public.guard_legacy_wallet_balance_mutation();

COMMENT ON FUNCTION public.guard_profile_balance_mutation() IS
  'Phase 3: blocks direct client mutation of canonical financial balances.';
COMMENT ON FUNCTION public.guard_legacy_wallet_balance_mutation() IS
  'Phase 3: blocks direct client mutation of legacy wallet balances.';
