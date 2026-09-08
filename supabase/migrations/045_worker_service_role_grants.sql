-- Migration 045: restore explicit worker privileges
--
-- The Edge Functions use the Supabase service-role client for scheduled work.
-- Keep these grants explicit so hardening/revocation migrations cannot leave
-- the workers with a valid service-role JWT but no table privileges.

GRANT SELECT ON TABLE
  public.transactions,
  public.listings,
  public.profiles,
  public.listing_views,
  public.messages
TO service_role;

GRANT INSERT, UPDATE, DELETE ON TABLE public.trending_listings TO service_role;
GRANT UPDATE ON TABLE public.listings, public.profiles TO service_role;
GRANT INSERT ON TABLE public.ticker_events TO service_role;

GRANT EXECUTE ON FUNCTION public.process_escrow_action(uuid,text,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.expire_flash_deals() TO service_role;
GRANT EXECUTE ON FUNCTION public.cleanup_amber_confirmations() TO service_role;
GRANT EXECUTE ON FUNCTION public.reclaim_silent_jurors(uuid) TO service_role;
