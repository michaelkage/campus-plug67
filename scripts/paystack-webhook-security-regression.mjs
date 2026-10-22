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
requireText('if (transaction.refund_status === "processed" && status !== "processed")', "Processed refund state must not regress");
requireText('!transaction.refund_processed_at', "Duplicate processed events must preserve the first processed timestamp");
requireText('.maybeSingle()', "Refund updates must first verify the referenced transaction exists");
console.log("Paystack webhook security regression checks passed (static source invariants).");
