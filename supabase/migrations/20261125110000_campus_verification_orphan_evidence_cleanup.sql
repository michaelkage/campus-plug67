-- Sweep abandoned uploads that never became a verification request.
-- A 24-hour grace period avoids racing the normal upload -> submit workflow.
-- The request insert trigger and Storage row locks serialize submission against
-- orphan discovery, so an object cannot be claimed for deletion and then reused.

CREATE TABLE IF NOT EXISTS public.campus_verification_evidence_orphan_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  evidence_path text NOT NULL UNIQUE,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 8),
  next_attempt_at timestamptz,
  claimed_at timestamptz,
  last_error text,
  deleted_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS campus_verification_evidence_orphan_due_idx
  ON public.campus_verification_evidence_orphan_jobs(next_attempt_at, created_at)
  WHERE deleted_at IS NULL AND cancelled_at IS NULL;

ALTER TABLE public.campus_verification_evidence_orphan_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.campus_verification_evidence_orphan_jobs
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.guard_campus_verification_evidence_submission()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_object storage.objects%ROWTYPE;
BEGIN
  SELECT * INTO v_object
    FROM storage.objects
   WHERE bucket_id = 'campus-verification-evidence'
     AND name = NEW.evidence_path
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Campus verification evidence object is missing';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.campus_verification_evidence_orphan_jobs j
     WHERE j.evidence_path = NEW.evidence_path
       AND j.cancelled_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Campus verification evidence has entered the cleanup queue; upload it again';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS campus_verification_evidence_submission_guard
  ON public.campus_verification_requests;
CREATE TRIGGER campus_verification_evidence_submission_guard
BEFORE INSERT ON public.campus_verification_requests
FOR EACH ROW EXECUTE FUNCTION public.guard_campus_verification_evidence_submission();

CREATE OR REPLACE FUNCTION public.campus_verification_evidence_object_exists(
  p_evidence_path text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF COALESCE(auth.jwt() ->> 'role', '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Campus evidence cleanup is service-role-only';
  END IF;
  IF p_evidence_path IS NULL OR length(trim(p_evidence_path)) = 0 THEN
    RAISE EXCEPTION 'Evidence path is required';
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM storage.objects
     WHERE bucket_id = 'campus-verification-evidence'
       AND name = p_evidence_path
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_campus_verification_orphan_cleanup(
  p_batch_size integer DEFAULT 50
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_claimed jsonb;
  v_discovered integer := 0;
BEGIN
  IF COALESCE(auth.jwt() ->> 'role', '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Campus evidence cleanup is service-role-only';
  END IF;
  IF p_batch_size IS NULL OR p_batch_size < 1 OR p_batch_size > 100 THEN
    RAISE EXCEPTION 'Batch size must be between 1 and 100';
  END IF;

  -- Lock Storage rows while registering jobs. The request trigger takes the
  -- same row lock before accepting a path, closing the submission/deletion race.
  WITH stale_objects AS (
    SELECT o.name
      FROM storage.objects o
     WHERE o.bucket_id = 'campus-verification-evidence'
       AND o.created_at <= now() - interval '24 hours'
       AND NOT EXISTS (
         SELECT 1 FROM public.campus_verification_requests r
         WHERE r.evidence_path = o.name
       )
       AND NOT EXISTS (
         SELECT 1 FROM public.campus_verification_evidence_orphan_jobs j
         WHERE j.evidence_path = o.name
           AND j.deleted_at IS NULL
           AND j.cancelled_at IS NULL
       )
     ORDER BY o.created_at, o.name
     LIMIT p_batch_size
     FOR UPDATE OF o SKIP LOCKED
  ), inserted AS (
    INSERT INTO public.campus_verification_evidence_orphan_jobs AS existing (evidence_path)
    SELECT name FROM stale_objects
    ON CONFLICT (evidence_path) DO UPDATE
      SET cancelled_at = NULL, attempts = 0, next_attempt_at = NULL,
          claimed_at = NULL, last_error = NULL, updated_at = now()
      WHERE existing.deleted_at IS NULL
        AND existing.cancelled_at IS NOT NULL
    RETURNING id
  )
  SELECT count(*)::integer INTO v_discovered FROM inserted;

  -- A request that was committed before this claim makes its orphan job moot.
  UPDATE public.campus_verification_evidence_orphan_jobs j
     SET cancelled_at = now(), claimed_at = NULL, updated_at = now()
   WHERE j.deleted_at IS NULL
     AND j.cancelled_at IS NULL
     AND EXISTS (
       SELECT 1 FROM public.campus_verification_requests r
       WHERE r.evidence_path = j.evidence_path
     );

  WITH candidates AS (
    SELECT j.id
      FROM public.campus_verification_evidence_orphan_jobs j
     WHERE j.deleted_at IS NULL
       AND j.cancelled_at IS NULL
       AND j.attempts < 8
       AND (j.next_attempt_at IS NULL OR j.next_attempt_at <= now())
       AND (j.claimed_at IS NULL OR j.claimed_at < now() - interval '10 minutes')
       AND NOT EXISTS (
         SELECT 1 FROM public.campus_verification_requests r
         WHERE r.evidence_path = j.evidence_path
       )
     ORDER BY j.created_at, j.id
     LIMIT p_batch_size
     FOR UPDATE SKIP LOCKED
  ), claimed AS (
    UPDATE public.campus_verification_evidence_orphan_jobs j
       SET claimed_at = now(), attempts = j.attempts + 1, updated_at = now()
      FROM candidates c
     WHERE j.id = c.id
    RETURNING j.id, j.evidence_path, j.attempts
  )
  SELECT COALESCE(jsonb_agg(to_jsonb(claimed)), '[]'::jsonb)
    INTO v_claimed
    FROM claimed;

  RETURN jsonb_build_object(
    'discovered', v_discovered,
    'claimed', v_claimed,
    'claimed_count', jsonb_array_length(v_claimed)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_campus_verification_orphan_cleanup(
  p_job_id uuid,
  p_evidence_path text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_updated integer;
BEGIN
  IF COALESCE(auth.jwt() ->> 'role', '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Campus evidence cleanup is service-role-only';
  END IF;
  UPDATE public.campus_verification_evidence_orphan_jobs
     SET deleted_at = now(), claimed_at = NULL, next_attempt_at = NULL,
         last_error = NULL, updated_at = now()
   WHERE id = p_job_id
     AND evidence_path = p_evidence_path
     AND claimed_at IS NOT NULL
     AND deleted_at IS NULL
     AND cancelled_at IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM public.campus_verification_requests r
       WHERE r.evidence_path = p_evidence_path
     );
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated = 1;
END;
$$;

CREATE OR REPLACE FUNCTION public.fail_campus_verification_orphan_cleanup(
  p_job_id uuid,
  p_evidence_path text,
  p_error text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_updated integer;
BEGIN
  IF COALESCE(auth.jwt() ->> 'role', '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Campus evidence cleanup is service-role-only';
  END IF;
  UPDATE public.campus_verification_evidence_orphan_jobs
     SET last_error = left(COALESCE(NULLIF(btrim(p_error), ''), 'Storage deletion failed'), 500),
         next_attempt_at = CASE
           WHEN attempts >= 8 THEN NULL
           ELSE now() + make_interval(mins => LEAST(1440, 5 * (2 ^ GREATEST(attempts - 1, 0))::integer))
         END,
         claimed_at = NULL,
         updated_at = now()
   WHERE id = p_job_id
     AND evidence_path = p_evidence_path
     AND claimed_at IS NOT NULL
     AND deleted_at IS NULL
     AND cancelled_at IS NULL;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated = 1;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_campus_verification_evidence_submission()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.campus_verification_evidence_object_exists(text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_campus_verification_orphan_cleanup(integer)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_campus_verification_orphan_cleanup(uuid,text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fail_campus_verification_orphan_cleanup(uuid,text,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.campus_verification_evidence_object_exists(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_campus_verification_orphan_cleanup(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_campus_verification_orphan_cleanup(uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_campus_verification_orphan_cleanup(uuid,text,text) TO service_role;

COMMENT ON TABLE public.campus_verification_evidence_orphan_jobs IS
  'Private retry queue for unreferenced campus verification uploads older than the 24-hour submission grace period.';

-- The verification audit is an evidence trail, not a mutable status table.
-- SECURITY DEFINER review/cleanup RPCs own inserts; no API role may rewrite
-- or truncate historical reviewer and retention events.
CREATE OR REPLACE FUNCTION public.prevent_campus_verification_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $audit$
BEGIN
  RAISE EXCEPTION 'Campus verification audit is append-only';
END;
$audit$;

REVOKE ALL ON FUNCTION public.prevent_campus_verification_audit_mutation()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS campus_verification_audit_immutable
  ON public.campus_verification_audit;
CREATE TRIGGER campus_verification_audit_immutable
BEFORE UPDATE OR DELETE ON public.campus_verification_audit
FOR EACH ROW EXECUTE FUNCTION public.prevent_campus_verification_audit_mutation();

REVOKE ALL ON public.campus_verification_audit
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.campus_verification_audit TO authenticated;
GRANT INSERT ON public.campus_verification_audit TO service_role;
