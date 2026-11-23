-- M13: Trust, Safety and Reputation Intelligence
-- Make reputation changes server-authoritative and PlugScore event processing idempotent.
-- Append-only migration. No existing score history or wallet ledger is rewritten.

ALTER TABLE public.plugscore_events
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS idempotency_key text;

CREATE UNIQUE INDEX IF NOT EXISTS plugscore_events_idempotency_uidx
  ON public.plugscore_events(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS plugscore_events_stale_processing_idx
  ON public.plugscore_events(status, updated_at)
  WHERE status = 'processing';

-- Only trusted server callers can enqueue score events. A source event can
-- contribute points once, even if its trigger/Edge Function is retried.
CREATE OR REPLACE FUNCTION public.enqueue_plugscore_event(
  p_user_id uuid,
  p_event_type text,
  p_points integer,
  p_reference_id uuid DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF auth.role() <> 'service_role' AND current_user NOT IN ('postgres','supabase_admin') THEN
    RAISE EXCEPTION 'PlugScore events may only be enqueued by trusted server processes';
  END IF;
  IF p_user_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.profiles WHERE id=p_user_id) THEN
    RAISE EXCEPTION 'PlugScore recipient does not exist';
  END IF;
  IF p_event_type NOT IN (
    'verified_listing_metadata',
    'escrow_release',
    'integrity_streak',
    'jury_vote_correct',
    'jury_vote_incorrect'
  ) THEN RAISE EXCEPTION 'Unsupported PlugScore event type'; END IF;
  IF p_points NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'PlugScore event points are outside the permitted range'; END IF;
  IF p_metadata IS NULL OR jsonb_typeof(p_metadata) <> 'object' OR octet_length(p_metadata::text)>4096 THEN
    RAISE EXCEPTION 'PlugScore event metadata must be a small JSON object';
  END IF;

  INSERT INTO public.plugscore_events(user_id,event_type,points,reference_id,metadata,idempotency_key)
  VALUES(
    p_user_id,
    p_event_type,
    p_points,
    p_reference_id,
    p_metadata,
    p_event_type || ':' || p_user_id::text || ':' || COALESCE(p_reference_id::text,'singleton')
  )
  ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING;

  SELECT id INTO v_id
  FROM public.plugscore_events
  WHERE idempotency_key=p_event_type || ':' || p_user_id::text || ':' || COALESCE(p_reference_id::text,'singleton');
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.enqueue_plugscore_event(uuid,text,integer,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_plugscore_event(uuid,text,integer,uuid,jsonb) TO service_role;

-- Prevent client-side score/badge inflation. Trusted RPCs set a transaction-local
-- capability flag; service-role operations remain available for server workflows.
CREATE OR REPLACE FUNCTION public.guard_profile_reputation_fields()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF (NEW.plug_score IS DISTINCT FROM OLD.plug_score OR NEW.badges IS DISTINCT FROM OLD.badges)
     AND auth.role() <> 'service_role'
     AND current_setting('app.trust_score_write',true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'Reputation fields are server-managed';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_profile_reputation_fields ON public.profiles;
CREATE TRIGGER guard_profile_reputation_fields
BEFORE UPDATE OF plug_score,badges ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.guard_profile_reputation_fields();

-- Correct the legacy "Integrity Streak" calculation: five latest terminal
-- seller outcomes must all be released. Counting any five historical releases
-- while ignoring cancelled/disputed deals was not a consecutive streak.
CREATE OR REPLACE FUNCTION public.get_integrity_streak_progress()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  actor uuid := auth.uid();
  v_clean integer := 0;
  v_count integer := 0;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  WITH recent AS (
    SELECT status
    FROM public.transactions
    WHERE seller_id=actor
      AND status IN ('released','disputed','cancelled')
    ORDER BY COALESCE(released_at,updated_at,created_at) DESC
    LIMIT 5
  )
  SELECT count(*)::integer,
         count(*) FILTER (WHERE status='released')::integer
  INTO v_count,v_clean
  FROM recent;

  RETURN jsonb_build_object(
    'clean_trades', CASE WHEN v_count=5 AND v_clean=5 THEN 5 ELSE v_clean END,
    'required_trades',5,
    'eligible',v_count=5 AND v_clean=5
  );
END;
$$;
REVOKE ALL ON FUNCTION public.get_integrity_streak_progress() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_integrity_streak_progress() TO authenticated;

-- Achievement claiming is atomic and idempotent. The client cannot choose points,
-- append arbitrary badges, or award itself an achievement based on stale counts.
CREATE OR REPLACE FUNCTION public.claim_trust_achievement(p_achievement text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  actor uuid := auth.uid();
  v_profile public.profiles%ROWTYPE;
  v_progress jsonb;
  v_awarded boolean := false;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_achievement NOT IN ('Integrity Streak','Power User') THEN
    RAISE EXCEPTION 'Unsupported trust achievement';
  END IF;

  SELECT * INTO v_profile FROM public.profiles WHERE id=actor FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Profile not found'; END IF;

  IF p_achievement='Integrity Streak' THEN
    v_progress := public.get_integrity_streak_progress();
    IF COALESCE((v_progress->>'eligible')::boolean,false) IS NOT TRUE THEN
      RETURN jsonb_build_object('awarded',false,'reason','Five consecutive released seller transactions are required','progress',v_progress);
    END IF;
  ELSIF COALESCE(v_profile.total_sales,0)<20 OR COALESCE(v_profile.plug_score,0)<700 THEN
    RETURN jsonb_build_object('awarded',false,'reason','Power User requires 20 completed sales and PlugScore of at least 700');
  END IF;

  IF COALESCE(v_profile.badges,ARRAY[]::text[]) @> ARRAY[p_achievement] THEN
    RETURN jsonb_build_object('awarded',false,'already_awarded',true,'achievement',p_achievement);
  END IF;

  PERFORM set_config('app.trust_score_write','on',true);
  UPDATE public.profiles
  SET badges=array_append(COALESCE(badges,ARRAY[]::text[]),p_achievement)
  WHERE id=actor;

  IF p_achievement='Integrity Streak' THEN
    PERFORM public.enqueue_plugscore_event(actor,'integrity_streak',25,NULL,jsonb_build_object('achievement',p_achievement));
  END IF;

  v_awarded := true;
  RETURN jsonb_build_object(
    'awarded',v_awarded,
    'achievement',p_achievement,
    'score_bonus',CASE WHEN p_achievement='Integrity Streak' THEN 25 ELSE 0 END,
    'progress',v_progress
  );
END;
$$;
REVOKE ALL ON FUNCTION public.claim_trust_achievement(text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.claim_trust_achievement(text) TO authenticated;

-- A worker crash cannot strand events forever. Stale processing rows are reclaimed,
-- and score application + completed status commit in the same transaction.
CREATE OR REPLACE FUNCTION public.process_plugscore_events(p_limit integer DEFAULT 50)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  event_row public.plugscore_events%ROWTYPE;
  processed integer := 0;
BEGIN
  IF auth.role() <> 'service_role' AND current_user NOT IN ('postgres','supabase_admin') THEN
    RAISE EXCEPTION 'PlugScore worker is service-only';
  END IF;

  FOR event_row IN
    SELECT *
    FROM public.plugscore_events
    WHERE (status='pending' AND available_at<=now())
       OR (status='processing' AND updated_at<=now()-interval '5 minutes')
    ORDER BY created_at
    LIMIT greatest(1,least(COALESCE(p_limit,50),100))
    FOR UPDATE SKIP LOCKED
  LOOP
    UPDATE public.plugscore_events
    SET status='processing',attempts=attempts+1,updated_at=now()
    WHERE id=event_row.id;

    BEGIN
      PERFORM set_config('app.trust_score_write','on',true);
      UPDATE public.profiles
      SET plug_score=least(1000,greatest(0,COALESCE(plug_score,500)+event_row.points))
      WHERE id=event_row.user_id;
      IF NOT FOUND THEN RAISE EXCEPTION 'PlugScore recipient no longer exists'; END IF;

      UPDATE public.plugscore_events
      SET status='completed',processed_at=now(),updated_at=now()
      WHERE id=event_row.id;
      processed:=processed+1;
    EXCEPTION WHEN OTHERS THEN
      UPDATE public.plugscore_events
      SET status=CASE WHEN attempts>=5 THEN 'failed' ELSE 'pending' END,
          available_at=now()+make_interval(secs=>least(300,power(2,attempts)::integer)),
          updated_at=now()
      WHERE id=event_row.id;
    END;
  END LOOP;
  RETURN processed;
END;
$$;
REVOKE ALL ON FUNCTION public.process_plugscore_events(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.process_plugscore_events(integer) TO service_role;

COMMENT ON FUNCTION public.claim_trust_achievement(text) IS
  'Atomically claims a server-validated trust achievement; clients cannot write reputation fields directly.';
COMMENT ON FUNCTION public.process_plugscore_events(integer) IS
  'Idempotent, crash-recoverable PlugScore worker. Score changes and event completion commit atomically.';
