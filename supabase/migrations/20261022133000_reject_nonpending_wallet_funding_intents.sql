-- A rejected funding intent must never be credited by the authenticated RPC.
-- Reuse the existing intent lock and preserve idempotent handling for credited intents.

CREATE OR REPLACE FUNCTION public.credit_wallet_funding(p_reference text, p_amount_kobo bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_intent public.wallet_funding_intents%ROWTYPE;
BEGIN
  SELECT *
    INTO v_intent
    FROM public.wallet_funding_intents
   WHERE reference = p_reference
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Funding intent not found';
  END IF;

  IF v_intent.user_id <> auth.uid() THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  IF v_intent.amount_kobo <> p_amount_kobo THEN
    RAISE EXCEPTION 'Funding amount mismatch';
  END IF;

  IF v_intent.status = 'credited' THEN
    RETURN jsonb_build_object(
      'success', true,
      'already_credited', true,
      'amount_kobo', p_amount_kobo
    );
  END IF;

  IF v_intent.status <> 'pending' THEN
    RAISE EXCEPTION 'Funding intent is not eligible for credit';
  END IF;

  INSERT INTO public.plug_credit_ledger(user_id, amount, reason, reference_id)
  VALUES (v_intent.user_id, p_amount_kobo, 'Campus Wallet funding', p_reference);

  UPDATE public.wallet_funding_intents
     SET status = 'credited',
         credited_at = now()
   WHERE id = v_intent.id;

  RETURN jsonb_build_object('success', true, 'amount_kobo', p_amount_kobo);
END;
$$;

REVOKE ALL ON FUNCTION public.credit_wallet_funding(text, bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.credit_wallet_funding(text, bigint) TO authenticated;
