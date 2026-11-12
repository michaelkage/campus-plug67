import fs from 'node:fs';
import assert from 'node:assert/strict';

const read = (file) => fs.readFileSync(file, 'utf8');
const migration = read('supabase/migrations/20261112130000_add_paystack_seller_payout_foundation.sql');
const onboarding = read('supabase/functions/manage-payout-recipient/index.ts');
const worker = read('supabase/functions/process-paystack-payouts/index.ts');
const reconciler = read('supabase/functions/reconcile-paystack-transfers/index.ts');
const manualRecovery = read('supabase/functions/resolve-paystack-payout-attention/index.ts');
const webhook = read('supabase/functions/paystack-webhook/index.ts');
const workflow = read('.github/workflows/seller-payout-reconciliation.yml');
const settingsUi = read('src/components/wallet/SellerPayoutSettings.tsx');
const settingsPage = read('src/pages/Settings.jsx');
const lifecycle = read('src/lib/transactionLifecycle.ts');

assert.ok(migration.includes('CREATE TABLE IF NOT EXISTS public.seller_payout_recipients'));
assert.ok(migration.includes('CREATE TABLE IF NOT EXISTS public.seller_payout_transfers'));
assert.ok(migration.includes('ALTER TABLE public.seller_payout_recipients ENABLE ROW LEVEL SECURITY'));
assert.ok(migration.includes('ALTER TABLE public.seller_payout_transfers ENABLE ROW LEVEL SECURITY'));
assert.ok(migration.includes('REVOKE ALL ON public.seller_payout_recipients FROM PUBLIC, anon, authenticated'));
assert.ok(migration.includes('REVOKE ALL ON public.seller_payout_transfers FROM PUBLIC, anon, authenticated'));
assert.ok(!/account_number\s+text/i.test(migration), 'Plaintext bank account numbers must never be persisted');
assert.ok(migration.includes("recipient_code text NOT NULL UNIQUE"));
assert.ok(migration.includes("account_last4 text NOT NULL"));
assert.ok(migration.includes("recipient_code ~ '^RCP_[A-Za-z0-9]+$'"));
assert.ok(migration.includes("reference ~ '^[a-z0-9_-]+$'"));
assert.ok(migration.includes("UNIQUE(transaction_id, attempt_number)"));
assert.ok(migration.includes('seller_payout_transfer_provider_id_uidx'));
assert.ok(migration.includes('REVOKE DELETE ON public.seller_payout_recipients, public.seller_payout_transfers FROM service_role'));
assert.ok(migration.includes('guard_seller_payout_recipient_mutation'));
assert.ok(migration.includes('guard_seller_payout_transfer_mutation'));
assert.ok(migration.includes('confirm_paystack_transfer_not_created'));
assert.ok(migration.includes('attempt_number BETWEEN 1 AND 5'));
assert.ok(migration.includes('Terminal payout attempt status is immutable'));

const saveRecipient = migration.slice(
  migration.indexOf('CREATE OR REPLACE FUNCTION public.save_seller_payout_recipient'),
  migration.indexOf('CREATE OR REPLACE FUNCTION public.claim_seller_payout_transfers'),
);
assert.ok(saveRecipient.includes("auth.jwt() ->> 'role', '') <> 'service_role'"));
assert.ok(saveRecipient.includes('UPDATE public.seller_payout_recipients'));
assert.ok(saveRecipient.includes('p_account_last4'));
assert.ok(!saveRecipient.includes('p_account_number'));

const claim = migration.slice(
  migration.indexOf('CREATE OR REPLACE FUNCTION public.claim_seller_payout_transfers'),
  migration.indexOf('CREATE OR REPLACE FUNCTION public.record_paystack_transfer'),
);
assert.ok(claim.includes("t.payment_verified IS TRUE"));
assert.ok(claim.includes("COALESCE(t.payment_method, 'paystack') <> 'campus_wallet'"));
assert.ok(claim.includes("t.status IN ('released', 'completed')"));
assert.ok(claim.includes("t.payout_status IN ('approved_for_settlement', 'failed', 'processing')"));
assert.ok(claim.includes("COALESCE(dispute.status, 'open') NOT IN ('closed','decided')"));
assert.ok(claim.includes("FOR UPDATE OF t SKIP LOCKED"));
assert.ok(claim.includes("v_last.status = 'processing' AND v_last.lease_expires_at <= now()"));
assert.ok(claim.includes('v_last.submission_attempts >= 10'), 'Exhausted ambiguous submissions must move to manual review');
assert.ok(claim.includes("v_last.status IN ('failed','reversed')"));
assert.ok(claim.includes("inflight.lease_expires_at <= now()"), 'Expired in-flight references must be recoverable without an active recipient');
assert.ok(claim.includes("'cp_tr_' || replace(gen_random_uuid()::text, '-', '')"));
assert.ok(claim.includes('WHERE id = v_transfer.recipient_id'), 'A retry must remain bound to its original beneficiary snapshot');

const record = migration.slice(
  migration.indexOf('CREATE OR REPLACE FUNCTION public.record_paystack_transfer'),
  migration.indexOf('REVOKE ALL ON FUNCTION public.save_seller_payout_recipient'),
);
assert.ok(record.includes("v_recipient.recipient_code <> p_recipient_code"));
assert.ok(record.includes('v_transfer.amount_kobo <> p_amount'));
assert.ok(record.includes("upper(COALESCE(p_currency, '')) <> 'NGN'"));
assert.ok(record.includes("UPDATE public.transactions\n       SET payout_status = 'paid'"));
assert.ok(record.includes("UPDATE public.transactions\n       SET payout_status = 'failed'"));
assert.ok(record.includes("v_previous_status = 'success' AND v_transfer.earnings_reversed_at IS NULL"));
assert.ok(record.includes("GREATEST(COALESCE(total_earnings, 0) - v_tx.amount, 0)"));
assert.ok(record.includes("v_previous_status IN ('failed','reversed','abandoned','blocked','rejected')"), 'Terminal provider transfer states cannot be overwritten by stale events');
assert.ok(record.includes("seller_payout_success"));
assert.ok(record.includes("seller_payout_reversed"));
assert.ok(record.includes("seller_payout_manual_review"));
assert.ok(record.includes("CASE WHEN v_status IN ('otp','needs_attention') THEN 'needs_attention' ELSE 'pending' END"));

assert.ok(onboarding.includes('getAuthenticatedUser(req)'));
assert.ok(onboarding.includes('PAYSTACK_SELLER_PAYOUT_ONBOARDING_ENABLED'));
assert.ok(onboarding.includes('enforceRateLimitWithToken'));
assert.ok(onboarding.includes('resolveAccount(accountNumber, bankCode)'));
assert.ok(onboarding.includes('normalizeName(input.confirmed_account_name) !== normalizeName(resolved.account_name ?? "")'));
assert.ok(onboarding.includes('confirm_ownership !== true'));
assert.ok(onboarding.includes('resolveBankName(bankCode)'));
assert.ok(onboarding.includes('account_number: accountNumber'));
assert.ok(onboarding.includes('p_account_last4: accountNumber.slice(-4)'));
assert.ok(!onboarding.includes('p_account_number:'), 'Account number must not be passed to persistence RPC');
assert.ok(onboarding.includes('bank_name: data.bank_name'));
assert.ok(!onboarding.includes('recipient_id: data.recipient_id'), 'Internal recipient IDs must not be exposed to clients');
assert.ok(!onboarding.includes('return jsonResponse({ recipient_code: recipientCode'), 'Provider recipient code must not be exposed in the user response');

assert.ok(worker.includes('claim_seller_payout_transfers'));
assert.ok(worker.includes('/transfer/verify/'));
assert.ok(worker.includes('recipient: item.recipient_code'));
assert.ok(worker.includes('reference: item.reference'));
assert.ok(worker.includes('deferred_ambiguous_submission'));
assert.ok(worker.includes('initiated.response.status === 409'));
assert.ok(worker.includes('p_status: "needs_attention"'));
assert.ok(worker.includes('isServiceRoleRequest(req)'));
assert.ok(worker.includes('PAYSTACK_SELLER_PAYOUTS_ENABLED') && worker.includes('!== "true"'), 'Actual money movement must remain disabled until explicitly enabled');

assert.ok(reconciler.includes('/transfer/verify/'));
assert.ok(reconciler.includes('actualRecipient === recipient.recipient_code'));
assert.ok(!reconciler.includes('"/transfer"'), 'Transfer reconciliation must never initiate transfers');
assert.ok(reconciler.includes('record_paystack_transfer'));
assert.ok(reconciler.includes('.limit(10)'), 'Scheduled transfer reconciliation must use a bounded batch');
assert.ok(reconciler.includes('last_reconciled_at'), 'Pending transfer reconciliation must rotate fairly across the backlog');
assert.ok(reconciler.includes('"needs_attention"'), 'Manual-attention transfers must still reconcile after merchant approval');
assert.ok(manualRecovery.includes('/transfer/verify/'));
assert.ok(manualRecovery.includes('confirm_not_created !== true'));
assert.ok(manualRecovery.includes('confirm_paystack_transfer_not_created'));
assert.ok(!manualRecovery.includes('"/transfer"'), 'Manual recovery must never initiate a new transfer');

assert.ok(webhook.includes('event.event === "transfer.success"'));
assert.ok(webhook.includes('event.event === "transfer.failed"'));
assert.ok(webhook.includes('event.event === "transfer.reversed"'));
assert.ok(webhook.includes('createHmacSignature(secret, body)'));
assert.ok(webhook.includes('admin.rpc("record_paystack_transfer"'));

assert.ok(workflow.includes('/functions/v1/process-paystack-payouts'));
assert.ok(workflow.includes('/functions/v1/reconcile-paystack-transfers'));
assert.ok(workflow.includes('timeout-minutes: 10'));
assert.ok(workflow.includes("if: github.ref == 'refs/heads/main'"), 'Transfer scheduler must refuse non-main refs');
assert.ok(workflow.includes("cron: \"*/10 * * * *\""));
assert.ok(settingsUi.includes("action: 'resolve'"));
assert.ok(settingsUi.includes('onboardingEnabled'));
assert.ok(settingsUi.includes('executionEnabled'));
assert.ok(settingsUi.includes("action: 'save'"));
assert.ok(settingsUi.includes('confirm_ownership: true'));
assert.ok(settingsUi.includes('Your full account number is sent directly to Paystack'));
assert.ok(settingsPage.includes('SellerPayoutSettings'));
assert.ok(lifecycle.includes("status === 'needs_attention'"));
assert.ok(lifecycle.includes('Bank transfer successful'));
assert.ok(lifecycle.includes('recipient bank may take additional time'));

console.log('Paystack seller payout lifecycle regression checks passed.');
