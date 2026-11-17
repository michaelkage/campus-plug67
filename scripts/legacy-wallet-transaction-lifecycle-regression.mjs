import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const sql = fs.readFileSync(path.join(
  process.cwd(),
  'supabase/migrations/20261103170000_reconcile_legacy_wallet_transaction_lifecycle.sql',
), 'utf8');

assert.ok(sql.includes('DISABLE TRIGGER guard_transaction_sensitive_mutation'));
assert.ok(sql.includes('ENABLE TRIGGER guard_transaction_sensitive_mutation'));
assert.ok(sql.includes("set_config('app.escrow_transition', 'true', true)"));
assert.ok(sql.includes("t.payment_method = 'campus_wallet'"));
assert.ok(sql.includes("t.status = 'locked'"));
assert.ok(sql.includes("h.status = 'held'"));
assert.ok(sql.includes("l.status = 'reserved'"));
assert.ok(sql.includes("h.buyer_id = t.buyer_id"));
assert.ok(sql.includes("h.seller_id = t.seller_id"));
assert.ok(sql.includes("h.amount_kobo = t.amount"));
assert.ok(sql.includes("p.reason = 'Campus Wallet escrow hold'"));
assert.ok(sql.includes("p.amount = -t.amount"));
assert.ok(sql.includes("escrow_status = 'held'"));
assert.ok(sql.includes('COALESCE(t.locked_at, t.created_at)'));

console.log('Legacy wallet transaction lifecycle regression checks passed.');
