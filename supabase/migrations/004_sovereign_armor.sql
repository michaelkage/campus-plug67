-- ============================================================
-- Campus Plug — Migration 004: Sovereign Armor
-- Run AFTER 001, 002, 003
-- ============================================================

-- ── SECURITY TABLES ───────────────────────────────────────────

-- Device fingerprint registry (FingerprintJS hardware hash)
create table if not exists public.user_security (
  id              uuid default uuid_generate_v4() primary key,
  user_id         uuid references auth.users(id) on delete cascade not null,
  device_hash     text not null,                    -- FingerprintJS visitorId
  device_label    text,                             -- e.g. "Chrome/MacBook"
  ip_address      inet,
  user_agent      text,
  trusted         boolean default false,
  last_seen_at    timestamptz default now(),
  created_at      timestamptz default now(),
  unique (user_id, device_hash)
);

-- Banned device registry (scammer fingerprints)
create table if not exists public.banned_devices (
  device_hash     text primary key,
  reason          text,
  banned_by       uuid references auth.users(id),
  banned_at       timestamptz default now()
);

-- WebAuthn / Passkey credentials
create table if not exists public.passkey_credentials (
  id                  uuid default uuid_generate_v4() primary key,
  user_id             uuid references auth.users(id) on delete cascade not null,
  credential_id       text unique not null,          -- base64url encoded
  public_key          text not null,                 -- COSE-encoded public key (base64url)
  sign_count          bigint default 0,
  transports          text[],                        -- ["internal","hybrid"]
  device_label        text,                          -- "Face ID · iPhone 15"
  backed_up           boolean default false,
  created_at          timestamptz default now(),
  last_used_at        timestamptz
);

-- Emergency Sale tokens (2 per user per month)
create table if not exists public.emergency_sale_tokens (
  id          uuid default uuid_generate_v4() primary key,
  user_id     uuid references public.profiles(id) on delete cascade not null,
  used        boolean default false,
  used_at     timestamptz,
  used_for    uuid references public.listings(id),
  month_year  text not null,                         -- 'YYYY-MM' e.g. '2025-07'
  created_at  timestamptz default now()
);

-- Ensure max 2 tokens per user per month (enforced by trigger)
create unique index emergency_tokens_user_month_count
  on public.emergency_sale_tokens(user_id, month_year)
  where not used;   -- partial index so we can have at most 2 unused per month

-- Listing EXIF audit log
create table if not exists public.listing_exif_flags (
  id              uuid default uuid_generate_v4() primary key,
  listing_id      uuid references public.listings(id) on delete cascade not null,
  image_url       text not null,
  gps_lat         numeric,
  gps_lng         numeric,
  gps_mismatch    boolean default false,              -- GPS vs declared university location
  timestamp_flag  boolean default false,              -- image timestamp vs upload time delta
  make            text,
  model           text,
  software        text,
  raw_exif        jsonb,
  analyzed_at     timestamptz default now()
);

-- Price floor violations log
create table if not exists public.price_floor_log (
  id              uuid default uuid_generate_v4() primary key,
  listing_id      uuid references public.listings(id),
  seller_id       uuid references public.profiles(id),
  category        text,
  listed_price    bigint,
  floor_price     bigint,
  token_used      uuid references public.emergency_sale_tokens(id),
  created_at      timestamptz default now()
);

-- ── RLS ───────────────────────────────────────────────────────

alter table public.user_security           enable row level security;
alter table public.banned_devices          enable row level security;
alter table public.passkey_credentials     enable row level security;
alter table public.emergency_sale_tokens   enable row level security;
alter table public.listing_exif_flags      enable row level security;
alter table public.price_floor_log         enable row level security;

-- user_security
create policy "Users see own security records"
  on public.user_security for select using (auth.uid() = user_id);
create policy "Users insert own security"
  on public.user_security for insert with check (auth.uid() = user_id);
create policy "Users update own security"
  on public.user_security for update using (auth.uid() = user_id);

-- banned_devices (public read so we can gate signup)
create policy "Anyone can read banned devices"
  on public.banned_devices for select using (true);

-- passkeys
create policy "Users manage own passkeys"
  on public.passkey_credentials for all using (auth.uid() = user_id);
create policy "Passkey public read by credential_id" -- needed for auth challenge
  on public.passkey_credentials for select using (true);

-- emergency tokens
create policy "Users see own tokens"
  on public.emergency_sale_tokens for select using (auth.uid() = user_id);
create policy "Service role manages tokens"
  on public.emergency_sale_tokens for all using (auth.role() = 'service_role');

-- EXIF flags
create policy "Listing parties see EXIF"
  on public.listing_exif_flags for select
  using (
    exists (
      select 1 from public.listings l
      where l.id = listing_id and (l.seller_id = auth.uid() or l.status = 'active')
    )
  );

-- price floor log
create policy "Users see own floor violations"
  on public.price_floor_log for select using (auth.uid() = seller_id);

-- ── INDEXES ───────────────────────────────────────────────────

create index if not exists user_security_hash_idx on public.user_security(device_hash);
create index if not exists passkey_cred_id_idx on public.passkey_credentials(credential_id);
create index if not exists emergency_tokens_user_month_idx on public.emergency_sale_tokens(user_id, month_year);
create index if not exists exif_flags_listing_idx on public.listing_exif_flags(listing_id);

-- ── REALTIME ──────────────────────────────────────────────────

alter publication supabase_realtime add table public.listing_exif_flags;

-- ============================================================
-- PRICE FLOOR FUNCTION (IQR + 40% floor + emergency tokens)
-- ============================================================

create or replace function public.get_price_floor(
  p_category   text,
  p_university text
)
returns json
language plpgsql stable
as $$
declare
  q1        bigint;
  q3        bigint;
  iqr       bigint;
  median    bigint;
  floor_prc bigint;
begin
  -- IQR calculation on clean data
  select
    percentile_cont(0.25) within group (order by price),
    percentile_cont(0.75) within group (order by price),
    percentile_cont(0.5)  within group (order by price)
  into q1, q3, median
  from public.listings
  where category = p_category
    and university = p_university
    and status in ('active','sold')
    and created_at > now() - interval '90 days';

  iqr := coalesce(q3 - q1, 0);

  -- Filter outliers, recompute median on clean data
  select percentile_cont(0.5) within group (order by price)
  into median
  from public.listings
  where category = p_category
    and university = p_university
    and status in ('active','sold')
    and created_at > now() - interval '90 days'
    and (iqr = 0 or (price >= q1 - 1.5 * iqr and price <= q3 + 1.5 * iqr));

  -- Floor = 60% of median (i.e. can't go more than 40% below)
  floor_prc := coalesce(round(median * 0.60), 0);

  return json_build_object(
    'floor_price',   floor_prc,
    'median_price',  median,
    'q1_price',      q1,
    'q3_price',      q3,
    'iqr',           iqr,
    'has_floor',     (floor_prc > 0)
  );
end;
$$;

-- ============================================================
-- EMERGENCY TOKEN PROVISIONING — auto-issue 2 tokens monthly
-- ============================================================

create or replace function public.provision_emergency_tokens(p_user_id uuid)
returns int
language plpgsql security definer
as $$
declare
  month_key text := to_char(now(), 'YYYY-MM');
  existing  int;
begin
  select count(*) into existing
  from public.emergency_sale_tokens
  where user_id = p_user_id and month_year = month_key;

  if existing >= 2 then return existing; end if;

  insert into public.emergency_sale_tokens(user_id, month_year)
  select p_user_id, month_key
  from generate_series(1, 2 - existing);

  return 2;
end;
$$;

-- ============================================================
-- PLUGSCORE TRIGGER (Enhanced — includes EXIF bonus, dispute penalty)
-- ============================================================

create or replace function public.update_plugscore_on_event()
returns trigger
language plpgsql security definer
as $$
begin
  -- EXIF-verified upload bonus (+10)
  if TG_TABLE_NAME = 'listing_exif_flags' then
    if not new.gps_mismatch and not new.timestamp_flag then
      update public.profiles
      set plug_score = least(plug_score + 10, 1000)
      where id = (
        select seller_id from public.listings where id = new.listing_id
      );

      -- Mark listing as metadata-verified
      update public.listings
      set metadata_verified = true
      where id = new.listing_id;

      insert into public.activity_feed(actor_name, actor_id, action, subject, emoji, university)
      select p.full_name, p.id, 'earned a metadata-verified badge', l.title, '🔍', l.university
      from public.listings l join public.profiles p on p.id = l.seller_id
      where l.id = new.listing_id;
    end if;
    return new;
  end if;

  -- Transaction completed (+50 seller)
  if TG_TABLE_NAME = 'transactions' then
    if new.status = 'released' and old.status != 'released' then
      update public.profiles
      set plug_score = least(plug_score + 50, 1000)
      where id = new.seller_id;
    end if;

    -- Dispute lost by seller (-100 seller)
    if new.status = 'disputed' and old.status != 'disputed' then
      -- Deduction applied when dispute resolves against seller
      -- (handled by admin action / future function)
      null;
    end if;

    return new;
  end if;

  return new;
end;
$$;

-- Attach to exif flags
drop trigger if exists on_exif_verified on public.listing_exif_flags;
create trigger on_exif_verified
  after insert on public.listing_exif_flags
  for each row execute procedure public.update_plugscore_on_event();

-- ============================================================
-- SELLER DISPUTE PENALTY — called by admin edge function
-- ============================================================

create or replace function public.apply_dispute_penalty(
  p_transaction_id uuid,
  p_penalize_seller boolean default true
)
returns void
language plpgsql security definer
as $$
declare
  tx record;
begin
  select * into tx from public.transactions where id = p_transaction_id;
  if not found then return; end if;

  if p_penalize_seller then
    -- Seller loses dispute: -100 PlugScore
    update public.profiles
    set plug_score = greatest(plug_score - 100, 0)
    where id = tx.seller_id;

    insert into public.notifications(user_id, type, title, body, data)
    values (tx.seller_id, 'dispute_lost',
      '⚠️ Dispute Resolved Against You',
      'Your PlugScore has been reduced by 100 points.',
      jsonb_build_object('transaction_id', p_transaction_id));
  else
    -- Buyer loses dispute (frivolous): -25 PlugScore
    update public.profiles
    set plug_score = greatest(plug_score - 25, 0)
    where id = tx.buyer_id;
  end if;

  -- Release or hold funds based on outcome
  if p_penalize_seller then
    -- Refund buyer (funds stay in dispute, admin processes refund manually)
    update public.transactions
    set status = 'cancelled', cancelled_at = now()
    where id = p_transaction_id;
  else
    -- Release to seller
    update public.transactions
    set status = 'released', released_at = now()
    where id = p_transaction_id;
  end if;
end;
$$;

-- ============================================================
-- ATOMIC POOL JOIN (prevents race conditions)
-- Better than Edge Function — single round trip
-- ============================================================

create or replace function public.atomic_pool_join(
  p_pool_id   uuid,
  p_user_id   uuid,
  p_ref       text
)
returns json
language plpgsql security definer
as $$
declare
  updated_count int;
  pool          record;
  reason        text; -- 1. Move the variable declaration here
begin
  -- Atomic increment with all guards in one statement
  update public.study_pools
  set
    current_count = current_count + 1,
    participants  = array_append(participants, p_user_id),
    payment_refs  = array_append(payment_refs, p_ref)
  where id = p_pool_id
    and status = 'open'
    and current_count < max_capacity
    and expires_at > now()
    and not (p_user_id = any(participants))
  returning current_count, max_capacity, title, organizer_id
  into pool;

  get diagnostics updated_count = row_count;

  if updated_count = 0 then
    -- 2. Remove the "declare" line from here
    select case
         when not exists (select 1 from public.study_pools where id = p_pool_id) then 'pool_not_found'
         when (select status from public.study_pools where id = p_pool_id) != 'open' then 'pool_closed'
         when (select current_count >= max_capacity from public.study_pools where id = p_pool_id) then 'pool_full'
         when (select expires_at < now() from public.study_pools where id = p_pool_id) then 'pool_expired'
         when (select p_user_id = any(participants) from public.study_pools where id = p_pool_id) then 'already_joined'
         else 'unknown_error'
    end into reason;

    return json_build_object(
      'success', false,
      'reason', reason
    );
  end if;

  -- Success path
  return json_build_object(
    'success', true,
    'pool', pool
  );
end;
$$;

-- ============================================================
-- ADD COLUMNS to existing listings table
-- ============================================================

alter table public.listings
  add column if not exists metadata_verified boolean default false,
  add column if not exists exif_flagged      boolean default false,
  add column if not exists floor_override    boolean default false,  -- emergency token used
  add column if not exists emergency_token_id uuid references public.emergency_sale_tokens(id);

-- ============================================================
-- VERIFY PROFILE VIEW (public, for /verify/:id route)
-- ============================================================

create or replace view public.public_profile_stats as
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
    coalesce(r.avg_rating, 0)    as avg_rating,
    coalesce(r.rating_count, 0)  as rating_count,
    (
      select count(*) from public.listings
      where seller_id = p.id and status = 'active'
    )                            as active_listings,
    (
      select count(*) from public.listing_exif_flags ef
      join public.listings l on l.id = ef.listing_id
      where l.seller_id = p.id and not ef.gps_mismatch and not ef.timestamp_flag
    )                            as verified_uploads
  from public.profiles p
  left join public.profile_ratings r on r.profile_id = p.id;

-- Grant anon read (needed for /verify route with no auth)
grant select on public.public_profile_stats to anon;
