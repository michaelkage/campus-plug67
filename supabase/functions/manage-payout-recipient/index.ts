import { createClient } from "https://esm.sh/@supabase/supabase-js@2.43.4";
import {
  getAuthenticatedUser,
  getBearerToken,
  jsonResponse,
  optionsResponse,
} from "../_shared/auth.ts";
import { enforceRateLimitWithToken } from "../_shared/rateLimit.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const serviceKey = Deno.env.get("EDGE_FUNCTION_SERVICE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const paystackSecret = Deno.env.get("PAYSTACK_SECRET_KEY") ?? "";
const admin = supabaseUrl && serviceKey
  ? createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })
  : null;

type PaystackEnvelope<T> = { status?: boolean; message?: string; data?: T };
type ResolvedAccount = {
  account_name?: string;
  account_number?: string;
  bank_id?: number;
};
type Bank = { name: string; code: string; active?: boolean; country?: string; currency?: string };
type Recipient = { recipient_code?: string; name?: string; type?: string };

function normalizeName(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en");
}

function validAccountNumber(value: unknown): value is string {
  return typeof value === "string" && /^\d{10}$/.test(value);
}

async function paystack<T>(path: string, init?: RequestInit): Promise<{ response: Response; payload: PaystackEnvelope<T> | null }> {
  const response = await fetch(`https://api.paystack.co${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${paystackSecret}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json().catch(() => null) as PaystackEnvelope<T> | null;
  return { response, payload };
}

async function resolveAccount(accountNumber: string, bankCode: string): Promise<ResolvedAccount> {
  const query = new URLSearchParams({ account_number: accountNumber, bank_code: bankCode });
  const { response, payload } = await paystack<ResolvedAccount>(`/bank/resolve?${query.toString()}`);
  if (!response.ok || payload?.status !== true || !payload.data?.account_name ||
      (payload.data.account_number && payload.data.account_number !== accountNumber)) {
    throw new Error(payload?.message || "The bank could not verify this account. Check the account number and bank.");
  }
  return payload.data;
}

async function resolveBankName(bankCode: string): Promise<string> {
  const query = new URLSearchParams({ country: "nigeria", perPage: "100", page: "1" });
  const { response, payload } = await paystack<Bank[]>(`/bank?${query.toString()}`);
  if (!response.ok || payload?.status !== true || !Array.isArray(payload.data)) {
    throw new Error("Unable to verify the selected bank");
  }
  const bank = payload.data.find((item) => item.code === bankCode && item.active !== false);
  if (!bank) throw new Error("Selected bank is not an active Nigerian bank");
  return bank.name;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return optionsResponse(req);
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405, {}, req);
  if (!admin || !anonKey || !paystackSecret) {
    return jsonResponse({ error: "Payout onboarding is not configured" }, 503, {}, req);
  }

  const user = await getAuthenticatedUser(req);
  const token = getBearerToken(req);
  if (!user || !token) return jsonResponse({ error: "Unauthorized" }, 401, {}, req);

  try {
    const rate = await enforceRateLimitWithToken(token, "seller-payout-recipient", 10, 60);
    if (!rate.allowed) return jsonResponse({ error: "Too many payout-account requests. Try again shortly." }, 429, {}, req);
  } catch {
    return jsonResponse({ error: "Payout security check is temporarily unavailable" }, 503, {}, req);
  }

  const body: unknown = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return jsonResponse({ error: "Invalid request body" }, 400, {}, req);
  }
  const input = body as Record<string, unknown>;
  const action = typeof input.action === "string" ? input.action : "";

  if (action === "list_banks") {
    try {
      const { response, payload } = await paystack<Bank[]>("/bank?country=nigeria&perPage=100&page=1");
      if (!response.ok || payload?.status !== true || !Array.isArray(payload.data)) {
        return jsonResponse({ error: payload?.message || "Unable to load Nigerian banks" }, 502, {}, req);
      }
      const banks = payload.data
        .filter((bank) => bank.active !== false && typeof bank.name === "string" && typeof bank.code === "string")
        .map((bank) => ({ name: bank.name, code: bank.code }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return jsonResponse({ banks }, 200, {}, req);
    } catch (error) {
      console.error("Payout bank list failed", error instanceof Error ? error.message : "unknown error");
      return jsonResponse({ error: "Unable to load banks right now" }, 502, {}, req);
    }
  }

  if (action === "current") {
    const { data, error } = await admin
      .from("seller_payout_recipients")
      .select("bank_name,account_name,account_last4,currency,verified_at,updated_at")
      .eq("seller_id", user.id)
      .eq("is_active", true)
      .maybeSingle();
    if (error) return jsonResponse({ error: "Unable to load saved payout account" }, 500, {}, req);
    return jsonResponse({
      recipient: data ?? null,
      onboarding_enabled: Deno.env.get("PAYSTACK_SELLER_PAYOUT_ONBOARDING_ENABLED") === "true",
      payout_execution_enabled: Deno.env.get("PAYSTACK_SELLER_PAYOUTS_ENABLED") === "true",
    }, 200, {}, req);
  }

  if (Deno.env.get("PAYSTACK_SELLER_PAYOUT_ONBOARDING_ENABLED") !== "true") {
    return jsonResponse({ error: "Seller bank payout setup is not open yet" }, 409, {}, req);
  }

  const accountNumber = input.account_number;
  const bankCode = input.bank_code;
  if (!validAccountNumber(accountNumber) || typeof bankCode !== "string" || !/^\d{2,12}$/.test(bankCode)) {
    return jsonResponse({ error: "Enter a valid 10-digit Nigerian account number and select a bank" }, 400, {}, req);
  }

  const { data: profile, error: profileError } = await admin
    .from("profiles")
    .select("id,is_suspended")
    .eq("id", user.id)
    .single();
  if (profileError || !profile || profile.is_suspended) {
    return jsonResponse({ error: "This account is not eligible for seller payouts" }, 403, {}, req);
  }

  if (action === "resolve") {
    try {
      const resolved = await resolveAccount(accountNumber, bankCode);
      return jsonResponse({
        account_name: resolved.account_name,
        account_last4: accountNumber.slice(-4),
        bank_code: bankCode,
      }, 200, {}, req);
    } catch (error) {
      return jsonResponse({ error: error instanceof Error ? error.message : "Bank account verification failed" }, 422, {}, req);
    }
  }

  if (action !== "save") return jsonResponse({ error: "Unsupported action" }, 400, {}, req);
  if (input.confirm_ownership !== true || typeof input.confirmed_account_name !== "string") {
    return jsonResponse({ error: "Confirm that this verified bank account belongs to you before saving it" }, 400, {}, req);
  }

  try {
    // Resolve again during save. The client-side preview is not a trusted source
    // for the account name or the bank/account binding.
    const resolved = await resolveAccount(accountNumber, bankCode);
    if (normalizeName(input.confirmed_account_name) !== normalizeName(resolved.account_name ?? "")) {
      return jsonResponse({ error: "The confirmed account name no longer matches the bank's verified account name. Verify it again." }, 409, {}, req);
    }

    const bankName = await resolveBankName(bankCode);
    const { response, payload } = await paystack<Recipient>("/transferrecipient", {
      method: "POST",
      body: JSON.stringify({
        type: "nuban",
        name: resolved.account_name,
        account_number: accountNumber,
        bank_code: bankCode,
        currency: "NGN",
        description: "Campus Plug verified seller payout account",
      }),
    });
    const recipientCode = payload?.data?.recipient_code;
    if (!response.ok || payload?.status !== true || typeof recipientCode !== "string" || !/^RCP_[A-Za-z0-9]+$/.test(recipientCode)) {
      return jsonResponse({ error: payload?.message || "Paystack could not create the payout recipient" }, 502, {}, req);
    }

    const { data, error } = await admin.rpc("save_seller_payout_recipient", {
      p_seller_id: user.id,
      p_recipient_code: recipientCode,
      p_bank_code: bankCode,
      p_bank_name: bankName,
      p_account_name: resolved.account_name,
      p_account_last4: accountNumber.slice(-4),
    });
    if (error) {
      console.error("Payout recipient persistence failed");
      return jsonResponse({ error: "The bank account was verified, but Campus Plug could not save the recipient. Contact support before trying another account." }, 500, {}, req);
    }

    return jsonResponse({
      recipient: {
        bank_name: data.bank_name,
        account_name: data.account_name,
        account_last4: data.account_last4,
        currency: data.currency,
        verified_at: data.verified_at,
      },
    }, 200, {}, req);
  } catch (error) {
    console.error("Payout recipient setup failed");
    return jsonResponse({ error: "Unable to save the payout account right now" }, 502, {}, req);
  }
});
