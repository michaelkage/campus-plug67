-- Admin console read models. All sensitive operational tables remain service-role-only.
-- This exposes aggregate/limited operational views through an explicit platform-admin RPC.

create or replace function public.get_admin_console_snapshot()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  result jsonb;
begin
  if not public.is_platform_admin() then
    raise exception 'platform admin required';
  end if;

  select jsonb_build_object(
    'generated_at', now(),
    'users', (select count(*) from public.profiles),
    'verified_users', (select count(*) from public.profiles where coalesce(is_verified,false)),
    'active_listings', (select count(*) from public.listings where status = 'active'),
    'pending_listings', (select count(*) from public.listings where status in ('pending','review')),
    'transactions_30d', (select count(*) from public.transactions where created_at >= now() - interval '30 days'),
    'released_30d', (select count(*) from public.transactions where status = 'released' and coalesce(released_at,created_at) >= now() - interval '30 days'),
    'disputed', (select count(*) from public.transactions where status = 'disputed'),
    'payment_events_24h', (select count(*) from public.payment_events where received_at >= now() - interval '24 hours'),
    'payment_failures_24h', (select count(*) from public.payment_events where processing_status = 'failed' and received_at >= now() - interval '24 hours'),
    'ledger_entries_24h', (select count(*) from public.financial_ledger where created_at >= now() - interval '24 hours'),
    'observability_errors_24h', (select count(*) from public.platform_observability_events where status = 'error' and created_at >= now() - interval '24 hours'),
    'recent_errors', coalesce((
      select jsonb_agg(to_jsonb(e) order by e.created_at desc)
      from (
        select id, request_id, service, operation, status, duration_ms, error_code, created_at
        from public.platform_observability_events
        where status = 'error'
        order by created_at desc
        limit 12
      ) e
    ), '[]'::jsonb),
    'recent_payments', coalesce((
      select jsonb_agg(to_jsonb(e) order by e.received_at desc)
      from (
        select provider, event_id, event_type, reference, transaction_id, amount, currency,
               processing_status, failure_reason, received_at, processed_at
        from public.payment_events
        order by received_at desc
        limit 12
      ) e
    ), '[]'::jsonb)
  ) into result;

  return result;
end;
$$;

revoke all on function public.get_admin_console_snapshot() from public, anon;
grant execute on function public.get_admin_console_snapshot() to authenticated, service_role;

create or replace function public.get_admin_transaction_timeline(p_transaction_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_platform_admin() then
    raise exception 'platform admin required';
  end if;

  return jsonb_build_object(
    'transaction', (
      select to_jsonb(t)
      from (
        select id, buyer_id, seller_id, amount, status, paystack_ref, payment_verified,
               created_at, locked_at, released_at
        from public.transactions where id = p_transaction_id
      ) t
    ),
    'transitions', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.created_at asc)
      from (
        select id, actor_user_id, from_state, to_state, action, source, request_id, metadata, created_at
        from public.transaction_state_transitions
        where transaction_id = p_transaction_id
        order by created_at asc
      ) x
    ), '[]'::jsonb),
    'payments', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.received_at asc)
      from (
        select provider, event_id, event_type, reference, amount, currency, processing_status,
               failure_reason, received_at, processed_at
        from public.payment_events
        where transaction_id = p_transaction_id
        order by received_at asc
      ) x
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.get_admin_transaction_timeline(uuid) from public, anon;
grant execute on function public.get_admin_transaction_timeline(uuid) to authenticated, service_role;
