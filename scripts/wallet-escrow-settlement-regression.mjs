import fs from "node:fs";
import path from "node:path";

const read = (file) => fs.readFileSync(path.join(process.cwd(), file), "utf8");
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const isolated = read("supabase/migrations/20261022150000_isolate_wallet_escrow_settlement.sql");
const resolver = read("supabase/migrations/20261022151000_guard_wallet_escrow_resolution.sql");

assert(isolated.includes("COALESCE(tx.payment_method, 'paystack') = 'campus_wallet'"), "General escrow state machine must reject wallet-funded transactions");
assert(isolated.includes("Campus Wallet escrow must be resolved through resolve_wallet_micro_escrow"), "Wallet settlement rejection must explain the required path");
assert(isolated.includes("GRANT EXECUTE ON FUNCTION public.process_escrow_action(uuid,text,text,text) TO authenticated, service_role"), "General escrow RPC permissions must be preserved");

assert(resolver.includes("FROM public.transactions\n   WHERE id = v_hold.transaction_id\n   FOR UPDATE"), "Wallet resolution must lock its transaction row");
assert(resolver.includes("COALESCE(v_tx.payment_method, '') <> 'campus_wallet'"), "Wallet resolution must verify payment method");
assert(resolver.includes("v_tx.status <> 'locked'"), "Wallet resolution must reject transactions changed by another state machine");
assert(resolver.includes("IF v_hold.status <> 'held'"), "Wallet resolution must remain one-shot");
assert(resolver.includes("UPDATE public.wallet_escrow_holds"), "Wallet resolution must finalize the hold");
assert(resolver.includes("REVOKE ALL ON FUNCTION public.resolve_wallet_micro_escrow(uuid,text) FROM PUBLIC, anon"), "Wallet resolver must not be public or anonymous");
assert(resolver.includes("GRANT EXECUTE ON FUNCTION public.resolve_wallet_micro_escrow(uuid,text) TO authenticated"), "Wallet resolver must remain available to authenticated participants");

const previous = read("supabase/migrations/0411_wallet_payout_offline_guardrails.sql");
assert(previous.includes("transaction_id uuid NOT NULL UNIQUE REFERENCES public.transactions(id)"), "A transaction must have at most one wallet escrow hold");
assert(previous.includes("FOR UPDATE"), "Wallet escrow paths must retain row locking");
console.log("Wallet escrow settlement isolation regression checks passed (static source invariants).");
