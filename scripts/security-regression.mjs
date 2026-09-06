import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const mustContain = (file, text) => {
  const content = read(file);
  if (!content.includes(text)) throw new Error(`${file} is missing: ${text}`);
};
const mustNotExist = (p) => {
  if (fs.existsSync(path.join(root, p))) throw new Error(`Obsolete duplicate still exists: ${p}`);
};

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
mustContain('vite.config.ts', "sourcemap: mode === 'development'");
mustContain('vite.config.ts', 'NetworkFirst');
mustContain('vite.config.ts', 'StaleWhileRevalidate');
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
mustContain('supabase/migrations/037_security_queue_duress.sql', 'campus_security_alerts');
mustContain('supabase/migrations/037_security_queue_duress.sql', 'activate_duress');
mustContain('supabase/migrations/038_plugscore_worker.sql', 'process_plugscore_events');
mustContain('supabase/migrations/038_plugscore_worker.sql', 'cron.schedule');
mustContain('supabase/migrations/039_duress_qr_token.sql', 'rotate_duress_qr_token');
mustContain('supabase/functions/verify-listing-images/index.ts', 'npm:exifr@7.1.3');
mustContain('supabase/functions/verify-listing-images/index.ts', 'EdgeRuntime.waitUntil');
mustContain('supabase/functions/verify-listing-images/index.ts', 'verification_source: "server_verified"');
mustContain('src/lib/gpsSpoof.js', 'increment_spoof_flag');
mustContain('src/lib/__tests__/format.test.ts', 'formatNaira');
mustContain('src/lib/__tests__/gpsSpoof.test.ts', 'gpsWeight');
mustContain('src/lib/__tests__/escrowStatus.test.ts', 'canTransitionEscrow');

mustNotExist('src/components/gear/MultiMatchSelectionGrid.jsx');
mustNotExist('src/components/gear/PlugHubTerminal.jsx');
mustNotExist('src/components/meetup/LiveMeetupTracker.tsx');

const supabaseFacade = read('src/lib/supabase.ts');
if (/as\s+any\b/.test(supabaseFacade)) throw new Error('Unsafe `as any` cast detected in Supabase facade');
if (/\.eq\(['"]balance['"]/.test(supabaseFacade) || /\.update\(\{[^}]*plug_credit_balance/s.test(supabaseFacade)) {
  throw new Error('Client-side wallet balance mutation detected');
}
if (/endsWith\(['"]\.edu\.ng['"]\)|endsWith\(['"]\.edu['"]\)/.test(supabaseFacade)) {
  throw new Error('Blanket EDU-domain acceptance detected');
}

console.log('Campus Plug security regression checks passed.');
