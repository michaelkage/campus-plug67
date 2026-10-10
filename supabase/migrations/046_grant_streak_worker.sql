-- Migration 046: allow the authenticated growth worker to call the streak RPC.
-- The Edge Function validates the end-user JWT before invoking this privileged RPC.
GRANT EXECUTE ON FUNCTION public.update_streak(uuid) TO service_role;
