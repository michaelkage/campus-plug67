-- ============================================================
-- Campus Plug — Migration 006: Social Gravity & Trust Hardening
-- Run AFTER 001–005
-- ============================================================

-- ── CHAT MESSAGES (full real-time, transaction-linked) ─────────
-- Enhance existing messages table with immutability + trust flags
alter table public.messages
  add column if not exists listing_id        uuid references public.listings(id),
  add column if not exists transaction_id    uuid references public.transactions(id),
  add column if not exists flagged           boolean   default false,
  add column if not exists flag_type         text,         -- 'phone' | 'whatsapp' | 'payment' | 'social'
  add column if not exists flag_severity     text,         -- 'warning' | 'critical'
  add column if not exists is_system_msg     boolean   default false,  -- escrow state change notifications
  add column if not exists deleted_at        timestamptz;              -- soft delete (body replaced with "[deleted]")

-- Immutability: prevent UPDATE of body once sent
-- (soft delete allowed, content editing is NOT)
create or replace rule messages_no_update as
  on update to public.messages
  do instead (
    -- Allow only: read status, flagged, deleted_at updates
    update public.messages set
      read       = new.read,
      flagged    = new.flagged,
      flag_type  = new.flag_type,
      flag_severity = new.flag_severity,
      deleted_at = new.deleted_at
    where id = old.id
  );

-- ── CONVERSATION INDEX ─────────────────────────────────────────
-- Efficiently fetch all messages between two users for a listing
create index if not exists messages_convo_listing_idx
  on public.messages (listing_id, created_at)
  where deleted_at is null;

create index if not exists messages_transaction_idx
  on public.messages (transaction_id)
  where transaction_id is not null;

-- ── PLUGPAY PROTECTION FLAG ────────────────────────────────────
alter table public.listings
  add column if not exists plugpay_protected   boolean default true,
  add column if not exists visibility_score    integer default 100,    -- 0-100, affects feed ranking
  add column if not exists trust_score         integer default 100,    -- drops if description has contact info
  add column if not exists negotiation_count   integer default 0,      -- unique senders chatting about listing
  add column if not exists is_trending         boolean default false;  -- view_count > 10 in last hour

-- ── PLUGSCORE TIERS ────────────────────────────────────────────
alter table public.profiles
  add column if not exists tier                text default 'citizen' check (tier in ('citizen','trusted','elite')),
  add column if not exists tier_updated_at     timestamptz,
  add column if not exists featured_listing_id uuid references public.listings(id),
  add column if not exists commission_rate     numeric default 0,       -- 0 = zero commission (elite)
  add column if not exists top_of_feed        boolean default false;   -- trusted+ only

-- ── SAFE ZONE LINK TO TRANSACTIONS ────────────────────────────
alter table public.transactions
  add column if not exists safe_zone_id uuid references public.safe_zones(id),
  add column if not exists safe_zone_name text;

-- ── TRENDING SNAPSHOT TABLE ────────────────────────────────────
-- Materialised cache — refreshed every 15 min by Edge Function
create table if not exists public.trending_listings (
  listing_id    uuid references public.listings(id) on delete cascade primary key,
  views_1h      integer default 0,
  views_24h     integer default 0,
  messages_1h   integer default 0,
  score         numeric default 0,       -- composite trending score
  updated_at    timestamptz default now()
);

alter table public.trending_listings enable row level security;
create policy "Trending public read"
  on public.trending_listings for select using (true);

-- ── CAMPUS TICKER EVENTS ───────────────────────────────────────
-- Separate from activity_feed — more ephemeral, university-scoped
create table if not exists public.ticker_events (
  id          uuid default uuid_generate_v4() primary key,
  university  text not null,
  emoji       text default '⚡',
  text        text not null,
  category    text default 'general',   -- 'sale' | 'pool' | 'gig' | 'streak' | 'referral'
  expires_at  timestamptz default (now() + interval '2 hours'),
  created_at  timestamptz default now()
);

create index ticker_university_idx on public.ticker_events(university, created_at desc)
  where expires_at > now();

alter table public.ticker_events enable row level security;
create policy "Ticker public read" on public.ticker_events for select using (expires_at > now());
create policy "Auth users insert ticker" on public.ticker_events for insert with check (true);

alter publication supabase_realtime add table public.ticker_events;
alter publication supabase_realtime add table public.messages;
alter publication supabase_realtime add table public.trending_listings;

-- ── TIER UPDATE FUNCTION ───────────────────────────────────────
create or replace function public.refresh_user_tier(p_user_id uuid)
returns text
language plpgsql security definer as $$
declare
  score    integer;
  new_tier text;
begin
  select plug_score into score from public.profiles where id = p_user_id;

  new_tier := case
    when score >= 800 then 'elite'
    when score >= 650 then 'trusted'
    else 'citizen'
  end;

  update public.profiles set
    tier              = new_tier,
    tier_updated_at   = now(),
    top_of_feed       = (new_tier in ('trusted','elite')),
    commission_rate   = case when new_tier = 'elite' then 0 else 0 end,  -- 0% for all for now
    visibility_score  = case
      when new_tier = 'elite'   then 100
      when new_tier = 'trusted' then 85
      else 70
    end
  where id = p_user_id;

  -- Notify on tier upgrade
  perform (
    select 1 from public.profiles
    where id = p_user_id and tier != new_tier
  );

  return new_tier;
end;
$$;

-- ── TIER TRIGGER: fires on every PlugScore change ─────────────
create or replace function public.on_plugscore_change()
returns trigger language plpgsql security definer as $$
declare
  new_tier text;
  old_tier text;
begin
  if new.plug_score = old.plug_score then return new; end if;

  old_tier := old.tier;
  new_tier := case
    when new.plug_score >= 800 then 'elite'
    when new.plug_score >= 650 then 'trusted'
    else 'citizen'
  end;

  new.tier             := new_tier;
  new.tier_updated_at  := now();
  new.top_of_feed      := new_tier in ('trusted','elite');

  -- Notify on upgrade (not downgrade)
  if new_tier != old_tier and (
    (new_tier = 'elite'   and old_tier in ('citizen','trusted')) or
    (new_tier = 'trusted' and old_tier = 'citizen')
  ) then
    insert into public.notifications(user_id, type, title, body, data)
    values (new.id,
      'tier_upgrade',
      case new_tier
        when 'elite'   then '🏆 You are now Campus Elite!'
        when 'trusted' then '⭐ You are now a Trusted Seller!'
      end,
      case new_tier
        when 'elite'   then 'You unlocked PlugCredit, zero-commission featured listings, and top feed placement.'
        when 'trusted' then 'You unlocked top-of-feed placement. Keep selling to reach Campus Elite!'
      end,
      jsonb_build_object('tier', new_tier, 'old_tier', old_tier)
    );

    -- Ticker event
    insert into public.ticker_events(university, emoji, text, category)
    select
      p.university,
      case new_tier when 'elite' then '🏆' else '⭐' end,
      p.full_name || ' just reached ' ||
        case new_tier when 'elite' then 'Campus Elite' else 'Trusted Seller' end || ' status!',
      'streak'
    from public.profiles p where p.id = new.id;
  end if;

  return new;
end;
$$;

drop trigger if exists plugscore_tier_sync on public.profiles;
create trigger plugscore_tier_sync
  before update on public.profiles
  for each row execute procedure public.on_plugscore_change();

-- ── TRUST BADGE: strip if contact info in description ─────────
create or replace function public.scan_listing_trust(p_listing_id uuid)
returns void language plpgsql security definer as $$
declare
  desc_text     text;
  has_contact   boolean;
  new_score     integer;
begin
  select description into desc_text
  from public.listings where id = p_listing_id;

  -- Detect contact info patterns in description
  has_contact := desc_text ~* '(0[789][01]\d{8}|\+?234[789][01]\d{8}|whatsapp|wa\.me|@\w+|instagram|telegram|opay|palmpay|kuda)';

  if has_contact then
    update public.listings set
      plugpay_protected = false,
      visibility_score  = greatest(visibility_score - 30, 20),
      trust_score       = greatest(trust_score - 40, 10)
    where id = p_listing_id;
  else
    update public.listings set
      plugpay_protected = true,
      visibility_score  = least(visibility_score + 5, 100),
      trust_score       = least(trust_score + 5, 100)
    where id = p_listing_id;
  end if;
end;
$$;

-- Trigger on listing insert/update
create or replace function public.on_listing_change()
returns trigger language plpgsql security definer as $$
begin
  perform public.scan_listing_trust(new.id);
  return new;
end;
$$;

drop trigger if exists listing_trust_scan on public.listings;
create trigger listing_trust_scan
  after insert or update of description on public.listings
  for each row execute procedure public.on_listing_change();

-- ── NEGOTIATION COUNT REFRESH ──────────────────────────────────
create or replace function public.refresh_negotiation_count(p_listing_id uuid)
returns void language plpgsql security definer as $$
declare
  unique_senders integer;
begin
  select count(distinct sender_id)
  into unique_senders
  from public.messages
  where listing_id  = p_listing_id
    and created_at  > now() - interval '1 hour'
    and deleted_at  is null
    and not is_system_msg;

  update public.listings
  set negotiation_count = unique_senders
  where id = p_listing_id;
end;
$$;

-- ── TRENDING REFRESH FUNCTION ──────────────────────────────────
create or replace function public.refresh_trending()
returns void language plpgsql security definer as $$
begin
  -- Upsert trending scores
  insert into public.trending_listings(listing_id, views_1h, views_24h, messages_1h, score, updated_at)
  select
    l.id                                                                    as listing_id,
    coalesce(v1h.cnt, 0)                                                    as views_1h,
    coalesce(v24h.cnt, 0)                                                   as views_24h,
    coalesce(m1h.cnt, 0)                                                    as messages_1h,
    -- Composite trending score
    (coalesce(v1h.cnt, 0) * 2 + coalesce(m1h.cnt, 0) * 5)::numeric        as score,
    now()
  from public.listings l
  left join (
    select listing_id, count(*) as cnt
    from public.listing_views
    where viewed_at > now() - interval '1 hour'
    group by listing_id
  ) v1h  on v1h.listing_id  = l.id
  left join (
    select listing_id, count(*) as cnt
    from public.listing_views
    where viewed_at > now() - interval '24 hours'
    group by listing_id
  ) v24h on v24h.listing_id = l.id
  left join (
    select listing_id, count(*) as cnt
    from public.messages
    where created_at > now() - interval '1 hour'
      and not is_system_msg
    group by listing_id
  ) m1h  on m1h.listing_id  = l.id
  where l.status = 'active'
    and (coalesce(v1h.cnt, 0) >= 3 or coalesce(m1h.cnt, 0) >= 2)
  on conflict (listing_id) do update set
    views_1h    = excluded.views_1h,
    views_24h   = excluded.views_24h,
    messages_1h = excluded.messages_1h,
    score       = excluded.score,
    updated_at  = now();

  -- Mark listings as trending
  update public.listings set is_trending = true
  where id in (
    select listing_id from public.trending_listings
    where views_1h >= 10 or score >= 20
  );

  -- Unmark stale trending
  update public.listings set is_trending = false
  where is_trending = true
    and id not in (
      select listing_id from public.trending_listings
      where views_1h >= 10 or score >= 20
    );
end;
$$;

-- ── TICKER INJECT ON TRANSACTION EVENTS ───────────────────────
create or replace function public.inject_ticker_event()
returns trigger language plpgsql security definer as $$
declare
  seller_name text;
  buyer_name  text;
  item_title  text;
  university  text;
begin
  if new.status = 'released' and old.status != 'released' then
    select p.full_name into seller_name from public.profiles p where p.id = new.seller_id;
    select l.title, l.university into item_title, university from public.listings l where l.id = new.listing_id;
    select p.full_name into buyer_name from public.profiles p where p.id = new.buyer_id;

    insert into public.ticker_events(university, emoji, text, category)
    values (university, '💰', seller_name || ' just sold "' || item_title || '" in minutes!', 'sale');
  end if;
  return new;
end;
$$;

drop trigger if exists tx_ticker_inject on public.transactions;
create trigger tx_ticker_inject
  after update on public.transactions
  for each row execute procedure public.inject_ticker_event();

-- ── CHAT SYSTEM MESSAGE HELPER ─────────────────────────────────
-- Auto-inject system messages on transaction state changes
create or replace function public.inject_chat_system_message()
returns trigger language plpgsql security definer as $$
declare
  msg text;
begin
  if new.status = old.status then return new; end if;

  msg := case new.status
    when 'locked'            then '🔐 Payment locked in PlugPay escrow. You are protected.'
    when 'meetup_initiated'  then '📍 Meetup initiated. Show the QR code when you meet.'
    when 'release_requested' then '⏰ Seller has requested fund release. Buyer has 48h to dispute.'
    when 'released'          then '✅ Exchange complete! Funds released. Rate your experience.'
    when 'disputed'          then '🚨 Dispute filed. Campus Plug team will review this chat as evidence.'
    else null
  end;

  if msg is null then return new; end if;

  -- Find the listing to get seller_id for chat context
  insert into public.messages(sender_id, receiver_id, listing_id, transaction_id, body, is_system_msg)
  values (
    new.seller_id, new.buyer_id,
    new.listing_id, new.id,
    msg, true
  );

  return new;
end;
$$;

drop trigger if exists tx_chat_system_msg on public.transactions;
create trigger tx_chat_system_msg
  after update on public.transactions
  for each row execute procedure public.inject_chat_system_message();

-- ── VIEW COUNT RPC (atomic) ────────────────────────────────────
create or replace function public.increment_view_count(p_listing_id uuid)
returns void language sql security definer as $$
  update public.listings
  set view_count = view_count + 1
  where id = p_listing_id;
$$;
