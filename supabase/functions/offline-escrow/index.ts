import { createClient } from "https://esm.sh/@supabase/supabase-js@2.43.4";
import {
  verifyAuthenticationResponse,
  type AuthenticationResponseJSON,
} from "https://esm.sh/@simplewebauthn/server@10.0.0";
import { decodeBase64Url, encodeBase64Url } from "https://deno.land/std@0.168.0/encoding/base64url.ts";
import {
  getAuthenticatedUser,
  getBearerToken,
  jsonResponse,
  optionsResponse,
} from "../_shared/auth.ts";
import { enforceRateLimitWithToken } from "../_shared/rateLimit.ts";

const FUNCTION_VERSION = "offline-escrow-v1";
const KEY_ID = "campus-plug-escrow-ed25519-v1";
const VOUCHER_PREFIX = "CPV1";
const RP_ID = Deno.env.get("RP_ID") ?? "campusplug.ng";
const APP_ORIGIN = Deno.env.get("APP_ORIGIN") ?? "https://campusplug.ng";
const VOUCHER_TTL_MS = 30 * 60 * 1000;
const SYNC_GRACE_MS = 6 * 60 * 60 * 1000;

type SellerCredential = {
  id: string;
  transports: string[];
};

type VoucherClaims = {
  v: 1;
  kid: string;
  jti: string;
  transaction_id: string;
  buyer_id: string;
  seller_id: string;
  payment_method: "campus_wallet" | "paystack";
  amount_kobo: number;
  safe_zone_id: string;
  seller_credentials: SellerCredential[];
  nonce: string;
  issued_at: string;
  expires_at: string;
  sync_grace_until: string;
};

type ReceiptCore = {
  v: 1;
  voucher_id: string;
  transaction_id: string;
  buyer_id: string;
  seller_id: string;
  nonce: string;
  voucher_hash: string;
  receipt_nonce: string;
  scanned_at: string;
};

type OfflineReceipt = {
  core: ReceiptCore;
  assertion: AuthenticationResponseJSON;
};

type SigningKeyRow = {
  key_id: string;
  public_key: string;
  private_key_pkcs8: string;
};

let cachedSigningKey: {
  keyId: string;
  publicKey: string;
  privateKey: CryptoKey;
} | null = null;

function getPrivilegedKey(): string | null {
  const raw = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (raw) {
    try {
      const keys = JSON.parse(raw) as Record<string, unknown>;
      const value = keys.default;
      if (typeof value === "string" && value.trim()) return value.trim();
    } catch {
      // Fall through to the app-owned deployment credential.
    }
  }
  return Deno.env.get("EDGE_FUNCTION_SERVICE_KEY")?.trim()
    || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim()
    || null;
}

function getAdminClient() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = getPrivilegedKey();
  if (!url || !key) throw new Error("Supabase runtime configuration is missing");
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256(input: string | Uint8Array): Promise<Uint8Array> {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

async function sha256Hex(input: string | Uint8Array): Promise<string> {
  return bytesToHex(await sha256(input));
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return "{" + Object.keys(object).sort().map((key) =>
      JSON.stringify(key) + ":" + canonicalJson(object[key])
    ).join(",") + "}";
  }
  return JSON.stringify(value);
}

function randomBase64Url(byteLength = 32): string {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

function parseIso(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function isUuid(value: unknown): value is string {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

async function getSigningKey(admin: ReturnType<typeof getAdminClient>) {
  if (cachedSigningKey) return cachedSigningKey;

  const load = async () => {
    const { data, error } = await admin.rpc("get_escrow_voucher_signing_key", {
      p_key_id: KEY_ID,
    });
    if (error) throw error;
    return (Array.isArray(data) ? data[0] : data) as SigningKeyRow | null;
  };

  let row = await load();
  if (!row) {
    const generated = await crypto.subtle.generateKey(
      { name: "Ed25519" },
      true,
      ["sign", "verify"],
    );
    const privateBytes = new Uint8Array(await crypto.subtle.exportKey("pkcs8", generated.privateKey));
    const publicBytes = new Uint8Array(await crypto.subtle.exportKey("raw", generated.publicKey));

    const { error: storeError } = await admin.rpc("store_escrow_voucher_signing_key", {
      p_key_id: KEY_ID,
      p_public_key: encodeBase64Url(publicBytes),
      p_private_key_pkcs8: encodeBase64Url(privateBytes),
    });
    if (storeError) throw storeError;
    row = await load();
  }

  if (!row?.public_key || !row.private_key_pkcs8) {
    throw new Error("Offline escrow signing key could not be loaded");
  }

  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    decodeBase64Url(row.private_key_pkcs8),
    { name: "Ed25519" },
    false,
    ["sign"],
  );

  const publicKey = await crypto.subtle.importKey(
    "raw",
    decodeBase64Url(row.public_key),
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  const probe = crypto.getRandomValues(new Uint8Array(16));
  const probeSignature = await crypto.subtle.sign({ name: "Ed25519" }, privateKey, probe);
  const keyPairMatches = await crypto.subtle.verify(
    { name: "Ed25519" },
    publicKey,
    probeSignature,
    probe,
  );
  if (!keyPairMatches) throw new Error("Offline escrow signing keypair failed self-check");

  cachedSigningKey = {
    keyId: row.key_id,
    publicKey: row.public_key,
    privateKey,
  };
  return cachedSigningKey;
}

async function signVoucher(
  claims: VoucherClaims,
  signingKey: Awaited<ReturnType<typeof getSigningKey>>,
): Promise<string> {
  const payload = new TextEncoder().encode(JSON.stringify(claims));
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: "Ed25519" }, signingKey.privateKey, payload),
  );
  return VOUCHER_PREFIX + "." + encodeBase64Url(payload) + "." + encodeBase64Url(signature);
}

async function verifyVoucherToken(
  token: string,
  signingKey: Awaited<ReturnType<typeof getSigningKey>>,
): Promise<VoucherClaims> {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== VOUCHER_PREFIX) {
    throw new Error("Invalid offline voucher format");
  }

  const payloadBytes = decodeBase64Url(parts[1]);
  const signature = decodeBase64Url(parts[2]);
  const publicKey = await crypto.subtle.importKey(
    "raw",
    decodeBase64Url(signingKey.publicKey),
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    { name: "Ed25519" },
    publicKey,
    signature,
    payloadBytes,
  );
  if (!valid) throw new Error("Offline voucher signature is invalid");

  const claims = JSON.parse(new TextDecoder().decode(payloadBytes)) as VoucherClaims;
  if (claims.v !== 1 || claims.kid !== signingKey.keyId || !claims.jti || !claims.nonce) {
    throw new Error("Unsupported offline voucher claims");
  }
  return claims;
}

function validateReceiptCore(core: ReceiptCore, claims: VoucherClaims, voucherHash: string) {
  if (!core || core.v !== 1
    || core.voucher_id !== claims.jti
    || core.transaction_id !== claims.transaction_id
    || core.buyer_id !== claims.buyer_id
    || core.seller_id !== claims.seller_id
    || core.nonce !== claims.nonce
    || core.voucher_hash !== voucherHash
    || typeof core.receipt_nonce !== "string"
    || core.receipt_nonce.length < 16
    || core.receipt_nonce.length > 128) {
    throw new Error("Offline receipt does not match the signed voucher");
  }

  const scannedAt = parseIso(core.scanned_at);
  const issuedAt = parseIso(claims.issued_at);
  const expiresAt = parseIso(claims.expires_at);
  const skew = 5 * 60 * 1000;
  if (scannedAt === null || issuedAt === null || expiresAt === null
    || scannedAt < issuedAt - skew || scannedAt > expiresAt + skew) {
    throw new Error("Receipt timestamp is outside the voucher validity window");
  }
}

async function issueVoucher(req: Request, userId: string, admin: ReturnType<typeof getAdminClient>) {
  const token = getBearerToken(req);
  if (!token) return jsonResponse({ error: "Unauthorized" }, 401, {}, req);

  const rate = await enforceRateLimitWithToken(token, "offline-escrow-issue", 5, 600);
  if (!rate.allowed) return jsonResponse({ error: "Too many voucher requests" }, 429, {}, req);

  const body = await req.json().catch(() => ({}));
  const transactionId = body?.transaction_id;
  if (!isUuid(transactionId)) return jsonResponse({ error: "Invalid transaction_id" }, 400, {}, req);

  const { data: tx, error: txError } = await admin
    .from("transactions")
    .select("id,buyer_id,seller_id,amount,payment_method,status,buyer_safe_zone_id")
    .eq("id", transactionId)
    .maybeSingle();
  if (txError) throw txError;
  if (!tx || tx.buyer_id !== userId) {
    return jsonResponse({ error: "Transaction not found or buyer access denied" }, 404, {}, req);
  }

  const { data: credentials, error: credentialError } = await admin
    .from("passkey_credentials")
    .select("credential_id,transports")
    .eq("user_id", tx.seller_id)
    .limit(8);
  if (credentialError) throw credentialError;
  if (!credentials?.length) {
    return jsonResponse({
      error: "Seller must register a passkey before offline handoff",
      code: "SELLER_PASSKEY_REQUIRED",
    }, 409, {}, req);
  }

  const amountKobo = Number(tx.amount);
  if (!Number.isSafeInteger(amountKobo) || amountKobo <= 0 || !isUuid(tx.buyer_safe_zone_id)) {
    return jsonResponse({ error: "Transaction is not eligible for an offline voucher" }, 409, {}, req);
  }

  const signingKey = await getSigningKey(admin);
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + VOUCHER_TTL_MS);
  const syncGraceUntil = new Date(expiresAt.getTime() + SYNC_GRACE_MS);
  const claims: VoucherClaims = {
    v: 1,
    kid: signingKey.keyId,
    jti: crypto.randomUUID(),
    transaction_id: tx.id,
    buyer_id: tx.buyer_id,
    seller_id: tx.seller_id,
    payment_method: tx.payment_method === "campus_wallet" ? "campus_wallet" : "paystack",
    amount_kobo: amountKobo,
    safe_zone_id: tx.buyer_safe_zone_id,
    seller_credentials: credentials.map((credential) => ({
      id: credential.credential_id,
      transports: Array.isArray(credential.transports) ? credential.transports : [],
    })),
    nonce: randomBase64Url(32),
    issued_at: issuedAt.toISOString(),
    expires_at: expiresAt.toISOString(),
    sync_grace_until: syncGraceUntil.toISOString(),
  };

  const voucherToken = await signVoucher(claims, signingKey);
  const voucherHash = await sha256Hex(voucherToken);
  const { data: created, error: createError } = await admin.rpc("create_offline_escrow_voucher", {
    p_voucher_id: claims.jti,
    p_transaction_id: claims.transaction_id,
    p_buyer_id: claims.buyer_id,
    p_seller_id: claims.seller_id,
    p_payment_method: claims.payment_method,
    p_amount_kobo: claims.amount_kobo,
    p_safe_zone_id: claims.safe_zone_id,
    p_key_id: claims.kid,
    p_nonce: claims.nonce,
    p_voucher_hash: voucherHash,
    p_issued_at: claims.issued_at,
    p_expires_at: claims.expires_at,
    p_sync_grace_until: claims.sync_grace_until,
  });
  if (createError || !created?.success) {
    console.error("offline voucher issuance failed", createError?.message ?? "RPC rejected voucher");
    return jsonResponse({ error: "Transaction is not eligible for an offline voucher" }, 409, {}, req);
  }

  return jsonResponse({
    success: true,
    voucher_token: voucherToken,
    claims,
    public_key: signingKey.publicKey,
    algorithm: "Ed25519",
    server_status: "funds_locked_provisional",
  }, 200, {}, req);
}

async function reconcileReceipt(req: Request, userId: string, admin: ReturnType<typeof getAdminClient>) {
  const token = getBearerToken(req);
  if (!token) return jsonResponse({ error: "Unauthorized" }, 401, {}, req);

  const rate = await enforceRateLimitWithToken(token, "offline-escrow-reconcile", 10, 600);
  if (!rate.allowed) return jsonResponse({ error: "Too many receipt sync attempts" }, 429, {}, req);

  const body = await req.json().catch(() => ({}));
  const voucherToken = body?.voucher_token;
  const receipt = body?.receipt as OfflineReceipt | undefined;
  if (typeof voucherToken !== "string" || voucherToken.length > 12000
    || !receipt?.core || !receipt?.assertion) {
    return jsonResponse({ error: "Invalid offline receipt payload" }, 400, {}, req);
  }

  const signingKey = await getSigningKey(admin);
  let claims: VoucherClaims;
  try {
    claims = await verifyVoucherToken(voucherToken, signingKey);
  } catch {
    return jsonResponse({ error: "Invalid offline voucher signature or format" }, 400, {}, req);
  }
  if (userId !== claims.buyer_id && userId !== claims.seller_id) {
    return jsonResponse({ error: "Only a transaction participant can sync this receipt" }, 403, {}, req);
  }

  const syncGraceUntil = parseIso(claims.sync_grace_until);
  if (syncGraceUntil === null || Date.now() > syncGraceUntil) {
    return jsonResponse({ error: "Offline receipt sync window has expired" }, 409, {}, req);
  }

  const voucherHash = await sha256Hex(voucherToken);
  try {
    validateReceiptCore(receipt.core, claims, voucherHash);
  } catch {
    return jsonResponse({ error: "Offline receipt does not match the signed voucher" }, 400, {}, req);
  }
  const receiptHash = await sha256Hex(canonicalJson(receipt));
  const credentialId = receipt.assertion.id;
  if (typeof credentialId !== "string"
    || !claims.seller_credentials.some((credential) => credential.id === credentialId)) {
    return jsonResponse({ error: "Receipt was not signed by a seller passkey in the voucher" }, 403, {}, req);
  }

  const { data: existing, error: existingError } = await admin
    .from("escrow_offline_receipts")
    .select("receipt_hash")
    .eq("voucher_id", claims.jti)
    .maybeSingle();
  if (existingError) throw existingError;
  const alreadyReconciled = async () => {
    const { data: transaction } = await admin
      .from("transactions")
      .select("status,auto_release_at")
      .eq("id", claims.transaction_id)
      .maybeSingle();
    return jsonResponse({
      success: true,
      already_reconciled: true,
      status: transaction?.status ?? "reconciled",
      transaction_id: claims.transaction_id,
      inspection_expires_at: transaction?.auto_release_at ?? null,
      funds_released: transaction?.status === "released",
    }, 200, {}, req);
  };

  if (existing) {
    if (existing.receipt_hash === receiptHash) return await alreadyReconciled();
    return jsonResponse({ error: "A different receipt has already been accepted" }, 409, {}, req);
  }

  const { data: credential, error: passkeyError } = await admin
    .from("passkey_credentials")
    .select("credential_id,public_key,sign_count,transports")
    .eq("user_id", claims.seller_id)
    .eq("credential_id", credentialId)
    .maybeSingle();
  if (passkeyError) throw passkeyError;
  if (!credential) return jsonResponse({ error: "Seller passkey is no longer registered" }, 403, {}, req);

  const challenge = encodeBase64Url(await sha256(new TextEncoder().encode(canonicalJson(receipt.core))));
  let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
  try {
    verification = await verifyAuthenticationResponse({
      response: receipt.assertion,
      expectedChallenge: challenge,
      expectedOrigin: APP_ORIGIN,
      expectedRPID: RP_ID,
      authenticator: {
        credentialID: credential.credential_id,
        credentialPublicKey: decodeBase64Url(credential.public_key),
        counter: Number(credential.sign_count ?? 0),
        transports: Array.isArray(credential.transports) ? credential.transports : undefined,
      },
      requireUserVerification: true,
    });
  } catch {
    const { data: racedReceipt } = await admin
      .from("escrow_offline_receipts")
      .select("receipt_hash")
      .eq("voucher_id", claims.jti)
      .maybeSingle();
    if (racedReceipt?.receipt_hash === receiptHash) return await alreadyReconciled();
    return jsonResponse({ error: "Seller passkey receipt verification failed" }, 403, {}, req);
  }

  if (!verification.verified) {
    const { data: racedReceipt } = await admin
      .from("escrow_offline_receipts")
      .select("receipt_hash")
      .eq("voucher_id", claims.jti)
      .maybeSingle();
    if (racedReceipt?.receipt_hash === receiptHash) return await alreadyReconciled();
    return jsonResponse({ error: "Seller passkey receipt verification failed" }, 403, {}, req);
  }

  const { data: result, error: reconcileError } = await admin.rpc("reconcile_offline_escrow_receipt", {
    p_voucher_id: claims.jti,
    p_transaction_id: claims.transaction_id,
    p_buyer_id: claims.buyer_id,
    p_seller_id: claims.seller_id,
    p_nonce: claims.nonce,
    p_voucher_hash: voucherHash,
    p_receipt_nonce: receipt.core.receipt_nonce,
    p_receipt_hash: receiptHash,
    p_seller_credential_id: credentialId,
    p_synced_by: userId,
    p_scanned_at: receipt.core.scanned_at,
    p_receipt_payload: receipt,
  });
  if (reconcileError) {
    const { data: racedReceipt } = await admin
      .from("escrow_offline_receipts")
      .select("receipt_hash")
      .eq("voucher_id", claims.jti)
      .maybeSingle();
    if (racedReceipt?.receipt_hash === receiptHash) return await alreadyReconciled();
    console.error("offline receipt reconciliation failed", reconcileError.message);
    return jsonResponse({ error: "Receipt reconciliation failed" }, 409, {}, req);
  }

  const newCounter = verification.authenticationInfo.newCounter;
  if (newCounter > Number(credential.sign_count ?? 0)) {
    const { error: counterError } = await admin
      .from("passkey_credentials")
      .update({ sign_count: newCounter, last_used_at: new Date().toISOString() })
      .eq("user_id", claims.seller_id)
      .eq("credential_id", credentialId);
    if (counterError) {
      console.error("offline escrow passkey counter update failed", counterError.message);
    }
  }

  return jsonResponse(result ?? {
    success: true,
    status: "inspection_pending",
    transaction_id: claims.transaction_id,
    funds_released: false,
  }, 200, {}, req);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return optionsResponse(req);

  const url = new URL(req.url);
  if (req.method === "GET" && url.pathname.endsWith("/ping")) {
    return jsonResponse({ status: "warm", fn: FUNCTION_VERSION, ts: Date.now() }, 200, {}, req);
  }

  try {
    const admin = getAdminClient();

    if (req.method === "GET" && url.pathname.endsWith("/public-key")) {
      const user = await getAuthenticatedUser(req);
      if (!user) return jsonResponse({ error: "Unauthorized" }, 401, {}, req);
      const signingKey = await getSigningKey(admin);
      return jsonResponse({
        key_id: signingKey.keyId,
        algorithm: "Ed25519",
        public_key: signingKey.publicKey,
      }, 200, {}, req);
    }

    if (req.method !== "POST") {
      return jsonResponse({ error: "Method not allowed" }, 405, {}, req);
    }

    const user = await getAuthenticatedUser(req);
    if (!user) return jsonResponse({ error: "Unauthorized" }, 401, {}, req);

    const body = await req.clone().json().catch(() => ({}));
    if (body?.action === "issue_voucher") {
      return await issueVoucher(req, user.id, admin);
    }
    if (body?.action === "reconcile_receipt") {
      return await reconcileReceipt(req, user.id, admin);
    }
    return jsonResponse({ error: "Unsupported action" }, 400, {}, req);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected offline escrow error";
    console.error("offline escrow request failed", message);
    return jsonResponse({ error: "Offline escrow request failed" }, 500, {}, req);
  }
});
