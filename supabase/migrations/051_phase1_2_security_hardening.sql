-- Campus Plug security hardening: passkey abuse controls + profile mutation boundaries.
-- Forward-only migration. Existing migrations remain unchanged.

-- ---------------------------------------------------------------------------
-- Passkey rate limiting for unauthenticated WebAuthn ceremonies.
-- The existing consume_rate_limit() buckets by auth.uid(), which is not useful
-- before authentication. This keyed variant lets Edge Functions use a hashed
-- server-derived key without exposing the raw IP/device identity to Postgres UI.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.consume_rate_limit_keyed(
  p_scope text,
  p_key text,
  p_limit integer,
  p_window_seconds integer
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  k text;
  b public.rate_limit_buckets%ROWTYPE;
BEGIN
  IF p_scope IS NULL OR length(trim(p_scope)) < 1 OR length(trim(p_scope)) > 80 THEN
    RAISE EXCEPTION 'Invalid rate limit scope';
  END IF;
  IF p_key IS NULL OR length(trim(p_key)) < 16 OR length(trim(p_key)) > 128 THEN
    RAISE EXCEPTION 'Invalid rate limit key';
  END IF;
  IF p_limit < 1 OR p_limit > 10000 OR p_window_seconds < 1 OR p_window_seconds > 86400 THEN
    RAISE EXCEPTION 'Invalid rate limit configuration';
  END IF;

  k := left(trim(p_scope) || ':' || trim(p_key), 250);
  INSERT INTO public.rate_limit_buckets(bucket_key)
  VALUES (k)
  ON CONFLICT DO NOTHING;

  SELECT * INTO b
  FROM public.rate_limit_buckets
  WHERE bucket_key = k
  FOR UPDATE;

  IF b.window_started_at + make_interval(secs => p_window_seconds) <= now() THEN
    UPDATE public.rate_limit_buckets
    SET window_started_at = now(), hit_count = 1, updated_at = now()
    WHERE bucket_key = k;
    RETURN jsonb_build_object(
      'allowed', true,
      'remaining', p_limit - 1,
      'reset_at', now() + make_interval(secs => p_window_seconds)
    );
  END IF;

  IF b.hit_count >= p_limit THEN
    RETURN jsonb_build_object(
      'allowed', false,
      'remaining', 0,
      'reset_at', b.window_started_at + make_interval(secs => p_window_seconds)
    );
  END IF;

  UPDATE public.rate_limit_buckets
  SET hit_count = hit_count + 1, updated_at = now()
  WHERE bucket_key = k;

  RETURN jsonb_build_object(
    'allowed', true,
    'remaining', p_limit - b.hit_count - 1,
    'reset_at', b.window_started_at + make_interval(secs => p_window_seconds)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.consume_rate_limit_keyed(text,text,integer,integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_rate_limit_keyed(text,text,integer,integer)
  TO service_role;

-- ---------------------------------------------------------------------------
-- Profile mutation boundary.
-- Public profile reads remain supported, but clients must not be able to
-- rewrite trust, moderation, wallet, accounting, or identity-control fields.
-- Server-side workers/functions retain authority through service_role.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_profile_sensitive_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.role() = 'service_role' THEN
    RETURN NEW;
  END IF;

  IF auth.uid() IS NULL OR auth.uid() <> OLD.id OR NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'Profile mutation is not authorized';
  END IF;

  IF NEW.email IS DISTINCT FROM OLD.email
     OR NEW.plug_score IS DISTINCT FROM OLD.plug_score
     OR NEW.total_sales IS DISTINCT FROM OLD.total_sales
     OR NEW.total_earnings IS DISTINCT FROM OLD.total_earnings
     OR NEW.badges IS DISTINCT FROM OLD.badges
     OR NEW.is_verified IS DISTINCT FROM OLD.is_verified
     OR NEW.is_suspended IS DISTINCT FROM OLD.is_suspended
     OR NEW.balance IS DISTINCT FROM OLD.balance
     OR NEW.plug_credit_balance IS DISTINCT FROM OLD.plug_credit_balance
     OR NEW.referral_code IS DISTINCT FROM OLD.referral_code
     OR NEW.streak_days IS DISTINCT FROM OLD.streak_days
     OR NEW.juror_streak IS DISTINCT FROM OLD.juror_streak
     OR NEW.free_listing_tokens IS DISTINCT FROM OLD.free_listing_tokens
  THEN
    RAISE EXCEPTION 'Protected profile fields are server-managed';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_profile_sensitive_mutation ON public.profiles;
CREATE TRIGGER guard_profile_sensitive_mutation
BEFORE UPDATE ON public.profiles
FOR EACH ROW
EXECUTE FUNCTION public.guard_profile_sensitive_mutation();

-- Tighten the original UPDATE policy with an explicit new-row ownership check.
DROP POLICY IF EXISTS "Users update own profile" ON public.profiles;
CREATE POLICY "Users update own profile"
  ON public.profiles
  FOR UPDATE
  TO authenticated
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

COMMENT ON FUNCTION public.consume_rate_limit_keyed(text,text,integer,integer)
  IS 'Server-only keyed abuse control for unauthenticated flows such as passkey ceremonies.';
COMMENT ON FUNCTION public.guard_profile_sensitive_mutation()
  IS 'Prevents client-side mutation of trust, moderation, accounting, wallet, and identity-control profile fields.';
