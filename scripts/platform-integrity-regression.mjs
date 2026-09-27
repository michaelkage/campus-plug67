import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const fail = (message) => { throw new Error(message); };

const migration = read('supabase/migrations/062_platform_integrity_ledger_observability.sql');
for (const required of [
  'create table if not exists public.payment_events',
  'unique (provider, event_id)',
  'create table if not exists public.financial_ledger',
  'create table if not exists public.transaction_state_transitions',
  'create table if not exists public.device_security_signals',
  'create table if not exists public.platform_observability_events',
  'record_transaction_state_transition',
  'record_financial_ledger_entry',
  'financial_ledger_balance',
  'alter table public.payment_events enable row level security',
  'alter table public.financial_ledger enable row level security',
  'alter table public.transaction_state_transitions enable row level security',
  'alter table public.device_security_signals enable row level security',
  'alter table public.platform_observability_events enable row level security',
]) if (!migration.includes(required)) fail(`Platform integrity migration missing: ${required}`);

const machine = read('src/lib/transactionStateMachine.ts');
for (const state of ['PENDING','LOCKED','MEETUP_INITIATED','RELEASE_REQUESTED','RELEASED','CANCELLED','DISPUTED','REFUNDED']) {
  if (!machine.includes(`'${state}'`)) fail(`Transaction state missing: ${state}`);
}

const config = read('supabase/config.toml');
if (!config.includes('project_id = "etwsfdovcgofhqseejjo"')) fail('Supabase project ref mismatch');

console.log('Platform integrity regression checks passed.');
