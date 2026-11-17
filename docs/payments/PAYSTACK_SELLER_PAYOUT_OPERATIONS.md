# Paystack seller payout operations runbook

**Status:** operational procedure for the branch implementation. This document does not authorize production deployment or payout activation.

## Safety boundary

- Campus Plug's `released` state means escrow has been resolved. It does **not** mean the seller's bank has been credited.
- Only a verified Paystack transfer success recorded by `record_paystack_transfer` sets `transactions.payout_status = 'paid'`.
- Campus Wallet proceeds settle to PlugCredit and must never be sent through Paystack Transfers.
- Amounts in `transactions.amount` and `seller_payout_transfers.amount_kobo` are **kobo**. Do not divide before submitting to Paystack. Divide by 100 only for naira display.
- Never create a second transfer manually to “unstick” an attempt. Every attempt has a stable `cp_tr_...` reference and immutable recipient snapshot.
- Never bypass merchant OTP or approve a transfer outside Paystack's authorized dashboard flow.
- Never ask a seller to send their full bank account number in chat or a support ticket. The recipient setup flow sends it directly to Paystack and stores only masked metadata plus the Paystack recipient code.

## Before enabling payouts

All of these are release gates. Record evidence and the person who verified each item in the release ticket.

1. **Independent technical review:** payout SQL state machine, webhook transitions, recipient snapshot binding, and manual recovery RPC reviewed by someone other than the implementer.
2. **Paystack merchant eligibility:** confirm in the intended Paystack environment that the business account is enabled for Transfers and that the available balance covers the intended test payouts and fees.
3. **Environment parity:** confirm whether the intended run is Paystack test or live mode. Never mix test recipient codes or keys with live transfers.
4. **Webhook configuration:** configure the exact deployed `paystack-webhook` URL in the matching Paystack environment. Confirm the signing secret matches `PAYSTACK_SECRET_KEY`. Ensure Paystack delivers:
   - `transfer.success`
   - `transfer.failed`
   - `transfer.reversed`
   The webhook verifies the HMAC SHA-512 signature before processing events. Do not weaken signature verification to troubleshoot delivery.
5. **OTP policy:** agree whether the merchant account requires OTP. If it does, assign an authorized merchant operator to approve transfers in the Paystack Dashboard. Campus Plug does not bypass OTP.
6. **Controlled test:** use a low-value test transfer in the intended environment, verify the exact reference, amount, NGN currency and recipient, observe the webhook or read-only reconciler, and confirm the seller-facing state only becomes paid after provider success.
7. **Operational ownership:** name a primary and backup operator for the ten-minute workflow, manual attention queue, reversals, and support escalations.
8. **Recovery approval:** approve the forward-only recovery plan. Do not restore the older sliding-expiry voucher function or manually rewrite payout statuses.

The two Edge Function flags are independent and default off:

- `PAYSTACK_SELLER_PAYOUT_ONBOARDING_ENABLED=true`: permits seller bank-recipient onboarding.
- `PAYSTACK_SELLER_PAYOUTS_ENABLED=true`: permits outbound transfers.

Keep the execution flag off until all gates above are complete. Do not enable it merely because CI is green.

## Scheduled jobs and ownership

After merge and deployment, `.github/workflows/seller-payout-reconciliation.yml` runs every ten minutes on `main`:

1. `process-paystack-payouts` claims a bounded batch (five) and verifies the persisted reference before any create request.
2. `reconcile-paystack-transfers` performs provider lookups only. It never creates or retries transfers.

The separate payment reconciliation workflow handles incoming payments and refunds. The payout worker uses the Supabase service-role key from GitHub Actions; the Paystack secret remains in Supabase Edge Function secrets.

Check GitHub Actions for every scheduled run. A green workflow means the HTTP calls completed successfully, not that every payout succeeded. Inspect the JSON result arrays and the database queue below. A worker can correctly defer an individual provider/API error while the overall invocation returns HTTP 200.

## Read-only queue monitoring

Run these queries in the Supabase SQL editor using an authorized operator account. They are read-only. Do not paste full provider payloads, account details, or secrets into tickets.

### Outstanding and attention queue

```sql
select
  status,
  count(*) as attempts,
  min(created_at) as oldest_attempt,
  max(updated_at) as latest_update
from public.seller_payout_transfers
where status in ('processing', 'pending', 'needs_attention')
group by status
order by status;
```

### Attempts requiring operator attention

```sql
select
  transaction_id,
  reference,
  attempt_number,
  status,
  provider_status,
  failure_reason,
  submission_attempts,
  created_at,
  updated_at,
  last_reconciled_at
from public.seller_payout_transfers
where status = 'needs_attention'
order by created_at asc;
```

### Expired processing leases

```sql
select
  transaction_id,
  reference,
  attempt_number,
  submission_attempts,
  lease_expires_at,
  updated_at
from public.seller_payout_transfers
where status = 'processing'
  and lease_expires_at < now()
order by lease_expires_at asc;
```

### Transactions released but not paid

```sql
select
  id as transaction_id,
  seller_id,
  payout_status,
  payout_reference,
  payout_failure_reason,
  updated_at
from public.transactions
where status in ('released', 'completed')
  and payout_status in ('approved_for_settlement', 'processing', 'failed', 'needs_attention')
order by updated_at asc;
```

These queries expose operational identifiers and failure reasons, not bank account numbers. Restrict query access and exports to authorized finance/support operators.

## Triage procedures

### A. OTP / manual attention

1. Find the attempt by its exact `cp_tr_...` reference in the queue query.
2. Open the matching transfer in the correct Paystack Dashboard environment. Confirm reference, amount, currency and beneficiary.
3. If Paystack requires OTP, an authorized merchant operator completes the approval through Paystack's own dashboard/security flow. Campus Plug support must not request or store the merchant OTP.
4. Allow the signed webhook to arrive. If it does not, the scheduled reconciler checks the existing reference and records the authoritative provider status.
5. Confirm the attempt leaves `needs_attention` only after an authoritative provider status is recorded. A delayed `pending` or `received` event must not downgrade manual attention.
6. If provider status remains unclear, leave it in manual attention and escalate to the finance/Paystack account owner. Do not create another transfer.

### B. Ambiguous timeout or expired lease

1. Do not assume a timeout means Paystack rejected the transfer.
2. Search Paystack by the exact persisted reference. Verify amount, NGN currency and beneficiary.
3. Let the worker/reconciler retry verification using that same reference. Do not generate a replacement reference.
4. If Paystack confirms a transfer exists, allow the webhook/reconciler to record it.
5. If the provider remains unavailable or contradictory, keep the attempt blocked and escalate. Never manually submit a duplicate transfer.

### C. Confirming that Paystack did not create a transfer

This is a restricted support operation, not a seller-facing action.

1. Verify the exact reference in Paystack and confirm the provider dashboard also shows no transfer.
2. Wait at least 30 minutes from attempt creation.
3. Confirm the attempt has no recorded provider transfer code or provider transfer ID.
4. Confirm there is no other active attempt for the transaction and that the transaction remains eligible (released/verified Paystack payment, no active dispute, no outstanding/processed refund).
5. An authorized operator invokes the service-role-only `resolve-paystack-payout-attention` endpoint with the exact reference, `confirm_not_created: true`, and a 20–500 character audit note. The endpoint performs another provider verification and only accepts a provider 404.
6. The database RPC enforces the remaining invariants and retry cap. A later attempt receives a new reference only after this conclusive recovery path and the configured backoff.
7. Record the support ticket and operator identity. Never call the database RPC directly from a client.

### D. Failed transfer

1. Confirm the provider status is conclusively failed or reversed; do not infer failure from a network/API error.
2. Review the failure reason in Paystack and the protected transfer ledger.
3. Check the attempt number. The system permits at most five conclusive attempts and applies backoff.
4. Correct the underlying issue through the verified recipient onboarding process if appropriate. A new attempt after a conclusive failure/reversal uses the seller's currently active verified recipient; an ambiguous in-flight attempt remains bound to its original recipient.
5. If the retry limit is exhausted or the provider outcome is not conclusive, escalate for manual settlement. Do not edit payout state or create an off-ledger transfer.

### E. Reversal after success

1. Treat a provider reversal as a financial incident. Preserve the reference and provider evidence.
2. The atomic recorder marks the transfer reversed, removes the paid payout state, and compensates the seller earnings ledger exactly once.
3. Confirm the seller-facing notification and transaction state. Reconcile again after any later authoritative provider event.
4. Escalate to the finance owner and Paystack. Do not manually re-credit earnings or mark the payout paid.

## Escalation thresholds

- **Immediate:** recipient/amount/currency/reference mismatch, unexpected beneficiary, reversal after success, duplicate transfer evidence, or suspected credential/webhook compromise. Keep execution disabled while investigating.
- **Same business day:** any `needs_attention` attempt, exhausted retry budget, OTP awaiting merchant action, or processing lease that remains expired after the next scheduled run.
- **Routine monitoring:** pending transfers and queue age. Investigate any attempt with no provider status progression across two reconciliation cycles (20 minutes), allowing for provider-side processing delays.

## Incident record checklist

For each case, capture:

- Transaction ID and exact transfer reference.
- Attempt number and current ledger status.
- Provider status and provider transfer code/ID, if present (never secret keys or OTPs).
- Amount in kobo and currency.
- Timestamp and result of provider verification.
- GitHub Actions run URL and reconciler result action.
- Operator identity, support ticket, decision and reason.
- Whether the seller was notified and what was communicated.

Do not attach raw webhook payloads or screenshots containing bank account details. Never record a full account number, API key, service-role key, or OTP.

## Rollback and disable procedure

1. Set `PAYSTACK_SELLER_PAYOUTS_ENABLED` to anything other than `true` in Supabase Edge Function secrets to stop new payout claims/submissions. This does not cancel transfers already accepted by Paystack.
2. Keep webhook handling and read-only reconciliation available so accepted transfers can still reach an authoritative terminal state.
3. Do not delete payout ledger rows, recipient snapshots, provider references, or audit notes.
4. Do not roll back by restoring an earlier migration or rewriting payout statuses. Use a reviewed forward-only migration for any database correction.
5. Re-enable only after the incident is understood, the provider state is reconciled, and the finance owner explicitly approves.

**Current release state:** PR #103 is draft and unmerged. No production migration, Edge Function deployment, secret change, feature-flag change, or provider transfer is authorized by this runbook.
