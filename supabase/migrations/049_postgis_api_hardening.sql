-- Migration 049: keep PostGIS installed without exposing extension helper RPCs.
--
-- spatial_ref_sys is extension-managed and is intentionally not altered here.
-- The PostGIS ST_EstimatedExtent overloads, when present in the installed
-- extension version, are callable functions in the public schema and are not
-- part of the Campus Plug client API. Revoke direct API execution from client
-- roles while leaving PostGIS installed and preserving internal SQL usage.
--
-- Local Supabase images can ship a PostGIS version without one or more of
-- these overloads, so each revoke is guarded by a catalog lookup.

do $$
begin
  if to_regprocedure('public.st_estimatedextent(text,text)') is not null then
    execute 'revoke execute on function public.st_estimatedextent(text,text) from public, anon, authenticated';
  end if;

  if to_regprocedure('public.st_estimatedextent(text,text,text)') is not null then
    execute 'revoke execute on function public.st_estimatedextent(text,text,text) from public, anon, authenticated';
  end if;

  if to_regprocedure('public.st_estimatedextent(text,text,text,boolean)') is not null then
    execute 'revoke execute on function public.st_estimatedextent(text,text,text,boolean) from public, anon, authenticated';
  end if;
end
$$;

-- Do not grant these functions back to service_role: server-side SQL that needs
-- PostGIS should use the database extension directly, not a client RPC surface.
