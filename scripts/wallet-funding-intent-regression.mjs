import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const fail = (message) => { throw new Error(message); };
const assertIncludes = (source, text, message) => {
  if (!source.includes(text)) fail(message || `Missing required funding guard: ${text}`);
};

const migration = read('supabase/migrations/20261022133000_reject_nonpending_wallet_funding_intents.sql');
const start = migration.toLowerCase().indexOf('create or replace function public.credit_wallet_funding');
if (start < 0) fail('Missing hardened wallet funding function');
const functionBody = migration.slice(start, migration.toLowerCase().indexOf('revoke all on function', start));

assertIncludes(functionBody, 'FOR UPDATE', 'Funding intent must be locked during credit');
assertIncludes(functionBody, "v_intent.status = 'credited'", 'Already-credited intents must remain idempotent');
assertIncludes(functionBody, "v_intent.status <> 'pending'", 'Rejected/non-pending intents must not be credited');
assertIncludes(functionBody, "RAISE EXCEPTION 'Funding intent is not eligible for credit'", 'Ineligible funding status must fail closed');
assertIncludes(functionBody, 'v_intent.user_id <> auth.uid()', 'Funding credit must be restricted to the intent owner');
assertIncludes(functionBody, 'v_intent.amount_kobo <> p_amount_kobo', 'Funding amount must match the locked intent');

const legacyLockdown = read('supabase/migrations/20261022140000_disable_legacy_wallet_funding_rpc.sql');
assertIncludes(legacyLockdown,
  'REVOKE ALL ON FUNCTION public.credit_wallet_funding(text, bigint)',
  'Legacy client-callable wallet credit RPC must be disabled');
assertIncludes(legacyLockdown, 'FROM PUBLIC, anon, authenticated, service_role',
  'No API role may execute the legacy credit RPC');
if (legacyLockdown.includes('GRANT EXECUTE ON FUNCTION public.credit_wallet_funding(text, bigint) TO authenticated')) {
  fail('Legacy wallet funding RPC must not be granted to authenticated users');
}

const serviceCredit = read('supabase/migrations/044_wallet_service_credit.sql');
assertIncludes(serviceCredit, 'GRANT EXECUTE ON FUNCTION public.credit_wallet_funding_for_user(uuid,text,bigint) TO service_role',
  'Verified wallet credits must use the service-role-only RPC');
assertIncludes(serviceCredit, 'FROM PUBLIC,anon,authenticated',
  'Service credit RPC must remain inaccessible to client roles');

const edge = read('supabase/functions/fund-wallet/index.ts');
assertIncludes(edge, 'api.paystack.co/transaction/verify/', 'Wallet credit flow must verify payment with Paystack');
assertIncludes(edge, 'credit_wallet_funding_for_user', 'Wallet credit flow must use the service-role-only RPC');
if (edge.includes('"credit_wallet_funding"')) fail('Edge function must not call the legacy client-callable RPC');
assertIncludes(edge, 'metadata.type !== "campus_wallet_funding"', 'Wallet funding must require the expected Paystack transaction type');
assertIncludes(edge, 'String(metadata.user_id || "") !== user.id', 'Wallet funding must require exact Paystack metadata ownership');
assertIncludes(edge, 'existing?.status === "rejected"', 'Rejected funding intents must remain rejected');
assertIncludes(edge, 'Number(existing.amount_kobo) !== amountKobo', 'Existing funding intent amounts must be immutable');
if (edge.includes('.upsert(')) fail('Funding verification must never overwrite an existing intent');

console.log('Wallet funding security regression checks passed (static SQL/source invariants).');
