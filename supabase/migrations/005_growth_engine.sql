-- ============================================================
-- Campus Plug — Migration 005: Growth Engine
-- Run AFTER 001–004
-- ============================================================

-- ── TRANSACTIONS: Check-in system ─────────────────────────────
alter table public.transactions
  add column if not exists buyer_arrived    boolean   default false,
  add column if not exists seller_arrived   boolean   default false,
  add column if not exists buyer_lat        numeric,
  add column if not exists buyer_lng        numeric,
  add column if not exists seller_lat       numeric,
  add column if not exists seller_lng       numeric,
  add column if not exists checkin_unlocked boolean   default false,
  add column if not exists buyer_arrived_at  timestamptz,
  add column if not exists seller_arrived_at timestamptz;

-- ── LISTINGS: Flash deals + view counts + market signals ──────
alter table public.listings
  add column if not exists is_flash_deal   boolean   default false,
  add column if not exists flash_expires_at timestamptz,
  add column if not exists view_count       integer   default 0,
  add column if not exists viewer_count     integer   default 0, -- concurrent live viewers
  add column if not exists avg_days_to_sell numeric,             -- cached from analytics fn
  add column if not exists share_count      integer   default 0;

-- ── SAFE ZONES (campus meetup spots) ──────────────────────────
create table if not exists public.safe_zones (
  id          uuid    default uuid_generate_v4() primary key,
  university  text    not null,
  name        text    not null,                       -- "Library Café"
  description text,
  lat         numeric not null,
  lng         numeric not null,
  radius_m    integer default 50,                     -- GPS match radius in meters
  verified    boolean default true,
  active      boolean default true,
  created_at  timestamptz default now()
);

alter table public.safe_zones enable row level security;
create policy "Safe zones public read"
  on public.safe_zones for select using (active = true);

-- Seed safe zones for UNILAG
insert into public.safe_zones (university, name, description, lat, lng, radius_m) values
  ('University of Lagos', 'Main Gate (Bus Stop)', 'High visibility, security post at entrance', 6.5161, 3.3956, 60),
  ('University of Lagos', 'Faculty of Science Canteen', 'Well-lit, always busy during hours', 6.5178, 3.3971, 40),
  ('University of Lagos', 'Library Complex Entrance', 'CCTV coverage, foot traffic', 6.5169, 3.3964, 45),
  ('University of Lagos', 'Student Union Building', 'Security office nearby', 6.5155, 3.3948, 50),
  ('University of Lagos', 'Sports Centre Entrance', 'Open space, easy to spot each other', 6.5183, 3.3959, 55)
on conflict do nothing;

-- ── STREAKS ───────────────────────────────────────────────────
create table if not exists public.streaks (
  id               uuid    default uuid_generate_v4() primary key,
  user_id          uuid    references public.profiles(id) on delete cascade not null unique,
  current_streak   integer default 0,
  longest_streak   integer default 0,
  last_active_date date,
  streak_frozen    boolean default false, -- freeze token to skip 1 day
  freeze_tokens    integer default 1,
  total_active_days integer default 0,
  created_at       timestamptz default now(),
  updated_at       timestamptz default now()
);

alter table public.streaks enable row level security;
create policy "Users see own streak"
  on public.streaks for select using (auth.uid() = user_id);
create policy "Users update own streak"
  on public.streaks for update using (auth.uid() = user_id);
create policy "Service role manages streaks"
  on public.streaks for all using (auth.role() = 'service_role');

-- ── REFERRALS ─────────────────────────────────────────────────
alter table public.profiles
  add column if not exists referred_by       uuid references public.profiles(id),
  add column if not exists referral_code     text unique,
  add column if not exists referral_count    integer default 0,
  add column if not exists streak_days       integer default 0;

-- Auto-generate referral codes
create or replace function public.generate_referral_code()
returns trigger language plpgsql as $$
begin
  if new.referral_code is null then
    new.referral_code := upper(substring(md5(new.id::text || now()::text), 1, 8));
  end if;
  return new;
end;
$$;

drop trigger if exists generate_referral_code_trigger on public.profiles;
create trigger generate_referral_code_trigger
  before insert on public.profiles
  for each row execute procedure public.generate_referral_code();

-- Backfill existing profiles
update public.profiles
set referral_code = upper(substring(md5(id::text), 1, 8))
where referral_code is null;

-- ── REFERRAL EVENTS LOG ────────────────────────────────────────
create table if not exists public.referral_events (
  id            uuid default uuid_generate_v4() primary key,
  referrer_id   uuid references public.profiles(id) not null,
  referee_id    uuid references public.profiles(id) not null,
  bonus_awarded boolean default false,
  bonus_amount  integer default 50,        -- PlugScore points
  awarded_at    timestamptz,
  created_at    timestamptz default now(),
  unique (referee_id)                      -- one referral per user
);

alter table public.referral_events enable row level security;
create policy "Users see own referrals"
  on public.referral_events for select
  using (auth.uid() = referrer_id or auth.uid() = referee_id);

-- ── GIGS: Booking slots + performance stats ────────────────────
alter table public.gigs
  add column if not exists booking_slots    jsonb default '[]'::jsonb,
  -- e.g. [{"day":"Monday","start":"09:00","end":"17:00","max_bookings":3}]
  add column if not exists jobs_completed   integer default 0,
  add column if not exists total_response_ms bigint default 0,   -- sum of response times
  add column if not exists response_count    integer default 0,  -- number of responses
  add column if not exists avg_response_mins numeric,            -- cached avg
  add column if not exists next_available_at timestamptz,
  add column if not exists is_available      boolean default true;

-- ── GIG BOOKINGS TABLE ─────────────────────────────────────────
create table if not exists public.gig_bookings (
  id           uuid default uuid_generate_v4() primary key,
  gig_id       uuid references public.gigs(id) on delete cascade not null,
  client_id    uuid references public.profiles(id) not null,
  seller_id    uuid references public.profiles(id) not null,
  slot_date    date not null,
  slot_time    text not null,              -- "14:00"
  status       text default 'pending' check (status in ('pending','confirmed','completed','cancelled')),
  notes        text,
  amount       bigint,
  created_at   timestamptz default now()
);

alter table public.gig_bookings enable row level security;
create policy "Parties see own bookings"
  on public.gig_bookings for select
  using (auth.uid() = client_id or auth.uid() = seller_id);
create policy "Clients create bookings"
  on public.gig_bookings for insert
  with check (auth.uid() = client_id);
create policy "Parties update bookings"
  on public.gig_bookings for update
  using (auth.uid() = client_id or auth.uid() = seller_id);

-- ── LIVE VIEWER SESSIONS (ephemeral) ──────────────────────────
create table if not exists public.listing_views (
  id          uuid default uuid_generate_v4() primary key,
  listing_id  uuid references public.listings(id) on delete cascade not null,
  viewer_id   uuid references public.profiles(id),
  session_id  text not null,             -- anonymous session ID
  viewed_at   timestamptz default now(),
  duration_s  integer                    -- time spent on listing
);

create index listing_views_listing_idx on public.listing_views(listing_id, viewed_at desc);

alter table public.listing_views enable row level security;
create policy "Sellers see own listing views"
  on public.listing_views for select
  using (exists (
    select 1 from public.listings l
    where l.id = listing_id and l.seller_id = auth.uid()
  ));
create policy "Auth users log views"
  on public.listing_views for insert with check (true);

-- ── CHAT LEAKAGE SCANNER LOGS ─────────────────────────────────
create table if not exists public.chat_flag_log (
  id           uuid default uuid_generate_v4() primary key,
  sender_id    uuid references public.profiles(id),
  listing_id   uuid references public.listings(id),
  message_hash text not null,            -- SHA-256 of message (no plaintext stored)
  flag_type    text not null,            -- 'phone_number' | 'whatsapp' | 'instagram' | 'external_payment'
  severity     text default 'warning' check (severity in ('warning','critical')),
  action_taken text default 'warned',   -- 'warned' | 'blocked' | 'reviewed'
  created_at   timestamptz default now()
);

alter table public.chat_flag_log enable row level security;
create policy "Users see own flags"
  on public.chat_flag_log for select using (auth.uid() = sender_id);
create policy "Auth users log flags"
  on public.chat_flag_log for insert with check (auth.uid() = sender_id);

-- ── MARKET INTELLIGENCE FUNCTION ──────────────────────────────
create or replace function public.get_market_intelligence(
  p_category   text,
  p_university text
)
returns json
language plpgsql stable
as $$
declare
  avg_days_to_sell numeric;
  price_data       json;
  total_sold       integer;
  sell_rate_pct    numeric;
begin
  -- Average days from creation to sold status
  select
    round(avg(extract(epoch from (updated_at - created_at)) / 86400), 1),
    count(*) filter (where status = 'sold'),
    round(
      100.0 * count(*) filter (where status = 'sold') /
      nullif(count(*), 0),
      1
    )
  into avg_days_to_sell, total_sold, sell_rate_pct
  from public.listings
  where category    = p_category
    and university  = p_university
    and created_at  > now() - interval '90 days';

  -- Price intelligence (reuse existing function)
  select row_to_json(r) into price_data from (
    select
      round(avg(price))                                            as avg_price,
      percentile_cont(0.5) within group (order by price)          as median_price,
      count(*) filter (where status = 'active')                   as active_count,
      count(*) filter (where status = 'sold')                     as sold_count
    from public.listings
    where category   = p_category
      and university = p_university
      and created_at > now() - interval '90 days'
  ) r;

  return json_build_object(
    'avg_days_to_sell',  coalesce(avg_days_to_sell, 0),
    'total_sold_90d',    coalesce(total_sold, 0),
    'sell_rate_pct',     coalesce(sell_rate_pct, 0),
    'price_data',        price_data,
    'demand_level',      case
      when coalesce(sell_rate_pct, 0) >= 70 then 'high'
      when coalesce(sell_rate_pct, 0) >= 40 then 'medium'
      else 'low'
    end
  );
end;
$$;

-- ── CHECK-IN PROXIMITY FUNCTION ───────────────────────────────
-- Returns meters between two GPS coordinates (Haversine)
create or replace function public.gps_distance_m(
  lat1 numeric, lng1 numeric,
  lat2 numeric, lng2 numeric
)
returns numeric
language sql immutable as $$
  select round(
    6371000 * acos(
      least(1.0, cos(radians(lat1)) * cos(radians(lat2)) *
      cos(radians(lng2) - radians(lng1)) +
      sin(radians(lat1)) * sin(radians(lat2)))
    )
  )
$$;

-- ── REFERRAL BONUS TRIGGER ─────────────────────────────────────
create or replace function public.process_referral_bonus()
returns trigger language plpgsql security definer as $$
declare
  referrer_id uuid;
begin
  -- Only fires when a transaction is released (first completed sale)
  if new.status != 'released' or old.status = 'released' then
    return new;
  end if;

  -- Check if buyer was referred and this is their first completed transaction
  select p.referred_by into referrer_id
  from public.profiles p
  where p.id = new.buyer_id
    and p.referred_by is not null;

  if referrer_id is null then return new; end if;

  -- Check if referral bonus not yet awarded
  if exists (
    select 1 from public.referral_events
    where referee_id = new.buyer_id and bonus_awarded = true
  ) then return new; end if;

  -- Award +50 PlugScore to referrer
  update public.profiles
  set plug_score     = least(plug_score + 50, 1000),
      referral_count = referral_count + 1
  where id = referrer_id;

  -- Mark referral as awarded
  update public.referral_events
  set bonus_awarded = true, awarded_at = now()
  where referee_id = new.buyer_id;

  -- Notify referrer
  insert into public.notifications (user_id, type, title, body, data)
  values (
    referrer_id, 'referral_bonus',
    '🎉 Referral Bonus!',
    'Your referral just completed their first purchase. +50 PlugScore!',
    jsonb_build_object('referee_id', new.buyer_id, 'bonus', 50)
  );

  -- Activity feed
  insert into public.activity_feed (actor_id, actor_name, action, emoji)
  select referrer_id, p.full_name, 'earned a referral bonus', '🎁'
  from public.profiles p where p.id = referrer_id;

  return new;
end;
$$;

create trigger on_referral_bonus
  after update on public.transactions
  for each row execute procedure public.process_referral_bonus();

-- ── CHECK-IN UNLOCK TRIGGER ────────────────────────────────────
create or replace function public.handle_checkin_update()
returns trigger language plpgsql security definer as $$
begin
  -- When both parties have arrived, unlock the QR scan button
  if new.buyer_arrived = true and new.seller_arrived = true
     and (old.buyer_arrived = false or old.seller_arrived = false)
  then
    update public.transactions
    set checkin_unlocked = true
    where id = new.id;

    -- Notify both
    insert into public.notifications (user_id, type, title, body, data)
    values
      (new.buyer_id,  'checkin_complete', '📍 Both Parties Arrived!',
       'QR scan is now unlocked. Complete your exchange!',
       jsonb_build_object('transaction_id', new.id)),
      (new.seller_id, 'checkin_complete', '📍 Buyer Has Arrived!',
       'Show your QR code — buyer is ready to scan.',
       jsonb_build_object('transaction_id', new.id));
  end if;
  return new;
end;
$$;

create trigger on_checkin_update
  after update on public.transactions
  for each row
  when (new.buyer_arrived is distinct from old.buyer_arrived
     or new.seller_arrived is distinct from old.seller_arrived)
  execute procedure public.handle_checkin_update();

-- ── STREAK UPDATE FUNCTION ─────────────────────────────────────
create or replace function public.update_streak(p_user_id uuid)
returns json
language plpgsql security definer as $$
declare
  s          record;
  today      date := current_date;
  new_streak integer;
begin
  select * into s from public.streaks where user_id = p_user_id;

  if not found then
    -- First activity
    insert into public.streaks (user_id, current_streak, longest_streak, last_active_date, total_active_days)
    values (p_user_id, 1, 1, today, 1)
    returning * into s;
    return json_build_object('streak', 1, 'bonus', false);
  end if;

  -- Already updated today
  if s.last_active_date = today then
    return json_build_object('streak', s.current_streak, 'bonus', false);
  end if;

  -- Consecutive day
  if s.last_active_date = today - 1 then
    new_streak := s.current_streak + 1;
  -- Missed yesterday but has freeze token
  elsif s.last_active_date = today - 2 and s.freeze_tokens > 0 and not s.streak_frozen then
    new_streak := s.current_streak + 1;
    update public.streaks set freeze_tokens = freeze_tokens - 1, streak_frozen = true
    where user_id = p_user_id;
  -- Streak broken
  else
    new_streak := 1;
    update public.streaks set streak_frozen = false where user_id = p_user_id;
  end if;

  update public.streaks set
    current_streak   = new_streak,
    longest_streak   = greatest(longest_streak, new_streak),
    last_active_date = today,
    total_active_days = total_active_days + 1,
    updated_at       = now()
  where user_id = p_user_id;

  -- Streak milestone bonuses
  if new_streak in (7, 14, 30, 60, 100) then
    update public.profiles
    set plug_score = least(plug_score + (new_streak / 2), 1000)
    where id = p_user_id;

    insert into public.notifications (user_id, type, title, body)
    values (p_user_id, 'streak_milestone',
      '🔥 ' || new_streak || '-Day Streak!',
      'You earned ' || (new_streak / 2) || ' bonus PlugScore points for consistency!');
  end if;

  -- Update profile streak_days
  update public.profiles set streak_days = new_streak where id = p_user_id;

  return json_build_object(
    'streak',    new_streak,
    'longest',   greatest(s.longest_streak, new_streak),
    'milestone', new_streak in (7, 14, 30, 60, 100),
    'bonus',     new_streak in (7, 14, 30, 60, 100)
  );
end;
$$;

-- ── FLASH DEAL AUTO-EXPIRE FUNCTION ───────────────────────────
create or replace function public.expire_flash_deals()
returns void language plpgsql security definer as $$
begin
  update public.listings
  set status = 'deleted', is_flash_deal = false
  where is_flash_deal = true
    and flash_expires_at < now()
    and status = 'active';
end;
$$;

-- ── REALTIME publications ──────────────────────────────────────
alter publication supabase_realtime add table public.listing_views;
alter publication supabase_realtime add table public.gig_bookings;
alter publication supabase_realtime add table public.streaks;
