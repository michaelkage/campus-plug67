-- Campus Plug v6.11 follow-up: durable asynchronous PlugScore worker.
-- Keeps rating/listing/escrow transactions free of non-critical score arithmetic.

CREATE OR REPLACE FUNCTION public.process_plugscore_events(p_limit integer DEFAULT 50)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE event_row record; processed integer:=0;
BEGIN
  FOR event_row IN
    SELECT * FROM public.plugscore_events
    WHERE status='pending' AND available_at<=now()
    ORDER BY created_at
    LIMIT greatest(1,least(p_limit,100))
    FOR UPDATE SKIP LOCKED
  LOOP
    UPDATE public.plugscore_events SET status='processing',attempts=attempts+1 WHERE id=event_row.id;
    BEGIN
      UPDATE public.profiles
      SET plug_score=least(COALESCE(plug_score,0)+event_row.points,1000)
      WHERE id=event_row.user_id;
      UPDATE public.plugscore_events SET status='completed',processed_at=now() WHERE id=event_row.id;
      processed:=processed+1;
    EXCEPTION WHEN OTHERS THEN
      UPDATE public.plugscore_events
      SET status=CASE WHEN attempts>=5 THEN 'failed' ELSE 'pending' END,
          available_at=now()+make_interval(secs=>least(300,power(2,attempts)::integer))
      WHERE id=event_row.id;
    END;
  END LOOP;
  RETURN processed;
END; $$;
REVOKE ALL ON FUNCTION public.process_plugscore_events(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.process_plugscore_events(integer) TO service_role;

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname='campus-plugscore-worker';
SELECT cron.schedule('campus-plugscore-worker','* * * * *','SELECT public.process_plugscore_events(50);');
