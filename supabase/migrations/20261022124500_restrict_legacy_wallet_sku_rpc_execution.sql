-- Make the intended caller boundary explicit for legacy SECURITY DEFINER RPCs.
-- These functions are user-facing, but must not be callable by anonymous clients.
REVOKE ALL ON FUNCTION public.credit_wallet_funding(text, bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.credit_wallet_funding(text, bigint) TO authenticated;

REVOKE ALL ON FUNCTION public.match_global_sku(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.match_global_sku(text) TO authenticated;
