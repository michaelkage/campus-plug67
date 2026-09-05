-- Campus Plug: PlugScore daily caps + multi-signal device ban checks.
-- Append-only: do not edit older migrations.

-- Daily PlugScore accrual ledger. Caps prevent farm rings from inflating trust overnight.
CREATE TABLE IF NOT EXISTS public.plugscore_daily_caps (
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  day date NOT NULL DEFAULT ((timezone('utc', now()))::date),
  points_earned integer NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);
ALTER TABLE public.plugscore_daily_caps ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users read own plugscore caps" ON public.plugscore_daily_caps;
CREATE POLICY "Users read own plugscore caps"
  ON public.plugscore_daily_caps FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION public.award_plugscore(p_user_id uuid, p_points integer, p_daily_cap integer DEFAULT 100)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  today date := (timezone('utc', now()))::date;
  earned integer := 0;
  room integer;
  granted integer := 0;
BEGIN
  IF p_user_id IS NULL OR p_points IS NULL OR p_points <= 0 THEN
    RETURN 0;
  END IF;

  INSERT INTO public.plugscore_daily_caps(user_id, day, points_earned)
  VALUES (p_user_id, today, 0)
  ON CONFLICT (user_id, day) DO NOTHING;

  SELECT points_earned INTO earned
  FROM public.plugscore_daily_caps
  WHERE user_id = p_user_id AND day = today
  FOR UPDATE;

  room := GREATEST(p_daily_cap - COALESCE(earned, 0), 0);
  granted := LEAST(p_points, room);
  IF granted <= 0 THEN
    RETURN 0;
  END IF;

  UPDATE public.plugscore_daily_caps
  SET points_earned = points_earned + granted
  WHERE user_id = p_user_id AND day = today;

  UPDATE public.profiles
  SET plug_score = LEAST(COALESCE(plug_score, 0) + granted, 1000)
  WHERE id = p_user_id;

  RETURN granted;
END;
$$;
REVOKE ALL ON FUNCTION public.award_plugscore(uuid, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.award_plugscore(uuid, integer, integer) TO service_role;

CREATE OR REPLACE FUNCTION public.update_plugscore_on_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  seller uuid;
BEGIN
  IF TG_TABLE_NAME = 'listing_exif_flags' THEN
    IF NEW.verification_source = 'server_verified'
       AND NOT NEW.gps_mismatch
       AND NOT NEW.timestamp_flag THEN
      SELECT seller_id INTO seller FROM public.listings WHERE id = NEW.listing_id;
      PERFORM public.award_plugscore(seller, 10, 100);
      UPDATE public.listings SET metadata_verified = true WHERE id = NEW.listing_id;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'transactions' THEN
    IF NEW.status = 'released' AND OLD.status IS DISTINCT FROM 'released' THEN
      PERFORM public.award_plugscore(NEW.seller_id, 50, 100);
    END IF;
    RETURN NEW;
  END IF;

  RETURN NEW;
END;
$$;

-- Multi-signal ban check: exact server hash, IP subnet, or client correlation id.
ALTER TABLE public.banned_devices
  ADD COLUMN IF NOT EXISTS ban_reason text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='banned_devices' AND column_name='device_fingerprint'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='banned_devices' AND column_name='device_hash'
  ) THEN
    ALTER TABLE public.banned_devices RENAME COLUMN device_hash TO device_fingerprint;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.check_device_ban(
  p_server_fingerprint text,
  p_ip text DEFAULT NULL,
  p_client_fingerprint text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  hit_reason text;
  ip_inet inet;
BEGIN
  BEGIN
    IF p_ip IS NOT NULL AND length(trim(p_ip)) > 0 AND lower(trim(p_ip)) <> 'unknown' THEN
      ip_inet := trim(p_ip)::inet;
    END IF;
  EXCEPTION WHEN others THEN
    ip_inet := NULL;
  END;

  SELECT COALESCE(ban_reason, reason, 'This device has been restricted.')
  INTO hit_reason
  FROM public.banned_devices
  WHERE COALESCE(active, true)
    AND (
      (p_server_fingerprint IS NOT NULL AND server_fingerprint = p_server_fingerprint)
      OR (ip_inet IS NOT NULL AND ip_prefix IS NOT NULL AND ip_inet <<= ip_prefix)
      OR (
        p_client_fingerprint IS NOT NULL
        AND length(p_client_fingerprint) >= 8
        AND (
          device_fingerprint = p_client_fingerprint
          OR server_fingerprint = p_client_fingerprint
        )
      )
    )
  LIMIT 1;

  IF hit_reason IS NOT NULL THEN
    RETURN jsonb_build_object('banned', true, 'reason', hit_reason);
  END IF;
  RETURN jsonb_build_object('banned', false);
END;
$$;
REVOKE ALL ON FUNCTION public.check_device_ban(text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_device_ban(text, text, text) TO service_role;
