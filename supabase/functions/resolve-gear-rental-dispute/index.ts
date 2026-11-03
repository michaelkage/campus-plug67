import { createClient } from "https://esm.sh/@supabase/supabase-js@2.43.4"
import { getAuthenticatedUser, jsonResponse, optionsResponse } from "../_shared/auth.ts"

const supabaseUrl = Deno.env.get("SUPABASE_URL")
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")
if (!supabaseUrl || !serviceKey) throw new Error("Missing Supabase service configuration")

const admin = createClient(supabaseUrl, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
})

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return optionsResponse(req)
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405, {}, req)

  const user = await getAuthenticatedUser(req)
  if (!user) return jsonResponse({ error: "Unauthorized" }, 401, {}, req)
  const role = user.app_metadata?.role
  if (role !== "admin" && role !== "platform_admin") {
    return jsonResponse({ error: "Platform admin required" }, 403, {}, req)
  }

  const body = await req.json().catch(() => null)
  const rentalId = body && typeof body === "object" && typeof body.rental_id === "string"
    ? body.rental_id.trim()
    : ""
  const lenderShareBps = body && typeof body === "object" && Number.isInteger(body.lender_share_bps)
    ? body.lender_share_bps
    : null

  if (!UUID_RE.test(rentalId)) return jsonResponse({ error: "A valid rental_id is required" }, 400, {}, req)
  if (lenderShareBps === null || lenderShareBps < 0 || lenderShareBps > 10_000) {
    return jsonResponse({ error: "lender_share_bps must be an integer from 0 to 10000" }, 400, {}, req)
  }

  const { data, error } = await admin.rpc("resolve_gear_rental_dispute", {
    p_rental_id: rentalId,
    p_lender_share_bps: lenderShareBps,
    p_admin_id: user.id,
  })
  if (error) return jsonResponse({ error: error.message }, 409, {}, req)
  return jsonResponse({ ...data, rental_id: rentalId, resolved_by: user.id }, 200, {}, req)
})
