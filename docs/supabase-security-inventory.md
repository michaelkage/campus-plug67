# Supabase security inventory

This inventory records the security-sensitive Supabase surfaces verified from the repository. It is intentionally limited to names and call paths; no credentials or secret values are stored here.

## User-callable / authenticated RPCs reviewed

| RPC | Repository caller | Trust boundary | Required authorization posture |
|---|---|---|---|
| `transfer_plug_credit` | `src/components/wallet/WalletDashboard.tsx` | Authenticated browser → RPC | Function derives sender from `auth.uid()`, rejects self-transfer/non-positive amounts, locks both accounts, checks balance, and writes an atomic ledger pair. |
| `process_escrow_action` | `supabase/functions/release-escrow/index.ts` and authenticated escrow UI path | Browser or trusted Edge worker → RPC | Buyer/seller identity is derived from JWT; transaction participant check and action/state checks are enforced in the function. Worker-only actions require service role. |
| `activate_duress` | Duress/safety client flow | Authenticated browser → RPC | Must require `auth.uid()` and operate only on the caller's safety state. |
| `set_duress_code` | Duress/safety client flow | Authenticated browser → RPC | Must bind the change to `auth.uid()`; never accept an arbitrary target user as authority. |
| `create_session_handoff` | Session-handoff flow | Authenticated client → RPC | Must bind creation to the authenticated user and use one-time/expiring handoff state. |
| `consume_session_handoff` | `supabase/functions/session-handoff/index.ts` | Trusted Edge worker → RPC | Token is consumed server-side and must be one-time/expiring. |
| `record_safe_arrival_v2` | `supabase/functions/safe-arrival/index.ts` | Authenticated Edge request → RPC | Edge function validates identity, role, transaction id, and finite/range-bounded coordinates before calling the RPC. |
| `increment_spoof_flag` | `src/lib/gpsSpoof.ts` | Authenticated client → RPC | Counter must be bound to the authenticated user; client telemetry must not grant arbitrary-user mutation authority. |
| `provision_my_emergency_tokens` | `src/lib/security.ts`, `src/contexts/AuthContext.tsx` | Authenticated browser → RPC | Wrapper derives the user from `auth.uid()`; arbitrary-user provisioning function is service-role-only. |
| `get_price_floor` | `src/lib/security.ts` | Authenticated client → RPC | Read-only pricing lookup; no mutation authority. |
| `get_price_suggestion` | `src/pages/Marketplace.jsx` | Authenticated client → RPC | Read-only pricing suggestion. |
| `get_market_intelligence` | `src/components/ui/MarketPulse.jsx` | Authenticated client → RPC | Read-only market data. |

## Server-authoritative Edge Function RPCs

| RPC | Caller | Reason it remains server-side |
|---|---|---|
| `process_paystack_success` | `supabase/functions/paystack-webhook/index.ts` | Payment verification/idempotency and transaction state mutation. |
| `credit_wallet_funding_for_user` | `supabase/functions/fund-wallet/index.ts` | Financial crediting occurs only after provider verification. |
| `resolve_dispute_verdict` | `supabase/functions/process-dispute/index.ts` | Dispute settlement mutates escrow/financial state. |
| `cleanup_phase2_17_data` | `supabase/functions/maintenance-cleanup/index.ts` | Scheduled maintenance. |
| `cleanup_stale_idempotency_keys` | `supabase/functions/maintenance-cleanup/index.ts` | Scheduled maintenance. |
| `update_streak` | `supabase/functions/process-growth-events/index.ts` | Server-mediated growth state update. |
| `check_device_ban` | `supabase/functions/security-gate/index.ts` | Security decision using server-side fingerprint context. |
| `consume_rate_limit` | `supabase/functions/_shared/rateLimit.ts` | Shared server-side rate-limit state. |

## Affected tables / access intent

The following application tables were explicitly hardened with RLS and role-appropriate policies in prior migrations:

- `scheduled_jobs` — service-only system data
- `global_sku_catalog` — public catalog reads
- `buyer_broadcast_demands` — authenticated owner access
- `gear_rentals` — rental participants
- `escrow_transactions` — transaction participants
- `wallets` — wallet owner access
- `referrals` — referral participants
- `campus_locations` — public location reads
- `class_alerts` — public class-alert reads
- `academic_resources` — public reads plus authenticated uploads
- `processed_webhooks` — server-authoritative payment idempotency
- `chat_scan_logs` — service inserts; message parties may read their own records
- `audit_logs` — server-authoritative writes

`spatial_ref_sys` is deliberately excluded from application RLS migrations because it is owned and managed by PostGIS.

## PostGIS API surface

The application retains PostGIS because spatial functionality is used. Migration `049_postgis_api_hardening.sql` revokes direct `EXECUTE` for the three known `ST_EstimatedExtent` overloads from `public`, `anon`, and `authenticated`. The extension itself is not removed or moved, so spatial columns and migrations remain intact.

## Client-secret boundary

Browser code must use only the public Supabase client configuration. Service-role credentials belong exclusively to Edge/server execution. Repository regression checks reject common committed-secret patterns and CI also runs Gitleaks.

## Remaining platform configuration

Supabase Auth **Leaked Password Protection** must be enabled in the Supabase dashboard/project Auth settings. This cannot safely be configured by committing a secret or dashboard credential to the repository.

## Advisor findings that require production statistics rather than automatic deletion

Unused and overlapping indexes/policies should be reviewed using production query statistics and actual policy semantics. This repository deliberately does not auto-delete approximately 117 unused indexes or approximately 113 overlapping permissive policies because doing so without workload evidence can break low-traffic features, foreign-key enforcement performance, scheduled jobs, or security behavior.
