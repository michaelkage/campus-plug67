import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const fail = (message) => { throw new Error(message); };

const forbidden = [
  /service[_-]?role[_-]?key\s*[:=]\s*['"]ey/i,
  /jwt[_-]?secret\s*[:=]/i,
  /database[_-]?password\s*[:=]/i,
  /SUPABASE_SERVICE_ROLE_KEY\s*=\s*[^$\s]/i,
];

const walk = (dir) => {
  const out = [];
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue;
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(rel));
    else if (/\.(js|jsx|ts|tsx|sql|toml|yml|yaml|json|md)$/.test(entry.name)) out.push(rel);
  }
  return out;
};

for (const file of walk('.')) {
  const content = read(file);
  for (const pattern of forbidden) {
    if (pattern.test(content) && !file.endsWith('.env.example')) {
      fail('Potential committed secret material detected in ' + file);
    }
  }
}

const migration = read('supabase/migrations/049_postgis_api_hardening.sql');
const normalizedMigration = migration.replace(/\s+/g, '');
for (const signature of [
  'st_estimatedextent(text,text)',
  'st_estimatedextent(text,text,text)',
  'st_estimatedextent(text,text,text,boolean)',
]) {
  if (!normalizedMigration.includes(signature)) {
    fail('Missing PostGIS hardening for ' + signature);
  }
}
if (!/revoke execute on function public\.st_estimatedextent/i.test(migration)) {
  fail('PostGIS helper execution is not revoked from client roles');
}

const config = read('supabase/config.toml');
if (!/\[functions\.maintenance-cleanup\][\s\S]*?verify_jwt\s*=\s*false/.test(config)) {
  fail('maintenance-cleanup must disable gateway JWT verification and authenticate its secret key in the handler');
}
for (const fn of ['release-escrow', 'calculate-trending', 'process-dispute']) {
  const pattern = new RegExp('\\[functions\\.' + fn + '\\][\\s\\S]*?verify_jwt\\s*=\\s*false');
  if (!pattern.test(config)) fail(fn + ' must use API-key authentication for service-to-service calls');
}

const viewMigration = read('supabase/migrations/048_security_linter_hardening.sql');
if (!/alter view public\.public_profile_stats\s+set \(security_invoker = true\)/i.test(viewMigration)) {
  fail('public_profile_stats must use security-invoker behavior');
}
if (/alter table public\.spatial_ref_sys/i.test(viewMigration)) {
  fail('Do not alter extension-owned spatial_ref_sys in the hardening migration');
}

const groupChatSearchPathMigration = read('supabase/migrations/20261103113000_fix_group_chat_activity_search_path.sql');
if (!/alter function public\.touch_group_chat_activity\(\)\s+set search_path = ''/i.test(groupChatSearchPathMigration)) {
  fail('touch_group_chat_activity must use an empty search_path');
}

const profileStatsMigration = read('supabase/migrations/20261103114500_secure_public_profile_stats_rpc.sql');
if (!/create or replace function private\.get_public_profile_stats[\s\S]*?security definer[\s\S]*?set search_path = ''/i.test(profileStatsMigration)) {
  fail('Private public-profile stats helper must be SECURITY DEFINER with an empty search_path');
}
if (!/create or replace function public\.get_public_profile_stats[\s\S]*?security invoker[\s\S]*?set search_path = ''/i.test(profileStatsMigration)) {
  fail('Exposed public-profile stats RPC must be SECURITY INVOKER with an empty search_path');
}
if (!/grant select\s*\(\s*reviewee_id\s*,\s*score\s*\)\s*on table public\.ratings to authenticated/i.test(profileStatsMigration)) {
  fail('profile_ratings must use least-privilege source-column grants');
}
if (/grant select on table public\.ratings to (anon|authenticated)/i.test(profileStatsMigration)) {
  fail('Do not grant broad ratings table access to client roles');
}
if (!/alter view public\.profile_ratings set \(security_invoker = true\)/i.test(profileStatsMigration)) {
  fail('profile_ratings must use SECURITY INVOKER');
}
if (!/revoke select on table public\.public_profile_stats from public, anon, authenticated/i.test(profileStatsMigration)) {
  fail('Retire direct access to the legacy public_profile_stats view');
}
if (!/revoke insert, update, delete on table public\.profile_ratings from authenticated/i.test(profileStatsMigration)) {
  fail('profile_ratings must remain a read-only aggregate view');
}
if (!/rpc\('get_public_profile_stats'/i.test(read('src/pages/VerifyProfile.jsx'))) {
  fail('Public resume verification must use the least-privilege stats RPC');
}
if (!/rpc\('get_public_profile_stats'/i.test(read('src/lib/supabase/queries.ts'))) {
  fail('getPublicProfileStats must use the least-privilege stats RPC');
}
if (/from\('public_profile_stats'\)/i.test(read('src/pages/VerifyProfile.jsx'))) {
  fail('Public resume verification must not query the legacy view directly');
}
if (/schemas\s*=\s*\[[^\]]*["']private["']/i.test(config)) {
  fail('The private helper schema must not be exposed through the Supabase Data API');
}

const required = [
  ['src/lib/gpsSpoof.ts', 'increment_spoof_flag'],
  ['src/lib/security.ts', 'provision_my_emergency_tokens'],
  ['supabase/functions/release-escrow/index.ts', 'process_escrow_action'],
  ['supabase/functions/safe-arrival/index.ts', 'record_safe_arrival_v2'],
  ['supabase/functions/fund-wallet/index.ts', 'credit_wallet_funding_for_user'],
];
for (const [file, text] of required) {
  if (!read(file).includes(text)) fail(file + ' no longer contains required server-authoritative RPC ' + text);
}

console.log('Supabase security regression checks passed.');
