-- READ-ONLY wallet ledger integrity audit.
-- Run in Supabase SQL Editor with a role that can read these tables.
-- These queries report anomalies only; they do not repair or mutate data.

-- 1) Duplicate ledger effects for the wallet operations protected by the new index.
SELECT reference_id, reason, count(*) AS row_count,
       array_agg(id ORDER BY created_at, id) AS ledger_entry_ids,
       array_agg(user_id ORDER BY created_at, id) AS user_ids,
       array_agg(amount ORDER BY created_at, id) AS amounts
FROM public.plug_credit_ledger
WHERE reason IN (
  'Campus Wallet funding',
  'Campus Wallet escrow hold',
  'Campus Wallet micro-escrow release',
  'Campus Wallet micro-escrow refund'
)
GROUP BY reference_id, reason
HAVING count(*) > 1
ORDER BY row_count DESC, reason, reference_id;

-- 2) Funding intents whose credited status and ledger effects disagree.
SELECT i.id AS funding_intent_id, i.reference, i.user_id, i.amount_kobo,
       i.status, count(l.id) AS matching_ledger_rows,
       coalesce(sum(l.amount), 0) AS ledger_amount
FROM public.wallet_funding_intents i
LEFT JOIN public.plug_credit_ledger l
  ON l.reference_id = i.id
 AND l.reason = 'Campus Wallet funding'
GROUP BY i.id, i.reference, i.user_id, i.amount_kobo, i.status
HAVING (i.status = 'credited' AND
        (count(l.id) <> 1 OR coalesce(sum(l.amount), 0) <> i.amount_kobo))
    OR (i.status <> 'credited' AND count(l.id) > 0)
ORDER BY i.created_at, i.id;

-- 3) Wallet escrow holds that do not have the expected debit/settlement ledger effects.
SELECT h.transaction_id, h.buyer_id, h.seller_id, h.amount_kobo, h.status,
       count(*) FILTER (
         WHERE l.reason = 'Campus Wallet escrow hold'
           AND l.user_id = h.buyer_id AND l.amount = -h.amount_kobo
       ) AS debit_rows,
       count(*) FILTER (
         WHERE l.reason = 'Campus Wallet micro-escrow release'
           AND l.user_id = h.seller_id AND l.amount = h.amount_kobo
       ) AS release_rows,
       count(*) FILTER (
         WHERE l.reason = 'Campus Wallet micro-escrow refund'
           AND l.user_id = h.buyer_id AND l.amount = h.amount_kobo
       ) AS refund_rows
FROM public.wallet_escrow_holds h
LEFT JOIN public.plug_credit_ledger l
  ON l.reference_id = h.transaction_id
 AND l.reason IN (
   'Campus Wallet escrow hold',
   'Campus Wallet micro-escrow release',
   'Campus Wallet micro-escrow refund'
 )
GROUP BY h.transaction_id, h.buyer_id, h.seller_id, h.amount_kobo, h.status
HAVING count(*) FILTER (
         WHERE l.reason = 'Campus Wallet escrow hold'
           AND l.user_id = h.buyer_id AND l.amount = -h.amount_kobo
       ) <> 1
    OR (h.status = 'released' AND (
         count(*) FILTER (
           WHERE l.reason = 'Campus Wallet micro-escrow release'
             AND l.user_id = h.seller_id AND l.amount = h.amount_kobo
         ) <> 1 OR
         count(*) FILTER (
           WHERE l.reason = 'Campus Wallet micro-escrow refund'
         ) > 0
       ))
    OR (h.status = 'refunded' AND (
         count(*) FILTER (
           WHERE l.reason = 'Campus Wallet micro-escrow refund'
             AND l.user_id = h.buyer_id AND l.amount = h.amount_kobo
         ) <> 1 OR
         count(*) FILTER (
           WHERE l.reason = 'Campus Wallet micro-escrow release'
         ) > 0
       ))
    OR (h.status = 'held' AND (
         count(*) FILTER (
           WHERE l.reason IN (
             'Campus Wallet micro-escrow release',
             'Campus Wallet micro-escrow refund'
           )
         ) > 0
       ))
ORDER BY h.transaction_id;

-- 4) Current profile balances that differ from the complete append-only ledger sum.
-- Treat results as investigation candidates: historical opening balances or legacy
-- migrations may mean a mismatch is not automatically proof of corruption.
SELECT p.id AS user_id,
       coalesce(p.plug_credit_balance, 0) AS stored_balance,
       coalesce(sum(l.amount), 0) AS ledger_net,
       coalesce(p.plug_credit_balance, 0) - coalesce(sum(l.amount), 0) AS difference
FROM public.profiles p
LEFT JOIN public.plug_credit_ledger l ON l.user_id = p.id
GROUP BY p.id, p.plug_credit_balance
HAVING coalesce(p.plug_credit_balance, 0) <> coalesce(sum(l.amount), 0)
ORDER BY abs(coalesce(p.plug_credit_balance, 0) - coalesce(sum(l.amount), 0)) DESC;
