import { createClient } from "https://esm.sh/@supabase/supabase-js@2.43.4";

function getPrivilegedKey(): string | null {
  const raw = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (raw) {
    try {
      const keys = JSON.parse(raw) as Record<string, unknown>;
      const defaultKey = keys.default;
      if (typeof defaultKey === "string" && defaultKey.trim()) return defaultKey.trim();
    } catch {
      // Fall through to the application-owned service key below.
    }
  }

  // Supabase reserves SUPABASE_* names for managed runtime variables, so the
  // deployment workflow mirrors the service credential into this app-owned key.
  const applicationKey = Deno.env.get("EDGE_FUNCTION_SERVICE_KEY")?.trim();
  if (applicationKey) return applicationKey;

  // Legacy compatibility for older deployments.
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim();
  return legacy || null;
}

function getAdminClient() {
  const url = Deno.env.get("SUPABASE_URL");
  const privilegedKey = getPrivilegedKey();
  if (!url || !privilegedKey) throw new Error("Supabase runtime configuration is missing");
  return createClient(url, privilegedKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export async function enforceRateLimitWithToken(
  token: string,
  scope: string,
  limit: number,
  windowSeconds: number,
): Promise<{ allowed: boolean; resetAt?: string }> {
  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!url || !anonKey) throw new Error("Supabase runtime configuration is missing");
  const client = createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client.rpc("consume_rate_limit", {
    p_scope: scope,
    p_limit: limit,
    p_window_seconds: windowSeconds,
  });
  if (error) throw error;
  return { allowed: Boolean(data?.allowed), resetAt: data?.reset_at };
}

/**
 * Rate limit an unauthenticated flow using a server-derived key (for example,
 * an IP hash). The key is never exposed to the client or stored in plaintext.
 */
export async function enforceRateLimitByKey(
  scope: string,
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<{ allowed: boolean; resetAt?: string }> {
  const admin = getAdminClient();
  const { data, error } = await admin.rpc("consume_rate_limit_keyed", {
    p_scope: scope,
    p_key: key,
    p_limit: limit,
    p_window_seconds: windowSeconds,
  });
  if (error) throw error;
  return { allowed: Boolean(data?.allowed), resetAt: data?.reset_at };
}
