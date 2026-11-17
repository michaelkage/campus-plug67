-- ============================================================
-- Campus Plug — Migration 009: v6.7 Integration Phase
-- Run AFTER 001–008
-- ============================================================

-- ── 1. SAFE ZONES: SSID hash fingerprints for indoor PoP ──────
-- Stores hashed BSSID arrays per safe zone for Faraday cage fallback.
-- Hash is SHA-256 of sorted BSSID list — never raw MAC addresses.
alter table public.safe_zones
  add column if not exists ssid_hashes     text[],         -- SHA-256 hashes of nearby BSSID lists
  add column if not exists ble_uuid        text,           -- broadcast UUID for BLE proximity check
  add column if not exists indoor          boolean default false,
  add column if not exists floor_level     integer;        -- -1 = basement, 0 = ground, 1+ = upper

-- Update UNILAG safe zones as indoor-capable
update public.safe_zones
set indoor = true, ssid_hashes = '{}', ble_uuid = null
where university = 'University of Lagos';

-- ── 2. TRANSACTIONS: v6.7 columns ─────────────────────────────
alter table public.transactions
  add column if not exists handshake_receipt_buffer timestamptz,   -- server holds state for 90s
  add column if not exists buyer_check_in_at        timestamptz,
  add column if not exists seller_check_in_at       timestamptz,
  add column if not exists stall_used               boolean   default false,
  add column if not exists high_value_flag          boolean   default false,
  add column if not exists multimodal_used          boolean   default false,  -- BLE/SSID fallback triggered
  add column if not exists pop_method               text,           -- 'GPS'|'SSID'|'BLE'|'MANUAL'
  add column if not exists gps_accuracy_m           numeric,
  add column if not exists ssid_match               boolean,
  add column if not exists ble_match                boolean,
  add column if not exists movement_delta_m         numeric   default 0;

-- ── 3. PROFILES: PlugCredit balance + jury cross-campus ────────
alter table public.profiles
  add column if not exists plug_credit_balance  bigint  default 0,  -- kobo
  add column if not exists theme_mode           text    default 'dark' check (theme_mode in ('dark','amoled')),
  add column if not exists accepted_terms_at    timestamptz,
  add column if not exists rolling_accuracy     numeric default 0,
  add column if not exists collusion_flag       boolean default false,
  add column if not exists magistrate_at        timestamptz,
  add column if not exists last_boost_at        timestamptz,
  add column if not exists juror_enabled        boolean default false,
  add column if not exists juror_cases_today    integer default 0,
  add column if not exists juror_last_case_at   timestamptz,
  add column if not exists free_listing_tokens  integer default 0,
  add column if not exists juror_streak         integer default 0,
  add column if not exists priority_relist_today      integer default 0,
  add column if not exists priority_relist_this_week  integer default 0,
  add column if not exists collusion_ceiling    integer default 100,
  add column if not exists top_of_feed         boolean default false,
  add column if not exists tier                text    default 'citizen' check (tier in ('citizen','trusted','elite'));

-- ── 4. JURY CASES: cross-campus columns ───────────────────────
create table if not exists public.jury_cases (
  id                  uuid default uuid_generate_v4() primary key,
  transaction_id      uuid references public.transactions(id) not null unique,
  claimant_id         uuid references public.profiles(id) not null,
  respondent_id       uuid references public.profiles(id) not null,
  dispute_reason      text not null,
  evidence_messages   jsonb,              -- sanitized: [Claimant]/[Respondent] labels
  amount              bigint not null,
  high_value          boolean generated always as (amount >= 5000000) stored,
  required_votes      integer generated always as (case when amount >= 5000000 then 4 else 3 end) stored,
  status              text default 'open' check (status in ('open','deliberating','decided','escalated','closed')),
  verdict             text check (verdict in ('claimant','respondent','split','void')),
  verdict_decided_at  timestamptz,
  votes_cast          integer default 0,
  jurors_assigned     uuid[] default '{}',
  juror_rotation_count integer default 0,
  escalated_to_admin  boolean default false,
  escalated_at        timestamptz,
  assigned_at         timestamptz default now(),
  dispute_campus      text,               -- campus of disputing parties
  juror_campus_lock   boolean default true, -- enforce cross-campus
  created_at          timestamptz default now()
);

alter table public.jury_cases enable row level security;
create policy "Parties see own cases" on public.jury_cases for select
  using (auth.uid() = claimant_id or auth.uid() = respondent_id);
create policy "Assigned jurors see cases" on public.jury_cases for select
  using (auth.uid() = any(jurors_assigned));
create policy "Service manages cases" on public.jury_cases for all using (auth.role() = 'service_role');

-- ── 5. JURY VOTES ──────────────────────────────────────────────
create table if not exists public.jury_votes (
  id               uuid default uuid_generate_v4() primary key,
  case_id          uuid references public.jury_cases(id) on delete cascade not null,
  juror_id         uuid references public.profiles(id) not null,
  verdict          text not null check (verdict in ('claimant','respondent','split','pending')),
  reasoning        text,
  reviewed_for_s   integer default 0,
  first_opened_at  timestamptz,           -- IMMUTABLE once set (trigger guards)
  opened_count     integer default 0,
  reward_given     boolean default false,
  plug_credit_payout bigint default 0,    -- kobo awarded
  payout_processed boolean default false,
  created_at       timestamptz default now(),
  unique (case_id, juror_id)
);

-- first_opened_at immutability trigger
create or replace function public.guard_first_opened_at()
returns trigger language plpgsql as $$
begin
  if old.first_opened_at is not null then
    new.first_opened_at := old.first_opened_at;
  end if;
  return new;
end;
$$;

drop trigger if exists guard_first_opened_at_trigger on public.jury_votes;
create trigger guard_first_opened_at_trigger
  before update on public.jury_votes
  for each row execute procedure public.guard_first_opened_at();

alter table public.jury_votes enable row level security;
create policy "Jurors see own votes" on public.jury_votes for select using (auth.uid() = juror_id);
create policy "Jurors submit votes"  on public.jury_votes for insert with check (auth.uid() = juror_id);
create policy "Service manages votes" on public.jury_votes for all using (auth.role() = 'service_role');

-- ── 6. PLUG CREDIT LEDGER (immutable append-only) ─────────────
create table if not exists public.plug_credit_ledger (
  id            uuid default uuid_generate_v4() primary key,
  user_id       uuid references public.profiles(id) on delete cascade not null,
  amount        bigint not null,                   -- kobo (+credit, -spend)
  reason        text   not null,                   -- 'jury_reward'|'relist_boost'|'purchase'
  reference_id  uuid,
  balance_after bigint not null,
  created_at    timestamptz default now()
);

create rule plug_credit_no_update as on update to public.plug_credit_ledger do instead nothing;
create rule plug_credit_no_delete as on delete to public.plug_credit_ledger do instead nothing;

alter table public.plug_credit_ledger enable row level security;
create policy "Users see own ledger" on public.plug_credit_ledger for select using (auth.uid() = user_id);
create policy "System inserts ledger" on public.plug_credit_ledger for insert with check (true);

-- ── 7. GLOBAL_CONFIG (admin war room control plane) ───────────
create table if not exists public.global_config (
  key             text primary key,
  is_enabled      boolean   default false,
  criteria_met    boolean   default false,          -- auto-computed
  threshold_value integer   default 0,              -- e.g. 50 transactions
  current_value   integer   default 0,              -- live counter
  mode            text      default 'HYBRID'
                    check (mode in ('AUTO','MANUAL','HYBRID')),
  label           text,                             -- display name
  description     text,
  icon            text,                             -- emoji
  updated_at      timestamptz default now(),
  updated_by      uuid references public.profiles(id)
);

-- Auto-sync criteria_met; AUTO mode self-enables
create or replace function public.sync_global_config()
returns trigger language plpgsql as $$
begin
  new.criteria_met := (new.threshold_value = 0) or (new.current_value >= new.threshold_value);
  if new.mode = 'AUTO' and new.criteria_met then
    new.is_enabled := true;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists global_config_sync on public.global_config;
create trigger global_config_sync
  before insert or update on public.global_config
  for each row execute procedure public.sync_global_config();

alter table public.global_config enable row level security;
create policy "Admins manage config" on public.global_config for all
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and 'Plug Dev' = any(p.badges))
         or auth.role() = 'service_role');
create policy "Authenticated read config" on public.global_config for select
  using (auth.role() = 'authenticated');

-- Seed all cloakable features
insert into public.global_config (key, mode, threshold_value, label, description, icon) values
  ('pop_engine',       'HYBRID',  1,  'GPS Meetup (PoP)',      'Proof-of-Presence meetup system',           '📍'),
  ('multi_modal_pop',  'HYBRID',  5,  'Indoor PoP (BLE/SSID)', 'SSID + BLE fallback for Faraday buildings',  '📶'),
  ('peer_jury',        'HYBRID',  1,  'Peer Jury',             'Cross-campus dispute resolution',            '⚖️'),
  ('trending_engine',  'MANUAL',  50, 'Trending Engine',       'Demand signals & trending feed',             '🔥'),
  ('trust_signals',    'AUTO',    3,  'Trust Signals',         'Confidence badges & verified patterns',      '🛡️'),
  ('plug_credit',      'MANUAL',  0,  'PlugCredit',            'BNPL backed by PlugScore',                   '💳'),
  ('tier_system',      'AUTO',    0,  'Tier System',           'Citizen / Trusted / Elite progression',      '⭐'),
  ('flash_deals',      'HYBRID',  10, 'Flash Deals',           'Time-limited 2-hour listings',               '⚡'),
  ('referral_system',  'AUTO',    1,  'Referrals',             'Referral codes & bonus system',              '🎁'),
  ('insight_dashboard','MANUAL',  0,  'Insight Engine',        'Escrow velocity & behavior analytics',       '📊')
on conflict (key) do nothing;

-- ── 8. FUNCTION: award ₦100 PlugCredit to jurors ───────────────
create or replace function public.payout_juror_incentive(
  p_juror_id uuid,
  p_amount   integer default 10000  -- ₦100 in kobo
)
returns bigint                        -- returns new balance
language plpgsql security definer as $$
declare
  new_bal bigint;
begin
  update public.profiles
  set plug_credit_balance = plug_credit_balance + p_amount
  where id = p_juror_id
  returning plug_credit_balance into new_bal;

  insert into public.plug_credit_ledger(user_id, amount, reason, balance_after)
  values (p_juror_id, p_amount, 'jury_reward', new_bal);

  return new_bal;
end;
$$;

-- ── 9. FUNCTION: increment global_config counters ─────────────
create or replace function public.increment_config_counter(p_key text)
returns void language sql security definer as $$
  update public.global_config
  set current_value = current_value + 1
  where key = p_key;
$$;

-- Trigger: on transaction release, increment trending counter
create or replace function public.on_tx_release_config()
returns trigger language plpgsql security definer as $$
begin
  if new.status = 'released' and (old.status is null or old.status != 'released') then
    perform public.increment_config_counter('trending_engine');
    perform public.increment_config_counter('pop_engine');
    perform public.increment_config_counter('referral_system');
  end if;
  return new;
end;
$$;

drop trigger if exists tx_release_config_trigger on public.transactions;
create trigger tx_release_config_trigger
  after update on public.transactions
  for each row execute procedure public.on_tx_release_config();

-- ── 10. AUDIT LOGS (rule-safe immutable) ──────────────────────
create table if not exists public.audit_logs (
  id               uuid default uuid_generate_v4() primary key,
  entity_type      text not null,
  entity_id        uuid not null,
  user_id          uuid references public.profiles(id),
  action           text not null,
  original_content text,
  new_content      text,
  metadata         jsonb,
  created_at       timestamptz default now()
);

-- ⚠️ ONLY intercept UPDATE and DELETE — NOT INSERT (preserves RETURNING)
create rule audit_no_update as on update to public.audit_logs do instead nothing;
create rule audit_no_delete as on delete to public.audit_logs do instead nothing;

alter table public.audit_logs enable row level security;
create policy "Parties read audit" on public.audit_logs for select
  using (auth.uid() = user_id or auth.role() = 'service_role');
create policy "System inserts audit" on public.audit_logs for insert with check (true);

-- ── 11. AMBER CONFIRMATIONS (server receipt buffer) ───────────
create table if not exists public.amber_confirmations (
  id              uuid default uuid_generate_v4() primary key,
  transaction_id  uuid references public.transactions(id) on delete cascade not null,
  user_id         uuid references public.profiles(id) not null,
  role            text not null check (role in ('buyer','seller')),
  confirmed_at    timestamptz default now(),
  buffer_expires  timestamptz default (now() + interval '90 seconds'),
  unique (transaction_id, user_id)
);

alter table public.amber_confirmations enable row level security;
create policy "Parties see confirmations" on public.amber_confirmations for select
  using (auth.uid() = user_id or exists (
    select 1 from public.transactions t
    where t.id = transaction_id and (t.buyer_id = auth.uid() or t.seller_id = auth.uid())
  ));
create policy "Auth insert confirmations" on public.amber_confirmations for insert
  with check (auth.uid() = user_id);

create or replace function public.cleanup_amber_confirmations()
returns void language sql security definer as $$
  delete from public.amber_confirmations where buffer_expires < now();
$$;

-- ── 12. REALTIME ───────────────────────────────────────────────
alter publication supabase_realtime add table public.global_config;
alter publication supabase_realtime add table public.jury_cases;
alter publication supabase_realtime add table public.jury_votes;
alter publication supabase_realtime add table public.amber_confirmations;
alter publication supabase_realtime add table public.plug_credit_ledger;
