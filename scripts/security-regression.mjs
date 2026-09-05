import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const mustContain = (file, text) => {
  const content = read(file);
  if (!content.includes(text)) throw new Error(`${file} is missing: ${text}`);
};

mustContain('supabase/migrations/033_phase2_17_production_hardening.sql', 'consume_rate_limit');
mustContain('supabase/migrations/033_phase2_17_production_hardening.sql', 'claim_idempotency_key');
mustContain('supabase/migrations/033_phase2_17_production_hardening.sql', 'guard_jury_case_transition');
mustContain('supabase/migrations/033_phase2_17_production_hardening.sql', 'guard_profile_balance_mutation');
mustContain('supabase/migrations/033_phase2_17_production_hardening.sql', 'cleanup_phase2_17_data');
mustContain('supabase/functions/_shared/auth.ts', 'getAuthenticatedUser');
mustContain('supabase/functions/_shared/rateLimit.ts', 'enforceRateLimitWithToken');
mustContain('supabase/functions/release-escrow/index.ts', 'process_escrow_action');
mustContain('supabase/functions/paystack-webhook/index.ts', 'processed_webhooks');
mustContain('supabase/functions/ai-chat-scan/index.ts', 'getAuthenticatedUser');
mustContain('supabase/functions/beacon-matcher/index.ts', 'getAuthenticatedUser');

// Guard against the two most dangerous regressions: permissive client wallet writes
// and blanket EDU-domain acceptance in the client.
const supabaseClient = read('src/lib/supabase.ts');
if (/\.eq\(['"]balance['"]/.test(supabaseClient) || /\.update\(\{[^}]*plug_credit_balance/s.test(supabaseClient)) {
  throw new Error('Client-side wallet balance mutation detected');
}
if (/endsWith\(['"]\.edu\.ng['"]\)|endsWith\(['"]\.edu['"]\)/.test(supabaseClient)) {
  throw new Error('Blanket EDU-domain acceptance detected');
}

console.log('Campus Plug security regression checks passed.');
