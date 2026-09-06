-- Campus Plug v6.11: panic QR credential for duress activation.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS duress_qr_token_hash text;

CREATE OR REPLACE FUNCTION public.rotate_duress_qr_token()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE actor uuid:=auth.uid(); token text;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  token:=encode(gen_random_bytes(24),'hex');
  UPDATE public.profiles SET duress_qr_token_hash=crypt(token,gen_salt('bf',10)) WHERE id=actor;
  RETURN jsonb_build_object('success',true,'token',token);
END; $$;
REVOKE ALL ON FUNCTION public.rotate_duress_qr_token() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.rotate_duress_qr_token() TO authenticated;

CREATE OR REPLACE FUNCTION public.activate_duress(p_transaction_id uuid,p_code text DEFAULT NULL,p_panic_token text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE actor uuid:=auth.uid(); tx public.transactions%ROWTYPE; counterparty uuid; fp text; alert_id uuid; valid_credential boolean:=false;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  SELECT * INTO tx FROM public.transactions WHERE id=p_transaction_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Transaction not found'; END IF;
  IF actor<>tx.seller_id AND actor<>tx.buyer_id THEN RAISE EXCEPTION 'Not authorized for this transaction'; END IF;
  IF tx.status NOT IN ('locked','meetup_initiated','release_requested') THEN RAISE EXCEPTION 'Transaction is not active'; END IF;
  IF COALESCE((tx.metadata->>'duress_active')::boolean,false) THEN RETURN jsonb_build_object('success',true,'already_active',true,'transaction_id',tx.id); END IF;

  IF p_code IS NOT NULL THEN
    SELECT crypt(p_code,duress_code_hash)=duress_code_hash INTO valid_credential FROM public.profiles WHERE id=actor AND duress_code_hash IS NOT NULL;
  END IF;
  IF NOT valid_credential AND p_panic_token IS NOT NULL THEN
    SELECT crypt(p_panic_token,duress_qr_token_hash)=duress_qr_token_hash INTO valid_credential FROM public.profiles WHERE id=actor AND duress_qr_token_hash IS NOT NULL;
  END IF;
  IF NOT COALESCE(valid_credential,false) THEN RAISE EXCEPTION 'Invalid duress credential'; END IF;

  counterparty:=CASE WHEN actor=tx.seller_id THEN tx.buyer_id ELSE tx.seller_id END;
  SELECT server_fingerprint INTO fp FROM public.user_security WHERE user_id=counterparty ORDER BY created_at DESC NULLS LAST LIMIT 1;
  INSERT INTO public.campus_security_alerts(transaction_id,reporter_id,counterparty_id,counterparty_server_fingerprint,university,metadata)
  VALUES(tx.id,actor,counterparty,fp,(SELECT university FROM public.profiles WHERE id=actor),jsonb_build_object('reason',CASE WHEN p_panic_token IS NOT NULL THEN 'panic_qr' ELSE 'duress_code' END,'escrow_status',tx.status))
  RETURNING id INTO alert_id;
  UPDATE public.transactions SET escrow_status='frozen',duress_triggered_at=now(),duress_triggered_by=actor,duress_alert_id=alert_id,metadata=COALESCE(metadata,'{}'::jsonb)||jsonb_build_object('duress_active',true,'duress_alert_id',alert_id) WHERE id=tx.id;
  INSERT INTO public.audit_logs(user_id,entity_type,entity_id,action,metadata) VALUES(actor,'transaction',tx.id,'escrow_duress',jsonb_build_object('alert_id',alert_id,'counterparty_id',counterparty));
  RETURN jsonb_build_object('success',true,'frozen',true,'alert_id',alert_id,'transaction_id',tx.id);
END; $$;
REVOKE ALL ON FUNCTION public.activate_duress(uuid,text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.activate_duress(uuid,text,text) TO authenticated;
