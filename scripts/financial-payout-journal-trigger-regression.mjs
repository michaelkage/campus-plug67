import fs from 'node:fs';
const migration = fs.readFileSync('supabase/migrations/20261121120000_wire_seller_payouts_to_financial_journal.sql','utf8');
for (const invariant of [
  'sync_seller_payout_to_financial_journal',
  "to_regprocedure('public.post_seller_payout_journal_event(uuid,text,bigint,text)')",
  "NEW.status = 'success'",
  "NEW.status = 'reversed'",
  "OLD.status = 'success'",
  'AFTER INSERT ON public.seller_payout_transfers',
  'AFTER UPDATE OF status ON public.seller_payout_transfers',
  'seller_payout_financial_journal_insert',
  'seller_payout_financial_journal_update',
  'NEW.transaction_id,NEW.reference,NEW.amount_kobo',
]) {
  if (!migration.includes(invariant)) throw new Error(`Seller payout journal integration missing invariant: ${invariant}`);
}
console.log('Seller payout journal trigger regression checks passed.');
