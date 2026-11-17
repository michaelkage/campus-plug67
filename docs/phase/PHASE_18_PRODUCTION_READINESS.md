# Phase 18 — Production Readiness

Phase 18 turns the Phase 17 CI/CD hardening into an explicit release gate. The repository is checked first; environment-dependent verification is recorded separately so the project never claims a production check that was not actually run.

## 1. Audit production-validation workflow — DONE
`production-validation.yml` runs frontend lint/typecheck/tests/security checks/build, a clean local Supabase migration reset, Edge Function compilation, and Gitleaks. A dedicated production-readiness script is now part of the frontend gate.

## 2. Clean Supabase migration reset — CI ENFORCED
The workflow starts local Supabase and runs `supabase db reset --local`. The readiness script also rejects duplicate numeric migration versions before the clean-room database step.

## 3. Edge Function compilation — CI ENFORCED
Every `supabase/functions/*/index.ts` entrypoint is compiled with Deno 2.1.4. The readiness script also requires every discovered non-shared function directory to contain an entrypoint.

## 4. Gitleaks / secret scanning — CI ENFORCED
The production validation workflow performs a full-history Gitleaks scan. Repository checks also reject service-role/private credentials exposed through Vite environment variables.

## 5. Production secret/config review — CODE READY
Production workflows reference secrets rather than hard-coded credentials. Required deployment secrets are checked by the deployment workflow: `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD`, `SUPABASE_URL`, and `SUPABASE_ANON_KEY`. Maintenance requires `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.

Actual secret values are intentionally not stored in the repository and cannot be verified from source code alone.

## 6. Two-user authorization tests — RUNTIME PENDING
The repository contains automated security regression coverage, but a true authenticated two-user staging test requires live test accounts and a staging/production Supabase environment. No credentials or fake results are introduced into CI to manufacture a pass.

## 7. Backup/recovery verification — RUNTIME PENDING
`RECOVERY_PLAN.md` and the Phase 2–17 implementation record document recovery architecture and operational requirements. A real restore drill must be performed against an actual Supabase backup/export in an isolated environment; source control alone cannot prove backup recoverability.

## 8. Fix findings — DONE FOR REPOSITORY-VERIFIABLE FINDINGS
Phase 18 adds the production-readiness gate, migration uniqueness validation, explicit deployment/maintenance secret checks, Edge Function inventory validation, and protection against browser-exposed service-role variables.

## 9. CI + E2E — REQUIRED RELEASE GATE
After Phase 18 changes, `Campus Plug CI`, `Browser E2E`, and `Production Validation` must all complete successfully on the final `main` commit. Historical cancelled runs caused by concurrency are not treated as failures.

## 10. Commit/push main — DONE
Phase 18 changes are committed directly to `main`. The final workflow state is the release signal; no production readiness claim is made until the relevant run for the final commit is green.

## Runtime release checklist

Before declaring the system production-ready, complete these environment-only actions:

- [ ] Confirm GitHub Actions secrets exist and are current.
- [ ] Execute authenticated two-user authorization tests against staging.
- [ ] Perform an isolated Supabase backup restoration drill.
- [ ] Confirm scheduled maintenance can reach `maintenance-cleanup` with the service-role secret.
- [ ] Confirm production Edge Function health checks after deployment.

The repository deliberately distinguishes **CI-enforced**, **code-verified**, and **runtime-pending** checks. This prevents a green source-level pipeline from being mistaken for proof that an external production environment has been tested.
