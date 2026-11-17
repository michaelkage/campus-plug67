-- Migration 043: durable payout-pending state and wallet-hold reconciliation.

CREATE OR REPLACE FUNCTION public.sync_wallet_hold_and_payout_state()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF NEW.status = 'released' AND OLD.status IS DISTINCT FROM 'released' THEN
    IF NEW.payment_method = 'campus_wallet' THEN
      UPDATE public.transactions SET payout_status='paid' WHERE id=NEW.id;
      UPDATE public.wallet_escrow_holds SET status='released',resolved_at=COALESCE(resolved_at,now()) WHERE transaction_id=NEW.id AND status='held';
    ELSE
      UPDATE public.transactions
      SET payout_status='approved_for_settlement', payout_approved_at=COALESCE(payout_approved_at,now())
      WHERE id=NEW.id AND COALESCE(payout_status,'not_applicable') <> 'paid';
    END IF;
  ELSIF NEW.status = 'cancelled' AND OLD.status IS DISTINCT FROM 'cancelled' AND NEW.payment_method = 'campus_wallet' THEN
    UPDATE public.wallet_escrow_holds SET status='refunded',resolved_at=COALESCE(resolved_at,now()) WHERE transaction_id=NEW.id AND status='held';
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_wallet_payout_state ON public.transactions;
CREATE TRIGGER trg_wallet_payout_state
AFTER UPDATE OF status ON public.transactions
FOR EACH ROW EXECUTE FUNCTION public.sync_wallet_hold_and_payout_state();

-- A payout marked approved is not a failure and must remain auditable until the
-- settlement worker/provider confirms success or records a real failure.
CREATE INDEX IF NOT EXISTS transactions_approved_settlement_idx
  ON public.transactions(payout_approved_at)
  WHERE payout_status='approved_for_settlement';
