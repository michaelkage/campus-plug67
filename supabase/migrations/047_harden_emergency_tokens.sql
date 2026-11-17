-- Migration 047: harden emergency token provisioning
--
-- The original provisioning function was SECURITY DEFINER and accepted an
-- arbitrary user id. It was correctly revoked from anon/authenticated, but the
-- browser still attempted to call it. This migration adds a narrow authenticated
-- wrapper that can only provision tokens for auth.uid(), while retaining the
-- original function for trusted server workers.
--
-- It also fixes the original partial unique index: UNIQUE(user_id, month_year)
-- allowed only ONE unused token, despite the intended monthly allowance of TWO.

-- The old index cannot enforce a two-row quota. Replace it with a trigger-backed
-- quota check protected by a transaction advisory lock to avoid concurrent races.
drop index if exists public.emergency_tokens_user_month_count;

create or replace function public.enforce_emergency_token_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  token_count integer;
  month_key text;
begin
  month_key := new.month_year;

  -- Serialize provisioning for this user/month so two concurrent requests
  -- cannot both observe fewer than two rows and exceed the quota.
  perform pg_advisory_xact_lock(hashtext(new.user_id::text || ':' || month_key));

  select count(*)
    into token_count
  from public.emergency_sale_tokens
  where user_id = new.user_id
    and month_year = month_key;

  if token_count >= 2 then
    raise exception 'Emergency token monthly limit reached';
  end if;

  return new;
end;
$$;

drop trigger if exists enforce_emergency_token_limit on public.emergency_sale_tokens;
create trigger enforce_emergency_token_limit
before insert on public.emergency_sale_tokens
for each row execute function public.enforce_emergency_token_limit();

-- Ensure the original privileged function cannot be reached through accidental
-- PUBLIC grants in a future migration.
revoke all on function public.provision_emergency_tokens(uuid) from public, anon, authenticated;
grant execute on function public.provision_emergency_tokens(uuid) to service_role;

-- Authenticated wrapper: caller identity is authoritative; the client cannot
-- choose another user's id.
create or replace function public.provision_my_emergency_tokens()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  caller_id uuid := auth.uid();
  month_key text := to_char(now(), 'YYYY-MM');
  existing integer;
  created integer := 0;
begin
  if caller_id is null then
    raise exception 'Authentication required';
  end if;

  perform pg_advisory_xact_lock(hashtext(caller_id::text || ':' || month_key));

  select count(*)
    into existing
  from public.emergency_sale_tokens
  where user_id = caller_id
    and month_year = month_key;

  if existing < 2 then
    insert into public.emergency_sale_tokens(user_id, month_year)
    select caller_id, month_key
    from generate_series(1, 2 - existing);
    created := 2 - existing;
  end if;

  return existing + created;
end;
$$;

revoke all on function public.provision_my_emergency_tokens() from public, anon;
grant execute on function public.provision_my_emergency_tokens() to authenticated;
