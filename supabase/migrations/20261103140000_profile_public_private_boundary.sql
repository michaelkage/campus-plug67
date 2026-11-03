-- Split public profile cards from private profile records.
--
-- public.profiles contains identity, wallet, moderation, security, and device
-- fields. Browser roles must only read their own full row. Public-facing
-- surfaces use a narrow owner-backed view with an explicit safe projection.

CREATE OR REPLACE VIEW public.public_profiles
WITH (security_barrier = true, security_invoker = false)
AS
SELECT
  p.id,
  p.full_name,
  p.university,
  p.department,
  p.level,
  p.avatar_url,
  p.bio,
  p.plug_score,
  p.total_sales,
  p.total_earnings,
  p.badges,
  p.is_verified,
  p.created_at,
  p.streak_days,
  p.tier,
  p.course
FROM public.profiles AS p;

ALTER VIEW public.public_profiles OWNER TO postgres;

REVOKE ALL ON TABLE public.public_profiles FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.public_profiles TO anon, authenticated;

-- Remove broad row visibility and give signed-in users only their own full
-- profile. Public profile cards are served by public.public_profiles instead.
DROP POLICY IF EXISTS "Profiles viewable by all" ON public.profiles;
DROP POLICY IF EXISTS "Users view own profile" ON public.profiles;

CREATE POLICY "Users view own profile"
  ON public.profiles
  FOR SELECT
  TO authenticated
  USING ((SELECT auth.uid()) = id);

-- Strip the excessive table grants (including DELETE, TRUNCATE, REFERENCES,
-- TRIGGER, and MAINTAIN). The auth.users trigger and trusted Edge Functions
-- run as privileged owners/service_role and retain their access.
REVOKE ALL ON TABLE public.profiles FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.profiles TO authenticated;

-- The old aggregate view is no longer queried directly by the client. The
-- SECURITY INVOKER get_public_profile_stats RPC is the supported public path.
REVOKE ALL ON TABLE public.public_profile_stats FROM PUBLIC, anon, authenticated;

DO $profile_boundary$
DECLARE
  forbidden_columns text[];
BEGIN
  IF has_table_privilege('anon', 'public.profiles', 'SELECT') THEN
    RAISE EXCEPTION 'anon must not be able to select private profiles';
  END IF;

  IF NOT has_table_privilege('authenticated', 'public.profiles', 'SELECT') THEN
    RAISE EXCEPTION 'authenticated users must retain own-profile SELECT';
  END IF;

  IF NOT has_table_privilege('anon', 'public.public_profiles', 'SELECT')
     OR NOT has_table_privilege('authenticated', 'public.public_profiles', 'SELECT') THEN
    RAISE EXCEPTION 'public profile projection must remain readable by browser roles';
  END IF;

  IF has_table_privilege('anon', 'public.public_profile_stats', 'SELECT')
     OR has_table_privilege('authenticated', 'public.public_profile_stats', 'SELECT') THEN
    RAISE EXCEPTION 'aggregate profile view must not bypass the public stats RPC';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename = 'profiles'
       AND policyname = 'Users view own profile'
       AND cmd = 'SELECT'
  ) THEN
    RAISE EXCEPTION 'owner-only profile SELECT policy is missing';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename = 'profiles'
       AND cmd = 'SELECT'
       AND qual = 'true'
  ) THEN
    RAISE EXCEPTION 'a broad public profile SELECT policy still exists';
  END IF;

  SELECT array_agg(column_name ORDER BY column_name)
    INTO forbidden_columns
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'public_profiles'
     AND column_name = ANY (ARRAY[
       'email',
       'matric_number',
       'balance',
       'plug_credit_balance',
       'duress_code_hash',
       'duress_qr_token_hash',
       'last_known_ip',
       'is_admin',
       'is_suspended',
       'collusion_flag',
       'collusion_flagged_at',
       'collusion_ceiling',
       'commission_rate',
       'free_listing_tokens',
       'priority_relist_today',
       'priority_relist_this_week',
       'last_boost_at',
       'boost_denials_this_week',
       'gps_spoof_flags',
       'referral_code',
       'referred_by',
       'preferences',
       'theme_mode',
       'accepted_terms_at',
       'juror_enabled',
       'rolling_accuracy',
       'juror_streak',
       'juror_cases_today',
       'juror_last_case_at',
       'magistrate_at'
     ]);

  IF forbidden_columns IS NOT NULL THEN
    RAISE EXCEPTION 'public_profiles exposes private columns: %', forbidden_columns;
  END IF;
END;
$profile_boundary$;
