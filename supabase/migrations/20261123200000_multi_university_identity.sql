-- M14: Multi-university identity and campus infrastructure.
-- Institution identity is derived from a confirmed Auth email and the
-- administrator-managed allowed_domains table. Client-supplied university
-- labels are never treated as proof of membership.

CREATE TABLE IF NOT EXISTS public.institutions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  normalized_name text GENERATED ALWAYS AS (lower(trim(name))) STORED,
  country_code text,
  timezone text,
  website_url text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS institutions_normalized_name_uidx
  ON public.institutions(normalized_name);
CREATE INDEX IF NOT EXISTS institutions_active_name_idx
  ON public.institutions(name) WHERE is_active;

-- Seed the directory from the existing approved-domain registry. Existing
-- profile labels are deliberately not used as proof and do not create members.
INSERT INTO public.institutions(name, slug)
SELECT DISTINCT
  trim(d.institution_name),
  regexp_replace(lower(trim(d.institution_name)), '[^a-z0-9]+', '-', 'g')
    || '-' || substr(md5(lower(trim(d.institution_name))), 1, 6)
FROM public.allowed_domains d
WHERE d.institution_name IS NOT NULL AND trim(d.institution_name) <> ''
ON CONFLICT (normalized_name) DO NOTHING;

ALTER TABLE public.allowed_domains
  ADD COLUMN IF NOT EXISTS institution_id uuid;

UPDATE public.allowed_domains d
SET institution_id = i.id
FROM public.institutions i
WHERE d.institution_id IS NULL
  AND lower(trim(d.institution_name)) = i.normalized_name;

-- Future domain registry changes stay aligned with the canonical directory.
CREATE OR REPLACE FUNCTION public.sync_allowed_domain_institution()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.institution_name IS NULL OR trim(NEW.institution_name) = '' THEN
    RAISE EXCEPTION 'An institution name is required for an approved email domain';
  END IF;

  INSERT INTO public.institutions(name, slug)
  VALUES (
    trim(NEW.institution_name),
    regexp_replace(lower(trim(NEW.institution_name)), '[^a-z0-9]+', '-', 'g')
      || '-' || substr(md5(lower(trim(NEW.institution_name))), 1, 6)
  )
  ON CONFLICT (normalized_name) DO UPDATE
    SET name = EXCLUDED.name
  RETURNING id INTO NEW.institution_id;

  NEW.domain := lower(trim(NEW.domain));
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS allowed_domains_sync_institution ON public.allowed_domains;
CREATE TRIGGER allowed_domains_sync_institution
BEFORE INSERT OR UPDATE OF domain, institution_name
ON public.allowed_domains
FOR EACH ROW
EXECUTE FUNCTION public.sync_allowed_domain_institution();

-- All existing rows were backfilled above. A NOT NULL FK prevents an approved
-- domain from silently pointing at a free-text or missing institution.
ALTER TABLE public.allowed_domains
  ALTER COLUMN institution_id SET NOT NULL;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'allowed_domains_institution_id_fkey'
      AND conrelid = 'public.allowed_domains'::regclass
  ) THEN
    ALTER TABLE public.allowed_domains
      ADD CONSTRAINT allowed_domains_institution_id_fkey
      FOREIGN KEY (institution_id) REFERENCES public.institutions(id)
      ON UPDATE RESTRICT ON DELETE RESTRICT;
  END IF;
END $$;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS primary_institution_id uuid
  REFERENCES public.institutions(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS public.institution_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  institution_id uuid NOT NULL REFERENCES public.institutions(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','verified','rejected','suspended')),
  verification_method text,
  verified_email text,
  verified_at timestamptz,
  is_primary boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, institution_id),
  CHECK (
    (status = 'verified' AND verified_at IS NOT NULL AND verified_email IS NOT NULL)
    OR status <> 'verified'
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS institution_memberships_one_primary_uidx
  ON public.institution_memberships(user_id) WHERE is_primary AND status = 'verified';
CREATE INDEX IF NOT EXISTS institution_memberships_user_status_idx
  ON public.institution_memberships(user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS institution_memberships_institution_status_idx
  ON public.institution_memberships(institution_id, status);

ALTER TABLE public.institutions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.institution_memberships ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Active institutions are readable" ON public.institutions;
CREATE POLICY "Active institutions are readable"
  ON public.institutions FOR SELECT TO authenticated
  USING (is_active = true);

DROP POLICY IF EXISTS "Users read their own institution memberships" ON public.institution_memberships;
CREATE POLICY "Users read their own institution memberships"
  ON public.institution_memberships FOR SELECT TO authenticated
  USING (user_id = auth.uid());

REVOKE ALL ON public.institutions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.institutions TO authenticated;
REVOKE ALL ON public.institution_memberships FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.institution_memberships TO authenticated;

-- University labels and primary institution pointers are compatibility
-- projections, not client-editable profile fields.
CREATE OR REPLACE FUNCTION public.guard_profile_institution_identity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.role() = 'authenticated'
     AND current_setting('app.institution_write', true) IS DISTINCT FROM 'on'
     AND (
       (TG_OP = 'INSERT' AND (NEW.university IS NOT NULL OR NEW.primary_institution_id IS NOT NULL))
       OR (TG_OP = 'UPDATE' AND (
         NEW.university IS DISTINCT FROM OLD.university
         OR NEW.primary_institution_id IS DISTINCT FROM OLD.primary_institution_id
       ))
     ) THEN
    RAISE EXCEPTION 'Institution identity is managed by verified campus membership';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_profile_institution_identity ON public.profiles;
CREATE TRIGGER guard_profile_institution_identity
BEFORE INSERT OR UPDATE OF university, primary_institution_id
ON public.profiles
FOR EACH ROW
EXECUTE FUNCTION public.guard_profile_institution_identity();

-- Ignore client-supplied university metadata during Auth profile creation.
-- The legacy university label may be populated from the allowlist for display,
-- but it does not create a verified membership or primary institution.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  detected_university text;
BEGIN
  SELECT d.institution_name
    INTO detected_university
  FROM public.allowed_domains d
  WHERE d.active = true
    AND lower(d.domain) = lower(split_part(COALESCE(NEW.email, ''), '@', 2))
  LIMIT 1;

  INSERT INTO public.profiles(id, email, full_name, university, is_verified)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NULLIF(trim(NEW.raw_user_meta_data->>'full_name'), ''), split_part(NEW.email, '@', 1)),
    detected_university,
    false
  )
  ON CONFLICT (id) DO UPDATE
    SET email = EXCLUDED.email,
        full_name = COALESCE(public.profiles.full_name, EXCLUDED.full_name),
        university = COALESCE(public.profiles.university, EXCLUDED.university);
  RETURN NEW;
END;
$$;

-- Claim membership only for the authenticated account's confirmed email.
-- The client cannot choose the institution or supply an arbitrary email.
CREATE OR REPLACE FUNCTION public.claim_my_institution_membership()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  actor uuid := auth.uid();
  account_email text;
  email_confirmed timestamptz;
  resolved_institution public.institutions%ROWTYPE;
  membership public.institution_memberships%ROWTYPE;
  profile_primary uuid;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;

  SELECT email, email_confirmed_at
    INTO account_email, email_confirmed
  FROM auth.users
  WHERE id = actor;

  IF account_email IS NULL OR email_confirmed IS NULL THEN
    RAISE EXCEPTION 'Verify your university email address before claiming campus membership';
  END IF;

  SELECT i.*
    INTO resolved_institution
  FROM public.allowed_domains d
  JOIN public.institutions i ON i.id = d.institution_id
  WHERE d.active = true
    AND lower(d.domain) = lower(split_part(account_email, '@', 2))
    AND i.is_active = true
  LIMIT 1;

  IF resolved_institution.id IS NULL THEN
    RAISE EXCEPTION 'Your verified email domain is not currently linked to an active Campus Plug institution';
  END IF;

  INSERT INTO public.institution_memberships(
    user_id, institution_id, status, verification_method,
    verified_email, verified_at, is_primary
  )
  VALUES (
    actor, resolved_institution.id, 'verified', 'verified_email_domain',
    lower(account_email), now(), false
  )
  ON CONFLICT (user_id, institution_id) DO UPDATE
    SET status = CASE
          WHEN public.institution_memberships.status = 'suspended' THEN 'suspended'
          ELSE 'verified'
        END,
        verification_method = 'verified_email_domain',
        verified_email = EXCLUDED.verified_email,
        verified_at = COALESCE(public.institution_memberships.verified_at, now()),
        updated_at = now()
  RETURNING * INTO membership;

  IF membership.status <> 'verified' THEN
    RAISE EXCEPTION 'This campus membership is suspended. Contact Campus Plug support';
  END IF;

  SELECT primary_institution_id
    INTO profile_primary
  FROM public.profiles
  WHERE id = actor
  FOR UPDATE;

  IF profile_primary IS NULL THEN
    PERFORM set_config('app.institution_write', 'on', true);
    UPDATE public.profiles
    SET primary_institution_id = resolved_institution.id,
        university = resolved_institution.name,
        updated_at = now()
    WHERE id = actor;
    UPDATE public.institution_memberships
    SET is_primary = false, updated_at = now()
    WHERE user_id = actor AND status = 'verified';
    UPDATE public.institution_memberships
    SET is_primary = true, updated_at = now()
    WHERE user_id = actor AND institution_id = resolved_institution.id AND status = 'verified';
  ELSIF profile_primary = resolved_institution.id THEN
    UPDATE public.institution_memberships
    SET is_primary = (institution_id = resolved_institution.id), updated_at = now()
    WHERE user_id = actor AND status = 'verified';
  END IF;

  RETURN jsonb_build_object(
    'membership_id', membership.id,
    'institution_id', resolved_institution.id,
    'institution_name', resolved_institution.name,
    'status', membership.status,
    'is_primary', profile_primary IS NULL OR profile_primary = resolved_institution.id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.set_my_primary_institution(p_institution_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  actor uuid := auth.uid();
  institution_name text;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;

  -- Serialize concurrent primary-campus switches for this account.
  PERFORM 1 FROM public.profiles WHERE id = actor FOR UPDATE;

  SELECT i.name
    INTO institution_name
  FROM public.institution_memberships m
  JOIN public.institutions i ON i.id = m.institution_id
  WHERE m.user_id = actor
    AND m.institution_id = p_institution_id
    AND m.status = 'verified'
    AND i.is_active = true
  FOR UPDATE OF m;

  IF institution_name IS NULL THEN
    RAISE EXCEPTION 'Only a verified, active campus membership can be selected as primary';
  END IF;

  PERFORM set_config('app.institution_write', 'on', true);
  UPDATE public.institution_memberships
  SET is_primary = false, updated_at = now()
  WHERE user_id = actor AND status = 'verified';
  UPDATE public.institution_memberships
  SET is_primary = true, updated_at = now()
  WHERE user_id = actor AND institution_id = p_institution_id AND status = 'verified';

  UPDATE public.profiles
  SET primary_institution_id = p_institution_id,
      university = institution_name,
      updated_at = now()
  WHERE id = actor;

  RETURN jsonb_build_object(
    'institution_id', p_institution_id,
    'institution_name', institution_name,
    'is_primary', true
  );
END;
$$;

REVOKE ALL ON FUNCTION public.claim_my_institution_membership() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_my_institution_membership() TO authenticated;
REVOKE ALL ON FUNCTION public.set_my_primary_institution(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_my_primary_institution(uuid) TO authenticated;

COMMENT ON TABLE public.institutions IS
  'Canonical institution directory. Membership verification is based on administrator-managed allowed email domains.';
COMMENT ON TABLE public.institution_memberships IS
  'Owner-readable, server-managed memberships. Only confirmed Auth email domains can create verified membership.';
COMMENT ON FUNCTION public.claim_my_institution_membership() IS
  'Claims the institution mapped to the authenticated account email after Auth email confirmation.';
