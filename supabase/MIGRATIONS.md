# Campus Plug database migrations

## Canonical migration path

The `supabase/migrations` directory is append-only. Existing migration files must not be edited or renumbered after deployment.

Current order:

```text
001_schema.sql
002_*.sql
003_sovereign_upgrade.sql
004_sovereign_armor.sql
005_growth_engine.sql
006_social_gravity.sql
007_sovereign_soul.sql
008_hardened_v63.sql
009_v67_integration.sql
010_v68_campus_overhaul.sql
029_atomic_accounting_triggers.sql
030_reconcile_escrow_triggers.sql
031_security_hardening.sql
```

The v6.9 hardening migration is the compatibility boundary for the older schema generations. It:

- makes `transactions.status` the single canonical escrow state;
- removes the abandoned `new_status` column;
- adds the transaction fields used by the current application;
- replaces client-controlled wallet writes with an atomic ledger RPC;
- makes PlugCredit the canonical profile balance;
- adds Paystack webhook idempotency storage and atomic payment validation;
- adds the missing chat scan log table;
- makes current beacon rows unique per user;
- removes public reads/writes for security-sensitive tables where the client does not need them;
- locks privileged RPCs to the service role;
- normalizes `allowed_domains.institution_name` and `banned_devices.device_fingerprint`.

## Clean-room verification

A clean Supabase project should be created and all migrations applied in filename order before production deployment. Do not use a production database as the migration test environment.

Recommended verification sequence:

1. `supabase db reset` against a local Supabase instance.
2. Apply every migration without manual SQL.
3. Generate database types from the resulting schema.
4. Run the frontend type-check/build.
5. Deploy Edge Functions.
6. Exercise signup, login, listing creation, marketplace payment, escrow transitions, dispute opening, PlugCredit transfer and beacon updates with test accounts.
7. Confirm that unauthenticated requests to privileged Edge Functions return 401/403.
8. Confirm that direct client inserts into the PlugCredit ledger and audit/chat security logs are rejected.
9. Confirm a duplicate Paystack webhook is a no-op.
10. Confirm concurrent pool joins cannot exceed capacity.

## Important production rule

Do not manually modify the production schema to make an old migration pass. If a schema correction is required, add a new migration and document the compatibility change here.
