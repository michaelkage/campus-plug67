-- Restrict the browser-callable audit writer to genuine edits/deletes of the caller's own messages.
-- Trusted service-role operations retain the generic validated audit path.
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
  current_content text;
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

  IF auth.role() <> 'service_role' THEN
    IF trim(p_entity_type) <> 'message' OR trim(p_action) NOT IN ('edit', 'delete') THEN
      RAISE EXCEPTION 'Authenticated audit writes are limited to message edits and deletes';
    END IF;

    SELECT m.content
      INTO current_content
      FROM public.messages m
     WHERE m.id = p_entity_id
       AND m.sender_id = actor
     FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Message not found or not owned by authenticated user';
    END IF;

    IF metadata_value->>'original_content' IS DISTINCT FROM current_content THEN
      RAISE EXCEPTION 'Audit original content does not match the persisted message';
    END IF;

    IF trim(p_action) = 'edit' THEN
      IF metadata_value->>'new_content' IS NULL
         OR length(trim(metadata_value->>'new_content')) = 0
         OR length(metadata_value->>'new_content') > 10000 THEN
        RAISE EXCEPTION 'Invalid edited message content';
      END IF;
    END IF;
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

COMMENT ON FUNCTION public.write_security_audit(text, uuid, text, jsonb)
IS 'Validated audit writer. Authenticated callers may record only their own message edits/deletes with matching persisted original content; trusted service-role writes remain available.';
