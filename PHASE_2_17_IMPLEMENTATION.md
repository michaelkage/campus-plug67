# Campus Plug — Phases 2–17 Implementation

This document records the production-hardening work added after the v6.9 security pass.

## Phase 2 — Authorization
- Added `is_platform_admin()` for server-side admin claims.
- Jury vote insertion now requires the authenticated user to be an assigned juror on an active case.
- Existing sensitive Edge Functions derive identity from verified Supabase JWTs.

## Phase 3 — Financial integrity
- Added a database guard preventing direct client mutation of wallet balances.
- Ledger-triggered balance updates remain atomic and locked.
- Financial operations continue through server/RPC paths.

## Phase 4 — Idempotency
- Added `idempotency_keys` with a unique `(scope, actor_id, idempotency_key)` constraint.
- Added claim/complete RPCs and stale-processing cleanup.
- Existing Paystack webhook processing remains database-idempotent.

## Phase 5 — Disputes
- Added database-enforced jury case transition rules.
- Decided cases require a verdict and closed cases retain the decision.
- Existing dispute function authorization remains server-side.

## Phase 6 — Admin/audit
- Added `is_platform_admin()` and a controlled `write_security_audit()` helper.
- Sensitive audit insertion remains service-authoritative.

## Phase 7 — Secrets/config
- Added repository secret-pattern scanning through GitHub Actions.
- CI must fail on detected credential patterns.
- Production secrets remain runtime configuration, never frontend source.

## Phase 8 — Abuse protection
- Added server-side rate-limit buckets and atomic `consume_rate_limit()` RPC.
- Applied limits to AI proxy, beacon operations, escrow actions, and study-pool joins.
- Limits are keyed by authenticated user and scope.

## Phase 9 — Trust anti-gaming
- Added append-only `trust_events` as an authoritative trust-input ledger.
- Duplicate `(user,event,source)` events are rejected by a database constraint.
- Frontend cannot directly insert trust events.

## Phase 10 — Notifications
- Added deterministic notification deduplication.
- `notifications.dedupe_key` is generated server-side and protected by a unique index.

## Phase 11 — Observability
- Added `system_events` for structured operational telemetry.
- Indexed timestamps and request IDs.
- RLS restricts reads to platform admins while writes are service-authoritative.

## Phase 12 — Backup/recovery
- Retention and maintenance functions are service-only.
- The existing recovery documentation remains the operational source of truth.
- Scheduled maintenance calls the cleanup Edge Function.

## Phase 13 — Privacy/lifecycle
- Added explicit retention policy records.
- Added scheduled cleanup for rate-limit state, old operational events, completed idempotency keys, and chat scan metadata.
- Beacon cleanup from the previous hardening pass remains active.

## Phase 14 — Performance
- Added transaction, notification, jury-case, and message indexes for common access paths.
- Existing marketplace/search indexes are preserved.

## Phase 15 — UX/PWA
- Existing responsive/PWA architecture is preserved.
- Backend hardening returns explicit authorization, rate-limit, and configuration errors so the UI can present deterministic failure states.

## Phase 16 — Automated testing
- Added `scripts/security-regression.mjs` for repeatable security invariants.
- The checks cover auth helpers, sensitive Edge Functions, financial mutation protection, and EDU-domain validation.

## Phase 17 — CI/CD
- Added `production-validation.yml` for npm validation, clean Supabase migration reset, Edge Function compilation, and Gitleaks scanning.
- Added scheduled maintenance workflow for retention cleanup.

## Production configuration still required
- Configure `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` as GitHub Actions secrets for scheduled maintenance.
- Run a real Supabase clean-room reset and frontend build in CI before production deployment.
- Perform authenticated two-user authorization tests against a staging database.
- Verify backup restoration in the real Supabase environment.
