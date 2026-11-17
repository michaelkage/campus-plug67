-- Reconcile legacy Campus Wallet purchases that committed a held escrow but
-- bypassed the UPDATE-only listing reservation trigger. Keep the funds held;
-- this migration changes listing visibility only and never releases/refunds money.
UPDATE public.listings AS l
   SET status = 'reserved',
       updated_at = now()
 WHERE l.status = 'active'
   AND EXISTS (
     SELECT 1
       FROM public.transactions AS t
       JOIN public.wallet_escrow_holds AS h
         ON h.transaction_id = t.id
      WHERE t.listing_id = l.id
        AND t.payment_method = 'campus_wallet'
        AND t.status = 'locked'
        AND h.status = 'held'
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
        AND NOT EXISTS (
          SELECT 1
            FROM public.transactions AS other
           WHERE other.listing_id = t.listing_id
             AND other.id <> t.id
             AND other.status IN ('pending', 'locked', 'meetup_initiated', 'release_requested', 'disputed')
        )
   );
