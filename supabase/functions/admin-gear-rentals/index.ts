import { createClient } from "https://esm.sh/@supabase/supabase-js@2.43.4"
import { getAuthenticatedUser, jsonResponse, optionsResponse } from "../_shared/auth.ts"

const url = Deno.env.get("SUPABASE_URL")
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")
if (!url || !serviceKey) throw new Error("Missing Supabase service configuration")
const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return optionsResponse(req)
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405, {}, req)

  const user = await getAuthenticatedUser(req)
  if (!user) return jsonResponse({ error: "Unauthorized" }, 401, {}, req)
  const role = user.app_metadata?.role
  if (role !== "admin" && role !== "platform_admin") return jsonResponse({ error: "Platform admin required" }, 403, {}, req)

  const body = await req.json().catch(() => null)
  if (!body || typeof body !== "object" || body.action !== "list_disputes") {
    return jsonResponse({ error: "Unsupported action" }, 400, {}, req)
  }

  const { data, error } = await admin.from("gear_rentals")
    .select("id,listing_id,borrower_id,lender_id,rental_status,start_date,end_date,rental_fee_kobo,security_deposit_kobo,total_held_kobo,dispute_reason,disputed_at,created_at,listing:listings(title),hold:gear_rental_holds(status,total_held_kobo)")
    .eq("rental_status", "disputed")
    .order("disputed_at", { ascending: true })
    .limit(100)

  if (error) return jsonResponse({ error: error.message }, 500, {}, req)
  return jsonResponse({ success: true, disputes: data ?? [] }, 200, {}, req)
})
