import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const fail = (message) => { throw new Error(message); };
const assertIncludes = (source, text, message) => {
  if (!source.includes(text)) fail(message || `Missing required purchase guard: ${text}`);
};
const extractFunction = (sql, name) => {
  const start = sql.toLowerCase().indexOf(`create or replace function public.${name.toLowerCase()}`);
  if (start < 0) fail(`Missing function definition: ${name}`);
  const next = sql.toLowerCase().indexOf('create or replace function public.', start + 1);
  return sql.slice(start, next < 0 ? sql.length : next);
};

const migrationPath = 'supabase/migrations/20261021143000_harden_cross_provider_listing_purchases.sql';
const migration = read(migrationPath);
const resolutionMigration = read('supabase/migrations/20261022180000_mark_wallet_listing_sold_on_release.sql');
const rpcPermissions = read('supabase/migrations/20261022120000_restrict_marketplace_escrow_rpc_execution.sql');
const legacyRpcPermissions = read('supabase/migrations/20261022124500_restrict_legacy_wallet_sku_rpc_execution.sql');
for (const signature of [
  'public.create_wallet_micro_escrow(uuid)',
  'public.resolve_wallet_micro_escrow(uuid, text)',
  'public.create_pending_paystack_transaction(uuid, text)',
]) {
  assertIncludes(rpcPermissions, `REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC, anon`,
    `Privileged RPC must revoke PUBLIC/anon execution: ${signature}`);
  assertIncludes(rpcPermissions, `GRANT EXECUTE ON FUNCTION ${signature} TO authenticated`,
    `Privileged RPC must remain available to authenticated users: ${signature}`);
}
for (const signature of [
  'public.credit_wallet_funding(text, bigint)',
  'public.match_global_sku(text)',
]) {
  assertIncludes(legacyRpcPermissions, `REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC, anon`,
    `Legacy RPC must revoke PUBLIC/anon execution: ${signature}`);
  assertIncludes(legacyRpcPermissions, `GRANT EXECUTE ON FUNCTION ${signature} TO authenticated`,
    `Legacy RPC must remain available to authenticated users: ${signature}`);
}
const wallet = extractFunction(migration, 'create_wallet_micro_escrow');
const paystack = extractFunction(migration, 'create_pending_paystack_transaction');
const resolve = extractFunction(resolutionMigration, 'resolve_wallet_micro_escrow');
const integrity = read('supabase/migrations/20260926131500_protect_listing_purchase_integrity.sql');
const listingDetail = read('src/pages/ListingDetail.jsx');
const walletLauncher = read('src/components/wallet/MicroEscrowLauncher.tsx');
const databaseTypes = read('src/types/database.ts');
const rpcTypes = read('src/lib/supabase/client.ts');

const activeStatuses = "'pending', 'locked', 'meetup_initiated', 'release_requested', 'disputed'";

for (const [name, fn] of [['wallet', wallet], ['Paystack', paystack]]) {
  assertIncludes(fn, 'FOR UPDATE', `${name} purchase path must lock the listing row`);
  assertIncludes(fn, activeStatuses, `${name} purchase path must check all active transaction states`);
  assertIncludes(fn, "'active_transaction_exists'", `${name} purchase path must return a structured conflict`);
  assertIncludes(fn, "'listing_unavailable'", `${name} purchase path must return a structured unavailable response`);
}

assertIncludes(integrity, 'CREATE UNIQUE INDEX IF NOT EXISTS transactions_one_active_per_listing',
  'The active-per-listing unique index must remain in place');
assertIncludes(paystack, 'WHEN unique_violation', 'Paystack must handle a last-resort uniqueness race');
assertIncludes(paystack, "v_constraint_name = 'transactions_one_active_per_listing'",
  'Paystack must map the unique-index race to active_transaction_exists');

const txInsert = wallet.indexOf('INSERT INTO public.transactions');
const ledgerInsert = wallet.indexOf('INSERT INTO public.plug_credit_ledger');
const holdInsert = wallet.indexOf('INSERT INTO public.wallet_escrow_holds');
const listingReserved = wallet.indexOf("SET status = 'reserved'");
if (!(txInsert >= 0 && ledgerInsert > txInsert && holdInsert > ledgerInsert && listingReserved > holdInsert)) {
  fail('Wallet escrow must insert transaction, ledger debit, and hold before reserving the listing');
}
assertIncludes(integrity, "SET status='sold'", 'Paystack settlement must keep using the sold listing convention');
assertIncludes(resolve, "SET status = 'sold'", 'Wallet escrow release must mark the listing sold');
assertIncludes(resolve, "AND status = 'reserved'", 'Wallet escrow release must only sell the reserved listing');
assertIncludes(resolve, "RAISE EXCEPTION 'Wallet escrow listing is not reserved'",
  'Wallet release must roll back if listing state is inconsistent');

assertIncludes(resolve, 'v_user IS NULL', 'Wallet escrow resolution must reject unauthenticated callers');
assertIncludes(resolve, "status = 'active'", 'Wallet refund must return the listing to active');
assertIncludes(resolve, "l.status = 'reserved'", 'Wallet refund must only restore a reserved listing');
assertIncludes(resolve, 'NOT EXISTS', 'Wallet refund must not reopen a listing with another active transaction');

if (/EXCEPTION\s+WHEN\s+OTHERS/i.test(wallet)) {
  fail('Wallet escrow must not swallow unexpected errors and commit partial state');
}
if (!(wallet.indexOf('INSERT INTO public.wallet_escrow_holds') < wallet.indexOf("SET status = 'reserved'"))) {
  fail('Listing state update must be part of the same atomic wallet escrow function');
}

assertIncludes(listingDetail, 'tx?.success === false', 'Paystack client must handle structured RPC conflicts');
assertIncludes(listingDetail, "['listings']", 'Paystack conflict handling must refresh marketplace results');
assertIncludes(listingDetail, "listing.status === 'reserved'", 'Marketplace detail must explain reserved listings');
assertIncludes(databaseTypes, "status: 'active' | 'reserved' | 'sold' | 'removed' | 'pending'", 'Listing database types must include the reserved state');
assertIncludes(rpcTypes, "code?:string;message?:string;transaction_id?:string", 'Paystack RPC types must model structured conflict responses');
assertIncludes(walletLauncher, "['listings']", 'Wallet success must refresh marketplace results');
assertIncludes(walletLauncher, "['transaction', listing.id, user.id]", 'Wallet success must refresh transaction state');

console.log('Marketplace purchase regression checks passed (static SQL/client invariants).');
