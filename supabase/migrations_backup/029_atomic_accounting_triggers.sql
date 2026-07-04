-- Campus Plug v67 - Production Atomic Accounting Triggers
CREATE OR REPLACE FUNCTION public.process_atomic_balance_update()
RETURNS TRIGGER AS $$
DECLARE
  current_bal bigint;
BEGIN
  SELECT balance INTO current_bal FROM public.profiles WHERE id = NEW.user_id FOR UPDATE;
  IF NEW.amount < 0 AND current_bal + NEW.amount < 0 THEN
    RAISE EXCEPTION 'Insufficient wallet balance for this Campus Plug transaction.';
  END IF;
  UPDATE public.profiles 
  SET balance = balance + NEW.amount 
  WHERE id = NEW.user_id;
  NEW.balance_after := current_bal + NEW.amount;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trigger_atomic_balance ON public.plug_credit_ledger;
CREATE TRIGGER trigger_atomic_balance
BEFORE INSERT ON public.plug_credit_ledger
FOR EACH ROW EXECUTE FUNCTION public.process_atomic_balance_update();
