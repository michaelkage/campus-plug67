import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const isCI = process.env.CI === 'true' || process.env.CI === '1';
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const mustContain = (file, text) => {
  const content = read(file);
  if (!content.includes(text)) throw new Error(`${file} is missing: ${text}`);
};
const mustNotExist = (p) => {
  if (fs.existsSync(path.join(root, p))) throw new Error(`Obsolete duplicate still exists: ${p}`);
};

// This suite is intentionally structural. It must never require Supabase, Paystack,
// network access, or repository secrets, especially on forked pull requests.
const requiredFiles = [
  'supabase/migrations/033_phase2_17_production_hardening.sql',
  'supabase/functions/_shared/auth.ts',
  'supabase/functions/_shared/rateLimit.ts',
  'supabase/functions/release-escrow/index.ts',
  'supabase/functions/security-gate/index.ts',
  'supabase/migrations/035_plugscore_cap_and_ban_signals.sql',
  'vite.config.ts',
  'supabase/functions/join-pool/index.ts',
  'supabase/functions/paystack-webhook/index.ts',
  'supabase/migrations/031_security_hardening.sql',
  'supabase/functions/ai-chat-scan/index.ts',
  'supabase/functions/beacon-matcher/index.ts',
  'supabase/migrations/036_authoritative_dispute_and_escrow_fixes.sql',
  'supabase/functions/process-dispute/index.ts',
  'supabase/migrations/037_security_queue_duress.sql',
  'supabase/migrations/038_plugscore_worker.sql',
  'supabase/migrations/039_duress_qr_token.sql',
  'supabase/migrations/040_safe_swap_and_campus_growth.sql',
  'supabase/migrations/041_wallet_payout_offline_guardrails.sql',
  'supabase/migrations/042_wallet_funding_and_sku_restore.sql',
  'supabase/migrations/043_payout_pending_wallet_sync.sql',
  'supabase/migrations/044_wallet_service_credit.sql',
  'supabase/functions/fund-wallet/index.ts',
  'src/pages/CampusWallet.tsx',
  'src/components/wallet/MicroEscrowLauncher.tsx',
  'src/components/ui/OfflineSyncBanner.tsx',
  'src/pages/SafeSwapZone.tsx',
  'src/pages/Marketplace.jsx',
  'src/pages/Gigs.jsx',
  'src/pages/Home.jsx',
  'src/App.tsx',
  'supabase/functions/verify-listing-images/index.ts',
  'src/lib/gpsSpoof.js',
  'src/components/marketplace/MultiMatchSelectionGrid.tsx',
  'src/lib/transactionState.ts',
  '.cursorrules',
  '.ai-context/schema-dump.sql',
];

for (const file of requiredFiles) {
  if (!fs.existsSync(path.join(root, file))) throw new Error(`Required file missing: ${file}`);
}

mustContain('supabase/migrations/033_phase2_17_production_hardening.sql', 'consume_rate_limit');
mustContain('supabase/migrations/033_phase2_17_production_hardening.sql', 'claim_idempotency_key');
mustContain('supabase/migrations/033_phase2_17_production_hardening.sql', 'guard_jury_case_transition');
mustContain('supabase/migrations/033_phase2_17_production_hardening.sql', 'guard_profile_balance_mutation');
mustContain('supabase/migrations/033_phase2_17_production_hardening.sql', 'cleanup_phase2_17_data');
mustContain('supabase/functions/_shared/auth.ts', 'getAuthenticatedUser');
mustContain('supabase/functions/_shared/auth.ts', 'corsHeaders');
mustContain('supabase/functions/_shared/rateLimit.ts', 'enforceRateLimitWithToken');
mustContain('supabase/functions/release-escrow/index.ts', 'process_escrow_action');
mustContain('supabase/functions/release-escrow/index.ts', 'activate_duress');
mustContain('supabase/functions/security-gate/index.ts', 'check_device_ban');
mustContain('supabase/migrations/035_plugscore_cap_and_ban_signals.sql', 'award_plugscore');
mustContain('supabase/migrations/035_plugscore_cap_and_ban_signals.sql', 'check_device_ban');
mustContain('vite.config.ts', 'NetworkFirst');
mustContain('vite.config.ts', 'StaleWhileRevalidate');
mustContain('vite.config.ts', 'backgroundSync');
mustContain('supabase/functions/join-pool/index.ts', 'verifyPaystackPayment');
mustContain('supabase/functions/join-pool/index.ts', 'api.paystack.co/transaction/verify');
mustContain('supabase/functions/paystack-webhook/index.ts', 'process_paystack_success');
mustContain('supabase/functions/paystack-webhook/index.ts', 'x-paystack-signature');
mustContain('supabase/functions/paystack-webhook/index.ts', 'createHmac');
mustContain('supabase/migrations/031_security_hardening.sql', 'processed_webhooks');
mustContain('supabase/functions/ai-chat-scan/index.ts', 'getAuthenticatedUser');
mustContain('supabase/functions/ai-chat-scan/index.ts', 'raw_content');
mustContain('supabase/functions/beacon-matcher/index.ts', 'getAuthenticatedUser');
mustContain('supabase/migrations/036_authoritative_dispute_and_escrow_fixes.sql', 'resolve_dispute_verdict');
mustContain('supabase/functions/process-dispute/index.ts', 'resolve_dispute_verdict');
mustContain('supabase/migrations/037_security_queue_duress.sql', 'CREATE EXTENSION IF NOT EXISTS pgcrypto');
mustContain('supabase/migrations/037_security_queue_duress.sql', 'campus_security_alerts');
mustContain('supabase/migrations/037_security_queue_duress.sql', 'activate_duress');
mustContain('supabase/migrations/038_plugscore_worker.sql', 'process_plugscore_events');
mustContain('supabase/migrations/038_plugscore_worker.sql', 'cron.schedule');
mustContain('supabase/migrations/039_duress_qr_token.sql', 'rotate_duress_qr_token');
mustContain('supabase/migrations/040_safe_swap_and_campus_growth.sql', 'is_in_safe_swap_zone');
mustContain('supabase/migrations/040_safe_swap_and_campus_growth.sql', 'record_safe_arrival');
mustContain('supabase/migrations/040_safe_swap_and_campus_growth.sql', 'radius_m = 50');
mustContain('supabase/migrations/040_safe_swap_and_campus_growth.sql', 'get_department_leaderboard');
mustContain('supabase/migrations/040_safe_swap_and_campus_growth.sql', 'campus_gig_categories');
mustContain('supabase/migrations/041_wallet_payout_offline_guardrails.sql', 'create_wallet_micro_escrow');
mustContain('supabase/migrations/041_wallet_payout_offline_guardrails.sql', 'wallet_funding_intents');
mustContain('supabase/migrations/042_wallet_funding_and_sku_restore.sql', 'length(trim(search_title)) < 3');
mustContain('supabase/migrations/043_payout_pending_wallet_sync.sql', 'approved_for_settlement');
mustContain('supabase/migrations/044_wallet_service_credit.sql', 'credit_wallet_funding_for_user');
mustContain('supabase/functions/fund-wallet/index.ts', 'api.paystack.co/transaction/verify');
mustContain('supabase/functions/fund-wallet/index.ts', 'credit_wallet_funding_for_user');
mustContain('src/pages/CampusWallet.tsx', 'Campus Wallet');
mustContain('src/components/wallet/MicroEscrowLauncher.tsx', 'create_wallet_micro_escrow');
mustContain('src/components/ui/OfflineSyncBanner.tsx', 'Offline Mode');
mustContain('src/pages/SafeSwapZone.tsx', 'PAYOUT PENDING PROCESSING');
mustContain('src/pages/Marketplace.jsx', 'UNILAG_HOSTELS');
mustContain('src/pages/Marketplace.jsx', 'hostel: form.hostel');
mustContain('src/pages/Gigs.jsx', 'ACADEMIC_GIGS');
mustContain('src/pages/Home.jsx', 'get_department_leaderboard');
mustContain('src/App.tsx', 'path="safe-swap"');
mustContain('src/App.tsx', 'MicroEscrowLauncher');
mustContain('supabase/functions/verify-listing-images/index.ts', 'npm:exifr@7.1.3');
mustContain('supabase/functions/verify-listing-images/index.ts', 'EdgeRuntime.waitUntil');
mustContain('supabase/functions/verify-listing-images/index.ts', 'verification_source: "server_verified"');
mustContain('src/lib/gpsSpoof.js', 'increment_spoof_flag');
mustContain('src/components/marketplace/MultiMatchSelectionGrid.tsx', 'MAX_SKU_QUERY_LENGTH');
mustContain('src/components/marketplace/MultiMatchSelectionGrid.tsx', 'useDebounce(search.slice(0,MAX_SKU_QUERY_LENGTH),300)');
mustContain('src/lib/transactionState.ts', 'indexedDB');
mustContain('src/lib/transactionState.ts', 'status');

mustNotExist('src/components/gear/MultiMatchSelectionGrid.jsx');
mustNotExist('src/components/gear/PlugHubTerminal.jsx');
mustNotExist('src/components/meetup/LiveMeetupTracker.tsx');

const supabaseFacade = read('src/lib/supabase.ts');
if (/as\s+any\b/.test(supabaseFacade)) throw new Error('Unsafe `as any` cast detected in Supabase facade');
if (/\.eq\(['"]balance['"]/.test(supabaseFacade) || /\.update\(\{[^}]*plug_credit_balance/s.test(supabaseFacade)) throw new Error('Client-side wallet balance mutation detected');
if (/endsWith\(['"]\.edu\.ng['"]\)|endsWith\(['"]\.edu['"]\)/.test(supabaseFacade)) throw new Error('Blanket EDU-domain acceptance detected');

// Forked PRs do not receive repository secrets. Structural checks intentionally
// run identically in CI and locally, with no external credentials required.
if (isCI) console.log('CI mode: external Supabase/Paystack calls are mocked by omission; structural checks only.');
console.log('Campus Plug security regression checks passed.');
