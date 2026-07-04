-- ============================================================
-- Campus Plug MVP — Database Schema
-- Run this in your Supabase SQL Editor
-- ============================================================

-- Extensions
create extension if not exists "uuid-ossp";
create extension if not exists pg_trgm; -- for fuzzy search

-- ============================================================
-- TABLES
-- ============================================================

-- Profiles (extends auth.users)
create table public.profiles (
  id            uuid references auth.users(id) on delete cascade primary key,
  email         text not null,
  full_name     text,
  university    text,
  matric_number text unique,
  department    text,
  level         text check (level in ('100', '200', '300', '400', '500', 'PG', 'Staff')),
  avatar_url    text,
  bio           text,
  plug_score    integer default 500 check (plug_score >= 0),
  total_sales   integer default 0,
  total_earnings bigint default 0,         -- stored in kobo
  badges        text[] default '{}',
  is_verified   boolean default false,
  is_suspended  boolean default false,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);

-- Listings
create table public.listings (
  id          uuid default uuid_generate_v4() primary key,
  seller_id   uuid references public.profiles(id) on delete cascade not null,
  title       text not null,
  description text,
  category    text not null check (category in (
    'Textbooks', 'Electronics', 'Hostels',
    'Gadgets', 'Clothing', 'Lab Equipment', 'Other'
  )),
  price       bigint not null check (price > 0),  -- kobo
  images      text[] default '{}',
  status      text default 'active' check (status in ('active', 'sold', 'reserved', 'deleted')),
  university  text not null,
  views       integer default 0,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

-- Create index for smart price suggester
create index listings_category_university_idx on public.listings(category, university, status);
create index listings_search_idx on public.listings using gin(to_tsvector('english', title || ' ' || coalesce(description, '')));

-- Transactions (Escrow)
create table public.transactions (
  id                uuid default uuid_generate_v4() primary key,
  listing_id        uuid references public.listings(id) not null,
  buyer_id          uuid references public.profiles(id) not null,
  seller_id         uuid references public.profiles(id) not null,
  amount            bigint not null,                    -- kobo
  status            text default 'pending' check (status in (
    'pending', 'locked', 'released', 'cancelled', 'disputed'
  )),
  qr_secret         text unique default uuid_generate_v4()::text,
  paystack_ref      text unique,
  payment_verified  boolean default false,
  meetup_location   text,
  created_at        timestamptz default now(),
  locked_at         timestamptz,
  released_at       timestamptz,
  cancelled_at      timestamptz
);

create index transactions_buyer_idx on public.transactions(buyer_id);
create index transactions_seller_idx on public.transactions(seller_id);

-- Lost & Found
create table public.lost_found (
  id          uuid default uuid_generate_v4() primary key,
  reporter_id uuid references public.profiles(id) not null,
  type        text not null check (type in ('lost', 'found')),
  title       text not null,
  description text,
  tags        text[] default '{}',
  location    text,
  image_url   text,
  status      text default 'open' check (status in ('open', 'resolved', 'claimed')),
  university  text not null,
  created_at  timestamptz default now()
);

create index lostfound_tags_idx on public.lost_found using gin(tags);
create index lostfound_university_idx on public.lost_found(university, status, type);

-- Notifications
create table public.notifications (
  id         uuid default uuid_generate_v4() primary key,
  user_id    uuid references public.profiles(id) on delete cascade not null,
  type       text not null,
  title      text not null,
  body       text,
  data       jsonb,
  read       boolean default false,
  created_at timestamptz default now()
);

create index notifications_user_unread_idx on public.notifications(user_id, read);

-- Activity Feed (denormalized for real-time performance)
create table public.activity_feed (
  id          uuid default uuid_generate_v4() primary key,
  actor_name  text not null,
  actor_id    uuid references public.profiles(id),
  action      text not null,
  subject     text,
  amount      bigint,
  emoji       text default '⚡',
  university  text,
  created_at  timestamptz default now()
);

-- Chat Messages
create table public.messages (
  id          uuid default uuid_generate_v4() primary key,
  sender_id   uuid references public.profiles(id) not null,
  receiver_id uuid references public.profiles(id) not null,
  listing_id  uuid references public.listings(id),
  body        text not null,
  read        boolean default false,
  created_at  timestamptz default now()
);

create index messages_conversation_idx on public.messages(
  least(sender_id::text, receiver_id::text),
  greatest(sender_id::text, receiver_id::text)
);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================

alter table public.profiles    enable row level security;
alter table public.listings    enable row level security;
alter table public.transactions enable row level security;
alter table public.lost_found  enable row level security;
alter table public.notifications enable row level security;
alter table public.activity_feed enable row level security;
alter table public.messages    enable row level security;

-- PROFILES
create policy "Profiles viewable by all"
  on public.profiles for select using (true);

create policy "Users insert own profile"
  on public.profiles for insert with check (auth.uid() = id);

create policy "Users update own profile"
  on public.profiles for update using (auth.uid() = id);

-- LISTINGS
create policy "Active listings viewable by all"
  on public.listings for select using (status != 'deleted');

create policy "Auth users create listings"
  on public.listings for insert
  with check (auth.uid() = seller_id);

create policy "Sellers update own listings"
  on public.listings for update
  using (auth.uid() = seller_id);

create policy "Sellers delete own listings"
  on public.listings for delete
  using (auth.uid() = seller_id);

-- TRANSACTIONS
create policy "Parties view own transactions"
  on public.transactions for select
  using (auth.uid() = buyer_id or auth.uid() = seller_id);

create policy "Buyers create transactions"
  on public.transactions for insert
  with check (auth.uid() = buyer_id);

-- LOST & FOUND
create policy "Lost & Found viewable by all"
  on public.lost_found for select using (true);

create policy "Auth users report items"
  on public.lost_found for insert
  with check (auth.role() = 'authenticated');

create policy "Reporters update own items"
  on public.lost_found for update
  using (auth.uid() = reporter_id);

-- NOTIFICATIONS
create policy "Users see own notifications"
  on public.notifications for select
  using (auth.uid() = user_id);

create policy "Users update own notifications"
  on public.notifications for update
  using (auth.uid() = user_id);

-- ACTIVITY FEED
create policy "Activity feed public read"
  on public.activity_feed for select using (true);

create policy "Service role inserts activity"
  on public.activity_feed for insert
  with check (true);

-- MESSAGES
create policy "Users see own messages"
  on public.messages for select
  using (auth.uid() = sender_id or auth.uid() = receiver_id);

create policy "Auth users send messages"
  on public.messages for insert
  with check (auth.uid() = sender_id);

-- ============================================================
-- FUNCTIONS & TRIGGERS
-- ============================================================

-- Auto-create profile on signup
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, email, full_name, is_verified)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)),
    false
  );
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- Auto-update updated_at
create or replace function public.handle_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger profiles_updated_at
  before update on public.profiles
  for each row execute procedure public.handle_updated_at();

create trigger listings_updated_at
  before update on public.listings
  for each row execute procedure public.handle_updated_at();

-- Lost & Found match detection
create or replace function public.check_lostfound_match()
returns trigger as $$
declare
  match       record;
  opp_type    text;
  match_score integer;
begin
  opp_type := case when new.type = 'lost' then 'found' else 'lost' end;

  -- Find matching items by overlapping tags in same university
  select lf.*, array_length(lf.tags & new.tags, 1) as score
  into match
  from public.lost_found lf
  where lf.type = opp_type
    and lf.status = 'open'
    and lf.university = new.university
    and lf.tags && new.tags          -- && means arrays overlap
  order by score desc
  limit 1;

  if match.id is not null then
    -- Notify reporter of new item
    insert into public.notifications (user_id, type, title, body, data)
    values (
      new.reporter_id,
      'lostfound_match',
      '🔍 Possible Match Found!',
      'A ' || opp_type || ' item may match yours: "' || match.title || '"',
      jsonb_build_object('match_id', match.id, 'match_title', match.title)
    );

    -- Notify the other reporter
    insert into public.notifications (user_id, type, title, body, data)
    values (
      match.reporter_id,
      'lostfound_match',
      '🔍 Possible Match Found!',
      'A ' || new.type || ' item may match yours: "' || new.title || '"',
      jsonb_build_object('match_id', new.id, 'match_title', new.title)
    );
  end if;

  return new;
end;
$$ language plpgsql security definer;

create trigger on_lostfound_created
  after insert on public.lost_found
  for each row execute procedure public.check_lostfound_match();

-- Update PlugScore on transaction release
create or replace function public.handle_transaction_update()
returns trigger as $$
declare
  actor_name text;
  item_title text;
begin
  if new.status = 'released' and old.status = 'locked' then
    -- Update seller stats
    update public.profiles
    set
      plug_score    = plug_score + 50,
      total_sales   = total_sales + 1,
      total_earnings = total_earnings + new.amount
    where id = new.seller_id;

    -- Update listing to sold
    update public.listings
    set status = 'sold'
    where id = new.listing_id;

    -- Fetch names for activity feed
    select full_name into actor_name from public.profiles where id = new.seller_id;
    select title      into item_title  from public.listings  where id = new.listing_id;

    -- Insert activity
    insert into public.activity_feed (actor_name, actor_id, action, subject, amount, emoji)
    values (actor_name, new.seller_id, 'completed a sale', item_title, new.amount, '💰');

    -- Badge checks
    update public.profiles
    set badges = (
      select array_agg(distinct b) from (
        select unnest(badges) as b
        union all
        select case
          when total_sales >= 100 then 'Hall of Fame'
          when total_sales >= 50  then 'Top Seller'
          when total_sales >= 10  then 'Rising Star'
          else null
        end
      ) sub where b is not null
    )
    where id = new.seller_id;

    -- Notify buyer
    insert into public.notifications (user_id, type, title, body, data)
    values (
      new.buyer_id,
      'transaction_complete',
      '✅ Exchange Complete!',
      'Funds have been released to the seller. Enjoy your item!',
      jsonb_build_object('transaction_id', new.id)
    );

    -- Notify seller
    insert into public.notifications (user_id, type, title, body, data)
    values (
      new.seller_id,
      'funds_released',
      '💰 Funds Released!',
      'Your payment has been released. ₦' || (new.amount / 100) || ' is on its way.',
      jsonb_build_object('transaction_id', new.id)
    );
  end if;

  if new.status = 'locked' and old.status = 'pending' then
    -- Notify seller that buyer paid
    insert into public.notifications (user_id, type, title, body, data)
    values (
      new.seller_id,
      'payment_locked',
      '🔐 Payment Locked in Escrow',
      'A buyer has paid and funds are locked. Arrange your meetup!',
      jsonb_build_object('transaction_id', new.id, 'listing_id', new.listing_id)
    );
  end if;

  return new;
end;
$$ language plpgsql security definer;

create trigger on_transaction_updated
  after update on public.transactions
  for each row execute procedure public.handle_transaction_update();

-- ============================================================
-- SMART PRICE SUGGESTER FUNCTION
-- ============================================================
create or replace function public.get_price_suggestion(
  p_category  text,
  p_university text,
  p_title     text default null
)
returns json as $$
declare
  result json;
begin
  select json_build_object(
    'avg_price',    round(avg(price)),
    'min_price',    min(price),
    'max_price',    max(price),
    'median_price', percentile_cont(0.5) within group (order by price),
    'sample_count', count(*)
  )
  into result
  from public.listings
  where category = p_category
    and university = p_university
    and status in ('active', 'sold')
    and created_at > now() - interval '90 days';

  return result;
end;
$$ language plpgsql stable;

-- ============================================================
-- REALTIME PUBLICATIONS
-- ============================================================

-- Enable realtime for key tables
alter publication supabase_realtime add table public.listings;
alter publication supabase_realtime add table public.activity_feed;
alter publication supabase_realtime add table public.notifications;
alter publication supabase_realtime add table public.messages;
alter publication supabase_realtime add table public.transactions;

-- ============================================================
-- SEED: Allowed university domains (optional config table)
-- ============================================================
create table if not exists public.allowed_domains (
  domain      text primary key,
  university  text not null,
  active      boolean default true
);

insert into public.allowed_domains (domain, university) values
  ('unilag.edu.ng',  'University of Lagos'),
  ('oauife.edu.ng',  'Obafemi Awolowo University'),
  ('ui.edu.ng',      'University of Ibadan'),
  ('uniben.edu.ng',  'University of Benin'),
  ('abu.edu.ng',     'Ahmadu Bello University'),
  ('yabatech.edu.ng','Yaba College of Technology'),
  ('lasu.edu.ng',    'Lagos State University'),
  ('unn.edu.ng',     'University of Nigeria Nsukka')
on conflict do nothing;

-- Grant select on allowed_domains to anon (needed during signup)
alter table public.allowed_domains enable row level security;
create policy "Anyone can read allowed domains"
  on public.allowed_domains for select using (true);
