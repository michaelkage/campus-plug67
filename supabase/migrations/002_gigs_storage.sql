-- ============================================================
-- Campus Plug — Migration 002: Gigs table + Storage
-- ============================================================

-- Gigs table
create table if not exists public.gigs (
  id              uuid default uuid_generate_v4() primary key,
  seller_id       uuid references public.profiles(id) on delete cascade not null,
  title           text not null,
  description     text,
  category        text not null,
  starting_price  bigint not null check (starting_price > 0),
  university      text not null,
  images          text[] default '{}',
  active          boolean default true,
  created_at      timestamptz default now()
);

alter table public.gigs enable row level security;

create policy "Gigs viewable by all"
  on public.gigs for select using (active = true);

create policy "Auth users create gigs"
  on public.gigs for insert
  with check (auth.uid() = seller_id);

create policy "Sellers update own gigs"
  on public.gigs for update
  using (auth.uid() = seller_id);

-- Add gigs to realtime
alter publication supabase_realtime add table public.gigs;

-- ============================================================
-- STORAGE BUCKETS
-- Run this in Supabase Dashboard > Storage > New Bucket
-- Or use the JS client as the service role
-- ============================================================

-- NOTE: Run the following in Supabase SQL editor or via service role client

-- Listings bucket (public)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'listings',
  'listings',
  true,
  5242880,  -- 5MB
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif']
)
on conflict (id) do nothing;

-- Avatars bucket (public)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'avatars',
  'avatars',
  true,
  2097152,  -- 2MB
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do nothing;

-- Storage RLS policies
create policy "Public read listings"
  on storage.objects for select
  using (bucket_id = 'listings');

create policy "Auth users upload listings"
  on storage.objects for insert
  with check (bucket_id = 'listings' and auth.role() = 'authenticated');

create policy "Users manage own listing images"
  on storage.objects for delete
  using (bucket_id = 'listings' and auth.uid()::text = (storage.foldername(name))[1]);

create policy "Public read avatars"
  on storage.objects for select
  using (bucket_id = 'avatars');

create policy "Users manage own avatar"
  on storage.objects for all
  using (bucket_id = 'avatars' and auth.uid()::text = (storage.foldername(name))[1]);
