-- Require the one-time cryptographic voucher for every buyer-confirmed
-- meetup -> inspection transition. This closes the legacy static qr_secret /
-- release_code path even when an older client calls the RPC directly.
--
-- The voucher is consumed by confirm_offline_handoff in the same database
-- transaction. PostgreSQL now() is transaction-stable, so the exact timestamp
-- match prevents a previously consumed or unrelated voucher from authorizing
-- a new inspection transition.
CREATE OR REPLACE FUNCTION public.require_offline_voucher_for_handoff()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF OLD.status = 'meetup_initiated'
     AND NEW.status = 'release_requested'
     AND NEW.handshake_receipt_buffer IS NOT NULL THEN
    IF NEW.buyer_safe_zone_id IS NULL
       OR NEW.seller_safe_zone_id IS NULL
       OR NEW.buyer_safe_zone_id IS DISTINCT FROM NEW.seller_safe_zone_id
       OR NOT EXISTS (
         SELECT 1
           FROM public.offline_handoff_vouchers AS voucher
          WHERE voucher.transaction_id = NEW.id
            AND voucher.buyer_id = NEW.buyer_id
            AND voucher.seller_id = NEW.seller_id
            AND voucher.amount = NEW.amount
            AND voucher.safe_zone_id = NEW.buyer_safe_zone_id
            AND voucher.safe_zone_id = NEW.seller_safe_zone_id
            AND voucher.consumed_at = NEW.handshake_receipt_buffer
            AND voucher.expires_at > voucher.consumed_at
       ) THEN
      RAISE EXCEPTION 'A valid one-time offline handoff voucher is required to confirm receipt';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.require_offline_voucher_for_handoff() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS transactions_require_offline_voucher ON public.transactions;
CREATE TRIGGER transactions_require_offline_voucher
BEFORE UPDATE OF status ON public.transactions
FOR EACH ROW
EXECUTE FUNCTION public.require_offline_voucher_for_handoff();
