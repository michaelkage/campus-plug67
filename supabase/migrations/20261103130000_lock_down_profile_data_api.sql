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

-- The profiles-table privilege cutover is intentionally a separate deployment.
-- First ship the frontend that uses public_profiles and the scoped RPCs; then
-- revoke legacy full-row SELECT access in the follow-up cutover migration.

CREATE OR REPLACE FUNCTION private.get_my_profile()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT pg_catalog.jsonb_build_object(
    'id', p.id,
    'email', p.email,
    'full_name', p.full_name,
    'university', p.university,
    'matric_number', p.matric_number,
    'department', p.department,
    'course', p.course,
    'level', p.level,
    'avatar_url', p.avatar_url,
    'bio', p.bio,
    'plug_score', p.plug_score,
    'total_sales', p.total_sales,
    'total_earnings', p.total_earnings,
    'badges', p.badges,
    'is_verified', p.is_verified,
    'is_suspended', p.is_suspended,
    'created_at', p.created_at,
    'updated_at', p.updated_at,
    'referred_by', p.referred_by,
    'referral_code', p.referral_code,
    'referral_count', p.referral_count,
    'streak_days', p.streak_days,
    'tier', p.tier,
    'tier_updated_at', p.tier_updated_at,
    'featured_listing_id', p.featured_listing_id,
    'top_of_feed', p.top_of_feed,
    'juror_enabled', p.juror_enabled,
    'rolling_accuracy', p.rolling_accuracy,
    'juror_streak', p.juror_streak,
    'juror_cases_today', p.juror_cases_today,
    'juror_last_case_at', p.juror_last_case_at,
    'magistrate_at', p.magistrate_at,
    'free_listing_tokens', p.free_listing_tokens,
    'priority_relist_today', p.priority_relist_today,
    'priority_relist_this_week', p.priority_relist_this_week,
    'last_position_reset', p.last_position_reset,
    'last_boost_at', p.last_boost_at,
    'boost_denials_this_week', p.boost_denials_this_week,
    'plug_credit_balance', p.plug_credit_balance,
    'theme_mode', p.theme_mode,
    'accepted_terms_at', p.accepted_terms_at,
    'is_admin', p.is_admin,
    'balance', p.balance,
    'preferences', p.preferences
  )
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
        'id', referred.id,
        'full_name', referred.full_name,
        'created_at', referred.created_at
      )
      ORDER BY referred.created_at DESC
    ),
    '[]'::jsonb
  )
  FROM (
    SELECT p.id, p.full_name, p.created_at
    FROM public.profiles AS p
    WHERE p.referred_by = (SELECT auth.uid())
    ORDER BY p.created_at DESC
    LIMIT 10
  ) AS referred;
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
      AND NOT EXISTS (
        SELECT 1
        FROM pg_depend AS extension_dependency
        WHERE extension_dependency.classid = 'pg_proc'::regclass
          AND extension_dependency.objid = p.oid
          AND extension_dependency.deptype = 'e'
      )
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
  public_profiles_oid oid := 'public.public_profiles'::regclass;
  my_profile_oid oid := to_regprocedure('public.get_my_profile()');
  my_referrals_oid oid := to_regprocedure('public.get_my_referrals()');
BEGIN
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
      AND NOT EXISTS (
        SELECT 1
        FROM pg_depend AS extension_dependency
        WHERE extension_dependency.classid = 'pg_proc'::regclass
          AND extension_dependency.objid = p.oid
          AND extension_dependency.deptype = 'e'
      )
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
