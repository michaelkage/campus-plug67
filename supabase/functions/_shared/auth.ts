import { createClient, type User } from "https://esm.sh/@supabase/supabase-js@2.43.4";

// Supabase's current Edge Runtime documents Deno.serve as the canonical server
// entry point. Keep a small compatibility bridge for older functions that still
// call the historical global `serve(...)` helper. This lets the whole function
// fleet migrate safely without making the health/deploy pipeline depend on the
// order in which individual functions are updated.
const edgeRuntime = globalThis as typeof globalThis & {
  serve?: typeof Deno.serve;
};
if (!edgeRuntime.serve) edgeRuntime.serve = Deno.serve;

const ALLOWED_HEADERS = "authorization, x-client-info, apikey, content-type";

export function getBearerToken(req: Request): string | null {
  const value = req.headers.get("Authorization") ?? "";
  const match = value.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const token = match[1].trim();
  return token || null;
}

function readJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const normalized = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const payload = JSON.parse(atob(padded));
    return payload && typeof payload === "object" ? payload as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/**
 * Recognize internal/service-role calls.
 *
 * The exact server-only service key is preferred. If a deployment has rotated
 * its service key while GitHub Actions still holds a valid older service-role
 * JWT, the Supabase Edge gateway's JWT verification is the trust boundary for
 * functions using the default `verify_jwt = true` setting. In that case we also
 * accept a token whose verified payload identifies the service_role audience and
 * the current project's issuer. Functions that disable gateway JWT verification
 * must not rely on this fallback.
 */
export function isServiceRoleRequest(req: Request): boolean {
  const token = getBearerToken(req);
  if (!token) return false;

  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (serviceKey && token === serviceKey) return true;

  const payload = readJwtPayload(token);
  if (!payload || payload.role !== "service_role") return false;

  const supabaseUrl = Deno.env.get("SUPABASE_URL")?.replace(/\/$/, "");
  const issuer = typeof payload.iss === "string" ? payload.iss.replace(/\/$/, "") : "";
  return Boolean(supabaseUrl && issuer === `${supabaseUrl}/auth/v1`);
}

export function corsHeaders(req: Request): HeadersInit {
  const origin = req.headers.get("Origin");
  const configured = [Deno.env.get("VITE_APP_URL"), Deno.env.get("APP_URL")]
    .filter((value): value is string => Boolean(value))
    .map((value) => value.replace(/\/$/, ""));

  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers": ALLOWED_HEADERS,
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Vary": "Origin",
  };

  if (origin && configured.includes(origin.replace(/\/$/, ""))) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

export function createUserClient(token: string) {
  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!url || !anonKey) throw new Error("Missing Supabase env");
  return createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
}

export async function getAuthenticatedUser(req: Request): Promise<User | null> {
  const token = getBearerToken(req);
  if (!token || isServiceRoleRequest(req)) return null;

  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!url || !anonKey) return null;

  const client = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user) return null;
  return data.user;
}

export async function requireUser(req: Request): Promise<User> {
  const user = await getAuthenticatedUser(req);
  if (!user) throw new Error("Unauthorized");
  return user;
}

export function jsonResponse(data: unknown, status = 200, extraHeaders: HeadersInit = {}, req?: Request): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...(req ? corsHeaders(req) : {}),
      "Content-Type": "application/json",
      ...extraHeaders,
    },
  });
}

export function optionsResponse(req: Request): Response {
  return new Response(null, { status: 204, headers: corsHeaders(req) });
}
