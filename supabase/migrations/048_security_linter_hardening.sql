-- Migration 048: clear Supabase security linter findings.
--
-- public_profile_stats is intentionally public for the unauthenticated
-- verification route, but it must execute with the querying user's RLS
-- context rather than the view owner's context.
--
-- The view already exists with the canonical column set from migration 004.
-- CREATE OR REPLACE VIEW cannot remove/reorder existing view columns, so use
-- ALTER VIEW to change only the security_invoker option.
alter view public.public_profile_stats
  set (security_invoker = true);

grant select on public.public_profile_stats to anon;

-- spatial_ref_sys is owned by the PostGIS extension. Do not attempt to alter
-- its RLS policy here: the migration role is intentionally not the owner of
-- extension-managed objects, and PostGIS owns their lifecycle.
