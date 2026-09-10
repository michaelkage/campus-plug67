-- ============================================================
-- Campus Plug — Profile University Integrity
-- Ensures every profile created from an approved education
-- domain has a university, matching the listings invariant.
-- ============================================================

-- Backfill profiles that were created without university metadata.
UPDATE public.profiles p
SET university = d.institution_name,
    updated_at = NOW()
FROM public.allowed_domains d
WHERE p.university IS NULL
  AND d.active = TRUE
  AND lower(split_part(p.email, '@', 2)) = lower(d.domain);

-- Keep the auth trigger authoritative for future accounts. Prefer an
-- explicitly supplied university, then fall back to the approved domain.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  detected_university text;
  supplied_university text;
BEGIN
  supplied_university := NULLIF(trim(new.raw_user_meta_data->>'university'), '');

  SELECT d.institution_name
    INTO detected_university
  FROM public.allowed_domains d
  WHERE d.active = TRUE
    AND lower(d.domain) = lower(split_part(COALESCE(new.email, ''), '@', 2))
  LIMIT 1;

  INSERT INTO public.profiles (id, email, full_name, university, is_verified)
  VALUES (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)),
    coalesce(supplied_university, detected_university),
    false
  )
  ON CONFLICT (id) DO UPDATE
  SET email = EXCLUDED.email,
      university = COALESCE(public.profiles.university, EXCLUDED.university),
      full_name = COALESCE(public.profiles.full_name, EXCLUDED.full_name);

  RETURN new;
END;
$$;

-- Repair profiles whenever their university is still missing. This is
-- deliberately narrow: it never overwrites an existing university.
CREATE OR REPLACE FUNCTION public.ensure_profile_university()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  detected_university text;
BEGIN
  IF NEW.university IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT d.institution_name
    INTO detected_university
  FROM public.allowed_domains d
  WHERE d.active = TRUE
    AND lower(d.domain) = lower(split_part(COALESCE(NEW.email, ''), '@', 2))
  LIMIT 1;

  IF detected_university IS NOT NULL THEN
    NEW.university := detected_university;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS profiles_ensure_university ON public.profiles;
CREATE TRIGGER profiles_ensure_university
  BEFORE INSERT OR UPDATE OF email, university ON public.profiles
  FOR EACH ROW
  EXECUTE PROCEDURE public.ensure_profile_university();

-- Defense in depth: if a client submits a listing without university,
-- derive it from the seller profile and approved email domain before the
-- NOT NULL constraint is evaluated. Existing non-null values are untouched.
CREATE OR REPLACE FUNCTION public.ensure_listing_university()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  seller_university text;
  seller_email text;
BEGIN
  IF NEW.university IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT p.university, p.email
    INTO seller_university, seller_email
  FROM public.profiles p
  WHERE p.id = NEW.seller_id;

  IF seller_university IS NOT NULL THEN
    NEW.university := seller_university;
    RETURN NEW;
  END IF;

  SELECT d.institution_name
    INTO NEW.university
  FROM public.allowed_domains d
  WHERE d.active = TRUE
    AND lower(d.domain) = lower(split_part(COALESCE(seller_email, ''), '@', 2))
  LIMIT 1;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS listings_ensure_university ON public.listings;
CREATE TRIGGER listings_ensure_university
  BEFORE INSERT OR UPDATE OF seller_id, university ON public.listings
  FOR EACH ROW
  EXECUTE PROCEDURE public.ensure_listing_university();

COMMENT ON COLUMN public.profiles.university IS
  'Resolved campus institution. Populated from approved email domain when available.';
