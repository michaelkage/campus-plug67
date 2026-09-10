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

function getApiKey(req: Request): string | null {
  const value = req.headers.get("apikey") ?? "";
  const key = value.trim();
  return key || null;
}

function getSecretKeys(): string[] {
  const raw = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return [];
    return Object.values(parsed).filter((value): value is string => typeof value === "string" && value.length > 0);
  } catch {
    return [];
  }
}

/**
 * Recognize internal/service-role calls.
 *
 * Current Supabase secret keys are API keys, not JWTs. They must be supplied in
 * the `apikey` header and authorized by the function itself. Legacy service_role
 * JWTs remain supported for compatibility, but are accepted only when they
 * exactly match the legacy service-role key provisioned by Supabase.
 */
export function isServiceRoleRequest(req: Request): boolean {
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const bearer = getBearerToken(req);
  const apiKey = getApiKey(req);

  if (serviceKey && (bearer === serviceKey || apiKey === serviceKey)) return true;
  if (apiKey && getSecretKeys().includes(apiKey)) return true;
  return false;
}

export function corsHeaders(req: Request): HeadersInit {
  const origin = req.headers.get("Origin");

  // Keep production browser origins working even when APP_URL/VITE_APP_URL was
  // not configured in the Edge Function environment. Environment variables can
  // still add/override deployment-specific origins without opening CORS to '*'.
  const configured = [
    "https://michaelkage.github.io",
    "https://campusplug.ng",
    "https://www.campusplug.ng",
    Deno.env.get("VITE_APP_URL"),
    Deno.env.get("APP_URL"),
  ]
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

export function requireUser(req: Request): Promise<User> {
  return getAuthenticatedUser(req).then((user) => {
    if (!user) throw new Error("Unauthorized");
    return user;
  });
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
