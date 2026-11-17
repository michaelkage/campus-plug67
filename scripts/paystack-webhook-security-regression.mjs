import fs from "node:fs";
import path from "node:path";

const source = fs.readFileSync(path.join(process.cwd(), "supabase/functions/paystack-webhook/index.ts"), "utf8");
const requireText = (text, message) => {
  if (!source.includes(text)) throw new Error(message);
};

requireText("crypto.subtle.importKey", "Webhook must use Web Crypto HMAC");
requireText("/^[a-f0-9]{128}$/i.test(signature)", "Webhook must validate the exact SHA-512 hex signature shape");
requireText("signatureMismatch |= expectedBytes[i] ^ suppliedBytes[i]", "Signature comparison must inspect all fixed-length bytes");
requireText('["pending", "processed", "failed", "cancelled", "needs_attention"].includes(status)', "Refund status must be allowlisted");
requireText('admin.rpc("record_paystack_refund"', "Refund state transitions must go through the atomic recorder");
requireText("p_refund_reference: refundReference", "Refund events must preserve provider refund identity");
requireText('event.event?.startsWith("refund.")', "Refund events must be handled by the refund recorder");
console.log("Paystack webhook security regression checks passed (static source invariants).");
