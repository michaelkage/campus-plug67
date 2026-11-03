import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const migration = fs.readFileSync(path.join(
  process.cwd(),
  'supabase/migrations/20261103150000_initialize_wallet_escrow_locked_state.sql',
), 'utf8');

const insertStart = migration.indexOf('INSERT INTO public.transactions');
const insertEnd = migration.indexOf('RETURNING * INTO v_tx', insertStart);
assert.ok(insertStart >= 0 && insertEnd > insertStart, 'Wallet transaction insert must exist');

const insert = migration.slice(insertStart, insertEnd);
assert.match(insert, /status,\s*locked_at,\s*escrow_status/i);
assert.match(insert, /'locked',\s*now\(\),\s*'held'/i);
assert.match(insert, /'campus_wallet'/i);
assert.ok(insert.includes("'approved_for_settlement'"));

console.log('Wallet escrow locked-state initialization regression checks passed.');
