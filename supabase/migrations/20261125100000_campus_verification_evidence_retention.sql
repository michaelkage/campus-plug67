-- Durable cleanup for private campus-verification evidence.
-- Storage objects are deleted by a service-role Edge Function; Postgres retains
-- the request, decision and audit history after the private file is removed.

ALTER TABLE public.campus_verification_requests
  ALTER COLUMN evidence_path DROP NOT NULL;

ALTER TABLE public.campus_verification_requests
  ADD COLUMN IF NOT EXISTS evidence_cleanup_attempts integer NOT NULL DEFAULT 0
    CHECK (evidence_cleanup_attempts >= 0),
  ADD COLUMN IF NOT EXISTS evidence_cleanup_next_attempt_at timestamptz,
  ADD COLUMN IF NOT EXISTS evidence_cleanup_claimed_at timestamptz,
  ADD COLUMN IF NOT EXISTS evidence_cleanup_last_error text,
  ADD COLUMN IF NOT EXISTS evidence_deleted_at timestamptz;

ALTER TABLE public.campus_verification_requests
  DROP CONSTRAINT IF EXISTS campus_verification_requests_status_check;
ALTER TABLE public.campus_verification_requests
  ADD CONSTRAINT campus_verification_requests_state_vocabulary_check
  CHECK (status IN ('pending_review','approved','rejected','expired'));

ALTER TABLE public.campus_verification_requests
  DROP CONSTRAINT IF EXISTS campus_verification_requests_check;
ALTER TABLE public.campus_verification_requests
  ADD CONSTRAINT campus_verification_requests_review_state_check
  CHECK (
    (status IN ('pending_review','expired') AND reviewed_by IS NULL AND reviewed_at IS NULL)
    OR (status IN ('approved','rejected') AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)
  );

ALTER TABLE public.campus_verification_audit
  DROP CONSTRAINT IF EXISTS campus_verification_audit_action_check;
ALTER TABLE public.campus_verification_audit
  ADD CONSTRAINT campus_verification_audit_action_check
  CHECK (action IN (
    'submitted','vouched','approved','rejected',
    'evidence_expired','evidence_deleted','evidence_cleanup_failed'
  ));

CREATE INDEX IF NOT EXISTS campus_verification_evidence_cleanup_idx
  ON public.campus_verification_requests(
    evidence_cleanup_next_attempt_at,
    evidence_expires_at,
    reviewed_at
  )
  WHERE evidence_path IS NOT NULL AND evidence_deleted_at IS NULL;

CREATE OR REPLACE FUNCTION public.claim_campus_verification_evidence_cleanup(
  p_batch_size integer DEFAULT 50
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_claimed jsonb;
  v_expired integer := 0;
BEGIN
  IF COALESCE(auth.jwt() ->> 'role', '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Campus evidence cleanup is service-role-only';
  END IF;
  IF p_batch_size IS NULL OR p_batch_size < 1 OR p_batch_size > 100 THEN
    RAISE EXCEPTION 'Batch size must be between 1 and 100';
  END IF;

  -- A pending request that reaches its retention deadline expires without
  -- becoming verified. Keep its request and audit metadata for accountability.
  WITH expired AS (
    UPDATE public.campus_verification_requests
       SET status = 'expired',
           review_reason = 'Evidence submission expired before review. Submit a new request.',
           updated_at = now()
     WHERE status = 'pending_review'
       AND evidence_expires_at <= now()
     RETURNING id, user_id, institution_id
  ), membership_updates AS (
    UPDATE public.institution_memberships m
       SET status = 'rejected', updated_at = now()
      FROM expired e
     WHERE m.user_id = e.user_id
       AND m.institution_id = e.institution_id
       AND m.status = 'pending'
    RETURNING m.user_id
  ), audit_expired AS (
    INSERT INTO public.campus_verification_audit(request_id, actor_id, action, metadata)
    SELECT e.id, NULL, 'evidence_expired',
           jsonb_build_object('reason', 'pending_review_retention_deadline')
      FROM expired e
    RETURNING id
  )
  SELECT count(*)::integer INTO v_expired FROM expired;

  WITH candidates AS (
    SELECT r.id
      FROM public.campus_verification_requests r
     WHERE r.evidence_path IS NOT NULL
       AND r.evidence_deleted_at IS NULL
       AND r.evidence_cleanup_attempts < 8
       AND (r.evidence_cleanup_next_attempt_at IS NULL
            OR r.evidence_cleanup_next_attempt_at <= now())
       AND (r.evidence_cleanup_claimed_at IS NULL
            OR r.evidence_cleanup_claimed_at < now() - interval '10 minutes')
       AND (
         r.status IN ('approved','rejected','expired')
         OR (r.status = 'pending_review' AND r.evidence_expires_at <= now())
       )
     ORDER BY COALESCE(r.reviewed_at, r.evidence_expires_at), r.id
     LIMIT p_batch_size
     FOR UPDATE SKIP LOCKED
  ), claimed AS (
    UPDATE public.campus_verification_requests r
       SET evidence_cleanup_claimed_at = now(),
           evidence_cleanup_attempts = r.evidence_cleanup_attempts + 1,
           updated_at = now()
      FROM candidates c
     WHERE r.id = c.id
    RETURNING r.id, r.evidence_path, r.evidence_cleanup_attempts, r.status
  )
  SELECT COALESCE(jsonb_agg(to_jsonb(claimed)), '[]'::jsonb)
    INTO v_claimed
    FROM claimed;

  RETURN jsonb_build_object(
    'expired_requests', v_expired,
    'claimed', v_claimed,
    'claimed_count', jsonb_array_length(v_claimed)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_campus_verification_evidence_cleanup(
  p_request_id uuid,
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
  UPDATE public.campus_verification_requests
     SET evidence_path = NULL,
         evidence_deleted_at = now(),
         evidence_cleanup_claimed_at = NULL,
         evidence_cleanup_next_attempt_at = NULL,
         evidence_cleanup_last_error = NULL,
         updated_at = now()
   WHERE id = p_request_id
     AND evidence_path = p_evidence_path
     AND evidence_cleanup_claimed_at IS NOT NULL
     AND evidence_deleted_at IS NULL;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated = 1 THEN
    INSERT INTO public.campus_verification_audit(request_id, actor_id, action, metadata)
    VALUES (p_request_id, NULL, 'evidence_deleted',
      jsonb_build_object('cleanup_attempt', true));
  END IF;
  RETURN v_updated = 1;
END;
$$;

CREATE OR REPLACE FUNCTION public.fail_campus_verification_evidence_cleanup(
  p_request_id uuid,
  p_evidence_path text,
  p_error text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_updated integer;
  v_attempts integer;
BEGIN
  IF COALESCE(auth.jwt() ->> 'role', '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Campus evidence cleanup is service-role-only';
  END IF;
  UPDATE public.campus_verification_requests
     SET evidence_cleanup_last_error = left(COALESCE(NULLIF(btrim(p_error), ''), 'Storage deletion failed'), 500),
         evidence_cleanup_next_attempt_at = CASE
           WHEN evidence_cleanup_attempts >= 8 THEN NULL
           ELSE now() + make_interval(mins => LEAST(1440, 5 * (2 ^ GREATEST(evidence_cleanup_attempts - 1, 0))::integer))
         END,
         evidence_cleanup_claimed_at = NULL,
         updated_at = now()
   WHERE id = p_request_id
     AND evidence_path = p_evidence_path
     AND evidence_cleanup_claimed_at IS NOT NULL
     AND evidence_deleted_at IS NULL
  RETURNING evidence_cleanup_attempts INTO v_attempts;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated = 1 THEN
    INSERT INTO public.campus_verification_audit(request_id, actor_id, action, metadata)
    VALUES (p_request_id, NULL, 'evidence_cleanup_failed',
      jsonb_build_object('attempt', v_attempts, 'retry_scheduled', v_attempts < 8));
  END IF;
  RETURN v_updated = 1;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_campus_verification_evidence_cleanup(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_campus_verification_evidence_cleanup(uuid,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fail_campus_verification_evidence_cleanup(uuid,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_campus_verification_evidence_cleanup(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_campus_verification_evidence_cleanup(uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_campus_verification_evidence_cleanup(uuid,text,text) TO service_role;

COMMENT ON FUNCTION public.claim_campus_verification_evidence_cleanup(integer) IS
  'Claims approved/rejected evidence for immediate deletion and expires pending evidence at its 30-day deadline. Service-role only; uses SKIP LOCKED and bounded retries.';
COMMENT ON FUNCTION public.complete_campus_verification_evidence_cleanup(uuid,text) IS
  'Records successful private evidence deletion while retaining request and decision audit metadata.';
COMMENT ON FUNCTION public.fail_campus_verification_evidence_cleanup(uuid,text,text) IS
  'Records a bounded storage cleanup error and schedules exponential retry; never exposes raw storage errors to applicants.';
