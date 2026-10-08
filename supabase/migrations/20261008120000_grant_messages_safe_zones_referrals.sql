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

-- Backfill content from legacy body column so historical rows remain readable.
update public.messages set content = body where content is null and body is not null;

-- CampusHub join uses upsert; ensure the insert policy allows the acting user
-- to join themselves (it already does), but the earlier
-- 051 policy replaced the recursive select policy with a non-recursive one
-- without granting the table privilege. The GRANTs above fix that.
