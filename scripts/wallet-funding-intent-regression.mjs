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
assertIncludes(migration, 'REVOKE ALL ON FUNCTION public.credit_wallet_funding(text, bigint) FROM PUBLIC, anon',
  'Funding RPC must revoke PUBLIC/anon execution');
assertIncludes(migration, 'GRANT EXECUTE ON FUNCTION public.credit_wallet_funding(text, bigint) TO authenticated',
  'Funding RPC must remain available to authenticated users');

console.log('Wallet funding intent regression checks passed (static SQL invariants).');
