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
if (/hostel_reviews|group_buy_participants|group_buy_pools/i.test(profileStatsMigration)) {
  fail('Public profile stats RPC must not depend on production-only, untracked tables');
}
if (!/public\.listing_exif_flags/i.test(profileStatsMigration) || !/active_listings/i.test(profileStatsMigration)) {
  fail('Public profile stats RPC must preserve the canonical EXIF and active-listing metrics');
}
if (!/left join public\.profile_ratings as rating_stats/i.test(profileStatsMigration)) {
  fail('Public profile stats RPC must use the aggregate profile_ratings view');
}
if (!/create or replace function public\.get_public_profile_stats[\s\S]*?security invoker[\s\S]*?set search_path = ''/i.test(profileStatsMigration)) {
  fail('Exposed public-profile stats RPC must be SECURITY INVOKER with an empty search_path');
}
if (/grant select[^;]*on table public\.ratings to (anon|authenticated)/i.test(profileStatsMigration)) {
  fail('Do not grant raw rating access to client roles');
}
if (!/alter view public\.profile_ratings set \(security_invoker = true\)/i.test(profileStatsMigration)) {
  fail('profile_ratings must use SECURITY INVOKER');
}
if (!/revoke all privileges on table public\.public_profile_stats from public, anon, authenticated/i.test(profileStatsMigration)) {
  fail('Retire all direct access to the legacy public_profile_stats view');
}
if (!/revoke all privileges on table public\.profile_ratings from public, anon, authenticated/i.test(profileStatsMigration)) {
  fail('profile_ratings must not be directly accessible to client roles');
}
if (!/rpc\('get_public_profile_stats'/i.test(read('src/pages/VerifyProfile.jsx'))) {
  fail('Public resume verification must use the least-privilege stats RPC');
}
if (!/rpc\('get_public_profile_stats'/i.test(read('src/lib/supabase/queries.ts'))) {
  fail('getPublicProfileStats must use the least-privilege stats RPC');
}
if (!read('src/lib/supabase/client.ts').includes('get_public_profile_stats:{Args:{p_profile_id:string};Returns:PublicProfileVerificationStats}')) {
  fail('Public profile stats RPC must be typed in the Supabase client');
}
if (!read('src/types/database.ts').includes('export interface PublicProfileVerificationStats')) {
  fail('Public profile stats RPC response type is missing');
}
if (/from\('profile_ratings'\)/i.test(read('src/pages/Profile.jsx'))) {
  fail('Profile rating summaries must use the public stats RPC, not raw aggregate views');
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

const rpcAccessMigration = read('supabase/migrations/20261103133000_restrict_security_definer_rpc_access.sql');
const compactRpcMigration = rpcAccessMigration.toLowerCase().replace(/\\s+/g, '');
const workerOnlyFunctions = [
  ['atomic_pool_join', 'uuid, uuid, text'],
  ['consume_session_handoff', 'text'],
  ['expire_flash_deals', ''],
  ['increment_view_count', 'uuid'],
  ['update_streak', 'uuid'],
  ['update_juror_accuracy', 'uuid'],
];
for (const [name, args] of workerOnlyFunctions) {
  const signature = 'public.' + name + '(' + args.replace(/\\s/g, '') + ')';
  if (!compactRpcMigration.includes('revokeallonfunction' + signature + 'frompublic,anon,authenticated')) {
    fail(name + ' must be unavailable to browser roles');
  }
  if (!compactRpcMigration.includes('grantexecuteonfunction' + signature + 'toservice_role')) {
    fail(name + ' must remain available to trusted Edge workers');
  }
}

for (const name of [
  'assign_jurors',
  'delete_user_data',
  'export_user_data',
  'search_users_by_department',
  'check_priority_relist',
  'scan_listing_trust',
  'reconcile_student_escrow',
]) {
  if (!compactRpcMigration.includes('revokeallonfunctionpublic.' + name + '(')) {
    fail(name + ' legacy/helper RPC must not be executable by API roles');
  }
}

const ghostStart = rpcAccessMigration.indexOf('CREATE OR REPLACE FUNCTION public.check_ghost_refund');
const priorityStart = rpcAccessMigration.indexOf('CREATE OR REPLACE FUNCTION public.check_priority_relist_v2');
const postgisStart = rpcAccessMigration.indexOf('-- The installed PostGIS package');
const ghostBody = rpcAccessMigration.slice(ghostStart, priorityStart);
const priorityBody = rpcAccessMigration.slice(priorityStart, postgisStart);
if (ghostStart < 0 || priorityStart < 0 || !ghostBody.includes('auth.uid()') ||
    !ghostBody.includes('buyer_id = actor OR seller_id = actor') ||
    !ghostBody.includes('IF tx.buyer_id <> actor')) {
  fail('Ghost-refund eligibility must be bound to the authenticated buyer/transaction participant');
}
if (!priorityBody.includes('auth.uid()') ||
    !priorityBody.includes('buyer_id = actor OR seller_id = actor') ||
    !priorityBody.includes('IF tx.seller_id <> actor')) {
  fail('Priority relist eligibility must be bound to the authenticated seller/transaction participant');
}
if (!compactRpcMigration.includes('revokeexecuteonfunctionpublic.st_estimatedextent')) {
  fail('PostGIS helper execution must be re-revoked after extension ACL drift');
}
if (!rpcAccessMigration.includes("p.prorettype = 'trigger'::regtype")) {
  fail('SECURITY DEFINER trigger functions must not remain directly executable by API roles');
}
if (/p_is_correct/.test(read('supabase/functions/process-dispute/index.ts'))) {
  fail('update_juror_accuracy call must match the deployed one-argument RPC signature');
}

console.log('Supabase security regression checks passed.');