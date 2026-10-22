import { createClient } from "https://esm.sh/@supabase/supabase-js@2.43.4";
import { getAuthenticatedUser, jsonResponse, optionsResponse } from "../_shared/auth.ts";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return optionsResponse(req);
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405, {}, req);
  const user = await getAuthenticatedUser(req);
  if (!user) return jsonResponse({ error: "Unauthorized" }, 401, {}, req);
  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  const amountKobo = Number(body?.amount_kobo);
  if (!Number.isSafeInteger(amountKobo) || amountKobo < 1000) return jsonResponse({ error: "Enter a valid wallet funding amount of at least ₦10" }, 400, {}, req);
  const reference = `CPW-${crypto.randomUUID().replaceAll("-", "").toUpperCase()}`;
  const { error } = await admin.from("wallet_funding_intents").insert({ user_id: user.id, reference, amount_kobo: amountKobo, status: "pending" });
  if (error) {
    console.error("Wallet funding intent creation failed", error.message);
    return jsonResponse({ error: "Unable to prepare wallet funding. Please retry." }, 503, {}, req);
  }
  return jsonResponse({ reference, amount_kobo: amountKobo }, 201, {}, req);
});
