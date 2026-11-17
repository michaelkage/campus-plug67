-- The growth Edge Function validates the user JWT before calling this RPC
-- through its service-role client.
GRANT EXECUTE ON FUNCTION public.update_streak(uuid) TO service_role;
