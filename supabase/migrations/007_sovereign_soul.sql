-- ============================================================
-- Campus Plug — Migration 007: Sovereign Soul
-- Run AFTER 001–006
-- ============================================================

-- ── TRANSACTIONS: PoP Engine columns ──────────────────────────
alter table public.transactions
  -- OMW (On My Way) presence accountability
  add column if not exists omw_active          boolean   default false,
  add column if not exists omw_timestamp       timestamptz,
  add column if not exists omw_expires_at      timestamptz,   -- omw_timestamp + 15 min
  add column if not exists omw_lat             numeric,
  add column if not exists omw_lng             numeric,

  -- Movement delta (jitter-proof)
  add column if not exists movement_delta_m    numeric   default 0,  -- metres moved in last 10 min
  add column if not exists last_position_lat   numeric,
  add column if not exists last_position_lng   numeric,
  add column if not exists last_position_at    timestamptz,
  add column if not exists stall_used          boolean   default false, -- has been marked stagnant once

  -- Amber-tier dual sync
  add column if not exists amber_zone_active   boolean   default false,
  add column if not exists buyer_verified_at   timestamptz,
  add column if not exists seller_verified_at  timestamptz,
  add column if not exists dual_sync_complete  boolean   default false,

  -- Override ("Something Went Wrong")
  add column if not exists override_used       boolean   default false,
  add column if not exists override_reason     text,           -- 'network'|'traffic'|'location'
  add column if not exists override_at         timestamptz,
  add column if not exists override_expires_at timestamptz,   -- override_at + 10 min

  -- Ghost refund / priority relist
  add column if not exists ghost_refund_eligible   boolean default false,
  add column if not exists ghost_refunded_at        timestamptz,
  add column if not exists priority_relist_granted  boolean default false,
  add column if not exists priority_relist_at       timestamptz;

-- ── PROFILES: Jury + Anti-Collusion ───────────────────────────
alter table public.profiles
  add column if not exists juror_enabled       boolean   default false,
  add column if not exists rolling_accuracy    numeric   default 0,    -- 0–100, last 20 jury cases
  add column if not exists juror_streak        integer   default 0,    -- correct verdicts this week
  add column if not exists juror_cases_today   integer   default 0,
  add column if not exists juror_last_case_at  timestamptz,
  add column if not exists magistrate_at       timestamptz,            -- when they earned Magistrate badge
  add column if not exists free_listing_tokens integer   default 0,    -- 0% fee tokens from jury rewards
  add column if not exists collusion_flag      boolean   default false,
  add column if not exists collusion_flagged_at timestamptz,
  add column if not exists collusion_ceiling   integer   default 100,  -- max visibility score (60 if flagged)
  add column if not exists priority_relist_today integer default 0,
  add column if not exists priority_relist_this_week integer default 0,
  add column if not exists last_position_reset date;                   -- for daily counter resets

-- ── AUDIT LOGS (immutable message archive) ─────────────────────
create table if not exists public.audit_logs (
  id               uuid default uuid_generate_v4() primary key,
  entity_type      text not null,                   -- 'message' | 'listing' | 'transaction'
  entity_id        uuid not null,
  user_id          uuid references public.profiles(id),
  action           text not null,                   -- 'edit' | 'delete' | 'flag'
  original_content text,                            -- original body (plaintext, for dispute use only)
  new_content      text,
  metadata         jsonb,
  created_at       timestamptz default now()
);

-- Audit logs are append-only: no UPDATE or DELETE allowed
create rule audit_no_update as on update to public.audit_logs do instead nothing;
create rule audit_no_delete as on delete to public.audit_logs do instead nothing;

alter table public.audit_logs enable row level security;
create policy "Admins and parties read audit logs"
  on public.audit_logs for select
  using (auth.uid() = user_id or auth.role() = 'service_role');
create policy "System inserts audit logs"
  on public.audit_logs for insert with check (true);

-- ── PEER JURY CASES ────────────────────────────────────────────
create table if not exists public.jury_cases (
  id                  uuid default uuid_generate_v4() primary key,
  transaction_id      uuid references public.transactions(id) not null unique,
  claimant_id         uuid references public.profiles(id) not null,   -- who filed dispute
  respondent_id       uuid references public.profiles(id) not null,
  dispute_reason      text not null,
  evidence_messages   jsonb,         -- pulled from chat at dispute time (hashed)
  amount              bigint not null,
  high_value          boolean generated always as (amount >= 5000000) stored,  -- ₦50,000+ in kobo
  status              text default 'open'
                        check (status in ('open','deliberating','decided','appealed','closed')),
  verdict             text          check (verdict in ('claimant','respondent','split','void')),
  verdict_decided_at  timestamptz,
  required_votes      integer generated always as (case when amount >= 5000000 then 4 else 3 end) stored,
  votes_cast          integer default 0,
  jurors_assigned     uuid[] default '{}',
  created_at          timestamptz default now()
);

alter table public.jury_cases enable row level security;
create policy "Parties see own cases"
  on public.jury_cases for select
  using (auth.uid() = claimant_id or auth.uid() = respondent_id);
create policy "Assigned jurors see cases"
  on public.jury_cases for select
  using (auth.uid() = any(jurors_assigned));
create policy "Service manages cases"
  on public.jury_cases for all using (auth.role() = 'service_role');

-- ── JURY VOTES ─────────────────────────────────────────────────
create table if not exists public.jury_votes (
  id           uuid default uuid_generate_v4() primary key,
  case_id      uuid references public.jury_cases(id) on delete cascade not null,
  juror_id     uuid references public.profiles(id) not null,
  verdict      text not null check (verdict in ('claimant','respondent','split')),
  reasoning    text,
  reviewed_for_s integer default 0,  -- seconds spent reviewing (client-reported)
  reward_given boolean default false,
  created_at   timestamptz default now(),
  unique (case_id, juror_id)  -- one vote per juror per case
);

alter table public.jury_votes enable row level security;
create policy "Jurors see own votes"
  on public.jury_votes for select using (auth.uid() = juror_id);
create policy "Jurors submit votes"
  on public.jury_votes for insert with check (auth.uid() = juror_id);
create policy "Service manages votes"
  on public.jury_votes for all using (auth.role() = 'service_role');

create index jury_votes_case_idx on public.jury_votes(case_id);

-- ── BUDDY LINKS (safe share) ────────────────────────────────────
create table if not exists public.buddy_links (
  id            uuid default uuid_generate_v4() primary key,
  token         text unique not null default encode(gen_random_bytes(16), 'hex'),
  creator_id    uuid references public.profiles(id) on delete cascade not null,
  transaction_id uuid references public.transactions(id),
  pin_hash      text,              -- bcrypt hash of optional PIN
  expires_at    timestamptz not null default (now() + interval '2 hours'),
  view_count    integer default 0,
  max_views     integer default 10,
  revoked       boolean default false,
  created_at    timestamptz default now()
);

alter table public.buddy_links enable row level security;
create policy "Creators manage own links"
  on public.buddy_links for all using (auth.uid() = creator_id);
create policy "Public read non-revoked links" -- for /buddy/:token route
  on public.buddy_links for select using (not revoked and expires_at > now());

-- ── PRIORITY RELIST LOG ────────────────────────────────────────
create table if not exists public.priority_relist_log (
  id           uuid default uuid_generate_v4() primary key,
  seller_id    uuid references public.profiles(id) not null,
  listing_id   uuid references public.listings(id) not null,
  transaction_id uuid references public.transactions(id),
  granted_at   timestamptz default now(),
  expires_at   timestamptz default (now() + interval '1 hour')
);

alter table public.priority_relist_log enable row level security;
create policy "Sellers see own relists" on public.priority_relist_log for select using (auth.uid() = seller_id);

-- ── JUROR ROTATION POOL ─────────────────────────────────────────
create or replace function public.assign_jurors(
  p_case_id       uuid,
  p_required       integer,
  p_exclude_ids   uuid[]
)
returns uuid[]
language plpgsql security definer as $$
declare
  juror_ids uuid[];
begin
  select array_agg(id) into juror_ids
  from (
    select p.id
    from public.profiles p
    where p.juror_enabled = true
      and p.rolling_accuracy >= 50
      and p.juror_cases_today < 5           -- daily cap
      and not p.collusion_flag
      and not (p.id = any(p_exclude_ids))   -- not a party to the dispute
    order by
      -- rotate: prefer those who've done fewest cases today
      p.juror_cases_today asc,
      p.rolling_accuracy desc,
      random()
    limit (p_required + 2)                  -- +2 buffer
  ) sub;

  -- Update assigned case
  update public.jury_cases
  set jurors_assigned = juror_ids, status = 'deliberating'
  where id = p_case_id;

  -- Notify assigned jurors
  insert into public.notifications(user_id, type, title, body, data)
  select
    j,
    'jury_assigned',
    '⚖️ You Have a New Case',
    'A transaction dispute needs your verdict. Review the evidence and vote.',
    jsonb_build_object('case_id', p_case_id)
  from unnest(juror_ids) j;

  return juror_ids;
end;
$$;

-- ── ROLLING ACCURACY UPDATE ────────────────────────────────────
create or replace function public.update_juror_accuracy(p_juror_id uuid)
returns void language plpgsql security definer as $$
declare
  correct_count   integer;
  total_count     integer;
  new_accuracy    numeric;
  weekly_correct  integer;
begin
  -- Last 20 resolved cases this juror voted on
  select
    count(*) filter (where v.verdict = c.verdict),
    count(*)
  into correct_count, total_count
  from public.jury_votes v
  join public.jury_cases c on c.id = v.case_id
  where v.juror_id = p_juror_id
    and c.status = 'decided'
    and v.created_at > now() - interval '90 days'
  order by v.created_at desc
  limit 20;

  if total_count = 0 then return; end if;

  new_accuracy := round((correct_count::numeric / total_count) * 100, 1);

  -- Weekly correct streak for Magistrate badge
  select count(*) into weekly_correct
  from public.jury_votes v
  join public.jury_cases c on c.id = v.case_id
  where v.juror_id = p_juror_id
    and c.status = 'decided'
    and v.verdict = c.verdict
    and v.created_at > date_trunc('week', now());

  update public.profiles set
    rolling_accuracy = new_accuracy,
    juror_streak     = weekly_correct,
    -- Magistrate badge: 3+ correct this week
    magistrate_at    = case
      when weekly_correct >= 3 and magistrate_at is null then now()
      else magistrate_at
    end,
    -- Free listing tokens: 3 correct/week
    free_listing_tokens = case
      when weekly_correct >= 3 and weekly_correct % 3 = 0
      then free_listing_tokens + 3
      else free_listing_tokens
    end
  where id = p_juror_id;

  -- Magistrate badge notification
  if weekly_correct = 3 then
    insert into public.notifications(user_id, type, title, body)
    values (p_juror_id, 'magistrate_badge',
      '⚖️ Magistrate Badge Earned!',
      'You had 3 correct verdicts this week. You''ve earned 3 free listing tokens!');
  end if;
end;
$$;

-- ── TRENDING WEIGHTED GRAVITY ──────────────────────────────────
create or replace function public.calculate_trending_score(
  p_views_1h       integer,
  p_messages_1h    integer,
  p_unique_views   integer,
  p_negotiations   integer,
  p_hours_old      numeric,
  p_seller_tier    text
)
returns numeric
language sql immutable as $$
  select round(
    (
      -- Weighted views by tier
      (p_views_1h * case p_seller_tier
        when 'elite'   then least(5.0, 5.0 - (p_views_1h::numeric - 10) * 0.05)  -- diminishing returns
        when 'trusted' then 3.0
        else 1.0
      end)
      +
      -- Negotiation weight (stronger signal)
      (p_messages_1h * 5.0)
    )
    -- Time decay: (hours_old + 2)^1.5
    / NULLIF(power(p_hours_old + 2, 1.5), 0),
    3
  )
$$;

-- ── GHOST REFUND ELIGIBILITY FUNCTION ─────────────────────────
create or replace function public.check_ghost_refund(p_transaction_id uuid)
returns json language plpgsql security definer as $$
declare
  tx         record;
  eligible   boolean := false;
  reason     text;
begin
  select * into tx from public.transactions where id = p_transaction_id;

  if tx.buyer_arrived and (
    not tx.seller_arrived and (
      not tx.omw_active or
      (tx.omw_active and tx.movement_delta_m < 50 and tx.omw_timestamp < now() - interval '20 minutes')
    )
  ) then
    eligible := true;
    reason   := 'Seller failed to arrive or show meaningful movement';
  end if;

  return json_build_object('eligible', eligible, 'reason', reason, 'transaction_id', p_transaction_id);
end;
$$;

-- ── PRIORITY RELIST ELIGIBILITY ────────────────────────────────
create or replace function public.check_priority_relist(p_transaction_id uuid)
returns json language plpgsql security definer as $$
declare
  tx           record;
  seller       record;
  eligible     boolean := false;
  reason       text;
begin
  select * into tx from public.transactions where id = p_transaction_id;
  select * into seller from public.profiles where id = tx.seller_id;

  -- Seller present ≥15 min, buyer never arrived, limits not exceeded
  if tx.seller_arrived
     and tx.seller_arrived_at < now() - interval '15 minutes'
     and not tx.buyer_arrived
     and seller.priority_relist_today < 1
     and seller.priority_relist_this_week < 3
  then
    eligible := true;
    reason   := 'Buyer failed to arrive; seller was present';
  end if;

  return json_build_object('eligible', eligible, 'reason', reason);
end;
$$;

-- ── REALTIME ──────────────────────────────────────────────────
alter publication supabase_realtime add table public.jury_cases;
alter publication supabase_realtime add table public.jury_votes;
alter publication supabase_realtime add table public.buddy_links;
