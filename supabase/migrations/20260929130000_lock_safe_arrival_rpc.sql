-- The safe-arrival RPC is a privileged Edge Function backend primitive.
-- Clients must use the authenticated safe-arrival Edge Function, which derives
-- the caller identity before invoking this SECURITY DEFINER function.
REVOKE ALL ON FUNCTION public.record_safe_arrival_v2(uuid,text,numeric,numeric,uuid,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_safe_arrival_v2(uuid,text,numeric,numeric,uuid,text) TO service_role;
