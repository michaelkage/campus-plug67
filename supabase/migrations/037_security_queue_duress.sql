-- Campus Plug v6.11: server image verification, async PlugScore queue, and duress freeze.
-- Append-only migration.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Async PlugScore queue
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.plugscore_events (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid REFERENCES public.profiles(id) ON DELETE CASCADE NOT NULL,
  event_type text NOT NULL,
  points integer NOT NULL,
  reference_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','completed','failed')),
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS plugscore_events_pending_idx
  ON public.plugscore_events(status, available_at, created_at)
  WHERE status IN ('pending','processing');
ALTER TABLE public.plugscore_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service manages plugscore events" ON public.plugscore_events;
CREATE POLICY "Service manages plugscore events"
  ON public.plugscore_events FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.enqueue_plugscore_event(
  p_user_id uuid, p_event_type text, p_points integer, p_reference_id uuid DEFAULT NULL, p_metadata jsonb DEFAULT '{}'::jsonb
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE event_id uuid;
BEGIN
  INSERT INTO public.plugscore_events(user_id,event_type,points,reference_id,metadata)
  VALUES(p_user_id,p_event_type,p_points,p_reference_id,COALESCE(p_metadata,'{}'::jsonb))
  RETURNING id INTO event_id;
  RETURN event_id;
END; $$;
REVOKE ALL ON FUNCTION public.enqueue_plugscore_event(uuid,text,integer,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_plugscore_event(uuid,text,integer,uuid,jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.update_plugscore_on_event()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE seller uuid;
BEGIN
  IF TG_TABLE_NAME = 'listing_exif_flags' THEN
    IF NEW.verification_source = 'server_verified' AND NOT NEW.gps_mismatch AND NOT NEW.timestamp_flag THEN
      SELECT seller_id INTO seller FROM public.listings WHERE id=NEW.listing_id;
      IF seller IS NOT NULL THEN
        PERFORM public.enqueue_plugscore_event(seller,'verified_listing_metadata',10,NEW.listing_id,jsonb_build_object('source','server_verified'));
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME = 'transactions' THEN
    IF NEW.status='released' AND OLD.status!='released' THEN
      PERFORM public.enqueue_plugscore_event(NEW.seller_id,'escrow_release',50,NEW.id,'{}'::jsonb);
    END IF;
    RETURN NEW;
  END IF;
  RETURN NEW;
END; $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Duress / panic freeze
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS duress_code_hash text;

ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS duress_triggered_at timestamptz,
  ADD COLUMN IF NOT EXISTS duress_triggered_by uuid REFERENCES public.profiles(id),
  ADD COLUMN IF NOT EXISTS duress_alert_id uuid;

CREATE TABLE IF NOT EXISTS public.campus_security_alerts (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  transaction_id uuid REFERENCES public.transactions(id) ON DELETE SET NULL,
  reporter_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  counterparty_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  counterparty_server_fingerprint text,
  university text,
  alert_type text NOT NULL DEFAULT 'escrow_duress',
  severity text NOT NULL DEFAULT 'critical',
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged','resolved')),
  created_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS campus_security_alerts_open_idx
  ON public.campus_security_alerts(status, created_at DESC);
ALTER TABLE public.campus_security_alerts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service manages security alerts" ON public.campus_security_alerts;
CREATE POLICY "Service manages security alerts"
  ON public.campus_security_alerts FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.set_duress_code(p_code text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE actor uuid:=auth.uid();
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_code IS NULL OR p_code !~ '^[0-9]{4,8}$' THEN RAISE EXCEPTION 'Duress code must be 4-8 digits'; END IF;
  UPDATE public.profiles SET duress_code_hash=crypt(p_code,gen_salt('bf',10)) WHERE id=actor;
  RETURN jsonb_build_object('success',true);
END; $$;
REVOKE ALL ON FUNCTION public.set_duress_code(text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.set_duress_code(text) TO authenticated;

CREATE OR REPLACE FUNCTION public.activate_duress(p_transaction_id uuid,p_code text DEFAULT NULL,p_panic_token text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  actor uuid:=auth.uid(); tx public.transactions%ROWTYPE; counterparty uuid; fp text; alert_id uuid;
  valid_code boolean:=false;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  SELECT * INTO tx FROM public.transactions WHERE id=p_transaction_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Transaction not found'; END IF;
  IF actor<>tx.seller_id AND actor<>tx.buyer_id THEN RAISE EXCEPTION 'Not authorized for this transaction'; END IF;
  IF tx.status NOT IN ('locked','meetup_initiated','release_requested') THEN RAISE EXCEPTION 'Transaction is not active'; END IF;
  IF COALESCE((tx.metadata->>'duress_active')::boolean,false) THEN
    RETURN jsonb_build_object('success',true,'already_active',true,'transaction_id',tx.id);
  END IF;

  SELECT crypt(p_code,duress_code_hash)=duress_code_hash INTO valid_code
  FROM public.profiles WHERE id=actor AND duress_code_hash IS NOT NULL;
  IF COALESCE(valid_code,false) IS NOT TRUE AND p_panic_token IS NOT NULL THEN
    SELECT crypt(p_panic_token,duress_qr_token_hash)=duress_qr_token_hash INTO valid_code
    FROM public.profiles WHERE id=actor AND duress_qr_token_hash IS NOT NULL;
  END IF;
  IF NOT COALESCE(valid_code,false) THEN RAISE EXCEPTION 'Invalid duress credential'; END IF;

  counterparty := CASE WHEN actor=tx.seller_id THEN tx.buyer_id ELSE tx.seller_id END;
  SELECT server_fingerprint INTO fp FROM public.user_security WHERE user_id=counterparty ORDER BY created_at DESC NULLS LAST LIMIT 1;

  INSERT INTO public.campus_security_alerts(transaction_id,reporter_id,counterparty_id,counterparty_server_fingerprint,university,metadata)
  VALUES(tx.id,actor,counterparty,fp,(SELECT university FROM public.profiles WHERE id=actor),jsonb_build_object('reason',CASE WHEN p_panic_token IS NOT NULL THEN 'panic_qr' ELSE 'duress_code' END,'escrow_status',tx.status))
  RETURNING id INTO alert_id;

  UPDATE public.transactions
  SET escrow_status='frozen', duress_triggered_at=now(), duress_triggered_by=actor,
      duress_alert_id=alert_id,
      metadata=COALESCE(metadata,'{}'::jsonb)||jsonb_build_object('duress_active',true,'duress_alert_id',alert_id)
  WHERE id=tx.id;

  INSERT INTO public.audit_logs(user_id,entity_type,entity_id,action,metadata)
  VALUES(actor,'transaction',tx.id,'escrow_duress',jsonb_build_object('alert_id',alert_id,'counterparty_id',counterparty));

  RETURN jsonb_build_object('success',true,'frozen',true,'alert_id',alert_id,'transaction_id',tx.id);
END; $$;
REVOKE ALL ON FUNCTION public.activate_duress(uuid,text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.activate_duress(uuid,text,text) TO authenticated;

-- process_escrow_action is superseded by migration 040 so that the original
-- authoritative state machine remains intact while adding safe-zone enforcement.
