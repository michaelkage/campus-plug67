-- ============================================================
-- Campus Plug — Migration 003: Sovereign Ecosystem Upgrade
-- ============================================================

-- ── ENUMS & DOMAIN TYPES ─────────────────────────────────────
create type transaction_status as enum (
  'pending', 'locked', 'meetup_initiated',
  'release_requested', 'disputed', 'released', 'cancelled'
);

-- Alter existing transactions table to use enum + new columns
alter table public.transactions
  add column if not exists new_status transaction_status default 'pending',
  add column if not exists meetup_initiated_at  timestamptz,
  add column if not exists release_requested_at timestamptz,
  add column if not exists disputed_at          timestamptz,
  add column if not exists dispute_reason       text,
  add column if not exists dispute_resolved_at  timestamptz,
  add column if not exists auto_release_at      timestamptz,  -- computed: release_requested_at + 48h
  add column if not exists buyer_rating         smallint check (buyer_rating between 1 and 5),
  add column if not exists seller_rating        smallint check (seller_rating between 1 and 5),
  add column if not exists meetup_spot          text;

-- Migrate existing status strings to enum
update public.transactions set new_status = status::transaction_status
  where status in ('pending','locked','released','cancelled','disputed');
update public.transactions set new_status = 'pending' where new_status is null;

-- ── STUDY POOLS TABLE ────────────────────────────────────────
create table if not exists public.study_pools (
  id               uuid default uuid_generate_v4() primary key,
  organizer_id     uuid references public.profiles(id) on delete cascade not null,
  title            text not null,
  description      text,
  category         text not null default 'Group Buy',
  item_name        text not null,                        -- e.g. "Ream of A4 Paper"
  unit_price       bigint not null,                      -- kobo per person
  total_price      bigint not null,                      -- full deal price in kobo
  max_capacity     integer not null check (max_capacity between 2 and 50),
  current_count    integer default 1,                    -- organizer is auto-participant
  participants     uuid[] default '{}',                  -- profile IDs
  payment_refs     text[] default '{}',                  -- Paystack refs per participant
  status           text default 'open' check (status in ('open','locked','completed','cancelled')),
  university       text not null,
  expires_at       timestamptz not null default (now() + interval '72 hours'),
  image_url        text,
  supplier_info    text,
  created_at       timestamptz default now()
);

alter table public.study_pools enable row level security;

create policy "Pools readable by all"
  on public.study_pools for select using (true);

create policy "Auth users create pools"
  on public.study_pools for insert
  with check (auth.uid() = organizer_id);

create policy "Organizer updates own pools"
  on public.study_pools for update
  using (auth.uid() = organizer_id);

-- ── RATINGS TABLE ─────────────────────────────────────────────
create table if not exists public.ratings (
  id             uuid default uuid_generate_v4() primary key,
  transaction_id uuid references public.transactions(id) on delete cascade unique,
  reviewer_id    uuid references public.profiles(id) not null,
  reviewee_id    uuid references public.profiles(id) not null,
  score          smallint not null check (score between 1 and 5),
  comment        text,
  created_at     timestamptz default now()
);

alter table public.ratings enable row level security;

create policy "Ratings public read"
  on public.ratings for select using (true);

create policy "Transaction parties rate"
  on public.ratings for insert
  with check (auth.uid() = reviewer_id);

-- ── AUTO-RELEASE JOB TRACKING ─────────────────────────────────
create table if not exists public.scheduled_jobs (
  id           uuid default uuid_generate_v4() primary key,
  type         text not null,           -- 'auto_release' | 'pool_expire'
  entity_id    uuid not null,           -- transaction_id or pool_id
  run_at       timestamptz not null,
  executed     boolean default false,
  executed_at  timestamptz,
  result       jsonb
);

-- ── INDEXES ───────────────────────────────────────────────────
create index if not exists pools_university_status_idx on public.study_pools(university, status);
create index if not exists pools_expires_idx on public.study_pools(expires_at) where status = 'open';
create index if not exists ratings_reviewee_idx on public.ratings(reviewee_id);
create index if not exists scheduled_jobs_run_at_idx on public.scheduled_jobs(run_at) where not executed;

-- ── REALTIME ──────────────────────────────────────────────────
alter publication supabase_realtime add table public.study_pools;
alter publication supabase_realtime add table public.ratings;

-- ============================================================
-- SMART PRICE SUGGESTER v2 — Outlier-Excluded Median
-- ============================================================
create or replace function public.get_price_suggestion(
  p_category   text,
  p_university text,
  p_title      text default null
)
returns json
language plpgsql stable
as $$
declare
  q1     bigint;
  q3     bigint;
  iqr    bigint;
  result json;
begin
  -- Compute IQR fence to exclude outliers
  select
    percentile_cont(0.25) within group (order by price),
    percentile_cont(0.75) within group (order by price)
  into q1, q3
  from public.listings
  where category = p_category
    and university = p_university
    and status in ('active', 'sold')
    and created_at > now() - interval '90 days';

  iqr := coalesce(q3 - q1, 0);

  -- Now compute stats excluding outliers (values outside 1.5×IQR)
  select json_build_object(
    'avg_price',      round(avg(price)),
    'min_price',      min(price),
    'max_price',      max(price),
    'median_price',   percentile_cont(0.5) within group (order by price),
    'q1_price',       q1,
    'q3_price',       q3,
    'sample_count',   count(*),
    'outliers_removed', (
      select count(*) from public.listings
      where category = p_category and university = p_university
        and status in ('active','sold')
        and created_at > now() - interval '90 days'
        and (price < q1 - 1.5 * iqr or price > q3 + 1.5 * iqr)
    )
  )
  into result
  from public.listings
  where category = p_category
    and university = p_university
    and status in ('active', 'sold')
    and created_at > now() - interval '90 days'
    and (iqr = 0 or (price >= q1 - 1.5 * iqr and price <= q3 + 1.5 * iqr));

  return result;
end;
$$;

-- ============================================================
-- POOL CAPACITY TRIGGER — Lock pool when full
-- ============================================================
create or replace function public.handle_pool_join()
returns trigger
language plpgsql security definer
as $$
begin
  -- If pool just reached max capacity, lock it
  if new.current_count >= new.max_capacity and new.status = 'open' then
    new.status := 'locked';

    -- Notify organizer
    insert into public.notifications(user_id, type, title, body, data)
    values (
      new.organizer_id,
      'pool_full',
      '🎉 Your Pool is Full!',
      '"' || new.title || '" has reached capacity. Time to purchase!',
      jsonb_build_object('pool_id', new.id)
    );

    -- Notify all participants
    insert into public.notifications(user_id, type, title, body, data)
    select
      unnest(new.participants),
      'pool_full',
      '🎉 Pool Locked — Deal On!',
      '"' || new.title || '" is full. Watch for purchase confirmation.',
      jsonb_build_object('pool_id', new.id);

    -- Activity feed
    insert into public.activity_feed(actor_name, action, subject, emoji, university)
    select p.full_name, 'filled a study pool', new.title, '🛒', new.university
    from public.profiles p where p.id = new.organizer_id;
  end if;

  return new;
end;
$$;

create trigger on_pool_updated
  before update on public.study_pools
  for each row
  when (new.current_count is distinct from old.current_count)
  execute procedure public.handle_pool_join();

-- ============================================================
-- TRANSACTION STATE MACHINE TRIGGER (Enhanced)
-- ============================================================
create or replace function public.handle_transaction_update()
returns trigger
language plpgsql security definer
as $$
declare
  actor_name  text;
  item_title  text;
  auto_ts     timestamptz;
begin
  -- PENDING → LOCKED (payment received)
  if new.status = 'locked' and old.status = 'pending' then
    update public.listings set status = 'reserved' where id = new.listing_id;

    insert into public.notifications(user_id, type, title, body, data)
    values (new.seller_id, 'payment_locked',
      '🔐 Payment Locked in Escrow',
      'Buyer paid! Arrange your Safe-Exchange meetup.',
      jsonb_build_object('transaction_id', new.id));
  end if;

  -- LOCKED → MEETUP_INITIATED
  if new.status = 'meetup_initiated' and old.status = 'locked' then
    -- Schedule auto-release for 24h if buyer doesn't scan
    insert into public.scheduled_jobs(type, entity_id, run_at)
    values ('check_qr_timeout', new.id, new.meetup_initiated_at + interval '24 hours');

    insert into public.notifications(user_id, type, title, body, data)
    values
      (new.buyer_id, 'meetup_initiated',
        '📍 Meetup Confirmed',
        'You have 24 hours to scan the seller''s QR code.',
        jsonb_build_object('transaction_id', new.id)),
      (new.seller_id, 'meetup_initiated',
        '📍 Buyer is On Their Way',
        'Show your QR code. Buyer has 24 hours to scan.',
        jsonb_build_object('transaction_id', new.id));
  end if;

  -- → RELEASE_REQUESTED (seller triggers after 24h)
  if new.status = 'release_requested' and old.status in ('locked','meetup_initiated') then
    -- Auto-release fires in 48h if no dispute
    auto_ts := now() + interval '48 hours';
    new.auto_release_at := auto_ts;

    insert into public.scheduled_jobs(type, entity_id, run_at)
    values ('auto_release', new.id, auto_ts);

    insert into public.notifications(user_id, type, title, body, data)
    values
      (new.buyer_id, 'release_requested',
        '⚠️ Seller Requested Fund Release',
        'You have 48 hours to dispute or funds auto-release to seller.',
        jsonb_build_object('transaction_id', new.id, 'auto_release_at', auto_ts)),
      (new.seller_id, 'release_requested',
        '⏳ Release Requested',
        'Buyer notified. Funds auto-release in 48 hours if no dispute.',
        jsonb_build_object('transaction_id', new.id));
  end if;

  -- → DISPUTED
  if new.status = 'disputed' and old.status != 'disputed' then
    -- Cancel any pending auto-release job
    update public.scheduled_jobs set executed = true, executed_at = now()
    where entity_id = new.id and type = 'auto_release' and not executed;

    insert into public.notifications(user_id, type, title, body, data)
    values
      (new.seller_id, 'disputed',
        '🚨 Buyer Raised a Dispute',
        'Your transaction is under review. Campus Plug will mediate.',
        jsonb_build_object('transaction_id', new.id)),
      (new.buyer_id, 'disputed',
        '🚨 Dispute Filed',
        'Your dispute is being reviewed. We''ll update you within 24 hours.',
        jsonb_build_object('transaction_id', new.id));
  end if;

  -- → RELEASED (final success)
  if new.status = 'released' and old.status != 'released' then
    select full_name into actor_name from public.profiles where id = new.seller_id;
    select title      into item_title  from public.listings  where id = new.listing_id;

    -- Update listing
    update public.listings set status = 'sold' where id = new.listing_id;

    -- Update seller profile
    update public.profiles set
      plug_score     = plug_score + 50,
      total_sales    = total_sales + 1,
      total_earnings = total_earnings + new.amount
    where id = new.seller_id;

    -- Badge evaluation
    with seller as (
      select total_sales, plug_score from public.profiles where id = new.seller_id
    )
    update public.profiles set badges = (
      select array_agg(distinct b) filter (where b is not null)
      from (
        select unnest(badges) as b
        union all
        select case
          when (select total_sales from seller) >= 100 then 'Hall of Fame'
          when (select total_sales from seller) >= 50  then 'Top Seller'
          when (select total_sales from seller) >= 10  then 'Rising Star'
          else null
        end
      ) sub
    )
    where id = new.seller_id;

    -- Activity feed
    insert into public.activity_feed(actor_name, actor_id, action, subject, amount, emoji, university)
    select actor_name, new.seller_id, 'completed a sale', item_title, new.amount, '💰', l.university
    from public.listings l where l.id = new.listing_id;

    -- Notify both parties
    insert into public.notifications(user_id, type, title, body, data)
    values
      (new.buyer_id,  'transaction_complete', '✅ Exchange Complete!',
        'Funds released to seller. Enjoy your item!',
        jsonb_build_object('transaction_id', new.id)),
      (new.seller_id, 'funds_released', '💰 Funds Released!',
        'Your ₦' || (new.amount / 100) || ' is on its way.',
        jsonb_build_object('transaction_id', new.id));

    -- Cancel any pending scheduled jobs
    update public.scheduled_jobs set executed = true, executed_at = now()
    where entity_id = new.id and not executed;
  end if;

  return new;
end;
$$;

drop trigger if exists on_transaction_updated on public.transactions;
create trigger on_transaction_updated
  after update on public.transactions
  for each row execute procedure public.handle_transaction_update();

-- ============================================================
-- PROFILE AVG RATING VIEW
-- ============================================================
create or replace view public.profile_ratings as
  select
    reviewee_id as profile_id,
    round(avg(score)::numeric, 1) as avg_rating,
    count(*) as rating_count
  from public.ratings
  group by reviewee_id;
