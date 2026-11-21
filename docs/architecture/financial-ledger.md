# Campus Plug financial ledger architecture

## Purpose and boundaries

Campus Plug has two historical wallet records with different responsibilities:

- `plug_credit_ledger` is the operational wallet mutation log used by existing wallet, escrow and refund code. It remains the compatibility write interface during this migration.
- `financial_ledger` is the legacy per-user financial projection. It is append-only and receives an idempotent mirror of every new PlugCredit ledger insert.
- `financial_accounts`, `financial_journal_transactions` and `financial_journal_entries` form the canonical double-entry accounting journal for supported NGN events.

The new journal does not rewrite wallet balances or replace the existing wallet write path. It records the accounting consequence of each supported event. The application must not insert journal rows directly.

All values are integer kobo. The first release is NGN-only.

## Chart of accounts

| Account code | Type | Scope | Meaning |
|---|---|---|---|
| `asset.paystack_clearing` | Asset | System | Control account for funds held/settled through Paystack |
| `asset.seller_recovery` | Asset | Per seller | Receivable when a refund is paid after seller payout |
| `liability.user_wallet` | Liability | Per user | Campus Plug's outstanding PlugCredit wallet obligation |
| `liability.escrow` | Liability | Per transaction | Funds held pending escrow resolution |
| `liability.seller_payable` | Liability | Per seller | Released Paystack proceeds owed to the seller |

The Paystack clearing account is a control account, not proof that a specific amount has reached the bank. Provider settlement reports and bank reconciliation are a later accounting integration.

## Posting rules

| Event | Debit | Credit |
|---|---|---|
| Campus Wallet funding | Paystack clearing | User wallet liability |
| Wallet escrow hold | Buyer wallet liability | Transaction escrow liability |
| Wallet escrow release | Transaction escrow liability | Seller wallet liability |
| Wallet escrow refund | Transaction escrow liability | Buyer wallet liability |
| Verified Paystack purchase | Paystack clearing | Transaction escrow liability |
| Paystack escrow released | Transaction escrow liability | Seller payable |
| Refund processed before payout | Transaction escrow liability | Paystack clearing |
| Seller bank transfer success | Seller payable | Paystack clearing |
| Seller bank transfer reversal | Paystack clearing | Seller payable |
| Refund processed after payout | Seller recovery receivable | Paystack clearing |

A transaction moving to `released` resolves escrow; it does not mean the seller's bank has been paid. Only a conclusive Paystack transfer success posts the settlement entry. A transfer reversal is a new compensating journal transaction; no prior entry is edited.

A refund arriving after payout creates a per-seller receivable. If the transfer is later reversed, the reversal credits that receivable. If a payout succeeds after a refund was already confirmed, the payout is recorded as an additional seller receivable rather than hiding the cash movement.

## Invariants

1. A journal transaction has at least two distinct accounts.
2. Total debits equal total credits before posting.
3. Amounts are positive integer kobo and currency is NGN.
4. An idempotency key is global and immutable. Reusing it with a different header, line payload or metadata is rejected.
5. Journal headers and lines are append-only. Corrections use compensating entries.
6. App roles have no direct table access. Security-definer functions and database triggers own posting.
7. Existing wallet balances are not recalculated or overwritten by the journal migration.
8. The legacy wallet ledger and the double-entry journal are reconciled with read-only audit queries.

## Event integration

- The PlugCredit-to-`financial_ledger` bridge runs after a PlugCredit insert and is part of the same database transaction.
- The `financial_ledger` trigger posts supported wallet reasons to the double-entry journal. Unknown legacy reasons are intentionally left unposted and appear in reconciliation; the system must not invent a counter-account for them.
- A transaction trigger posts Paystack funding, escrow release and provider-confirmed refund events. It is idempotent and can safely run on repeated updates.
- A seller payout transfer trigger posts only conclusive `success` and a true `success` to `reversed` transition. Pending, processing, failed and manual-attention states do not move the general ledger.
- Refund claims are serialized against payout claims by locking the transaction row. A new refund cannot start while a seller transfer is processing or requires manual reconciliation. A repeated existing refund claim remains idempotently readable.

## Reconciliation

Run these read-only scripts after applying migrations in a disposable database and again after rollout:

- `supabase/audits/financial-ledger-mirror-readonly.sql`
- `supabase/audits/financial-journal-reconciliation-readonly.sql`

Investigate any missing wallet mirror, unposted supported wallet reason, missing Paystack funding/release/refund posting, payout outcome without a journal entry, wallet projection mismatch or non-zero trial-balance difference.

## Migration order

When merging the current stacked work, preserve this sequence:

1. PR #103 payout schema and transfer trigger foundation.
2. `20261121120000_wire_seller_payouts_to_financial_journal.sql`.
3. `20261121130000_block_refund_during_inflight_payout.sql`.
4. `20261121132500_allow_legacy_completed_transaction_status.sql`.
5. `20261121135000_mirror_plug_credit_to_financial_ledger.sql`.
6. `20261121140000_create_double_entry_financial_journal.sql`.

The payout trigger is safe before the journal function exists: it waits until the function is installed, and the journal migration backfills conclusive transfer outcomes. Do not apply these migrations out of order.

## Not yet in scope

- Paystack settlement report and bank-statement reconciliation.
- Platform fees, commissions, VAT and revenue recognition.
- Chargebacks, reversals outside seller payouts and partial refunds.
- Multi-currency accounts and FX gains/losses.
- A finance operations UI with restricted read-only RPCs.
- Migration of wallet balance reads away from the legacy operational projection.

These require explicit accounts, event semantics, provider evidence and tests before implementation.