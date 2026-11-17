-- Phase 5: Dispute state-machine hardening
-- Enforce the state machine and decision invariants at the database boundary,
-- including updates that do not change status.

CREATE OR REPLACE FUNCTION public.guard_jury_case_transition()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public AS $$
BEGIN
  -- A decided/closed case is authoritative. Its verdict cannot be rewritten.
  IF OLD.status IN ('decided', 'closed')
     AND NEW.verdict IS DISTINCT FROM OLD.verdict THEN
    RAISE EXCEPTION 'Verdict cannot be changed after a case is decided';
  END IF;

  -- A closed case is terminal.
  IF OLD.status = 'closed' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'Closed jury cases are terminal';
  END IF;

  -- Validate status transitions only when the status actually changes.
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT (
       (OLD.status = 'open' AND NEW.status IN ('deliberating', 'escalated', 'closed')) OR
       (OLD.status = 'deliberating' AND NEW.status IN ('decided', 'escalated', 'closed')) OR
       (OLD.status = 'escalated' AND NEW.status IN ('deliberating', 'decided', 'closed')) OR
       (OLD.status = 'decided' AND NEW.status = 'closed')
     ) THEN
    RAISE EXCEPTION 'Invalid jury case transition: % -> %', OLD.status, NEW.status;
  END IF;

  -- Decision invariants apply even when status itself is unchanged.
  IF NEW.status IN ('decided', 'closed') AND NEW.verdict IS NULL THEN
    RAISE EXCEPTION 'A decided or closed case requires a verdict';
  END IF;

  IF NEW.status = 'decided' AND NEW.verdict_decided_at IS NULL THEN
    RAISE EXCEPTION 'A decided case requires verdict_decided_at';
  END IF;

  IF OLD.status IN ('decided', 'closed')
     AND NEW.verdict_decided_at IS DISTINCT FROM OLD.verdict_decided_at THEN
    RAISE EXCEPTION 'Decision timestamp cannot be changed after a case is decided';
  END IF;

  IF OLD.status = 'decided'
     AND NEW.status = 'closed'
     AND NEW.verdict IS DISTINCT FROM OLD.verdict THEN
    RAISE EXCEPTION 'Closed case must retain its decision';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_jury_case_transition ON public.jury_cases;
CREATE TRIGGER guard_jury_case_transition
BEFORE UPDATE OF status, verdict, verdict_decided_at ON public.jury_cases
FOR EACH ROW EXECUTE FUNCTION public.guard_jury_case_transition();

COMMENT ON FUNCTION public.guard_jury_case_transition() IS
  'Phase 5: enforces valid dispute transitions and immutable decision invariants.';
