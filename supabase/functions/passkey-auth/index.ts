// Campus Plug — passkey-auth Edge Function
//
// FIX #11: Stateless challenge store.
// The old code used a module-level Map<string, string> which is wiped on every
// Deno isolate cold start.  Authentication and registration challenges were lost
// between warm-up and verify calls that hit different isolate instances.
//
// Fix: challenges are now persisted to the `user_security` table immediately after
// generation (both reg: and auth: keys), and always read from the DB as the
// authoritative source.  The in-memory Map is retained as a fast-path cache for
// requests that arrive in the same warm isolate, but is never the sole source of truth.
//
// Persistence format: a user_security row with:
//   device_hash  = "challenge:<userId>:<type>"   (type = "reg" | "auth")
//   device_label = "__challenge__<challenge>"
//   flag_type    = "webauthn_challenge"
//
// A created_at timestamp allows expired challenges to be ignored (TTL = 5 min).

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.43.4";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "https://esm.sh/@simplewebauthn/server@10.0.0";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Content-Type": "application/json",
};

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } }
);

const RP_NAME = "Campus Plug";
const RP_ID   = Deno.env.get("RP_ID")       ?? "campusplug.ng";
const ORIGIN  = Deno.env.get("APP_ORIGIN")  ?? "https://campusplug.ng";
const CHALLENGE_TTL_MS = 5 * 60 * 1_000;   // 5 minutes

const ok  = (d: unknown)         => new Response(JSON.stringify(d),             { status: 200, headers: CORS });
const bad = (m: string, s = 400) => new Response(JSON.stringify({ error: m }), { status: s,   headers: CORS });

// ── In-memory fast-path cache (same isolate only) ─────────────────────────────
const _cache = new Map<string, string>();

// ── Challenge persistence helpers ─────────────────────────────────────────────

async function saveChallenge(userId: string, type: "reg" | "auth", challenge: string): Promise<void> {
  const key = `challenge:${userId}:${type}`;
  _cache.set(key, challenge);

  // Upsert to DB so it survives cold starts
  await admin.from("user_security").upsert(
    {
      user_id:      userId,
      device_hash:  key,
      device_label: `__challenge__${challenge}`,
      flag_type:    "webauthn_challenge",
      created_at:   new Date().toISOString(),
    },
    { onConflict: "user_id,device_hash" }
  );
}

async function loadChallenge(userId: string, type: "reg" | "auth"): Promise<string | null> {
  const key = `challenge:${userId}:${type}`;

  // Fast path: in-memory cache
  if (_cache.has(key)) return _cache.get(key)!;

  // Slow path: DB lookup
  const { data } = await admin
    .from("user_security")
    .select("device_label, created_at")
    .eq("user_id", userId)
    .eq("device_hash", key)
    .maybeSingle();

  if (!data?.device_label) return null;

  // Enforce TTL
  const age = Date.now() - new Date(data.created_at).getTime();
  if (age > CHALLENGE_TTL_MS) {
    await clearChallenge(userId, type);
    return null;
  }

  const challenge = data.device_label.replace("__challenge__", "");
  _cache.set(key, challenge);
  return challenge;
}

async function clearChallenge(userId: string, type: "reg" | "auth"): Promise<void> {
  const key = `challenge:${userId}:${type}`;
  _cache.delete(key);
  await admin
    .from("user_security")
    .delete()
    .eq("user_id", userId)
    .eq("device_hash", key);
}

// ── Handler ───────────────────────────────────────────────────────────────────

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method === "GET" && new URL(req.url).pathname.endsWith("/ping"))
    return ok({ status: "warm", ts: Date.now(), fn: "passkey-auth" });

  let body: Record<string, unknown>;
  try { body = await req.json(); }
  catch { return bad("Invalid JSON"); }

  const { action, userId, userEmail, response, deviceLabel } =
    body as Record<string, string>;

  // ── GENERATE REGISTRATION OPTIONS ──────────────────────────────────────────
  if (action === "generate_registration_options") {
    if (!userId || !userEmail) return bad("Missing userId or userEmail");

    const { data: existing } = await admin
      .from("passkey_credentials")
      .select("credential_id, transports")
      .eq("user_id", userId);

    const options = await generateRegistrationOptions({
      rpName:          RP_NAME,
      rpID:            RP_ID,
      userID:          userId,
      userName:        userEmail,
      timeout:         60_000,
      attestationType: "none",
      excludeCredentials: (existing ?? []).map((c) => ({
        id:         c.credential_id,
        type:       "public-key",
        transports: c.transports ?? [],
      })),
      authenticatorSelection: {
        residentKey:             "required",
        userVerification:        "required",
        authenticatorAttachment: "platform",
      },
    });

    // FIX #11: persist challenge to DB (not just in-memory Map)
    await saveChallenge(userId, "reg", options.challenge);

    return ok({ options });
  }

  // ── VERIFY REGISTRATION ────────────────────────────────────────────────────
  if (action === "verify_registration") {
    if (!userId || !response) return bad("Missing userId or response");

    // FIX #11: load from DB-backed store
    const expectedChallenge = await loadChallenge(userId, "reg");
    if (!expectedChallenge) return bad("Challenge expired or not found. Please retry.");

    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response:                response as never,
        expectedChallenge,
        expectedOrigin:          ORIGIN,
        expectedRPID:            RP_ID,
        requireUserVerification: true,
      });
    } catch (e) {
      return bad("Verification failed: " + (e as Error).message);
    }

    if (!verification.verified || !verification.registrationInfo) {
      return bad("Passkey verification did not succeed");
    }

    const {
      credentialID,
      credentialPublicKey,
      counter,
      credentialBackedUp,
    } = verification.registrationInfo;

    const { error } = await admin.from("passkey_credentials").insert({
      user_id:      userId,
      credential_id: credentialID,
      public_key:   Buffer.from(credentialPublicKey).toString("base64url"),
      sign_count:   counter,
      transports:   [],
      device_label: deviceLabel || "My Passkey",
      backed_up:    credentialBackedUp,
    });

    if (error) return bad("Failed to save credential: " + error.message);

    await clearChallenge(userId, "reg");
    return ok({ verified: true, credentialID });
  }

  // ── GENERATE AUTHENTICATION OPTIONS ────────────────────────────────────────
  if (action === "generate_authentication_options") {
    if (!userId) return bad("Missing userId");

    const { data: creds } = await admin
      .from("passkey_credentials")
      .select("credential_id, transports")
      .eq("user_id", userId);

    if (!creds?.length) return ok({ options: null });

    const options = await generateAuthenticationOptions({
      rpID:             RP_ID,
      timeout:          60_000,
      allowCredentials: creds.map((c) => ({
        id:         c.credential_id,
        type:       "public-key",
        transports: c.transports ?? ["internal"],
      })),
      userVerification: "required",
    });

    // FIX #11: persist auth challenge to DB
    await saveChallenge(userId, "auth", options.challenge);

    return ok({ options });
  }

  // ── VERIFY AUTHENTICATION ──────────────────────────────────────────────────
  if (action === "verify_authentication") {
    if (!userId || !response) return bad("Missing userId or response");

    const credId = (response as Record<string, string>).id;

    const { data: cred } = await admin
      .from("passkey_credentials")
      .select("*")
      .eq("credential_id", credId)
      .eq("user_id", userId)
      .maybeSingle();

    if (!cred) return bad("Credential not found");

    // FIX #11: load from DB-backed store
    const expectedChallenge = await loadChallenge(userId, "auth");
    if (!expectedChallenge) return bad("Challenge expired. Please retry login.");

    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response:          response as never,
        expectedChallenge,
        expectedOrigin:    ORIGIN,
        expectedRPID:      RP_ID,
        authenticator: {
          credentialID:        cred.credential_id,
          credentialPublicKey: Buffer.from(cred.public_key, "base64url"),
          counter:             cred.sign_count ?? 0,
          transports:          cred.transports ?? [],
        },
        requireUserVerification: true,
      });
    } catch (e) {
      return bad("Auth verification failed: " + (e as Error).message);
    }

    if (!verification.verified) return bad("Signature invalid");

    // Update sign count (replay attack prevention)
    await admin
      .from("passkey_credentials")
      .update({
        sign_count:   verification.authenticationInfo.newCounter,
        last_used_at: new Date().toISOString(),
      })
      .eq("credential_id", credId);

    await clearChallenge(userId, "auth");

    // Generate a short-lived session for this user via admin magic link
    const { data: profileData } = await admin
      .from("profiles")
      .select("email")
      .eq("id", userId)
      .single();

    const { data: sessionData, error: sessionErr } =
      await admin.auth.admin.generateLink({
        type:  "magiclink",
        email: profileData?.email ?? "",
      });

    if (sessionErr || !sessionData) return bad("Session generation failed");

    const { data: session } = await admin.auth.verifyOtp({
      token_hash: sessionData.properties?.hashed_token ?? "",
      type:       "magiclink",
    });

    return ok({
      verified:      true,
      access_token:  session?.session?.access_token  ?? null,
      refresh_token: session?.session?.refresh_token ?? null,
    });
  }

  return bad(`Unknown action: ${action}`);
});
