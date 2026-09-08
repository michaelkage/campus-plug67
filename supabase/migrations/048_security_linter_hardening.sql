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

-- PostGIS creates spatial_ref_sys when the extension is installed. The local
-- migration validator may not install PostGIS, so guard this remediation.
do $$
begin
  if to_regclass('public.spatial_ref_sys') is not null then
    execute 'alter table public.spatial_ref_sys enable row level security';
    execute 'drop policy if exists "Public can read spatial reference data" on public.spatial_ref_sys';
    execute 'create policy "Public can read spatial reference data" on public.spatial_ref_sys for select using (true)';
  end if;
end
$$;
