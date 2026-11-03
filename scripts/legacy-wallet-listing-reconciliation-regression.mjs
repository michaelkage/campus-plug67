import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const sql = fs.readFileSync(path.join(
  process.cwd(),
  'supabase/migrations/20261103160000_reconcile_legacy_wallet_escrow_listing_reservations.sql',
), 'utf8');

assert.ok(sql.includes("SET status = 'reserved'"), 'Repair must reserve, not sell, the listing');
assert.ok(sql.includes("t.payment_method = 'campus_wallet'"));
assert.ok(sql.includes("t.status = 'locked'"));
assert.ok(sql.includes("h.status = 'held'"));
assert.ok(sql.includes('h.buyer_id = t.buyer_id'));
assert.ok(sql.includes('h.seller_id = t.seller_id'));
assert.ok(sql.includes('h.amount_kobo = t.amount'));
assert.ok(sql.includes("p.reason = 'Campus Wallet escrow hold'"));
assert.ok(sql.includes('p.amount = -t.amount'));
assert.ok(sql.includes('AND NOT EXISTS'), 'Repair must exclude a competing active transaction');
assert.ok(!/UPDATE public\\.(transactions|wallet_escrow_holds|plug_credit_ledger)/i.test(sql),
  'Repair must not mutate transaction state, escrow holds, or ledger balances');

console.log('Legacy wallet listing reconciliation regression checks passed.');
