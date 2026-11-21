-- Keep the legacy completed terminal value readable while the current
-- lifecycle uses released for escrow resolution and payout_status for bank
-- settlement. The client state machine already treats completed as terminal.

ALTER TABLE public.transactions
  DROP CONSTRAINT IF EXISTS transactions_status_v69_check;

ALTER TABLE public.transactions
  ADD CONSTRAINT transactions_status_v70_check
  CHECK (status IN (
    'pending',
    'locked',
    'meetup_initiated',
    'release_requested',
    'disputed',
    'released',
    'cancelled',
    'completed'
  ));

COMMENT ON CONSTRAINT transactions_status_v70_check ON public.transactions IS
  'Includes legacy completed as a terminal compatibility state; current escrow resolution uses released and bank settlement is tracked separately by payout_status.';
