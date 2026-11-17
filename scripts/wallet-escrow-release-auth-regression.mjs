import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const migration = fs.readFileSync(path.join(
  process.cwd(),
  'supabase/migrations/20261103140000_require_buyer_confirmation_for_wallet_escrow_release.sql',
), 'utf8');

const releaseStart = migration.indexOf("IF p_action = 'release' THEN");
const buyerGuard = migration.indexOf("IF v_user <> v_hold.buyer_id THEN", releaseStart);
const denial = migration.indexOf("Only the buyer can release Campus Wallet escrow", buyerGuard);
const sellerCredit = migration.indexOf(
  "INSERT INTO public.plug_credit_ledger(user_id, amount, reason, reference_id)",
  releaseStart,
);

assert.ok(releaseStart >= 0, 'Wallet release branch must exist');
assert.ok(buyerGuard > releaseStart, 'Buyer authorization must be inside the release branch');
assert.ok(denial > buyerGuard, 'Seller release attempts must be rejected');
assert.ok(sellerCredit > denial, 'Seller payout must happen only after buyer authorization');
assert.ok(migration.includes('REVOKE ALL ON FUNCTION public.resolve_wallet_micro_escrow(uuid,text) FROM PUBLIC, anon'));
assert.ok(migration.includes('GRANT EXECUTE ON FUNCTION public.resolve_wallet_micro_escrow(uuid,text) TO authenticated'));

console.log('Wallet escrow release authorization regression checks passed.');
