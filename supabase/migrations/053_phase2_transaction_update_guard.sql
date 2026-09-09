-- Phase 2 follow-up: preserve legitimate transaction metadata writes while
-- preventing browser clients from changing escrow/payment authority fields.

DROP POLICY IF EXISTS "Parties update transaction metadata only" ON public.transactions;
CREATE POLICY "Parties update own transaction metadata"
  ON public.transactions
  FOR UPDATE
  TO authenticated
  USING (auth.uid() = buyer_id OR auth.uid() = seller_id)
  WITH CHECK (auth.uid() = buyer_id OR auth.uid() = seller_id);

CREATE OR REPLACE FUNCTION public.guard_transaction_sensitive_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.role() = 'service_role' THEN
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.buyer_id IS DISTINCT FROM OLD.buyer_id
     OR NEW.seller_id IS DISTINCT FROM OLD.seller_id
     OR NEW.listing_id IS DISTINCT FROM OLD.listing_id
     OR NEW.amount IS DISTINCT FROM OLD.amount
     OR NEW.status IS DISTINCT FROM OLD.status
     OR NEW.qr_secret IS DISTINCT FROM OLD.qr_secret
     OR NEW.release_code IS DISTINCT FROM OLD.release_code
     OR NEW.paystack_ref IS DISTINCT FROM OLD.paystack_ref
     OR NEW.payment_verified IS DISTINCT FROM OLD.payment_verified
     OR NEW.escrow_status IS DISTINCT FROM OLD.escrow_status
     OR NEW.locked_at IS DISTINCT FROM OLD.locked_at
     OR NEW.released_at IS DISTINCT FROM OLD.released_at
     OR NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at
     OR NEW.completed_at IS DISTINCT FROM OLD.completed_at
     OR NEW.released_at IS DISTINCT FROM OLD.released_at
     OR NEW.release_requested_at IS DISTINCT FROM OLD.release_requested_at
     OR NEW.auto_release_at IS DISTINCT FROM OLD.auto_release_at
     OR NEW.disputed_at IS DISTINCT FROM OLD.disputed_at
     OR NEW.dispute_reason IS DISTINCT FROM OLD.dispute_reason
  THEN
    RAISE EXCEPTION 'Protected transaction fields are server-managed';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_transaction_sensitive_mutation ON public.transactions;
CREATE TRIGGER guard_transaction_sensitive_mutation
BEFORE UPDATE ON public.transactions
FOR EACH ROW
EXECUTE FUNCTION public.guard_transaction_sensitive_mutation();

COMMENT ON FUNCTION public.guard_transaction_sensitive_mutation()
  IS 'Allows client transaction metadata updates while protecting escrow, payment, ownership, amount, and state-transition fields.';
