# Campus membership verification fallback

## Why a fallback is required

A confirmed university email domain is useful evidence, but it is not a reliable universal gate for Nigerian campuses. Some institutions issue student mailboxes late, expose unreliable webmail, or have students who cannot access their campus mailbox during onboarding.

The existing confirmed-email-domain flow should remain the strongest automatic path. A student without an approved campus mailbox should be allowed to create an ordinary account and enter a clearly labelled **campus membership pending** state, not be forced to invent an email address or be treated as verified.

## Proposed verification tiers

1. **Tier 1: confirmed institutional email** — automatic membership verification when the confirmed Auth email domain maps to an active institution in `allowed_domains`.
2. **Tier 2: institution evidence review** — student selects a canonical institution, supplies a matric number for format/consistency checks, and uploads a student ID card or other approved enrollment evidence. Matric format is a validation aid, never proof by itself. The request stays pending until an authorized reviewer approves it.
3. **Tier 3: verified-peer vouch** — one or more already-verified members of the same institution can vouch for the applicant. Vouches are additional evidence, not automatic approval, and must not let a small clique verify one another without review.

## Required implementation contract

- Separate account creation from campus verification. A personal email can confirm account ownership, but it must not create a verified campus membership.
- Use explicit membership/request states: `unverified`, `pending_review`, `verified`, `rejected`, `suspended`. Do not overload `profiles.is_verified` to mean both email confirmation and campus membership.
- Store ID evidence in a private Storage bucket. Never place ID images in public listing buckets or public URLs. Use short-lived signed URLs for authorized reviewers only.
- Storage object paths must be owner-scoped. Clients may upload their own evidence but cannot set review status, reviewer identity, verified timestamps, or primary membership.
- Store matric numbers only when needed, normalize them, avoid exposing them in public profiles, and never log them.
- Review actions must be server-authoritative, role-checked against trusted JWT app metadata/database roles, audited, and idempotent.
- Peer vouches must require a verified active member of the same institution, unique voucher/request pairs, account-age and activity checks, per-voucher rate limits, and conflict/collusion checks. Vouching must not directly mutate profile identity.
- Add evidence retention/deletion rules. Delete rejected/expired ID documents after the stated retention window; provide a user-visible explanation before upload.
- Keep campus-only privileges behind verified membership. Pending users may use ordinary account features but must not receive verified badges, trust-score bonuses, campus moderator powers or access to restricted campus groups.
- Add tests for cross-campus submissions, unauthorized review, reused vouchers, rate limits, storage path traversal, private bucket access, and status-transition integrity.

## Implemented workflow (pending deployment)

The evidence-review implementation is now present in the stacked Campus Plug branch:

- Account signup accepts a personal email. Supabase Auth email confirmation remains mandatory, but it does not grant campus membership.
- Approved institutional email domains continue to use the existing automatic membership claim.
- Other students can submit an institution, normalized matric number and one private JPG/PNG/WebP/PDF evidence object (maximum 5 MB).
- Evidence paths are owner- and institution-scoped in the private `campus-verification-evidence` bucket. Only the applicant and platform admins can read the object; direct client writes to request, membership and audit tables are denied.
- The applicant can share the request UUID with a same-campus verified peer. Vouching requires a verified membership, a 30-day-old account, a maximum of five vouches per 30 days, and one vouch per request. A vouch never changes membership status.
- The Admin Console review queue exposes applicant details, matric number, peer-vouch context and a 60-second signed evidence URL. Approval/rejection runs through an admin-authorized RPC and writes an audit record. A reviewer decision attempts immediate evidence deletion.
- Manual approval creates a verified membership using `manual_evidence_review`; it does not set platform-admin roles, award PlugScore or bypass campus-only authorization.

### Deployment and retention gates

This is repository implementation, not a live verification service. The migration must be applied and the frontend deployed before users can use it. No migration has been applied and no Edge Function or production setting has been changed.

Pending evidence receives a 30-day `evidence_expires_at` timestamp. The repository now includes a service-role cleanup worker and a database claim/retry state machine. Approved/rejected evidence is eligible for immediate cleanup; pending evidence expires after 30 days, is marked `expired`, and its pending institution membership is rejected without granting verification. Request, decision and audit metadata remain available after the object path is cleared. Storage deletion retries use a 10-minute stale-claim lease, batches of 50, exponential backoff and a maximum of eight attempts. Exhausted failures remain visible in `evidence_cleanup_last_error` for operator reconciliation. The worker is not automatically scheduled until the production Vault secrets and Cron job below are configured.

### Configure the scheduled worker after deployment

1. Deploy the migration and Edge Function, then add the following secrets in the Supabase Vault (use the project's actual API URL and service-role secret; never commit either value):

   ```sql
   select vault.create_secret('https://YOUR_PROJECT_REF.supabase.co', 'campus_verification_project_url');
   select vault.create_secret('YOUR_SERVICE_ROLE_SECRET', 'campus_verification_service_key');
   ```

2. Enable `pg_cron` and `pg_net` if they are not already enabled. Schedule the worker with:

   ```sql
   do $
   declare job_id bigint;
   begin
     select jobid into job_id from cron.job
      where jobname = 'campus-verification-evidence-retention';
     if job_id is not null then perform cron.unschedule(job_id); end if;
     perform cron.schedule(
       'campus-verification-evidence-retention',
       '*/15 * * * *',
       $
       select net.http_post(
         url := (select decrypted_secret from vault.decrypted_secrets where name = 'campus_verification_project_url')
           || '/functions/v1/cleanup-campus-verification-evidence',
         headers := jsonb_build_object(
           'Content-Type', 'application/json',
           'apikey', (select decrypted_secret from vault.decrypted_secrets where name = 'campus_verification_service_key'),
           'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'campus_verification_service_key')
         ),
         body := jsonb_build_object('trigger', 'scheduled')
       );
       $
     );
   end $;
   ```

3. Confirm the Cron run history and Edge Function logs show successful invocations. Alert on nonzero `failed`, `evidence_cleanup_attempts >= 8`, or old non-null evidence paths whose expiry/review time has passed. Successful deletion stamps `evidence_deleted_at` and clears `evidence_path`; failed attempts retain the path and last error for retry or operator recovery. Run a manual worker POST with the service key after deployment to verify end-to-end Storage deletion before enabling the recurring job.

Until these production steps are completed and monitored, the code is implemented but automatic deletion is not live. A failed deletion must be treated as a privacy cleanup incident and manually reconciled from the private bucket.

The initial vouch controls reduce casual abuse but do not prove the voucher knows the applicant. Reviewers must treat vouches as supporting context only. Stronger anti-collusion signals (shared device/payment graph, voucher clusters, and campus-admin review) remain follow-on work.

## Rollout sequence

1. Add the request/evidence schema and private Storage bucket with strict RLS/storage policies.
2. Add an authenticated submission RPC that validates the selected institution and owner-scoped evidence path.
3. Add the admin review queue and audited approve/reject RPCs.
4. Add peer vouching with anti-collusion limits, initially as supplemental reviewer evidence only.
5. Update signup/onboarding copy to explain the tiers and keep pending users usable without granting verified privileges.
6. Backfill and reconcile existing memberships without changing existing verified records.

Do not implement a client-only matric-number check or automatically verify from a peer vouch. Those would make the verification label easier to obtain while making it less meaningful.
