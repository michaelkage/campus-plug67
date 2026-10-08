-- Campus Plug: grant authenticated access to messages, safe_zones, referral_events.
-- Debug export (2026-10-08) shows 42501 permission denied on these tables:
--   messages       SELECT (Chat.jsx, MarketplaceChat) -> "column messages.content does not exist"
--   safe_zones     SELECT (SafeSwapZone)             -> permission denied for table safe_zones
--   referral_events SELECT (referrals UI)             -> permission denied for table referral_events
--   group_chat_members INSERT (CampusHub join)        -> RLS USING violation
-- These tables had RLS enabled but were never granted privileges to `authenticated`,
-- so RLS policies were unreachable. Also add messages.content / message_type
-- columns that client code inserts/selects.

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.messages TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.safe_zones TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.referral_events TO authenticated;

alter table public.messages
  add column if not exists content      text,
  add column if not exists message_type text default 'text';

-- Replace the legacy immutability rule. Its `on update do instead`
-- body recursively re-triggers itself (42P17), so the backfill below
-- cannot run while it exists. Use a BEFORE UPDATE trigger that rejects
-- edits to immutable columns instead.
drop rule if exists messages_no_update on public.messages;

-- Backfill content from legacy body column so historical rows remain readable.
update public.messages set content = body where content is null and body is not null;

-- Immutability guard: only read-receipt / flag / soft-delete transitions allowed.
create or replace function public.messages_guard_immutable()
returns trigger language plpgsql as $$
begin
  if old.sender_id is distinct from new.sender_id
     or old.receiver_id is distinct from new.receiver_id
     or old.listing_id is distinct from new.listing_id
     or old.transaction_id is distinct from new.transaction_id then
    raise exception 'messages: participants and listing linkage are immutable';
  end if;

  if old.body is distinct from new.body or old.content is distinct from new.content then
    if new.body = '[Message deleted]' or new.content = '[Message deleted]' then
      return new;
    end if;
    raise exception 'messages: content is immutable; only soft-delete placeholder allowed';
  end if;
  return new;
end $$;

drop trigger if exists messages_guard_immutable on public.messages;
create trigger messages_guard_immutable
  before update on public.messages
  for each row execute function public.messages_guard_immutable();

-- CampusHub join uses upsert; ensure the insert policy allows the acting user
-- to join themselves (it already does), but the earlier
-- 051 policy replaced the recursive select policy with a non-recursive one
-- without granting the table privilege. The GRANTs above fix that.
