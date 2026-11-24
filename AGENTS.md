# Campus Plug engineering guidance

This file is the canonical repository-wide guidance for coding agents and contributors.

## Project architecture

- Frontend: React 18, TypeScript/JSX, Vite, Tailwind, Framer Motion and TanStack Query.
- Backend: Supabase PostgreSQL, RLS, RPCs, Storage and Edge Functions.
- Payments: Campus Wallet, Paystack, escrow, refunds and seller settlement.
- The committed migration history is authoritative. `.ai-context/schema-dump.sql` is a lightweight navigation aid, not a substitute for inspecting the relevant migrations.

## Non-negotiable security invariants

- Never trust client-supplied identity, university, roles, device type, GPS, EXIF, transaction state, wallet balance, payment status or PlugScore as authoritative.
- Browser fingerprints and browser geolocation are correlation/evidence signals only.
- Preserve RLS, rate limits, idempotency, auditability, and server-side ownership checks. SECURITY DEFINER functions must use a safe `search_path` and explicit execute grants.
- Marketplace escrow transitions, inspection windows, dispute decisions, wallet debits/credits, refunds and payouts remain server/database authoritative. A QR scan, offline receipt or local state is never itself a payout instruction.
- Never add client-side writes to wallet balances or directly release escrow from a browser.
- Offline replay is allowlisted. Do not queue payment intents, wallet transfers, escrow releases, payouts, dispute decisions or other irreversible financial operations.
- Scope IndexedDB queues and cached private data to the authenticated user; reject stale-user work after account changes.
- Do not place Supabase access/refresh tokens, reusable credentials, session handoff secrets or payment secrets in QR codes, URLs, logs or offline payloads.
- Keep Edge Function health checks cheap and side-effect free.
- Paystack webhooks must verify provider signatures and use idempotent server-side processing.

## UI and design system

- Use the generated Material 3 semantic roles and tokens. Do not introduce raw hex/RGB colors or a competing palette.
- The palette is generated from `src/theme/theme.tokens.json` by `src/theme/themeEngine.ts`; do not hand-edit generated token values in `src/index.css`.
- Prefer existing Material Web components and established repository primitives. Tailwind is used for layout utilities and existing component composition.
- Preserve keyboard access, visible focus, labels, error descriptions, live status announcements, reduced-motion preferences and adequate touch targets.
- Check landmarks and dialog focus behavior when changing navigation, forms or overlays.

## Engineering workflow

1. Inspect the relevant pages/components, hooks, schema types, migrations, Edge Functions and tests before changing behavior.
2. Fix the underlying state/security contract rather than adding a UI-only workaround.
3. Keep changes scoped, typed, idempotent where appropriate, and backward-compatible with existing flows.
4. Add regression coverage for security boundaries and user-visible behavior. Structural tests must not require live payment, network or production database access.
5. Run the relevant tests plus:
   - `npm run lint`
   - `npm run typecheck`
   - `npm run test:security:all`
   - `npm run test:platform-integrity`
   - `npm run build`
6. Report exactly which checks ran and their results. Never claim a test, migration, deployment or action succeeded without evidence.
7. Do not merge pull requests, deploy Edge Functions, apply migrations or alter production settings without explicit authorization.

## Local tooling and secrets

- Personal IDE/agent configuration belongs in local ignored files, not in the shared repository.
- Keep `.claude/`, `.clinerules` and `.cursorrules` out of commits. Use this file for shared instructions.
- Never commit local API keys, routing keys, tokens, environment files or machine-specific settings.
- Keep `.ai-context/schema-dump.sql` only as a sanitized structural snapshot; never put secrets or production data in it.
