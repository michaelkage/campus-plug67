-- Campus Plug v67 - Production Escrow Reconciliation Triggers
CREATE OR REPLACE FUNCTION public.reconcile_student_escrow()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'completed' AND OLD.status != 'completed' THEN
    INSERT INTO public.plug_credit_ledger (user_id, amount, reason, reference_id)
    VALUES (NEW.seller_id, NEW.amount, 'Escrow payout for transaction #' || NEW.id, NEW.id);
    NEW.released_at := NOW();
  ELSIF NEW.status = 'cancelled' AND OLD.status != 'cancelled' THEN
    INSERT INTO public.plug_credit_ledger (user_id, amount, reason, reference_id)
    VALUES (NEW.buyer_id, NEW.amount, 'Refund for cancelled transaction #' || NEW.id, NEW.id);
    NEW.cancelled_at := NOW();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trigger_reconcile_escrow ON public.transactions;
CREATE TRIGGER trigger_reconcile_escrow
BEFORE UPDATE OF status ON public.transactions
FOR EACH ROW EXECUTE FUNCTION public.reconcile_student_escrow();
