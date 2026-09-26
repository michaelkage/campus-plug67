-- Harden Paystack webhook idempotency so failed processing can safely retry.
CREATE OR REPLACE FUNCTION public.process_paystack_success(p_webhook_id text,p_event_type text,p_reference text,p_amount bigint,p_transaction_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  inserted_count int;
  webhook_row public.processed_webhooks%ROWTYPE;
  tx public.transactions%ROWTYPE;
BEGIN
  INSERT INTO public.processed_webhooks(webhook_id,event_type,processed)
    VALUES(p_webhook_id,p_event_type,false)
    ON CONFLICT(webhook_id) DO NOTHING;
  GET DIAGNOSTICS inserted_count=ROW_COUNT;

  IF inserted_count=0 THEN
    SELECT * INTO webhook_row FROM public.processed_webhooks
      WHERE webhook_id=p_webhook_id FOR UPDATE;
    IF webhook_row.processed THEN
      RETURN jsonb_build_object('success',true,'duplicate',true);
    END IF;
  END IF;

  IF p_transaction_id IS NULL THEN RAISE EXCEPTION 'Payment missing transaction_id'; END IF;
  SELECT * INTO tx FROM public.transactions WHERE id=p_transaction_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Transaction not found for payment'; END IF;
  IF tx.paystack_ref IS DISTINCT FROM p_reference THEN RAISE EXCEPTION 'Paystack reference mismatch'; END IF;
  IF tx.amount<>p_amount THEN RAISE EXCEPTION 'Paystack amount mismatch'; END IF;
  IF tx.status<>'pending' THEN RAISE EXCEPTION 'Transaction is not awaiting payment'; END IF;

  UPDATE public.transactions
    SET status='locked',payment_verified=true,locked_at=now()
    WHERE id=tx.id;
  UPDATE public.processed_webhooks SET processed=true WHERE webhook_id=p_webhook_id;

  RETURN jsonb_build_object('success',true,'duplicate',false,'transaction_id',tx.id);
END; $$;

REVOKE ALL ON FUNCTION public.process_paystack_success(text,text,text,bigint,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.process_paystack_success(text,text,text,bigint,uuid) TO service_role;