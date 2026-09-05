-- Campus Plug v6.9 security/consistency hardening.
-- Append-only migration: existing deployed migrations are intentionally not rewritten.

-- Canonical transaction fields used by the current application.
ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS release_code text,
  ADD COLUMN IF NOT EXISTS escrow_status text DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS meetup_latitude numeric,
  ADD COLUMN IF NOT EXISTS meetup_longitude numeric,
  ADD COLUMN IF NOT EXISTS meetup_time timestamptz,
  ADD COLUMN IF NOT EXISTS payment_method text,
  ADD COLUMN IF NOT EXISTS metadata jsonb DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();
UPDATE public.transactions SET release_code = qr_secret WHERE release_code IS NULL AND qr_secret IS NOT NULL;

DO $$ DECLARE c record; BEGIN
  FOR c IN SELECT conname FROM pg_constraint
    WHERE conrelid='public.transactions'::regclass AND contype='c'
      AND pg_get_constraintdef(oid) ILIKE '%status%'
  LOOP EXECUTE format('ALTER TABLE public.transactions DROP CONSTRAINT IF EXISTS %I', c.conname); END LOOP;
END $$;
ALTER TABLE public.transactions ADD CONSTRAINT transactions_status_v69_check
  CHECK (status IN ('pending','locked','meetup_initiated','release_requested','disputed','released','cancelled'));

UPDATE public.transactions SET escrow_status = CASE
  WHEN status='released' THEN 'released'
  WHEN status='cancelled' THEN 'refunded'
  WHEN status IN ('locked','meetup_initiated','release_requested','disputed') THEN 'held'
  ELSE 'pending' END;

CREATE OR REPLACE FUNCTION public.sync_transaction_escrow_fields()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  NEW.updated_at := now();
  IF NEW.status='pending' THEN NEW.escrow_status:='pending';
  ELSIF NEW.status IN ('locked','meetup_initiated','release_requested','disputed') THEN NEW.escrow_status:='held';
  ELSIF NEW.status='released' THEN NEW.escrow_status:='released'; NEW.released_at:=COALESCE(NEW.released_at,now()); NEW.completed_at:=COALESCE(NEW.completed_at,now());
  ELSIF NEW.status='cancelled' THEN NEW.escrow_status:='refunded'; NEW.cancelled_at:=COALESCE(NEW.cancelled_at,now()); END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS transaction_sync_escrow_fields ON public.transactions;
CREATE TRIGGER transaction_sync_escrow_fields BEFORE UPDATE OF status,escrow_status ON public.transactions
FOR EACH ROW EXECUTE FUNCTION public.sync_transaction_escrow_fields();
ALTER TABLE public.transactions DROP COLUMN IF EXISTS new_status;
DROP TRIGGER IF EXISTS trigger_reconcile_escrow ON public.transactions;

-- One live beacon per user; history remains append-only.
CREATE UNIQUE INDEX IF NOT EXISTS ticker_events_current_beacon_uidx
  ON public.ticker_events(user_id,event_type) WHERE event_type='beacon_current';

-- Wallet canonical field + compatibility mirror for old UI/schema versions.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS plug_credit_balance bigint DEFAULT 0,
  ADD COLUMN IF NOT EXISTS balance bigint DEFAULT 0;
DO $$ BEGIN
  UPDATE public.profiles SET plug_credit_balance=balance
  WHERE COALESCE(plug_credit_balance,0)=0 AND COALESCE(balance,0)<>0;
END $$;

CREATE OR REPLACE FUNCTION public.process_atomic_balance_update()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE current_bal bigint; new_bal bigint;
BEGIN
  SELECT COALESCE(plug_credit_balance,0) INTO current_bal FROM public.profiles WHERE id=NEW.user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Wallet owner does not exist'; END IF;
  new_bal := current_bal + NEW.amount;
  IF new_bal < 0 THEN RAISE EXCEPTION 'Insufficient PlugCredit balance'; END IF;
  UPDATE public.profiles SET plug_credit_balance=new_bal,balance=new_bal WHERE id=NEW.user_id;
  NEW.balance_after:=new_bal;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS trigger_atomic_balance ON public.plug_credit_ledger;
CREATE TRIGGER trigger_atomic_balance BEFORE INSERT ON public.plug_credit_ledger
FOR EACH ROW EXECUTE FUNCTION public.process_atomic_balance_update();

DROP POLICY IF EXISTS "System inserts ledger" ON public.plug_credit_ledger;
DROP POLICY IF EXISTS "Users insert ledger" ON public.plug_credit_ledger;
CREATE POLICY "Service role inserts ledger" ON public.plug_credit_ledger FOR INSERT TO service_role WITH CHECK(true);

CREATE OR REPLACE FUNCTION public.transfer_plug_credit(p_recipient_id uuid,p_amount bigint,p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE actor uuid:=auth.uid(); transfer_id uuid:=gen_random_uuid(); sender_balance bigint; recipient_balance bigint;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_recipient_id IS NULL OR p_recipient_id=actor THEN RAISE EXCEPTION 'Invalid recipient'; END IF;
  IF p_amount IS NULL OR p_amount<=0 THEN RAISE EXCEPTION 'Transfer amount must be positive'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.profiles WHERE id=p_recipient_id) THEN RAISE EXCEPTION 'Recipient not found'; END IF;
  PERFORM 1 FROM public.profiles WHERE id IN(actor,p_recipient_id) ORDER BY id FOR UPDATE;
  SELECT plug_credit_balance INTO sender_balance FROM public.profiles WHERE id=actor;
  SELECT plug_credit_balance INTO recipient_balance FROM public.profiles WHERE id=p_recipient_id;
  IF sender_balance<p_amount THEN RAISE EXCEPTION 'Insufficient PlugCredit balance'; END IF;
  INSERT INTO public.plug_credit_ledger(user_id,amount,reason,reference_id,balance_after) VALUES(actor,-p_amount,COALESCE(p_reason,'PlugCredit transfer'),transfer_id,0);
  INSERT INTO public.plug_credit_ledger(user_id,amount,reason,reference_id,balance_after) VALUES(p_recipient_id,p_amount,'PlugCredit transfer received',transfer_id,0);
  INSERT INTO public.audit_logs(user_id,entity_type,entity_id,action,metadata) VALUES(actor,'plug_credit_transfer',transfer_id,'transfer',jsonb_build_object('recipient_id',p_recipient_id,'amount',p_amount));
  RETURN jsonb_build_object('success',true,'transfer_id',transfer_id,'sender_balance',sender_balance-p_amount,'recipient_balance',recipient_balance+p_amount);
END; $$;
REVOKE ALL ON FUNCTION public.transfer_plug_credit(uuid,bigint,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.transfer_plug_credit(uuid,bigint,text) TO authenticated;

CREATE OR REPLACE FUNCTION public.payout_juror_incentive(p_juror_id uuid,p_amount integer DEFAULT 10000)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE new_bal bigint;
BEGIN
  IF p_amount<=0 THEN RAISE EXCEPTION 'Payout must be positive'; END IF;
  INSERT INTO public.plug_credit_ledger(user_id,amount,reason) VALUES(p_juror_id,p_amount,'jury_reward');
  SELECT plug_credit_balance INTO new_bal FROM public.profiles WHERE id=p_juror_id;
  RETURN new_bal;
END; $$;
REVOKE ALL ON FUNCTION public.payout_juror_incentive(uuid,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.payout_juror_incentive(uuid,integer) TO service_role;

-- Single authoritative escrow state transition API. User identity comes from JWT.
CREATE OR REPLACE FUNCTION public.process_escrow_action(p_transaction_id uuid,p_action text,p_qr_secret text DEFAULT NULL,p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE tx public.transactions%ROWTYPE; actor uuid:=auth.uid(); privileged boolean:=(auth.role()='service_role');
BEGIN
  IF actor IS NULL AND NOT privileged THEN RAISE EXCEPTION 'Authentication required'; END IF;
  SELECT * INTO tx FROM public.transactions WHERE id=p_transaction_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Transaction not found'; END IF;
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
      INSERT INTO public.plug_credit_ledger(user_id,amount,reason,reference_id) VALUES(tx.seller_id,tx.amount,'Escrow release',tx.id);
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
      INSERT INTO public.plug_credit_ledger(user_id,amount,reason,reference_id) VALUES(tx.buyer_id,tx.amount,'Escrow refund',tx.id);
    WHEN 'auto_release' THEN
      IF NOT privileged THEN RAISE EXCEPTION 'Auto-release is service-only'; END IF;
      IF tx.status<>'release_requested' OR tx.auto_release_at IS NULL OR tx.auto_release_at>now() THEN RAISE EXCEPTION 'Transaction is not due for auto-release'; END IF;
      UPDATE public.transactions SET status='released',released_at=now(),completed_at=now() WHERE id=tx.id;
      INSERT INTO public.plug_credit_ledger(user_id,amount,reason,reference_id) VALUES(tx.seller_id,tx.amount,'Escrow auto-release',tx.id);
    ELSE RAISE EXCEPTION 'Invalid escrow action: %',p_action;
  END CASE;
  INSERT INTO public.audit_logs(user_id,entity_type,entity_id,action,metadata) VALUES(COALESCE(actor,tx.seller_id),'transaction',tx.id,'escrow_'||p_action,jsonb_build_object('previous_status',tx.status));
  RETURN jsonb_build_object('success',true,'transaction_id',tx.id,'action',p_action);
END; $$;
REVOKE ALL ON FUNCTION public.process_escrow_action(uuid,text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.process_escrow_action(uuid,text,text,text) TO authenticated,service_role;

-- Atomic Paystack idempotency + amount/reference validation.
CREATE TABLE IF NOT EXISTS public.processed_webhooks(id uuid DEFAULT uuid_generate_v4() PRIMARY KEY,webhook_id text NOT NULL UNIQUE,event_type text NOT NULL,processed boolean DEFAULT false,created_at timestamptz DEFAULT now());
ALTER TABLE public.processed_webhooks ENABLE ROW LEVEL SECURITY;
CREATE OR REPLACE FUNCTION public.process_paystack_success(p_webhook_id text,p_event_type text,p_reference text,p_amount bigint,p_transaction_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE inserted_count int; tx public.transactions%ROWTYPE;
BEGIN
  INSERT INTO public.processed_webhooks(webhook_id,event_type,processed) VALUES(p_webhook_id,p_event_type,false) ON CONFLICT(webhook_id) DO NOTHING;
  GET DIAGNOSTICS inserted_count=ROW_COUNT;
  IF inserted_count=0 THEN RETURN jsonb_build_object('success',true,'duplicate',true); END IF;
  IF p_transaction_id IS NULL THEN RAISE EXCEPTION 'Payment missing transaction_id'; END IF;
  SELECT * INTO tx FROM public.transactions WHERE id=p_transaction_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Transaction not found for payment'; END IF;
  IF tx.paystack_ref IS DISTINCT FROM p_reference THEN RAISE EXCEPTION 'Paystack reference mismatch'; END IF;
  IF tx.amount<>p_amount THEN RAISE EXCEPTION 'Paystack amount mismatch'; END IF;
  IF tx.status<>'pending' THEN RAISE EXCEPTION 'Transaction is not awaiting payment'; END IF;
  UPDATE public.transactions SET status='locked',payment_verified=true,locked_at=now() WHERE id=tx.id;
  UPDATE public.processed_webhooks SET processed=true WHERE webhook_id=p_webhook_id;
  RETURN jsonb_build_object('success',true,'duplicate',false,'transaction_id',tx.id);
END; $$;
REVOKE ALL ON FUNCTION public.process_paystack_success(text,text,text,bigint,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.process_paystack_success(text,text,text,bigint,uuid) TO service_role;

-- Canonical allowed-domain naming. No blanket .edu fallback remains in the client.
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='allowed_domains' AND column_name='institution_name') THEN
    IF EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='allowed_domains' AND column_name='university') THEN
      ALTER TABLE public.allowed_domains RENAME COLUMN university TO institution_name;
    ELSE ALTER TABLE public.allowed_domains ADD COLUMN institution_name text; END IF;
  END IF;
END $$;
ALTER TABLE public.allowed_domains ADD COLUMN IF NOT EXISTS id uuid DEFAULT uuid_generate_v4(),ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();

-- Scanner persistence; plaintext chat is not retained here.
CREATE TABLE IF NOT EXISTS public.chat_scan_logs(id uuid DEFAULT uuid_generate_v4() PRIMARY KEY,message_id uuid REFERENCES public.messages(id) ON DELETE CASCADE NOT NULL,sender_id uuid REFERENCES public.profiles(id) ON DELETE CASCADE NOT NULL,receiver_id uuid REFERENCES public.profiles(id) ON DELETE CASCADE,chat_type text,flagged boolean NOT NULL DEFAULT false,flag_type text,confidence numeric DEFAULT 0,matched_patterns text,content_hash text NOT NULL,scanned_at timestamptz DEFAULT now());
ALTER TABLE public.chat_scan_logs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users insert chat scan logs" ON public.chat_scan_logs;
CREATE POLICY "Service inserts chat scan logs" ON public.chat_scan_logs FOR INSERT TO service_role WITH CHECK(true);
CREATE POLICY "Message parties read chat scan logs" ON public.chat_scan_logs FOR SELECT TO authenticated USING(auth.uid()=sender_id OR auth.uid()=receiver_id);
DROP POLICY IF EXISTS "Auth users log flags" ON public.chat_flag_log;
DROP POLICY IF EXISTS "Users can insert their own chat logs" ON public.chat_flag_log;
CREATE POLICY "Service inserts chat flags" ON public.chat_flag_log FOR INSERT TO service_role WITH CHECK(true);

-- Audit logs and privileged functions are server-authoritative.
DROP POLICY IF EXISTS "System inserts audit logs" ON public.audit_logs;
DROP POLICY IF EXISTS "System inserts audit" ON public.audit_logs;
CREATE POLICY "Service inserts audit logs" ON public.audit_logs FOR INSERT TO service_role WITH CHECK(true);
REVOKE ALL ON FUNCTION public.increment_config_counter(text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.increment_config_counter(text) TO service_role;
REVOKE ALL ON FUNCTION public.apply_dispute_penalty(uuid,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.apply_dispute_penalty(uuid,boolean) TO service_role;
REVOKE ALL ON FUNCTION public.reclaim_silent_jurors(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.reclaim_silent_jurors(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.provision_emergency_tokens(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.provision_emergency_tokens(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.cleanup_amber_confirmations() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_amber_confirmations() TO service_role;
ALTER FUNCTION public.increment_config_counter(text) SET search_path=public;
ALTER FUNCTION public.apply_dispute_penalty(uuid,boolean) SET search_path=public;
ALTER FUNCTION public.reclaim_silent_jurors(uuid) SET search_path=public;
ALTER FUNCTION public.provision_emergency_tokens(uuid) SET search_path=public;
ALTER FUNCTION public.cleanup_amber_confirmations() SET search_path=public;

-- Banned fingerprints are not public data.
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='banned_devices' AND column_name='device_fingerprint')
     AND EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='banned_devices' AND column_name='device_hash') THEN
    ALTER TABLE public.banned_devices RENAME COLUMN device_hash TO device_fingerprint;
  END IF;
END $$;
DROP POLICY IF EXISTS "Anyone can read banned devices" ON public.banned_devices;
CREATE POLICY "Service reads banned devices" ON public.banned_devices FOR SELECT TO service_role USING(true);

COMMENT ON COLUMN public.profiles.plug_credit_balance IS 'Canonical Campus Plug wallet balance in kobo. Mutate only through server-authoritative ledger RPCs.';
COMMENT ON TABLE public.wallets IS 'Legacy compatibility table; not used for Campus Plug wallet accounting.';
