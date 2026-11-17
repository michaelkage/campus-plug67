-- Restrict the SECURITY DEFINER SKU matcher to authenticated API callers.
-- The catalog is not secret, but an anonymous caller should not inherit EXECUTE
-- through PostgreSQL's default PUBLIC function privilege.
REVOKE ALL ON FUNCTION public.match_global_sku(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.match_global_sku(text) TO authenticated;
