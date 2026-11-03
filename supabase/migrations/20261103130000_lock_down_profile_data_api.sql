-- Lock down the private profiles table and publish only an explicit safe projection.
-- Public profile reads move to public_profiles; the signed-in user's own profile
-- is served through an auth.uid()-scoped RPC.

CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC;
GRANT USAGE ON SCHEMA private TO authenticated;

CREATE TABLE IF NOT EXISTS public.public_profiles (
  id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  full_name text,
  university text,
  department text,
  course text,
  level text,
  avatar_url text,
  bio text,
  plug_score integer,
  total_sales integer,
  total_earnings bigint,
  badges text[],
  is_verified boolean,
  created_at timestamptz,
  tier text
);

ALTER TABLE public.public_profiles ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS public_profiles_plug_score_idx
  ON public.public_profiles (plug_score DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS public_profiles_total_sales_idx
  ON public.public_profiles (total_sales DESC NULLS LAST);

DROP POLICY IF EXISTS "Public profiles are readable by everyone" ON public.public_profiles;
CREATE POLICY "Public profiles are readable by everyone"
  ON public.public_profiles
  FOR SELECT
  TO anon, authenticated
  USING (true);

REVOKE ALL PRIVILEGES ON TABLE public.public_profiles FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.public_profiles TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION private.sync_public_profile_projection()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF TG_OP = 'UPDATE'
     AND ROW(
       NEW.full_name,
       NEW.university,
       NEW.department,
       NEW.course,
       NEW.level,
       NEW.avatar_url,
       NEW.bio,
       NEW.plug_score,
       NEW.total_sales,
       NEW.total_earnings,
       NEW.badges,
       NEW.is_verified,
       NEW.created_at,
       NEW.tier
     ) IS NOT DISTINCT FROM ROW(
       OLD.full_name,
       OLD.university,
       OLD.department,
       OLD.course,
       OLD.level,
       OLD.avatar_url,
       OLD.bio,
       OLD.plug_score,
       OLD.total_sales,
       OLD.total_earnings,
       OLD.badges,
       OLD.is_verified,
       OLD.created_at,
       OLD.tier
     ) THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.public_profiles (
    id,
    full_name,
    university,
    department,
    course,
    level,
    avatar_url,
    bio,
    plug_score,
    total_sales,
    total_earnings,
    badges,
    is_verified,
    created_at,
    tier
  )
  VALUES (
    NEW.id,
    NEW.full_name,
    NEW.university,
    NEW.department,
    NEW.course,
    NEW.level,
    NEW.avatar_url,
    NEW.bio,
    NEW.plug_score,
    NEW.total_sales,
    NEW.total_earnings,
    NEW.badges,
    NEW.is_verified,
    NEW.created_at,
    NEW.tier
  )
  ON CONFLICT (id) DO UPDATE
  SET
    full_name = EXCLUDED.full_name,
    university = EXCLUDED.university,
    department = EXCLUDED.department,
    course = EXCLUDED.course,
    level = EXCLUDED.level,
    avatar_url = EXCLUDED.avatar_url,
    bio = EXCLUDED.bio,
    plug_score = EXCLUDED.plug_score,
    total_sales = EXCLUDED.total_sales,
    total_earnings = EXCLUDED.total_earnings,
    badges = EXCLUDED.badges,
    is_verified = EXCLUDED.is_verified,
    created_at = EXCLUDED.created_at,
    tier = EXCLUDED.tier;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION private.sync_public_profile_projection()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS profiles_sync_public_projection ON public.profiles;
CREATE TRIGGER profiles_sync_public_projection
  AFTER INSERT OR UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION private.sync_public_profile_projection();

-- Backfill the public projection before removing direct profile-table reads.
INSERT INTO public.public_profiles (
  id,
  full_name,
  university,
  department,
  course,
  level,
  avatar_url,
  bio,
  plug_score,
  total_sales,
  total_earnings,
  badges,
  is_verified,
  created_at,
  tier
)
SELECT
  p.id,
  p.full_name,
  p.university,
  p.department,
  p.course,
  p.level,
  p.avatar_url,
  p.bio,
  p.plug_score,
  p.total_sales,
  p.total_earnings,
  p.badges,
  p.is_verified,
  p.created_at,
  p.tier
FROM public.profiles AS p
ON CONFLICT (id) DO UPDATE
SET
  full_name = EXCLUDED.full_name,
  university = EXCLUDED.university,
  department = EXCLUDED.department,
  course = EXCLUDED.course,
  level = EXCLUDED.level,
  avatar_url = EXCLUDED.avatar_url,
  bio = EXCLUDED.bio,
  plug_score = EXCLUDED.plug_score,
  total_sales = EXCLUDED.total_sales,
  total_earnings = EXCLUDED.total_earnings,
  badges = EXCLUDED.badges,
  is_verified = EXCLUDED.is_verified,
  created_at = EXCLUDED.created_at,
  tier = EXCLUDED.tier;

-- Public reads are now served from public_profiles. Keep only an own-row id
-- lookup on profiles so authenticated UPDATE statements filtered by id still work.
REVOKE SELECT ON TABLE public.profiles FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.profiles FROM PUBLIC, anon;
GRANT SELECT (id) ON TABLE public.profiles TO authenticated;

DROP POLICY IF EXISTS "Profiles viewable by all" ON public.profiles;
DROP POLICY IF EXISTS "Users can read own profile" ON public.profiles;
CREATE POLICY "Users can read own profile"
  ON public.profiles
  FOR SELECT
  TO authenticated
  USING ((SELECT auth.uid()) = id);

CREATE OR REPLACE FUNCTION private.get_my_profile()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT pg_catalog.to_jsonb(p) - ARRAY[
    'last_known_ip',
    'duress_code_hash',
    'duress_qr_token_hash',
    'commission_rate',
    'collusion_flag',
    'collusion_flagged_at',
    'collusion_ceiling',
    'gps_spoof_flags'
  ]
  FROM public.profiles AS p
  WHERE p.id = (SELECT auth.uid());
$function$;

CREATE OR REPLACE FUNCTION public.get_my_profile()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $function$
  SELECT private.get_my_profile();
$function$;

CREATE OR REPLACE FUNCTION private.get_my_referrals()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'id', p.id,
        'full_name', p.full_name,
        'created_at', p.created_at
      )
      ORDER BY p.created_at DESC
    ),
    '[]'::jsonb
  )
  FROM public.profiles AS p
  WHERE p.referred_by = (SELECT auth.uid());
$function$;

CREATE OR REPLACE FUNCTION public.get_my_referrals()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $function$
  SELECT private.get_my_referrals();
$function$;

REVOKE ALL ON FUNCTION private.get_my_profile()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.get_my_profile() TO authenticated;

REVOKE ALL ON FUNCTION public.get_my_profile()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_my_profile() TO authenticated;

REVOKE ALL ON FUNCTION private.get_my_referrals()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.get_my_referrals() TO authenticated;

REVOKE ALL ON FUNCTION public.get_my_referrals()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_my_referrals() TO authenticated;

-- This legacy SECURITY DEFINER RPC returns complete profiles (including private
-- columns) and has no current repository call sites.
REVOKE ALL ON FUNCTION public.search_users_by_department(text)
  FROM PUBLIC, anon, authenticated, service_role;

-- Trigger functions are invoked by their triggers; client EXECUTE grants are
-- unnecessary and make them appear as callable SECURITY DEFINER RPCs.
DO $revoke_trigger_execute$
DECLARE
  trigger_signature regprocedure;
BEGIN
  PERFORM pg_catalog.set_config('search_path', 'pg_catalog', true);

  FOR trigger_signature IN
    SELECT p.oid::regprocedure
    FROM pg_proc AS p
    JOIN pg_namespace AS n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prosecdef
      AND p.prorettype = 'trigger'::regtype
      AND EXISTS (
        SELECT 1
        FROM pg_trigger AS t
        WHERE t.tgfoid = p.oid
          AND NOT t.tgisinternal
      )
  LOOP
    EXECUTE pg_catalog.format(
      'REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role',
      trigger_signature
    );
  END LOOP;
END;
$revoke_trigger_execute$;

DO $assertions$
DECLARE
  profile_oid oid := 'public.profiles'::regclass;
  public_profiles_oid oid := 'public.public_profiles'::regclass;
  my_profile_oid oid := to_regprocedure('public.get_my_profile()');
  my_referrals_oid oid := to_regprocedure('public.get_my_referrals()');
BEGIN
  IF has_column_privilege('anon', profile_oid, 'email', 'SELECT')
     OR has_column_privilege('anon', profile_oid, 'matric_number', 'SELECT')
     OR has_column_privilege('anon', profile_oid, 'last_known_ip', 'SELECT')
     OR has_column_privilege('anon', profile_oid, 'plug_credit_balance', 'SELECT')
     OR has_column_privilege('anon', profile_oid, 'duress_code_hash', 'SELECT')
     OR has_column_privilege('authenticated', profile_oid, 'email', 'SELECT')
     OR has_column_privilege('authenticated', profile_oid, 'matric_number', 'SELECT')
     OR has_column_privilege('authenticated', profile_oid, 'last_known_ip', 'SELECT')
     OR has_column_privilege('authenticated', profile_oid, 'plug_credit_balance', 'SELECT')
     OR has_column_privilege('authenticated', profile_oid, 'duress_code_hash', 'SELECT') THEN
    RAISE EXCEPTION 'Client roles must not read private profile columns';
  END IF;

  IF NOT has_column_privilege('authenticated', profile_oid, 'id', 'SELECT') THEN
    RAISE EXCEPTION 'Authenticated users need own-profile id access for row-scoped updates';
  END IF;

  IF NOT has_table_privilege('anon', public_profiles_oid, 'SELECT')
     OR NOT has_table_privilege('authenticated', public_profiles_oid, 'SELECT')
     OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = public_profiles_oid) THEN
    RAISE EXCEPTION 'The public profile projection must be readable with RLS enabled';
  END IF;

  IF has_function_privilege('anon', my_profile_oid, 'EXECUTE')
     OR has_function_privilege('anon', my_referrals_oid, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', my_profile_oid, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', my_referrals_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'Private profile RPCs must be authenticated-only';
  END IF;

  IF has_function_privilege('anon', 'public.search_users_by_department(text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.search_users_by_department(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Legacy full-profile search RPC must not be client executable';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_proc AS p
    JOIN pg_namespace AS n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prosecdef
      AND p.prorettype = 'trigger'::regtype
      AND EXISTS (
        SELECT 1
        FROM pg_trigger AS t
        WHERE t.tgfoid = p.oid
          AND NOT t.tgisinternal
      )
      AND (
        has_function_privilege('anon', p.oid, 'EXECUTE')
        OR has_function_privilege('authenticated', p.oid, 'EXECUTE')
      )
  ) THEN
    RAISE EXCEPTION 'Public SECURITY DEFINER trigger functions must not be client executable';
  END IF;
END;
$assertions$;

NOTIFY pgrst, 'reload schema';
