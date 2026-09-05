import { createClient } from "https://esm.sh/@supabase/supabase-js@2.43.4";

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
