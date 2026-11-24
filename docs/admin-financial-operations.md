# Admin financial operations workbench

## Purpose

The Admin Console's Financial ops tab is a read-only reconciliation workbench. It surfaces exceptions from the existing Paystack event history, transaction refund state, compatibility financial ledger and immutable double-entry journal.

It currently reports:

- Refund attention: refunds marked failed/needs-attention, plus pending or processing refunds older than 15 minutes.
- Failed payment/webhook events.
- Verified Paystack transactions missing their expected funding, release or processed-refund journal posting.
- Legacy PlugCredit ledger entries missing their matching financial journal mirror.
- Trial-balance imbalances, if any.
- Existing disputed transaction counts for operational context.

The queues are capped at 30 rows by default and the RPC accepts a bounded limit from 1 to 100. The page refreshes automatically every 60 seconds while the tab is open.

## Safety boundary

**Read-only by design.** The snapshot RPC checks `is_platform_admin()` on the server and returns only bounded operational rows. The UI can open the existing transaction timeline for investigation, but it does not retry refunds, does not initiate payouts, does not release escrow, and does not write ledger entries.

This is deliberate. A displayed failure is not proof that a provider operation is safe to repeat. Retry and payout controls must be backed by explicit idempotent server workflows, provider status reconciliation, and audited operator authorization before being exposed.

## Deployment

The migration `20261125120000_admin_financial_operations_snapshot.sql` and frontend change are repository work only. No migration has been applied and no deployment has occurred.

After the stacked PR is reviewed and explicitly approved for rollout:

1. Apply the migration in the normal reviewed migration sequence.
2. Deploy the frontend containing the Financial ops tab.
3. Confirm an ordinary authenticated user is denied by the RPC while a platform admin can load the bounded queues.
4. Reconcile sample rows against the provider event ledger and financial journal using the read-only audit SQL before using the panel operationally.
5. Monitor query latency and keep the queue limit bounded.

The first release intentionally excludes direct refund retry, seller payout execution, manual journal posting, and dispute settlement. Those require dedicated, separately reviewed mutation workflows.
