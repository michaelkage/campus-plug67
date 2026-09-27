CREATE OR REPLACE FUNCTION public.guard_transaction_client_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public
AS $$
BEGIN
  IF auth.role() = 'service_role' OR current_setting('app.escrow_transition', true) = 'true' THEN
    RETURN NEW;
  END IF;
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
  THEN RAISE EXCEPTION 'Protected transaction fields can only be changed by the escrow service'; END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.cancel_pending_transaction(p_transaction_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE actor uuid:=auth.uid(); tx public.transactions%ROWTYPE;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  SELECT * INTO tx FROM public.transactions WHERE id=p_transaction_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Transaction not found'; END IF;
  IF tx.buyer_id<>actor THEN RAISE EXCEPTION 'Only the buyer can cancel payment'; END IF;
  IF tx.status<>'pending' THEN RAISE EXCEPTION 'Only pending payments can be cancelled'; END IF;
  PERFORM set_config('app.escrow_transition','true',true);
  UPDATE public.transactions SET status='cancelled',cancelled_at=now() WHERE id=tx.id;
  RETURN jsonb_build_object('success',true,'transaction_id',tx.id);
END;
$$;

CREATE OR REPLACE FUNCTION public.process_escrow_action(p_transaction_id uuid,p_action text,p_qr_secret text DEFAULT NULL,p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE tx public.transactions%ROWTYPE; actor uuid:=auth.uid(); privileged boolean:=(auth.role()='service_role');
BEGIN
  IF actor IS NULL AND NOT privileged THEN RAISE EXCEPTION 'Authentication required'; END IF;
  SELECT * INTO tx FROM public.transactions WHERE id=p_transaction_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Transaction not found'; END IF;
  IF NOT privileged AND actor<>tx.buyer_id AND actor<>tx.seller_id THEN RAISE EXCEPTION 'Not authorized for this transaction'; END IF;
  PERFORM set_config('app.escrow_transition','true',true);
  CASE p_action
    WHEN 'initiate_meetup' THEN
      IF privileged OR actor<>tx.seller_id THEN RAISE EXCEPTION 'Only the seller can initiate the meetup'; END IF;
      IF tx.status<>'locked' THEN RAISE EXCEPTION 'Meetup can only start from locked state'; END IF;
      UPDATE public.transactions SET status='meetup_initiated',meetup_initiated_at=COALESCE(meetup_initiated_at,now()) WHERE id=tx.id;
    WHEN 'request_release' THEN
      IF privileged OR actor<>tx.seller_id THEN RAISE EXCEPTION 'Only the seller can request release'; END IF;
      IF tx.status<>'meetup_initiated' THEN RAISE EXCEPTION 'Release can only be requested after meetup initiation'; END IF;
      IF tx.meetup_initiated_at IS NULL OR tx.meetup_initiated_at>now()-interval '24 hours' THEN RAISE EXCEPTION '24-hour release gate has not elapsed'; END IF;
      UPDATE public.transactions SET status='release_requested',release_requested_at=COALESCE(release_requested_at,now()),auto_release_at=now()+interval '48 hours' WHERE id=tx.id;
    WHEN 'release' THEN
      IF privileged OR actor<>tx.buyer_id THEN RAISE EXCEPTION 'Only the buyer can release escrow'; END IF;
      IF tx.status<>'meetup_initiated' THEN RAISE EXCEPTION 'Escrow is not ready for buyer release'; END IF;
      IF p_qr_secret IS NULL OR p_qr_secret<>COALESCE(tx.qr_secret,tx.release_code) THEN RAISE EXCEPTION 'Invalid release credential'; END IF;
      UPDATE public.transactions SET status='released',released_at=now(),completed_at=now() WHERE id=tx.id;
      INSERT INTO public.plug_credit_ledger(user_id,amount,reason,reference_id) VALUES(tx.seller_id,tx.amount,'Escrow release',tx.id) ON CONFLICT DO NOTHING;
    WHEN 'dispute' THEN
      IF privileged OR actor<>tx.buyer_id THEN RAISE EXCEPTION 'Only the buyer can dispute'; END IF;
      IF tx.status<>'release_requested' THEN RAISE EXCEPTION 'Transaction is not in the dispute window'; END IF;
      IF tx.auto_release_at IS NOT NULL AND tx.auto_release_at<=now() THEN RAISE EXCEPTION 'Dispute window has expired'; END IF;
      IF p_reason IS NULL OR length(trim(p_reason))<20 THEN RAISE EXCEPTION 'Dispute reason must be at least 20 characters'; END IF;
      UPDATE public.transactions SET status='disputed',disputed_at=now(),dispute_reason=trim(p_reason) WHERE id=tx.id;
    WHEN 'refund' THEN
      IF NOT privileged THEN RAISE EXCEPTION 'Refund is an administrative action'; END IF;
      IF tx.status NOT IN('locked','meetup_initiated','release_requested','disputed') THEN RAISE EXCEPTION 'Transaction cannot be refunded'; END IF;
      UPDATE public.transactions SET status='cancelled',cancelled_at=now() WHERE id=tx.id;
      INSERT INTO public.plug_credit_ledger(user_id,amount,reason,reference_id) VALUES(tx.buyer_id,tx.amount,'Escrow refund',tx.id) ON CONFLICT DO NOTHING;
      UPDATE public.listings SET status='active',updated_at=now() WHERE id=tx.listing_id AND status='sold';
    WHEN 'auto_release' THEN
      IF NOT privileged THEN RAISE EXCEPTION 'Auto-release is service-only'; END IF;
      IF tx.status<>'release_requested' OR tx.auto_release_at IS NULL OR tx.auto_release_at>now() THEN RAISE EXCEPTION 'Transaction is not due for auto-release'; END IF;
      UPDATE public.transactions SET status='released',released_at=now(),completed_at=now() WHERE id=tx.id;
      INSERT INTO public.plug_credit_ledger(user_id,amount,reason,reference_id) VALUES(tx.seller_id,tx.amount,'Escrow auto-release',tx.id) ON CONFLICT DO NOTHING;
    ELSE RAISE EXCEPTION 'Invalid escrow action: %',p_action;
  END CASE;
  INSERT INTO public.audit_logs(user_id,entity_type,entity_id,action,metadata) VALUES(COALESCE(actor,tx.seller_id),'transaction',tx.id,'escrow_'||p_action,jsonb_build_object('previous_status',tx.status));
  RETURN jsonb_build_object('success',true,'transaction_id',tx.id,'action',p_action);
END; $$;

CREATE OR REPLACE FUNCTION public.process_paystack_success(p_webhook_id text,p_event_type text,p_reference text,p_amount bigint,p_transaction_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE inserted_count int; webhook_row public.processed_webhooks%ROWTYPE; tx public.transactions%ROWTYPE;
BEGIN
  INSERT INTO public.processed_webhooks(webhook_id,event_type,processed) VALUES(p_webhook_id,p_event_type,false) ON CONFLICT(webhook_id) DO NOTHING;
  GET DIAGNOSTICS inserted_count=ROW_COUNT;
  IF inserted_count=0 THEN
    SELECT * INTO webhook_row FROM public.processed_webhooks WHERE webhook_id=p_webhook_id FOR UPDATE;
    IF webhook_row.processed THEN RETURN jsonb_build_object('success',true,'duplicate',true); END IF;
  END IF;
  IF p_transaction_id IS NULL THEN RAISE EXCEPTION 'Payment missing transaction_id'; END IF;
  SELECT * INTO tx FROM public.transactions WHERE id=p_transaction_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Transaction not found for payment'; END IF;
  IF tx.paystack_ref IS DISTINCT FROM p_reference THEN RAISE EXCEPTION 'Paystack reference mismatch'; END IF;
  IF tx.amount<>p_amount THEN RAISE EXCEPTION 'Paystack amount mismatch'; END IF;
  IF tx.status<>'pending' THEN RAISE EXCEPTION 'Transaction is not awaiting payment'; END IF;
  PERFORM set_config('app.escrow_transition','true',true);
  UPDATE public.transactions SET status='locked',payment_verified=true,locked_at=now() WHERE id=tx.id;
  UPDATE public.listings SET status='sold',updated_at=now() WHERE id=tx.listing_id AND status='active';
  UPDATE public.processed_webhooks SET processed=true WHERE webhook_id=p_webhook_id;
  RETURN jsonb_build_object('success',true,'duplicate',false,'transaction_id',tx.id);
END; $$;

REVOKE ALL ON FUNCTION public.cancel_pending_transaction(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_pending_transaction(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.process_escrow_action(uuid,text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.process_escrow_action(uuid,text,text,text) TO authenticated,service_role;
REVOKE ALL ON FUNCTION public.process_paystack_success(text,text,text,bigint,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.process_paystack_success(text,text,text,bigint,uuid) TO service_role;