-- Campus Plug v6.10 security hardening.
-- Append-only: do not edit older migrations.

-- Server-derived security signals. Browser fingerprints remain correlation-only.
ALTER TABLE public.user_security
  ADD COLUMN IF NOT EXISTS server_fingerprint text,
  ADD COLUMN IF NOT EXISTS risk_score integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_risk_check_at timestamptz;
CREATE INDEX IF NOT EXISTS user_security_server_fingerprint_idx
  ON public.user_security(server_fingerprint);

ALTER TABLE public.banned_devices
  ADD COLUMN IF NOT EXISTS server_fingerprint text,
  ADD COLUMN IF NOT EXISTS ip_prefix cidr,
  ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true;
CREATE INDEX IF NOT EXISTS banned_devices_server_fingerprint_idx
  ON public.banned_devices(server_fingerprint) WHERE active;
CREATE INDEX IF NOT EXISTS banned_devices_ip_prefix_idx
  ON public.banned_devices(ip_prefix) WHERE active AND ip_prefix IS NOT NULL;

-- Browser EXIF is forgeable and must never be treated as proof of presence.
ALTER TABLE public.listing_exif_flags
  ADD COLUMN IF NOT EXISTS verification_source text NOT NULL DEFAULT 'client_advisory',
  ADD COLUMN IF NOT EXISTS verified_at timestamptz;
ALTER TABLE public.listing_exif_flags
  DROP CONSTRAINT IF EXISTS listing_exif_flags_verification_source_check;
ALTER TABLE public.listing_exif_flags
  ADD CONSTRAINT listing_exif_flags_verification_source_check
  CHECK (verification_source IN ('client_advisory','server_verified'));
UPDATE public.listing_exif_flags
SET verification_source='client_advisory'
WHERE verification_source IS NULL;

-- Only server-verified metadata can grant the metadata PlugScore bonus.
CREATE OR REPLACE FUNCTION public.update_plugscore_on_event()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF TG_TABLE_NAME = 'listing_exif_flags' THEN
    IF NEW.verification_source = 'server_verified'
       AND NOT NEW.gps_mismatch
       AND NOT NEW.timestamp_flag THEN
      UPDATE public.profiles
      SET plug_score = least(COALESCE(plug_score,0) + 10, 1000)
      WHERE id = (SELECT seller_id FROM public.listings WHERE id = NEW.listing_id);
      UPDATE public.listings SET metadata_verified=true WHERE id=NEW.listing_id;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME = 'transactions' THEN
    IF NEW.status='released' AND OLD.status!='released' THEN
      UPDATE public.profiles
      SET plug_score=least(COALESCE(plug_score,0)+50,1000)
      WHERE id=NEW.seller_id;
    END IF;
    RETURN NEW;
  END IF;
  RETURN NEW;
END; $$;

-- Ledger payout idempotency. A retried release can never create a second payout.
CREATE UNIQUE INDEX IF NOT EXISTS plug_credit_ledger_escrow_reference_uidx
  ON public.plug_credit_ledger(reference_id, reason)
  WHERE reason IN ('Escrow release','Escrow auto-release','Escrow refund');

-- Authoritative escrow state machine. The transaction row lock serializes all
-- competing user/webhook/cron actions before the state transition and payout.
CREATE OR REPLACE FUNCTION public.process_escrow_action(
  p_transaction_id uuid,p_action text,p_qr_secret text DEFAULT NULL,p_reason text DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  tx public.transactions%ROWTYPE;
  actor uuid:=auth.uid();
  privileged boolean:=(auth.role()='service_role');
  previous_status text;
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

-- PostgreSQL already serializes UPDATEs on the same pool row. Keep the capacity
-- predicate inside that UPDATE and return a deterministic conflict reason.
CREATE OR REPLACE FUNCTION public.atomic_pool_join(p_pool_id uuid,p_user_id uuid,p_ref text)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE pool record; reason text;
BEGIN
  UPDATE public.study_pools
  SET current_count=current_count+1,
      participants=array_append(participants,p_user_id),
      payment_refs=array_append(payment_refs,p_ref)
  WHERE id=p_pool_id AND status='open' AND current_count<max_capacity
    AND expires_at>now()
    AND NOT (p_user_id=ANY(COALESCE(participants,ARRAY[]::uuid[])))
  RETURNING current_count,max_capacity,title,organizer_id,university,unit_price INTO pool;

  IF FOUND THEN RETURN json_build_object('success',true,'pool',row_to_json(pool)); END IF;

  SELECT CASE
    WHEN NOT EXISTS(SELECT 1 FROM public.study_pools WHERE id=p_pool_id) THEN 'pool_not_found'
    WHEN (SELECT status FROM public.study_pools WHERE id=p_pool_id)<>'open' THEN 'pool_closed'
    WHEN (SELECT current_count>=max_capacity FROM public.study_pools WHERE id=p_pool_id) THEN 'pool_full'
    WHEN (SELECT expires_at<=now() FROM public.study_pools WHERE id=p_pool_id) THEN 'pool_expired'
    WHEN (SELECT p_user_id=ANY(COALESCE(participants,ARRAY[]::uuid[])) FROM public.study_pools WHERE id=p_pool_id) THEN 'already_joined'
    ELSE 'join_conflict'
  END INTO reason;
  RETURN json_build_object('success',false,'reason',reason);
END; $$;
REVOKE ALL ON FUNCTION public.atomic_pool_join(uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.atomic_pool_join(uuid,uuid,text) TO authenticated,service_role;
