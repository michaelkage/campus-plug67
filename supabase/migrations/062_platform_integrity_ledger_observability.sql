-- Campus Plug platform integrity foundation
-- Phase 19-25: financial ledger, payment event ledger, transaction transition audit,
-- device risk signals, structured observability, and reconciliation primitives.

create table if not exists public.payment_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'paystack',
  event_id text not null,
  event_type text not null,
  reference text,
  transaction_id uuid,
  amount bigint,
  currency text not null default 'NGN',
  payload_hash text,
  processing_status text not null default 'received'
    check (processing_status in ('received','processing','processed','failed','ignored')),
  failure_reason text,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (provider, event_id)
);

create index if not exists payment_events_reference_idx
  on public.payment_events(provider, reference);
create index if not exists payment_events_transaction_idx
  on public.payment_events(transaction_id, received_at desc);
create index if not exists payment_events_status_idx
  on public.payment_events(processing_status, received_at desc);

alter table public.payment_events enable row level security;
revoke all on public.payment_events from anon, authenticated;
grant select on public.payment_events to service_role;

create table if not exists public.financial_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete restrict,
  amount bigint not null check (amount > 0),
  currency text not null default 'NGN',
  direction text not null check (direction in ('credit','debit')),
  source text not null,
  reference_type text,
  reference_id uuid,
  idempotency_key text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (user_id, idempotency_key)
);

create index if not exists financial_ledger_user_created_idx
  on public.financial_ledger(user_id, created_at desc);
create index if not exists financial_ledger_reference_idx
  on public.financial_ledger(reference_type, reference_id);

alter table public.financial_ledger enable row level security;
drop policy if exists "Users read own financial ledger" on public.financial_ledger;
create policy "Users read own financial ledger"
  on public.financial_ledger for select
  to authenticated
  using ((select auth.uid()) = user_id);
revoke insert, update, delete on public.financial_ledger from anon, authenticated;
grant select on public.financial_ledger to authenticated;
grant all on public.financial_ledger to service_role;

create table if not exists public.transaction_state_transitions (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null,
  actor_user_id uuid references auth.users(id) on delete set null,
  from_state text,
  to_state text not null,
  action text not null,
  source text not null default 'server',
  request_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists transaction_transitions_tx_created_idx
  on public.transaction_state_transitions(transaction_id, created_at desc);
create index if not exists transaction_transitions_actor_created_idx
  on public.transaction_state_transitions(actor_user_id, created_at desc);

alter table public.transaction_state_transitions enable row level security;
drop policy if exists "Transaction parties read transition history" on public.transaction_state_transitions;
create policy "Transaction parties read transition history"
  on public.transaction_state_transitions for select
  to authenticated
  using (
    exists (
      select 1
      from public.transactions t
      where t.id = transaction_state_transitions.transaction_id
        and ((select auth.uid()) = t.buyer_id or (select auth.uid()) = t.seller_id)
    )
  );
revoke insert, update, delete on public.transaction_state_transitions from anon, authenticated;
grant select on public.transaction_state_transitions to authenticated;
grant all on public.transaction_state_transitions to service_role;

create table if not exists public.device_security_signals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  device_id text not null,
  signal_type text not null,
  confidence numeric(5,4) check (confidence between 0 and 1),
  risk_delta integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists device_security_signals_device_idx
  on public.device_security_signals(device_id, last_seen_at desc);
create index if not exists device_security_signals_user_idx
  on public.device_security_signals(user_id, last_seen_at desc);

alter table public.device_security_signals enable row level security;
revoke all on public.device_security_signals from anon, authenticated;
grant all on public.device_security_signals to service_role;

create table if not exists public.platform_observability_events (
  id bigint generated always as identity primary key,
  request_id text,
  trace_id text,
  user_id uuid references auth.users(id) on delete set null,
  service text not null,
  operation text not null,
  status text not null,
  duration_ms integer,
  error_code text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists platform_observability_created_idx
  on public.platform_observability_events(created_at desc);
create index if not exists platform_observability_request_idx
  on public.platform_observability_events(request_id);
create index if not exists platform_observability_service_idx
  on public.platform_observability_events(service, operation, created_at desc);

alter table public.platform_observability_events enable row level security;
revoke all on public.platform_observability_events from anon, authenticated;
grant all on public.platform_observability_events to service_role;

create or replace function public.record_transaction_state_transition(
  p_transaction_id uuid,
  p_actor_user_id uuid,
  p_from_state text,
  p_to_state text,
  p_action text,
  p_request_id text default null,
  p_metadata jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  insert into public.transaction_state_transitions
    (transaction_id, actor_user_id, from_state, to_state, action, request_id, metadata)
  values
    (p_transaction_id, p_actor_user_id, p_from_state, p_to_state, p_action, p_request_id, coalesce(p_metadata, '{}'::jsonb))
  returning id into v_id;
  return v_id;
end;
$$;

revoke all on function public.record_transaction_state_transition(uuid,uuid,text,text,text,text,jsonb)
  from public, anon, authenticated;
grant execute on function public.record_transaction_state_transition(uuid,uuid,text,text,text,text,jsonb)
  to service_role;

create or replace function public.record_financial_ledger_entry(
  p_user_id uuid,
  p_amount bigint,
  p_currency text,
  p_direction text,
  p_source text,
  p_reference_type text default null,
  p_reference_id uuid default null,
  p_idempotency_key text default null,
  p_metadata jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if p_amount <= 0 then raise exception 'ledger amount must be positive'; end if;
  if p_direction not in ('credit','debit') then raise exception 'invalid ledger direction'; end if;

  insert into public.financial_ledger
    (user_id, amount, currency, direction, source, reference_type, reference_id, idempotency_key, metadata)
  values
    (p_user_id, p_amount, coalesce(p_currency,'NGN'), p_direction, p_source, p_reference_type,
     p_reference_id, p_idempotency_key, coalesce(p_metadata,'{}'::jsonb))
  on conflict (user_id, idempotency_key)
  do update set idempotency_key = excluded.idempotency_key
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.record_financial_ledger_entry(uuid,bigint,text,text,text,text,uuid,text,jsonb)
  from public, anon, authenticated;
grant execute on function public.record_financial_ledger_entry(uuid,bigint,text,text,text,text,uuid,text,jsonb)
  to service_role;

create or replace function public.financial_ledger_balance(p_user_id uuid, p_currency text default 'NGN')
returns bigint
language sql
security definer
set search_path = public
as $$
  select coalesce(sum(case when direction = 'credit' then amount else -amount end), 0)::bigint
  from public.financial_ledger
  where user_id = p_user_id and currency = coalesce(p_currency,'NGN');
$$;

revoke all on function public.financial_ledger_balance(uuid,text)
  from public, anon, authenticated;
grant execute on function public.financial_ledger_balance(uuid,text)
  to service_role;

comment on table public.payment_events is 'Immutable provider event ledger for idempotent payment reconciliation.';
comment on table public.financial_ledger is 'Append-only financial source of truth; wallet balances must reconcile to this ledger.';
comment on table public.transaction_state_transitions is 'Server-side transaction state audit trail.';
comment on table public.device_security_signals is 'Security signals; device identity is never treated as authentication.';
comment on table public.platform_observability_events is 'Structured operational telemetry correlated by request_id/trace_id.';
