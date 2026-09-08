-- Migration 048: clear Supabase security linter findings.
--
-- public_profile_stats is intentionally public for the unauthenticated
-- verification route, but it must execute with the querying user's RLS
-- context rather than the view owner's context.
create or replace view public.public_profile_stats
with (security_invoker = true)
as
  select
    p.id,
    p.full_name,
    p.university,
    p.department,
    p.level,
    p.plug_score,
    p.total_sales,
    p.total_earnings,
    p.badges,
    p.is_verified,
    p.created_at,
    coalesce(r.avg_rating, 0) as avg_rating,
    coalesce(r.rating_count, 0) as rating_count,
    (
      select count(*) from public.listings
      where seller_id = p.id and status = 'active'
    ) as active_listings,
    (
      select count(*)
      from public.listing_exif_flags ef
      join public.listings l on l.id = ef.listing_id
      where l.seller_id = p.id
        and not ef.gps_mismatch
        and not ef.timestamp_flag
    ) as verified_uploads
  from public.profiles p
  left join public.profile_ratings r on r.profile_id = p.id;

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
