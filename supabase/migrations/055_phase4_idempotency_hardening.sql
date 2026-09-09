-- Phase 4: Idempotency hardening
-- The original claim primitive could report an existing processing row as newly
-- claimed. That permits concurrent retries to execute the same mutation twice.
-- Claiming is now insert-wins: only the request that inserted the row owns the work.

CREATE OR REPLACE FUNCTION public.claim_idempotency_key(
  p_scope text,
  p_key text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  actor uuid := auth.uid();
  normalized_scope text := trim(p_scope);
  normalized_key text := trim(p_key);
  inserted_id uuid;
  row_data public.idempotency_keys%ROWTYPE;
BEGIN
  IF actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF normalized_scope IS NULL
     OR length(normalized_scope) < 1
     OR length(normalized_scope) > 80 THEN
    RAISE EXCEPTION 'Invalid idempotency scope';
  END IF;

  IF normalized_key IS NULL
     OR length(normalized_key) < 8
     OR length(normalized_key) > 200 THEN
    RAISE EXCEPTION 'Invalid idempotency key';
  END IF;

  INSERT INTO public.idempotency_keys(scope, actor_id, idempotency_key)
  VALUES (normalized_scope, actor, normalized_key)
  ON CONFLICT (scope, actor_id, idempotency_key) DO NOTHING
  RETURNING id INTO inserted_id;

  IF inserted_id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'claimed', true,
      'status', 'processing',
      'response', NULL
    );
  END IF;

  SELECT * INTO row_data
  FROM public.idempotency_keys
  WHERE scope = normalized_scope
    AND actor_id = actor
    AND idempotency_key = normalized_key;

  RETURN jsonb_build_object(
    'claimed', false,
    'status', row_data.status,
    'response', row_data.response
  );
END;
$$;

REVOKE ALL ON FUNCTION public.claim_idempotency_key(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_idempotency_key(text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.complete_idempotency_key(
  p_scope text,
  p_key text,
  p_response jsonb,
  p_failed boolean DEFAULT false
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  updated_count integer;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  UPDATE public.idempotency_keys
  SET status = CASE WHEN p_failed THEN 'failed' ELSE 'completed' END,
      response = p_response,
      completed_at = now()
  WHERE scope = trim(p_scope)
    AND actor_id = auth.uid()
    AND idempotency_key = trim(p_key)
    AND status = 'processing';

  GET DIAGNOSTICS updated_count = ROW_COUNT;
  IF updated_count <> 1 THEN
    RAISE EXCEPTION 'Idempotency key is missing or no longer processing';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.complete_idempotency_key(text, text, jsonb, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.complete_idempotency_key(text, text, jsonb, boolean) TO authenticated;

COMMENT ON FUNCTION public.claim_idempotency_key(text, text) IS
  'Phase 4: atomically grants mutation ownership to exactly one authenticated request.';
COMMENT ON FUNCTION public.complete_idempotency_key(text, text, jsonb, boolean) IS
  'Phase 4: completes only an active idempotency claim owned by the authenticated actor.';
