CREATE OR REPLACE FUNCTION public.cancel_pending_transaction(p_transaction_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public
AS $$
DECLARE actor uuid := auth.uid(); tx public.transactions%ROWTYPE;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  SELECT * INTO tx FROM public.transactions WHERE id=p_transaction_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Transaction not found'; END IF;
  IF tx.buyer_id <> actor THEN RAISE EXCEPTION 'Only the buyer can cancel payment'; END IF;
  IF tx.status <> 'pending' THEN RAISE EXCEPTION 'Only pending payments can be cancelled'; END IF;
  UPDATE public.transactions SET status='cancelled',cancelled_at=now() WHERE id=tx.id;
  RETURN jsonb_build_object('success',true,'transaction_id',tx.id);
END;
$$;

REVOKE ALL ON FUNCTION public.cancel_pending_transaction(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_pending_transaction(uuid) TO authenticated;

DROP POLICY IF EXISTS "Parties update own transaction metadata" ON public.transactions;
CREATE POLICY "Parties update safe transaction metadata" ON public.transactions
FOR UPDATE TO authenticated
USING (auth.uid() = buyer_id OR auth.uid() = seller_id)
WITH CHECK (auth.uid() = buyer_id OR auth.uid() = seller_id);

CREATE OR REPLACE FUNCTION public.guard_transaction_client_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public
AS $$
BEGIN
  IF auth.role() = 'service_role' THEN RETURN NEW; END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.listing_id IS DISTINCT FROM OLD.listing_id
    OR NEW.buyer_id IS DISTINCT FROM OLD.buyer_id
    OR NEW.seller_id IS DISTINCT FROM OLD.seller_id
    OR NEW.amount IS DISTINCT FROM OLD.amount
    OR NEW.status IS DISTINCT FROM OLD.status
    OR NEW.payment_verified IS DISTINCT FROM OLD.payment_verified
    OR NEW.paystack_ref IS DISTINCT FROM OLD.paystack_ref
    OR NEW.locked_at IS DISTINCT FROM OLD.locked_at
    OR NEW.meetup_initiated_at IS DISTINCT FROM OLD.meetup_initiated_at
    OR NEW.release_requested_at IS DISTINCT FROM OLD.release_requested_at
    OR NEW.released_at IS DISTINCT FROM OLD.released_at
    OR NEW.completed_at IS DISTINCT FROM OLD.completed_at
    OR NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at
    OR NEW.disputed_at IS DISTINCT FROM OLD.disputed_at
    OR NEW.auto_release_at IS DISTINCT FROM OLD.auto_release_at
    OR NEW.qr_secret IS DISTINCT FROM OLD.qr_secret
    OR NEW.release_code IS DISTINCT FROM OLD.release_code
  THEN
    RAISE EXCEPTION 'Protected transaction fields can only be changed by the escrow service';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS transactions_guard_client_update ON public.transactions;
CREATE TRIGGER transactions_guard_client_update
BEFORE UPDATE ON public.transactions
FOR EACH ROW EXECUTE FUNCTION public.guard_transaction_client_update();

REVOKE ALL ON FUNCTION public.guard_transaction_client_update() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.guard_transaction_client_update() TO authenticated,service_role;