-- Restore a refunded marketplace item to active inventory.
-- This is safe because refund is only permitted before escrow completion.
CREATE OR REPLACE FUNCTION public.process_escrow_action(p_transaction_id uuid,p_action text,p_qr_secret text DEFAULT NULL,p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  tx public.transactions%ROWTYPE;
  actor uuid:=auth.uid();
  privileged boolean:=(auth.role()='service_role');
  previous_status text;
  safe_zone record;
BEGIN
  IF actor IS NULL AND NOT privileged THEN RAISE EXCEPTION 'Authentication required'; END IF;
  SELECT * INTO tx FROM public.transactions WHERE id=p_transaction_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Transaction not found'; END IF;
  previous_status:=tx.status;
  IF NOT privileged AND actor<>tx.buyer_id AND actor<>tx.seller_id THEN RAISE EXCEPTION 'Not authorized for this transaction'; END IF;

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
      IF tx.buyer_lat IS NULL OR tx.buyer_lng IS NULL OR tx.buyer_location_captured_at IS NULL OR tx.buyer_location_captured_at < now()-interval '10 minutes' THEN
        RAISE EXCEPTION 'Safe Swap location is missing or stale';
      END IF;
      SELECT * INTO safe_zone FROM public.is_in_safe_swap_zone(tx.buyer_lat,tx.buyer_lng,(SELECT university FROM public.profiles WHERE id=tx.buyer_id)) LIMIT 1;
      IF NOT FOUND THEN RAISE EXCEPTION 'QR release is only allowed inside an approved 50m Safe Swap Zone'; END IF;
      UPDATE public.transactions SET status='released',released_at=now(),completed_at=now(),buyer_safe_zone_id=safe_zone.zone_id WHERE id=tx.id;
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

  INSERT INTO public.audit_logs(user_id,entity_type,entity_id,action,metadata)
  VALUES(COALESCE(actor,tx.seller_id),'transaction',tx.id,'escrow_'||p_action,jsonb_build_object('previous_status',previous_status));
  RETURN jsonb_build_object('success',true,'transaction_id',tx.id,'action',p_action);
END; $$;

REVOKE ALL ON FUNCTION public.process_escrow_action(uuid,text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.process_escrow_action(uuid,text,text,text) TO authenticated,service_role;