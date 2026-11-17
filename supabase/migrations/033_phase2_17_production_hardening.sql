-- Campus Plug v6.9+ production hardening: Phases 2-17
-- Forward-only migration. The client requests; the server decides; the database enforces.

-- ---------------------------------------------------------------------------
-- Phase 2: authorization primitives
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_platform_admin()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT COALESCE((auth.jwt()->'app_metadata'->>'role') IN ('admin','platform_admin'), false)
      OR auth.role() = 'service_role';
$$;
REVOKE ALL ON FUNCTION public.is_platform_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_platform_admin() TO authenticated, service_role;

-- Jury writes are only valid for assigned jurors on active cases.
DROP POLICY IF EXISTS "Jurors submit votes" ON public.jury_votes;
CREATE POLICY "Assigned jurors submit votes" ON public.jury_votes
  FOR INSERT TO authenticated
  WITH CHECK (
    auth.uid() = juror_id
    AND EXISTS (
      SELECT 1 FROM public.jury_cases c
      WHERE c.id = jury_votes.case_id
        AND c.status = 'deliberating'
        AND auth.uid() = ANY(c.jurors_assigned)
    )
  );

-- ---------------------------------------------------------------------------
-- Phase 3: financial integrity guard
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_profile_balance_mutation()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF (NEW.balance IS DISTINCT FROM OLD.balance OR NEW.plug_credit_balance IS DISTINCT FROM OLD.plug_credit_balance)
     AND auth.role() <> 'service_role'
     AND COALESCE(current_setting('app.financial_write', true), '0') <> '1' THEN
    RAISE EXCEPTION 'Direct wallet balance mutation is not permitted';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS guard_profile_balance_mutation ON public.profiles;
CREATE TRIGGER guard_profile_balance_mutation
BEFORE UPDATE OF balance, plug_credit_balance ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.guard_profile_balance_mutation();

-- ---------------------------------------------------------------------------
-- Phase 4: reusable idempotency ledger
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.idempotency_keys (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  scope text NOT NULL,
  actor_id uuid REFERENCES public.profiles(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  response jsonb,
  status text NOT NULL DEFAULT 'processing' CHECK (status IN ('processing','completed','failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE(scope, actor_id, idempotency_key)
);
ALTER TABLE public.idempotency_keys ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users manage own idempotency keys" ON public.idempotency_keys;
CREATE POLICY "Users read own idempotency keys" ON public.idempotency_keys
  FOR SELECT TO authenticated USING (auth.uid() = actor_id);

CREATE OR REPLACE FUNCTION public.claim_idempotency_key(
  p_scope text, p_key text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE actor uuid := auth.uid(); row_data public.idempotency_keys%ROWTYPE;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_scope IS NULL OR length(trim(p_scope)) < 1 OR length(trim(p_scope)) > 80 THEN RAISE EXCEPTION 'Invalid idempotency scope'; END IF;
  IF p_key IS NULL OR length(trim(p_key)) < 8 OR length(trim(p_key)) > 200 THEN RAISE EXCEPTION 'Invalid idempotency key'; END IF;
  INSERT INTO public.idempotency_keys(scope,actor_id,idempotency_key)
  VALUES(trim(p_scope),actor,trim(p_key))
  ON CONFLICT(scope,actor_id,idempotency_key) DO NOTHING;
  SELECT * INTO row_data FROM public.idempotency_keys
  WHERE scope=trim(p_scope) AND actor_id=actor AND idempotency_key=trim(p_key);
  RETURN jsonb_build_object('claimed', row_data.status='processing' AND row_data.response IS NULL,
                            'status', row_data.status, 'response', row_data.response);
END;
$$;
REVOKE ALL ON FUNCTION public.claim_idempotency_key(text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.claim_idempotency_key(text,text) TO authenticated;

CREATE OR REPLACE FUNCTION public.complete_idempotency_key(
  p_scope text, p_key text, p_response jsonb, p_failed boolean DEFAULT false
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  UPDATE public.idempotency_keys
  SET status=CASE WHEN p_failed THEN 'failed' ELSE 'completed' END,
      response=p_response, completed_at=now()
  WHERE scope=trim(p_scope) AND actor_id=auth.uid() AND idempotency_key=trim(p_key);
END;
$$;
REVOKE ALL ON FUNCTION public.complete_idempotency_key(text,text,jsonb,boolean) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.complete_idempotency_key(text,text,jsonb,boolean) TO authenticated;

-- ---------------------------------------------------------------------------
-- Phase 5: dispute state machine
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_jury_case_transition()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;
  IF NOT (
    (OLD.status='open' AND NEW.status IN ('deliberating','closed')) OR
    (OLD.status='deliberating' AND NEW.status IN ('decided','escalated','closed')) OR
    (OLD.status='escalated' AND NEW.status IN ('deliberating','decided','closed')) OR
    (OLD.status='decided' AND NEW.status='closed')
  ) THEN
    RAISE EXCEPTION 'Invalid jury case transition: % -> %', OLD.status, NEW.status;
  END IF;
  IF NEW.status='decided' AND NEW.verdict IS NULL THEN RAISE EXCEPTION 'A decided case requires a verdict'; END IF;
  IF NEW.status='closed' AND OLD.status='decided' AND NEW.verdict IS NULL THEN RAISE EXCEPTION 'Closed case must retain its verdict'; END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS guard_jury_case_transition ON public.jury_cases;
CREATE TRIGGER guard_jury_case_transition
BEFORE UPDATE OF status ON public.jury_cases
FOR EACH ROW EXECUTE FUNCTION public.guard_jury_case_transition();

-- ---------------------------------------------------------------------------
-- Phase 6: privileged audit helper
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.write_security_audit(
  p_entity_type text, p_entity_id uuid, p_action text, p_metadata jsonb DEFAULT '{}'::jsonb
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE audit_id uuid;
BEGIN
  IF auth.uid() IS NULL AND auth.role() <> 'service_role' THEN RAISE EXCEPTION 'Authentication required'; END IF;
  INSERT INTO public.audit_logs(entity_type,entity_id,user_id,action,metadata)
  VALUES(p_entity_type,p_entity_id,auth.uid(),p_action,COALESCE(p_metadata,'{}'::jsonb))
  RETURNING id INTO audit_id;
  RETURN audit_id;
END;
$$;
REVOKE ALL ON FUNCTION public.write_security_audit(text,uuid,text,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.write_security_audit(text,uuid,text,jsonb) TO authenticated,service_role;

-- ---------------------------------------------------------------------------
-- Phase 8: rate limiting / abuse protection
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.rate_limit_buckets (
  bucket_key text PRIMARY KEY,
  window_started_at timestamptz NOT NULL DEFAULT now(),
  hit_count integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.rate_limit_buckets ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.consume_rate_limit(
  p_scope text, p_limit integer, p_window_seconds integer
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE actor text := COALESCE(auth.uid()::text, 'anonymous');
DECLARE k text := left(trim(p_scope)||':'||actor, 250);
DECLARE b public.rate_limit_buckets%ROWTYPE;
BEGIN
  IF p_limit < 1 OR p_limit > 10000 OR p_window_seconds < 1 OR p_window_seconds > 86400 THEN RAISE EXCEPTION 'Invalid rate limit configuration'; END IF;
  INSERT INTO public.rate_limit_buckets(bucket_key) VALUES(k) ON CONFLICT DO NOTHING;
  SELECT * INTO b FROM public.rate_limit_buckets WHERE bucket_key=k FOR UPDATE;
  IF b.window_started_at + make_interval(secs => p_window_seconds) <= now() THEN
    UPDATE public.rate_limit_buckets SET window_started_at=now(),hit_count=1,updated_at=now() WHERE bucket_key=k;
    RETURN jsonb_build_object('allowed',true,'remaining',p_limit-1,'reset_at',now()+make_interval(secs=>p_window_seconds));
  END IF;
  IF b.hit_count >= p_limit THEN
    RETURN jsonb_build_object('allowed',false,'remaining',0,'reset_at',b.window_started_at+make_interval(secs=>p_window_seconds));
  END IF;
  UPDATE public.rate_limit_buckets SET hit_count=hit_count+1,updated_at=now() WHERE bucket_key=k;
  RETURN jsonb_build_object('allowed',true,'remaining',p_limit-b.hit_count-1,'reset_at',b.window_started_at+make_interval(secs=>p_window_seconds));
END;
$$;
REVOKE ALL ON FUNCTION public.consume_rate_limit(text,integer,integer) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.consume_rate_limit(text,integer,integer) TO authenticated,service_role;

-- ---------------------------------------------------------------------------
-- Phase 9: trust anti-gaming event ledger
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.trust_events (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  source_id uuid,
  weight integer NOT NULL DEFAULT 0,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id,event_type,source_id)
);
ALTER TABLE public.trust_events ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS trust_events_user_created_idx ON public.trust_events(user_id,created_at DESC);
CREATE POLICY "Users read own trust events" ON public.trust_events FOR SELECT TO authenticated USING(auth.uid()=user_id);

-- ---------------------------------------------------------------------------
-- Phase 10: notification deduplication
-- ---------------------------------------------------------------------------
ALTER TABLE public.notifications ADD COLUMN IF NOT EXISTS dedupe_key text;
CREATE OR REPLACE FUNCTION public.set_notification_dedupe_key()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  NEW.dedupe_key := COALESCE(
    NEW.data->>'event_id',
    md5(COALESCE(NEW.user_id::text,'')||'|'||COALESCE(NEW.type,'')||'|'||COALESCE(NEW.data::text,'')||'|'||COALESCE(NEW.body,''))
  );
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS set_notification_dedupe_key ON public.notifications;
CREATE TRIGGER set_notification_dedupe_key BEFORE INSERT ON public.notifications
FOR EACH ROW EXECUTE FUNCTION public.set_notification_dedupe_key();
CREATE UNIQUE INDEX IF NOT EXISTS notifications_user_dedupe_uidx
ON public.notifications(user_id,dedupe_key) WHERE dedupe_key IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Phase 11: operational events (no secrets/PII by design)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.system_events (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  event_name text NOT NULL,
  severity text NOT NULL DEFAULT 'info' CHECK(severity IN ('debug','info','warn','error','critical')),
  request_id text,
  actor_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  entity_type text,
  entity_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.system_events ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS system_events_created_idx ON public.system_events(created_at DESC);
CREATE INDEX IF NOT EXISTS system_events_request_idx ON public.system_events(request_id) WHERE request_id IS NOT NULL;
CREATE POLICY "Admins read system events" ON public.system_events FOR SELECT TO authenticated USING(public.is_platform_admin());
CREATE POLICY "Service writes system events" ON public.system_events FOR INSERT TO service_role WITH CHECK(true);

-- ---------------------------------------------------------------------------
-- Phase 12/13: retention registry and safe cleanup
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.retention_policies (
  data_class text PRIMARY KEY,
  retention_days integer NOT NULL CHECK(retention_days >= 1 AND retention_days <= 36500),
  rationale text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.retention_policies(data_class,retention_days,rationale) VALUES
 ('beacon_current',1,'Current proximity state only'),
 ('beacon_history',7,'Short operational troubleshooting window'),
 ('rate_limit_buckets',2,'Abuse-control state'),
 ('system_events',90,'Operational diagnostics'),
 ('idempotency_keys',90,'Replay protection and incident investigation'),
 ('chat_scan_logs',90,'Moderation audit without plaintext retention')
ON CONFLICT(data_class) DO UPDATE SET retention_days=EXCLUDED.retention_days,rationale=EXCLUDED.rationale,updated_at=now();
ALTER TABLE public.retention_policies ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins read retention policies" ON public.retention_policies FOR SELECT TO authenticated USING(public.is_platform_admin());

CREATE OR REPLACE FUNCTION public.cleanup_phase2_17_data()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE n_rate bigint:=0; n_events bigint:=0; n_idem bigint:=0; n_scan bigint:=0;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'Service role required'; END IF;
  DELETE FROM public.rate_limit_buckets WHERE updated_at < now()-interval '2 days'; GET DIAGNOSTICS n_rate=ROW_COUNT;
  DELETE FROM public.system_events WHERE created_at < now()-interval '90 days'; GET DIAGNOSTICS n_events=ROW_COUNT;
  DELETE FROM public.idempotency_keys WHERE created_at < now()-interval '90 days' AND status <> 'processing'; GET DIAGNOSTICS n_idem=ROW_COUNT;
  DELETE FROM public.chat_scan_logs WHERE scanned_at < now()-interval '90 days'; GET DIAGNOSTICS n_scan=ROW_COUNT;
  RETURN jsonb_build_object('rate_limit_buckets',n_rate,'system_events',n_events,'idempotency_keys',n_idem,'chat_scan_logs',n_scan);
END;
$$;
REVOKE ALL ON FUNCTION public.cleanup_phase2_17_data() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_phase2_17_data() TO service_role;

-- ---------------------------------------------------------------------------
-- Phase 14: high-value indexes
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS transactions_buyer_status_idx ON public.transactions(buyer_id,status,created_at DESC);
CREATE INDEX IF NOT EXISTS transactions_seller_status_idx ON public.transactions(seller_id,status,created_at DESC);
CREATE INDEX IF NOT EXISTS notifications_user_created_idx ON public.notifications(user_id,created_at DESC);
CREATE INDEX IF NOT EXISTS jury_cases_status_created_idx ON public.jury_cases(status,created_at DESC);
CREATE INDEX IF NOT EXISTS messages_transaction_created_idx ON public.messages(transaction_id,created_at ASC);

-- ---------------------------------------------------------------------------
-- Phase 16/17 support: test/CI metadata
-- ---------------------------------------------------------------------------
COMMENT ON TABLE public.idempotency_keys IS 'Phase 4: server-side replay protection for retriable mutations';
COMMENT ON TABLE public.rate_limit_buckets IS 'Phase 8: server-side abuse controls; no client-visible identity data';
COMMENT ON TABLE public.trust_events IS 'Phase 9: authoritative trust inputs; frontend cannot insert';
COMMENT ON TABLE public.system_events IS 'Phase 11: operational telemetry; never store secrets or plaintext private messages';
COMMENT ON TABLE public.retention_policies IS 'Phase 13: documented data lifecycle policy';
