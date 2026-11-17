-- Migration 044: service-role wallet funding credit for verified Paystack callbacks.
CREATE OR REPLACE FUNCTION public.credit_wallet_funding_for_user(p_user_id uuid,p_reference text,p_amount_kobo bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_intent public.wallet_funding_intents%ROWTYPE;
BEGIN
  SELECT * INTO v_intent FROM public.wallet_funding_intents WHERE reference=p_reference FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Funding intent not found'; END IF;
  IF v_intent.user_id<>p_user_id OR v_intent.amount_kobo<>p_amount_kobo THEN RAISE EXCEPTION 'Funding intent mismatch'; END IF;
  IF v_intent.status='credited' THEN RETURN jsonb_build_object('success',true,'already_credited',true,'amount_kobo',p_amount_kobo); END IF;
  INSERT INTO public.plug_credit_ledger(user_id,amount,reason,reference_id) VALUES(p_user_id,p_amount_kobo,'Campus Wallet funding',p_reference);
  UPDATE public.wallet_funding_intents SET status='credited',credited_at=now() WHERE id=v_intent.id;
  RETURN jsonb_build_object('success',true,'amount_kobo',p_amount_kobo);
END; $$;
REVOKE ALL ON FUNCTION public.credit_wallet_funding_for_user(uuid,text,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.credit_wallet_funding_for_user(uuid,text,bigint) TO service_role;
