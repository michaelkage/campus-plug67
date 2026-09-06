-- Campus Plug v6.13: cross-device continuity.
-- Desktop is a preparation surface; physical meetup authorization is mobile-only.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- One-time desktop -> phone handoff. Never stores a bearer session token.
CREATE TABLE IF NOT EXISTS public.session_handoffs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  transaction_id uuid REFERENCES public.transactions(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS session_handoffs_user_idx ON public.session_handoffs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS session_handoffs_expiry_idx ON public.session_handoffs(expires_at) WHERE consumed_at IS NULL;
ALTER TABLE public.session_handoffs ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.create_session_handoff(p_transaction_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  actor uuid := auth.uid();
  raw_token text := encode(gen_random_bytes(32), 'hex');
  hash text := encode(digest(raw_token, 'sha256'), 'hex');
  handoff_id uuid;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_transaction_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.transactions t
    WHERE t.id=p_transaction_id AND (t.buyer_id=actor OR t.seller_id=actor)
  ) THEN RAISE EXCEPTION 'Not authorized for this transaction'; END IF;

  DELETE FROM public.session_handoffs WHERE user_id=actor AND (consumed_at IS NOT NULL OR expires_at < now());
  INSERT INTO public.session_handoffs(user_id,transaction_id,token_hash,expires_at)
  VALUES(actor,p_transaction_id,hash,now()+interval '2 minutes')
  RETURNING id INTO handoff_id;

  RETURN jsonb_build_object('token',raw_token,'expires_at',now()+interval '2 minutes','handoff_id',handoff_id,'transaction_id',p_transaction_id);
END; $$;
REVOKE ALL ON FUNCTION public.create_session_handoff(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.create_session_handoff(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.consume_session_handoff(p_token text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  row public.session_handoffs%ROWTYPE;
BEGIN
  IF p_token IS NULL OR length(p_token) < 32 THEN RETURN jsonb_build_object('success',false,'error','Invalid handoff token'); END IF;
  SELECT * INTO row FROM public.session_handoffs
  WHERE token_hash=encode(digest(p_token,'sha256'),'hex')
    AND consumed_at IS NULL AND expires_at > now()
  FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'error','Handoff expired or already used'); END IF;
  UPDATE public.session_handoffs SET consumed_at=now() WHERE id=row.id;
  RETURN jsonb_build_object('success',true,'user_id',row.user_id,'transaction_id',row.transaction_id);
END; $$;
REVOKE ALL ON FUNCTION public.consume_session_handoff(text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.consume_session_handoff(text) TO service_role;

-- Server-side mobile arrival endpoint. The Edge Function supplies the user/device
-- classification after inspecting the real HTTP User-Agent.
CREATE OR REPLACE FUNCTION public.record_safe_arrival_v2(
  p_transaction_id uuid,
  p_role text,
  p_lat numeric,
  p_lng numeric,
  p_user_id uuid,
  p_device_type text
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  tx public.transactions%ROWTYPE;
  uni text;
  z record;
BEGIN
  IF p_device_type <> 'mobile' THEN
    RETURN jsonb_build_object('success',false,'code','MOBILE_REQUIRED','message','Meetup release must be completed on a phone with GPS.');
  END IF;
  IF p_user_id IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_role NOT IN ('buyer','seller') THEN RAISE EXCEPTION 'Invalid arrival role'; END IF;
  IF p_lat IS NULL OR p_lng IS NULL OR p_lat NOT BETWEEN -90 AND 90 OR p_lng NOT BETWEEN -180 AND 180 THEN RAISE EXCEPTION 'Invalid coordinates'; END IF;
  SELECT * INTO tx FROM public.transactions WHERE id=p_transaction_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Transaction not found'; END IF;
  IF (p_role='buyer' AND tx.buyer_id<>p_user_id) OR (p_role='seller' AND tx.seller_id<>p_user_id) THEN RAISE EXCEPTION 'Not authorized for this transaction'; END IF;
  SELECT university INTO uni FROM public.profiles WHERE id=p_user_id;
  IF uni IS NULL THEN RAISE EXCEPTION 'University is required for safe-zone validation'; END IF;
  SELECT * INTO z FROM public.is_in_safe_swap_zone(p_lat,p_lng,uni) LIMIT 1;
  IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'within_safe_zone',false,'message','Outside an approved 50m Safe Swap Zone'); END IF;

  IF p_role='buyer' THEN
    UPDATE public.transactions SET buyer_arrived=true,buyer_arrival_time=now(),buyer_lat=p_lat,buyer_lng=p_lng,buyer_location_captured_at=now(),buyer_safe_zone_id=z.zone_id WHERE id=tx.id;
  ELSE
    UPDATE public.transactions SET seller_arrived=true,seller_arrival_time=now(),seller_lat=p_lat,seller_lng=p_lng,seller_location_captured_at=now(),seller_safe_zone_id=z.zone_id WHERE id=tx.id;
  END IF;
  RETURN jsonb_build_object('success',true,'within_safe_zone',true,'zone_id',z.zone_id,'zone_name',z.zone_name,'distance_m',z.distance_m,'device_type','mobile');
END; $$;
REVOKE ALL ON FUNCTION public.record_safe_arrival_v2(uuid,text,numeric,numeric,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.record_safe_arrival_v2(uuid,text,numeric,numeric,uuid,text) TO service_role;

-- Existing direct arrival RPC remains for backwards compatibility, but the new UI
-- path uses record_safe_arrival_v2 through the server-gated Edge Function.

-- Mark uploads requiring a mobile live-photo confirmation when desktop-originated.
ALTER TABLE public.listings
  ADD COLUMN IF NOT EXISTS verification_source_device text,
  ADD COLUMN IF NOT EXISTS mobile_verification_required boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS mobile_verification_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS mobile_verification_completed_at timestamptz;

-- Keep old passkeys usable while making hybrid/phone handoff an explicit supported transport.
UPDATE public.passkey_credentials
SET transports=ARRAY['internal','hybrid']::text[]
WHERE transports IS NULL OR cardinality(transports)=0;

CREATE INDEX IF NOT EXISTS transactions_mobile_release_idx
  ON public.transactions(id,buyer_location_captured_at)
  WHERE status='meetup_initiated';
