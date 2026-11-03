-- The original wallet RPC inserted directly into status=locked and bypassed
-- UPDATE-only synchronization. Backfill lifecycle metadata only for fully consistent
-- held escrows. Temporarily bypass the sensitive-mutation guard inside this migration;
-- all other transaction triggers remain enabled and the guard is re-enabled immediately.
ALTER TABLE public.transactions DISABLE TRIGGER guard_transaction_sensitive_mutation;

SELECT set_config('app.escrow_transition', 'true', true);

UPDATE public.transactions AS t
   SET locked_at = COALESCE(t.locked_at, t.created_at),
       escrow_status = 'held'
  FROM public.wallet_escrow_holds AS h,
       public.listings AS l
 WHERE h.transaction_id = t.id
   AND l.id = t.listing_id
   AND t.payment_method = 'campus_wallet'
   AND t.status = 'locked'
   AND h.status = 'held'
   AND l.status = 'reserved'
   AND h.buyer_id = t.buyer_id
   AND h.seller_id = t.seller_id
   AND h.amount_kobo = t.amount
   AND EXISTS (
     SELECT 1
       FROM public.plug_credit_ledger AS p
      WHERE p.reference_id = t.id
        AND p.user_id = t.buyer_id
        AND p.amount = -t.amount
        AND p.reason = 'Campus Wallet escrow hold'
   )
   AND (t.locked_at IS NULL OR t.escrow_status IS DISTINCT FROM 'held');

ALTER TABLE public.transactions ENABLE TRIGGER guard_transaction_sensitive_mutation;
