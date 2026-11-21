import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const fail = (message) => { throw new Error(message); };

const migration = read('supabase/migrations/20261121135000_mirror_plug_credit_to_financial_ledger.sql');
for (const required of [
  'CREATE OR REPLACE FUNCTION public.record_financial_ledger_entry',
  'ON CONFLICT (user_id, idempotency_key) DO NOTHING',
  'ledger idempotency key reused with a different financial payload',
  'CREATE TRIGGER financial_ledger_append_only_guard',
  'BEFORE UPDATE OR DELETE ON public.financial_ledger',
  'CREATE OR REPLACE FUNCTION public.mirror_plug_credit_ledger_to_financial_ledger',
  'AFTER INSERT ON public.plug_credit_ledger',
  "'plug-credit-ledger:' || NEW.id::text",
  'abs(NEW.amount)',
  'CASE WHEN NEW.amount > 0 THEN \'credit\' ELSE \'debit\' END',
  'DO $backfill$',
  'REVOKE ALL ON FUNCTION public.record_financial_ledger_entry(uuid,bigint,text,text,text,text,uuid,text,jsonb)\n  FROM PUBLIC, anon, authenticated, service_role',
]) if (!migration.includes(required)) fail(`Financial ledger migration missing invariant: ${required}`);

const audit = read('supabase/audits/financial-ledger-mirror-readonly.sql');
for (const required of [
  'Missing mirror rows',
  'Conflicting mirror payloads',
  'Orphan mirror rows',
  'missing_mirrors',
]) if (!audit.includes(required)) fail(`Financial ledger audit missing check: ${required}`);

console.log('Financial ledger mirror regression checks passed.');
