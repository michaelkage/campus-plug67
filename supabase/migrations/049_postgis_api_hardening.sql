-- Migration 049: keep PostGIS installed without exposing extension helper RPCs.
--
-- spatial_ref_sys is extension-managed and is intentionally not altered here.
-- The PostGIS ST_EstimatedExtent overloads, however, are callable functions in
-- the public schema and are not part of the Campus Plug client API. Revoke
-- direct API execution from client roles while leaving the extension installed
-- and preserving internal SQL/PostGIS functionality.

revoke execute on function public.st_estimatedextent(text, text) from public, anon, authenticated;
revoke execute on function public.st_estimatedextent(text, text, text) from public, anon, authenticated;
revoke execute on function public.st_estimatedextent(text, text, text, boolean) from public, anon, authenticated;

-- Do not grant these functions back to service_role: server-side SQL that needs
-- PostGIS should use the database extension directly, not a client RPC surface.
