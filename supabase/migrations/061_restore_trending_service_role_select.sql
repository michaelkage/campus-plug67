-- Migration 061: restore SELECT for the trending worker.
--
-- The calculate-trending Edge Function uses upsert() on trending_listings.
-- PostgREST/Supabase requires SELECT as part of an upsert conflict check,
-- so INSERT/UPDATE/DELETE alone are insufficient for the service_role client.
GRANT SELECT ON TABLE public.trending_listings TO service_role;
