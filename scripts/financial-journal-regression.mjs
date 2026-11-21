import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const fail = (message) => { throw new Error(message); };

const migration = read('supabase/migrations/20261121140000_create_double_entry_financial_journal.sql');
for (const required of [
  'CREATE TABLE IF NOT EXISTS public.financial_accounts',
  'CREATE TABLE IF NOT EXISTS public.financial_journal_transactions',
  'CREATE TABLE IF NOT EXISTS public.financial_journal_entries',
  "(account_type IN ('asset','expense') AND normal_balance='debit')",
  "(account_type IN ('liability','equity','revenue') AND normal_balance='credit')",
  'exists with an incompatible type or normal balance',
  'CHECK ((debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0))',
  'financial_journal_transactions_append_only',
  'financial_journal_entries_append_only',
  'financial_accounts_identity_guard',
  'jsonb_array_length(p_lines) < 2',
  'v_total_debit IS DISTINCT FROM v_total_credit',
  'A balanced journal must affect at least two distinct accounts',
  'Journal idempotency key reused with a different financial payload',
  'liability.user_wallet',
  'liability.escrow',
  'liability.seller_payable',
  'asset.paystack_clearing',
  'asset.seller_recovery',
  'Campus Wallet funding',
  'Campus Wallet escrow hold',
  'Campus Wallet micro-escrow release',
  'Campus Wallet micro-escrow refund',
  'Campus Plug gear rental escrow hold',
  'Gear rental fee released after return inspection',
  'Gear rental security deposit returned',
  'Gear rental cancellation refund',
  'Gear rental dispute settlement',
  'Gear rental dispute settlement refund',
  'post_paystack_transaction_journal_event',
  'paystack-escrow-funded:',
  'paystack-escrow-released:',
  'paystack-escrow-refunded:',
  'post_seller_payout_journal_event',
  'paystack-payout:',
  'Campus Wallet escrow hold',
  'Campus Wallet micro-escrow release',
  'Campus Wallet micro-escrow refund',
  'financial_journal_trial_balance',
  'financial_account_balances',
  'REVOKE ALL ON public.financial_accounts',
  'REVOKE ALL ON FUNCTION public.post_seller_payout_journal_event(uuid,text,bigint,text)\n  FROM PUBLIC, anon, authenticated, service_role',
  'DO $backfill$',
]) if (!migration.includes(required)) fail(`Double-entry journal migration missing invariant: ${required}`);

if (migration.includes("'payout_status',p_transaction.payout_status") || migration.includes("'refund_status',p_transaction.refund_status")) {
  fail('Transaction journal idempotency metadata must not contain mutable lifecycle fields');
}
for (const required of [
  "WHERE idempotency_key = 'paystack-escrow-refunded:' || p_transaction.id::text",
  'Refund classification is a point-in-time decision',
]) if (!migration.includes(required)) fail(`Refund journal idempotency invariant missing: ${required}`);

const audit = read('supabase/audits/financial-journal-reconciliation-readonly.sql');
for (const required of [
  'FROM public.financial_journal_transactions',
  'COALESCE(sum(e.debit),0)',
  "j.idempotency_key='financial-ledger:' || f.id::text",
  "'paystack-escrow-funded:' || t.id::text",
  "'paystack-escrow-released:' || t.id::text",
  "'paystack-escrow-refunded:' || t.id::text",
  "p.status IN ('success','reversed')",
  'missing_reversal_posting',
  'unposted_rows',
  'difference_kobo',
  'financial_journal_trial_balance',
]) if (!audit.includes(required)) fail(`Financial journal audit missing check: ${required}`);

const databaseTest = read('supabase/tests/financial_journal.test.sql');
for (const required of [
  'SELECT plan(33)',
  'paystack-escrow-funded:',
  'paystack-escrow-released:',
  'paystack-escrow-refunded:',
  'paystack-payout:',
  'financial_journal_trial_balance',
  'Journal entry history cannot be edited',
  'Unbalanced journal postings are rejected before commit',
  'A repeated idempotency key cannot post a different journal payload',
  'Refund before payout consumes the seller payable',
  'Late payout success after refund is recognized as a seller recovery receivable',
  'Late payout reversal clears the recovery receivable',
  'Service role cannot bypass the PlugCredit ledger trigger',
  'Service role cannot post arbitrary double-entry journal transactions',
  'Service role cannot bypass the trusted PlugCredit-to-ledger writer',
]) if (!databaseTest.includes(required)) fail(`Financial journal database test missing coverage: ${required}`);

console.log('Double-entry financial journal regression checks passed.');
