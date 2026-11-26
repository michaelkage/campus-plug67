-- Wire conclusive Paystack seller transfer outcomes into the canonical
-- financial journal when Milestone 4 is installed.
--
-- This migration is deliberately safe in either merge order:
-- * If the journal function is already installed, transfer outcomes post now.
-- * If not, the trigger remains installed and starts posting once the journal
--   function becomes available. Milestone 4 also backfills existing outcomes.

CREATE OR REPLACE FUNCTION public.sync_seller_payout_to_financial_journal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF to_regprocedure('public.post_seller_payout_journal_event(uuid,text,bigint,text)') IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.status = 'success' THEN
    IF TG_OP = 'INSERT' THEN
      EXECUTE 'SELECT public.post_seller_payout_journal_event($1,$2,$3,$4)'
        USING NEW.transaction_id,NEW.reference,NEW.amount_kobo,'success';
    ELSIF OLD.status IS DISTINCT FROM 'success' THEN
      EXECUTE 'SELECT public.post_seller_payout_journal_event($1,$2,$3,$4)'
        USING NEW.transaction_id,NEW.reference,NEW.amount_kobo,'success';
    END IF;
  ELSIF NEW.status = 'reversed' AND TG_OP = 'UPDATE' AND OLD.status = 'success' THEN
    EXECUTE 'SELECT public.post_seller_payout_journal_event($1,$2,$3,$4)'
      USING NEW.transaction_id,NEW.reference,NEW.amount_kobo,'reversed';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.sync_seller_payout_to_financial_journal()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS seller_payout_financial_journal_sync ON public.seller_payout_transfers;
DROP TRIGGER IF EXISTS seller_payout_financial_journal_insert ON public.seller_payout_transfers;
DROP TRIGGER IF EXISTS seller_payout_financial_journal_update ON public.seller_payout_transfers;

CREATE TRIGGER seller_payout_financial_journal_insert
AFTER INSERT ON public.seller_payout_transfers
FOR EACH ROW
EXECUTE FUNCTION public.sync_seller_payout_to_financial_journal();

CREATE TRIGGER seller_payout_financial_journal_update
AFTER UPDATE OF status ON public.seller_payout_transfers
FOR EACH ROW
EXECUTE FUNCTION public.sync_seller_payout_to_financial_journal();

COMMENT ON FUNCTION public.sync_seller_payout_to_financial_journal() IS
  'Posts successful seller bank transfers and later provider reversals to the canonical financial journal when installed.';
