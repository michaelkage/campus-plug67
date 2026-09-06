import { createClient, type User } from "https://esm.sh/@supabase/supabase-js@2.43.4";

const ALLOWED_HEADERS = "authorization, x-client-info, apikey, content-type";

export function getBearerToken(req: Request): string | null {
  const value = req.headers.get("Authorization") ?? "";
  if (!value.startsWith("Bearer ")) return null;
  const token = value.slice("Bearer ".length).trim();
  return token || null;
}

export function isServiceRoleRequest(req: Request): boolean {
  const token = getBearerToken(req);
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  return Boolean(token && serviceKey && token === serviceKey);
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
