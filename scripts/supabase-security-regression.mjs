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

const profileDataMigration = read('supabase/migrations/20261103130000_lock_down_profile_data_api.sql');
if (!/create table if not exists public\.public_profiles/i.test(profileDataMigration)) {
  fail('A dedicated public_profiles projection must replace public reads from profiles');
}
if (!/alter table public\.public_profiles enable row level security/i.test(profileDataMigration)
    || !/create policy "Public profiles are readable by everyone"/i.test(profileDataMigration)) {
  fail('Public profile projection must be protected by an explicit RLS read policy');
}
const publicProjectionColumns = profileDataMigration.match(/create table if not exists public\.public_profiles\s*\(([\s\S]*?)\);/i)?.[1] ?? '';
if (!publicProjectionColumns
    || /\b(email|matric_number|last_known_ip|plug_credit_balance|balance|duress_code_hash|duress_qr_token_hash|collusion_flag|commission_rate)\b/i.test(publicProjectionColumns)) {
  fail('Public profile projection must exclude private account and security fields');
}
const privateProfileBody = profileDataMigration.match(/create or replace function private\.get_my_profile\(\)[\s\S]*?as \$function\$([\s\S]*?)\$function\$/i)?.[1] ?? '';
if (!/jsonb_build_object/i.test(privateProfileBody)) {
  fail('Private profile RPC must construct an explicit allowlisted response');
}
for (const privateField of ['last_known_ip', 'duress_code_hash', 'duress_qr_token_hash', 'commission_rate', 'collusion_flag', 'collusion_flagged_at', 'collusion_ceiling', 'gps_spoof_flags']) {
  if (privateProfileBody.includes(`'${privateField}'`)) {
    fail('Private profile RPC must not return ' + privateField);
  }
}
if (/revoke select on table public\.profiles/i.test(profileDataMigration)
    || !/profiles-table privilege cutover is intentionally a separate deployment/i.test(profileDataMigration)) {
  fail('Profile-table revocation must follow the frontend rollout in a separate migration');
}
if (!/create or replace function private\.get_my_profile[\s\S]*?security definer[\s\S]*?set search_path = ''[\s\S]*?auth\.uid\(\)/i.test(profileDataMigration)
    || !/create or replace function public\.get_my_profile[\s\S]*?security invoker[\s\S]*?set search_path = ''/i.test(profileDataMigration)) {
  fail('Private profile reads must use an auth.uid-scoped definer helper behind an invoker RPC');
}
if (!/create or replace function private\.get_my_referrals[\s\S]*?security definer[\s\S]*?auth\.uid\(\)/i.test(profileDataMigration)
    || !/create or replace function public\.get_my_referrals[\s\S]*?security invoker/i.test(profileDataMigration)) {
  fail('Referral reads must be scoped to the authenticated referrer');
}
if (!/revoke all on function public\.search_users_by_department\(text\)\s+from public, anon, authenticated, service_role/i.test(profileDataMigration)) {
  fail('Legacy full-profile search RPC must be disabled');
}
if (!/revoke all on function %s from public, anon, authenticated, service_role/i.test(profileDataMigration)) {
  fail('SECURITY DEFINER trigger functions must not be directly executable by client roles');
}

const authContext = read('src/contexts/AuthContext.tsx');
if (!/rpc\('get_my_profile'/i.test(authContext) || /from\('profiles'\)\.select\('\*'\)/i.test(authContext)) {
  fail('AuthContext must load private profile data through the scoped RPC');
}
for (const file of [
  'src/contexts/ThemeContext.tsx',
  'src/components/wallet/WalletDashboard.tsx',
  'src/pages/CampusWallet.tsx',
  'src/components/wallet/MicroEscrowLauncher.tsx',
]) {
  const source = read(file);
  if (!/rpc\('get_my_profile'/i.test(source) || /from\('profiles'\)\.select/i.test(source)) {
    fail(file + ' must read private profile fields through get_my_profile');
  }
}
for (const file of [
  'src/pages/Chat.jsx',
  'src/pages/Leaderboard.jsx',
  'src/pages/Profile.jsx',
  'src/components/chat/MarketplaceChat.tsx',
]) {
  if (!/from\('public_profiles'\)/i.test(read(file))) {
    fail(file + ' must use the safe public_profiles projection');
  }
}
if (!/rpc\('get_my_referrals'/i.test(read('src/components/ui/Referral.tsx'))
    || /from\('profiles'\)/i.test(read('src/components/ui/Referral.tsx'))) {
  fail('Referral UI must use the caller-scoped referral RPC');
}
if (/from\('profiles'\)/i.test(read('src/lib/passkeys.ts'))
    || !/userEmail: email\.trim\(\)\.toLowerCase\(\)/i.test(read('src/lib/passkeys.ts'))) {
  fail('Passkey login must resolve email server-side, not query private profiles from the browser');
}
if (!/admin\.from\("profiles"\)\.select\("id"\)\.eq\("email",normalizedEmail\)/i.test(read('supabase/functions/passkey-auth/index.ts'))) {
  fail('Passkey edge function must resolve account IDs using its service credential');
}
if (/collusion_flag/i.test(read('src/components/ui/TrustSignals.tsx'))) {
  fail('Internal collusion signals must not be displayed on public profiles');
}
if (!read('src/types/database.ts').includes('export interface PublicProfile')
    || !read('src/types/database.ts').includes('export interface MyProfile')) {
  fail('Public and private profile response types are required');
}
if (!read('src/lib/supabase/client.ts').includes('get_my_profile:{Args:Record<string,never>;Returns:MyProfile}')
    || !read('src/lib/supabase/client.ts').includes('get_my_referrals:{Args:Record<string,never>;Returns:MyReferral[]}')) {
  fail('Private profile RPCs must have explicit client types');
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
