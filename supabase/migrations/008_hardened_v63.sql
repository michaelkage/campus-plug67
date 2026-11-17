-- ============================================================
-- Campus Plug — Migration 008: Hardened v6.3
-- Run AFTER 001–007
-- ============================================================

-- ── 1. AUDIT LOGS: Rule-Safe Immutability ─────────────────────
-- Drop the v007 rules if they exist, re-create correctly.
-- Key: we ONLY intercept UPDATE and DELETE.
-- INSERT is NOT intercepted → preserves INSERT...RETURNING for Edge Functions.

drop rule if exists audit_no_update on public.audit_logs;
drop rule if exists audit_no_delete on public.audit_logs;

-- PostgreSQL table-level rules (not INSTEAD OF — that's views only)
create rule audit_no_update
  as on update to public.audit_logs
  do instead nothing;

create rule audit_no_delete
  as on delete to public.audit_logs
  do instead nothing;

-- ── 2. JURY CASES: Rotation Ceiling + Escalation ──────────────
alter table public.jury_cases
  add column if not exists assigned_at           timestamptz default now(),
  add column if not exists juror_rotation_count  integer     default 0,    -- total jurors assigned (including replacements)
  add column if not exists escalated_to_admin    boolean     default false,
  add column if not exists escalated_at          timestamptz;

-- ── 3. JURY VOTES: Anti-Speedrun (first_opened_at immutable) ──
alter table public.jury_votes
  add column if not exists first_opened_at  timestamptz,    -- set once, never overwritten
  add column if not exists opened_count     integer default 0; -- how many times they've opened the case

-- Immutable rule: once first_opened_at is set, protect it from overwrite
-- We handle this in the Edge Function, but add a trigger as a hard guard:
create or replace function public.guard_first_opened_at()
returns trigger language plpgsql as $$
begin
  -- If first_opened_at is already set, preserve the original value
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

-- ── 4. PROFILES: Boost Cooldown + Anti-Abuse ──────────────────
alter table public.profiles
  add column if not exists last_boost_at             timestamptz,
  add column if not exists boost_denials_this_week   integer default 0,
  add column if not exists gps_spoof_flags           integer default 0,
  add column if not exists last_known_ip             inet;

-- ── 5. TRANSACTIONS: GPS Spoof Detection Columns ──────────────
alter table public.transactions
  add column if not exists gps_spoof_suspected  boolean default false,
  add column if not exists spoof_reason         text,       -- 'impossible_speed' | 'ip_mismatch'
  add column if not exists max_speed_kmh        numeric,    -- max speed detected between two points
  add column if not exists last_ip              inet;

-- ── 6. AMBER SYNC BUFFER TABLE ─────────────────────────────────
-- Server-side receipt buffer for the dual-confirm handshake.
-- When User A confirms, we store it here for 90 seconds.
-- Dual sync succeeds when BOTH confirmations arrive within the buffer window.
create table if not exists public.amber_confirmations (
  id              uuid default uuid_generate_v4() primary key,
  transaction_id  uuid references public.transactions(id) on delete cascade not null,
  user_id         uuid references public.profiles(id) not null,
  role            text not null check (role in ('buyer','seller')),
  confirmed_at    timestamptz default now(),
  buffer_expires  timestamptz default (now() + interval '90 seconds'),
  unique (transaction_id, user_id)
);

create index amber_conf_tx_idx on public.amber_confirmations(transaction_id, buffer_expires);

alter table public.amber_confirmations enable row level security;
create policy "Parties see own confirmations"
  on public.amber_confirmations for select
  using (auth.uid() = user_id or exists (
    select 1 from public.transactions t
    where t.id = transaction_id
      and (t.buyer_id = auth.uid() or t.seller_id = auth.uid())
  ));
create policy "Auth users insert confirmations"
  on public.amber_confirmations for insert with check (auth.uid() = user_id);

-- Auto-cleanup expired confirmations (called by cron)
create or replace function public.cleanup_amber_confirmations()
returns void language sql security definer as $$
  delete from public.amber_confirmations where buffer_expires < now();
$$;

-- ── 7. JUROR RECLAIM LOG ───────────────────────────────────────
create table if not exists public.juror_reclaims (
  id           uuid default uuid_generate_v4() primary key,
  case_id      uuid references public.jury_cases(id) on delete cascade not null,
  juror_id     uuid references public.profiles(id) not null,
  reason       text not null,   -- 'never_opened' | 'never_voted'
  penalty_pts  integer default 5,
  reclaimed_at timestamptz default now()
);

alter table public.juror_reclaims enable row level security;
create policy "System manages reclaims" on public.juror_reclaims for all using (auth.role() = 'service_role');
create policy "Users see own reclaims" on public.juror_reclaims for select using (auth.uid() = juror_id);

-- ── 8. GPS SPOOF DETECTION FUNCTION ───────────────────────────
-- Returns speed in km/h between two timestamped GPS points.
-- If speed > 300 km/h (impossible for Lagos traffic), flag as spoof.
create or replace function public.detect_gps_spoof(
  lat1 numeric, lng1 numeric, ts1 timestamptz,
  lat2 numeric, lng2 numeric, ts2 timestamptz
)
returns json language plpgsql immutable as $$
declare
  dist_m    numeric;
  time_s    numeric;
  speed_kmh numeric;
  spoofed   boolean := false;
begin
  -- Distance (Haversine)
  dist_m := 6371000 * acos(
    least(1.0,
      cos(radians(lat1)) * cos(radians(lat2)) *
      cos(radians(lng2) - radians(lng1)) +
      sin(radians(lat1)) * sin(radians(lat2))
    )
  );

  time_s := extract(epoch from (ts2 - ts1));
  if time_s <= 0 then
    return json_build_object('spoofed', false, 'speed_kmh', 0, 'dist_m', dist_m);
  end if;

  speed_kmh := (dist_m / time_s) * 3.6;
  -- Flag if impossible speed (>300 km/h = faster than any Lagos vehicle)
  spoofed := speed_kmh > 300;

  return json_build_object(
    'spoofed',    spoofed,
    'speed_kmh',  round(speed_kmh, 1),
    'dist_m',     round(dist_m, 0),
    'reason',     case when spoofed then 'impossible_speed' else null end
  );
end;
$$;

-- ── 9. PRIORITY RELIST ANTI-ABUSE FUNCTION ────────────────────
-- Returns whether a priority relist boost is eligible.
-- Denies if buyer traded/attempted with seller in last 30 days.
create or replace function public.check_priority_relist_v2(p_transaction_id uuid)
returns json language plpgsql security definer as $$
declare
  tx           record;
  seller_prof  record;
  recent_hist  integer;
  eligible     boolean := false;
  deny_reason  text;
begin
  select * into tx from public.transactions where id = p_transaction_id;
  select * into seller_prof from public.profiles where id = tx.seller_id;

  -- Cooldown: 6 hours between boosts
  if seller_prof.last_boost_at is not null
     and seller_prof.last_boost_at > now() - interval '6 hours'
  then
    deny_reason := 'cooldown_active';
    return json_build_object('eligible', false, 'reason', deny_reason,
      'cooldown_remaining_mins',
      round(extract(epoch from (seller_prof.last_boost_at + interval '6 hours' - now())) / 60));
  end if;

  -- Daily / weekly limits
  if seller_prof.priority_relist_today >= 1
  then
    deny_reason := 'daily_limit_reached';
    return json_build_object('eligible', false, 'reason', deny_reason);
  end if;
  if seller_prof.priority_relist_this_week >= 3
  then
    deny_reason := 'weekly_limit_reached';
    return json_build_object('eligible', false, 'reason', deny_reason);
  end if;

  -- Anti-abuse: buyer has NOT traded with or attempted transaction with seller in last 30 days
  select count(*) into recent_hist
  from public.transactions t
  where t.seller_id = tx.seller_id
    and t.buyer_id  = tx.buyer_id
    and t.created_at > now() - interval '30 days'
    and t.id != p_transaction_id
    and t.status not in ('cancelled');

  if recent_hist > 0 then
    deny_reason := 'buyer_seller_recent_history';
    return json_build_object('eligible', false, 'reason', deny_reason,
      'detail', 'This buyer has transacted with you recently. Boost denied to prevent abuse.');
  end if;

  -- Seller present check
  if not tx.seller_arrived
     or tx.seller_arrived_at is null
     or tx.seller_arrived_at > now() - interval '15 minutes'
  then
    deny_reason := 'seller_not_present_long_enough';
    return json_build_object('eligible', false, 'reason', deny_reason);
  end if;

  -- Buyer never showed
  if tx.buyer_arrived then
    deny_reason := 'buyer_arrived';
    return json_build_object('eligible', false, 'reason', deny_reason);
  end if;

  eligible := true;
  return json_build_object('eligible', true, 'reason', null);
end;
$$;

-- ── 10. JUROR RECLAIM FUNCTION ─────────────────────────────────
create or replace function public.reclaim_silent_jurors(p_case_id uuid)
returns json language plpgsql security definer as $$
declare
  c           record;
  v           record;
  reclaimed   integer := 0;
  new_jurors  uuid[];
  excluded    uuid[];
begin
  select * into c from public.jury_cases where id = p_case_id;
  if not found or c.status != 'deliberating' then
    return json_build_object('reclaimed', 0, 'reason', 'case_not_deliberating');
  end if;

  -- Admin escalation check: max 10 jurors total
  if c.juror_rotation_count >= 10 then
    update public.jury_cases set
      escalated_to_admin = true,
      escalated_at       = now(),
      status             = 'escalated'
    where id = p_case_id;

    -- Notify admin (insert into notifications for admin profile if one exists)
    insert into public.notifications(user_id, type, title, body, data)
    select id, 'admin_escalation',
      '⚠️ Dispute Requires Admin Review',
      'Jury case has cycled through 10 jurors without resolution. Manual review needed.',
      jsonb_build_object('case_id', p_case_id, 'amount', c.amount)
    from public.profiles
    where 'admin' = any(badges)
    limit 3;

    return json_build_object('escalated', true, 'case_id', p_case_id);
  end if;

  -- Build exclusion list: parties + all ever-assigned jurors
  excluded := array_cat(
    array[c.claimant_id, c.respondent_id],
    coalesce(c.jurors_assigned, '{}')
  );

  -- Find silent jurors: assigned >30 min ago and (never opened OR never voted)
  for v in
    select jv.juror_id, jv.first_opened_at,
           exists(select 1 from jury_votes jv2 where jv2.case_id = p_case_id and jv2.juror_id = jv.juror_id) as voted
    from jury_votes jv
    where jv.case_id = p_case_id
      and jv.created_at < now() - interval '30 minutes'
      and not jv.reward_given
  loop
    -- Silent if never opened OR opened but never voted and >30 min has passed
    if v.first_opened_at is null or (not v.voted and v.first_opened_at < now() - interval '30 minutes') then
      -- Penalise
      update public.profiles
      set plug_score = greatest(plug_score - 5, 0)
      where id = v.juror_id;

      -- Log reclaim
      insert into public.juror_reclaims(case_id, juror_id, reason, penalty_pts)
      values (p_case_id, v.juror_id,
        case when v.first_opened_at is null then 'never_opened' else 'never_voted' end,
        5);

      -- Notify juror
      insert into public.notifications(user_id, type, title, body)
      values (v.juror_id, 'jury_reclaim',
        '⚖️ Removed from Jury',
        'You were removed from a case for inactivity. -5 PlugScore. Respond within 30 minutes in future cases.');

      reclaimed := reclaimed + 1;
    end if;
  end loop;

  if reclaimed = 0 then
    return json_build_object('reclaimed', 0);
  end if;

  -- Assign replacements
  select array_agg(p.id) into new_jurors
  from public.profiles p
  where p.juror_enabled = true
    and p.rolling_accuracy >= 50
    and p.juror_cases_today < 5
    and not p.collusion_flag
    and not (p.id = any(excluded))
  order by p.juror_cases_today asc, p.rolling_accuracy desc, random()
  limit reclaimed + 2;  -- buffer

  -- Update case
  update public.jury_cases set
    jurors_assigned      = array_cat(jurors_assigned, coalesce(new_jurors, '{}'::uuid[])),
    juror_rotation_count = juror_rotation_count + reclaimed,
    assigned_at          = now()
  where id = p_case_id;

  -- Notify replacements
  if new_jurors is not null then
    insert into public.notifications(user_id, type, title, body, data)
    select j, 'jury_assigned',
      '⚖️ New Case Assigned',
      'You have been assigned to a dispute case. Please review and vote within 30 minutes.',
      jsonb_build_object('case_id', p_case_id)
    from unnest(new_jurors) j;
  end if;

  return json_build_object(
    'reclaimed',    reclaimed,
    'replacements', array_length(new_jurors, 1),
    'total_rotations', c.juror_rotation_count + reclaimed
  );
end;
$$;

-- ── 11. REALTIME ───────────────────────────────────────────────
alter publication supabase_realtime add table public.amber_confirmations;
alter publication supabase_realtime add table public.juror_reclaims;
