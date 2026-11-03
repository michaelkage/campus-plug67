-- Keep public resume verification available without granting anonymous
-- access to the underlying transaction, rating, or hostel tables.
--
-- The exposed RPC is SECURITY INVOKER. Its narrowly scoped helper lives in
-- the unexposed private schema and returns only the public profile projection.

CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC;
GRANT USAGE ON SCHEMA private TO anon, authenticated;

CREATE OR REPLACE FUNCTION private.get_public_profile_stats(p_profile_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  WITH tx_stats AS (
    SELECT
      t.seller_id,
      count(*) FILTER (
        WHERE t.status = 'released'::text OR t.status = 'completed'::text
      ) AS total_sales,
      COALESCE(
        sum(t.amount) FILTER (
          WHERE t.status = 'released'::text OR t.status = 'completed'::text
        ),
        0::numeric
      ) AS total_earnings,
      0::integer AS verified_uploads
    FROM public.transactions AS t
    WHERE t.seller_id IS NOT NULL
    GROUP BY t.seller_id
  ),
  rating_stats AS (
    SELECT
      r.reviewee_id AS user_id,
      COALESCE(avg(r.score), 0::numeric) AS avg_rating,
      count(*) AS rating_count
    FROM public.ratings AS r
    GROUP BY r.reviewee_id
  ),
  hostel_stats AS (
    SELECT
      hr.user_id,
      count(*) AS hostel_reviews_count,
      COALESCE(avg(hr.rating), 0::numeric) AS hostel_avg_rating
    FROM public.hostel_reviews AS hr
    GROUP BY hr.user_id
  ),
  groupbuy_stats AS (
    SELECT
      participant.user_id,
      count(*) AS pools_joined,
      COALESCE(sum(participant.contribution_kobo), 0::numeric) AS total_contributions,
      count(*) FILTER (
        WHERE participant.pool_id IN (
          SELECT pool.id
          FROM public.group_buy_pools AS pool
          WHERE pool.status = 'completed'::text
        )
      ) AS successful_pools
    FROM public.group_buy_participants AS participant
    GROUP BY participant.user_id
  ),
  pool_creator_stats AS (
    SELECT
      listing.seller_id AS user_id,
      count(pool.id)::integer AS pools_created
    FROM public.group_buy_pools AS pool
    JOIN public.listings AS listing ON listing.id = pool.listing_id
    GROUP BY listing.seller_id
  )
  SELECT pg_catalog.to_jsonb(stats)
  FROM (
    SELECT
      p.id,
      p.full_name,
      p.university,
      p.department,
      p.level,
      p.is_verified,
      p.created_at,
      p.plug_score,
      p.badges,
      COALESCE(tx_stats.total_sales, 0::bigint) AS total_sales,
      COALESCE(tx_stats.total_earnings, 0::numeric) AS total_earnings,
      COALESCE(tx_stats.verified_uploads, 0::integer) AS verified_uploads,
      COALESCE(rating_stats.avg_rating, 0::numeric) AS avg_rating,
      COALESCE(rating_stats.rating_count, 0::bigint) AS rating_count,
      COALESCE(hostel_stats.hostel_reviews_count, 0::bigint) AS hostel_reviews_count,
      COALESCE(hostel_stats.hostel_avg_rating, 0::numeric) AS hostel_avg_rating,
      COALESCE(groupbuy_stats.pools_joined, 0::bigint) AS pools_joined,
      COALESCE(pool_creator_stats.pools_created, 0::integer) AS pools_created,
      COALESCE(groupbuy_stats.total_contributions, 0::numeric) AS total_contributions,
      COALESCE(groupbuy_stats.successful_pools, 0::bigint) AS successful_pools
    FROM public.profiles AS p
    LEFT JOIN tx_stats ON p.id = tx_stats.seller_id
    LEFT JOIN rating_stats ON p.id = rating_stats.user_id
    LEFT JOIN hostel_stats ON p.id = hostel_stats.user_id
    LEFT JOIN groupbuy_stats ON p.id = groupbuy_stats.user_id
    LEFT JOIN pool_creator_stats ON p.id = pool_creator_stats.user_id
    WHERE p.id = p_profile_id
  ) AS stats;
$function$;

REVOKE ALL ON FUNCTION private.get_public_profile_stats(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.get_public_profile_stats(uuid) TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.get_public_profile_stats(p_profile_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $function$
  SELECT private.get_public_profile_stats(p_profile_id);
$function$;

REVOKE ALL ON FUNCTION public.get_public_profile_stats(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_public_profile_stats(uuid) TO anon, authenticated;

-- The browser now uses the RPC. Retire direct access to the view because its
-- SECURITY INVOKER definition would otherwise require broad base-table grants.
REVOKE ALL PRIVILEGES ON TABLE public.public_profile_stats FROM PUBLIC, anon, authenticated;

-- The profile page needs only aggregate ratings. Grant the two source columns
-- required by the invoker view, not reviewer IDs, transaction IDs, or comments.
GRANT SELECT (reviewee_id, score) ON TABLE public.ratings TO authenticated;
ALTER VIEW public.profile_ratings SET (security_invoker = true);
REVOKE INSERT, UPDATE, DELETE ON TABLE public.profile_ratings FROM authenticated;

DO $assertions$
DECLARE
  helper_oid oid := to_regprocedure('private.get_public_profile_stats(uuid)');
  public_oid oid := to_regprocedure('public.get_public_profile_stats(uuid)');
BEGIN
  IF helper_oid IS NULL OR public_oid IS NULL THEN
    RAISE EXCEPTION 'Public profile stats RPC functions were not created';
  END IF;

  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = helper_oid) THEN
    RAISE EXCEPTION 'Private profile stats helper must be SECURITY DEFINER';
  END IF;

  IF NOT (
    SELECT coalesce(proconfig, ARRAY[]::text[]) @> ARRAY['search_path=""']
    FROM pg_proc WHERE oid = helper_oid
  ) THEN
    RAISE EXCEPTION 'Private profile stats helper must pin an empty search_path';
  END IF;

  IF (SELECT prosecdef FROM pg_proc WHERE oid = public_oid) THEN
    RAISE EXCEPTION 'Public profile stats RPC must remain SECURITY INVOKER';
  END IF;

  IF NOT (
    SELECT coalesce(reloptions, ARRAY[]::text[]) @> ARRAY['security_invoker=true']
    FROM pg_class WHERE oid = 'public.profile_ratings'::regclass
  ) THEN
    RAISE EXCEPTION 'profile_ratings must use SECURITY INVOKER';
  END IF;

  IF has_column_privilege('authenticated', 'public.ratings', 'reviewee_id', 'SELECT') IS NOT TRUE
     OR has_column_privilege('authenticated', 'public.ratings', 'score', 'SELECT') IS NOT TRUE THEN
    RAISE EXCEPTION 'Authenticated users need the two source columns for profile_ratings';
  END IF;

  IF has_column_privilege('authenticated', 'public.ratings', 'reviewer_id', 'SELECT')
     OR has_column_privilege('authenticated', 'public.ratings', 'comment', 'SELECT') THEN
    RAISE EXCEPTION 'Rating reviewer identity and comments must remain private';
  END IF;

  IF has_table_privilege('anon', 'public.public_profile_stats', 'SELECT')
     OR has_table_privilege('authenticated', 'public.public_profile_stats', 'SELECT') THEN
    RAISE EXCEPTION 'Direct access to the legacy public profile stats view must be revoked';
  END IF;

  IF NOT has_function_privilege('anon', public_oid, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', public_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'Public profile stats RPC must be executable by anon and authenticated';
  END IF;

  IF has_table_privilege('authenticated', 'public.profile_ratings', 'INSERT')
     OR has_table_privilege('authenticated', 'public.profile_ratings', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.profile_ratings', 'DELETE') THEN
    RAISE EXCEPTION 'Aggregate profile_ratings view must be read-only';
  END IF;
END;
$assertions$;
