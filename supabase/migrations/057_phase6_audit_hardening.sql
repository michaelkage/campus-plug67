-- Phase 6 — Admin / audit hardening
-- Keep audit writes server-authoritative and make the shared helper safe for
-- authenticated clients without exposing direct audit_logs INSERT access.

CREATE OR REPLACE FUNCTION public.write_security_audit(
  p_entity_type text,
  p_entity_id uuid,
  p_action text,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  audit_id uuid;
  actor uuid := auth.uid();
  metadata_value jsonb := COALESCE(p_metadata, '{}'::jsonb);
BEGIN
  IF auth.role() <> 'service_role' AND actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF p_entity_type IS NULL OR length(trim(p_entity_type)) = 0 OR length(p_entity_type) > 80 THEN
    RAISE EXCEPTION 'Invalid audit entity type';
  END IF;

  IF p_action IS NULL OR length(trim(p_action)) = 0 OR length(p_action) > 80 THEN
    RAISE EXCEPTION 'Invalid audit action';
  END IF;

  IF p_entity_id IS NULL THEN
    RAISE EXCEPTION 'Audit entity id is required';
  END IF;

  IF octet_length(metadata_value::text) > 32768 THEN
    RAISE EXCEPTION 'Audit metadata is too large';
  END IF;

  INSERT INTO public.audit_logs(entity_type, entity_id, user_id, action, metadata)
  VALUES (
    trim(p_entity_type),
    p_entity_id,
    actor,
    trim(p_action),
    metadata_value
  )
  RETURNING id INTO audit_id;

  RETURN audit_id;
END;
$$;

REVOKE ALL ON FUNCTION public.write_security_audit(text, uuid, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.write_security_audit(text, uuid, text, jsonb) TO authenticated, service_role;

-- The browser must never write audit rows directly. Existing privileged
-- database functions and the helper above use SECURITY DEFINER/service role.
DROP POLICY IF EXISTS "System inserts audit logs" ON public.audit_logs;
DROP POLICY IF EXISTS "System inserts audit" ON public.audit_logs;
DROP POLICY IF EXISTS "Service inserts audit logs" ON public.audit_logs;
DROP POLICY IF EXISTS "Service inserts audit" ON public.audit_logs;
CREATE POLICY "Service inserts audit logs"
  ON public.audit_logs
  FOR INSERT
  WITH CHECK (auth.role() = 'service_role');

ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

COMMENT ON FUNCTION public.write_security_audit(text, uuid, text, jsonb)
IS 'Phase 6: validated SECURITY DEFINER audit writer; actor is always derived from auth.uid().';
COMMENT ON TABLE public.audit_logs
IS 'Security/audit trail. Direct browser inserts are prohibited; use write_security_audit or service-role operations.';
