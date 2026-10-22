-- Defense in depth: one wallet ledger effect per reference and operation.
-- The funding reference_id is the UUID wallet_funding_intents.id, not Paystack's text reference.
CREATE UNIQUE INDEX IF NOT EXISTS plug_credit_ledger_wallet_reference_uidx
  ON public.plug_credit_ledger(reference_id, reason)
  WHERE reason IN (
    'Campus Wallet funding',
    'Campus Wallet escrow hold',
    'Campus Wallet micro-escrow release',
    'Campus Wallet micro-escrow refund'
  );

COMMENT ON INDEX public.plug_credit_ledger_wallet_reference_uidx IS
  'Prevents duplicate wallet funding, escrow holds, releases, or refunds for the same reference and operation.';
