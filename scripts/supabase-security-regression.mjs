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
      fail(`Potential committed secret material detected in ${file}`);
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
    fail(`Missing PostGIS hardening for ${signature}`);
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
  const pattern = new RegExp(`\\[functions\\.${fn}\\][\\s\\S]*?verify_jwt\\s*=\\s*false`);
  if (!pattern.test(config)) fail(`${fn} must use API-key authentication for service-to-service calls`);
}

const viewMigration = read('supabase/migrations/048_security_linter_hardening.sql');
if (!/alter view public\.public_profile_stats\s+set \(security_invoker = true\)/i.test(viewMigration)) {
  fail('public_profile_stats must use security-invoker behavior');
}
if (/alter table public\.spatial_ref_sys/i.test(viewMigration)) {
  fail('Do not alter extension-owned spatial_ref_sys in the hardening migration');
}

const required = [
  ['src/lib/gpsSpoof.ts', 'increment_spoof_flag'],
  ['src/lib/security.ts', 'provision_my_emergency_tokens'],
  ['supabase/functions/release-escrow/index.ts', 'process_escrow_action'],
  ['supabase/functions/safe-arrival/index.ts', 'record_safe_arrival_v2'],
  ['supabase/functions/fund-wallet/index.ts', 'credit_wallet_funding_for_user'],
];
for (const [file, text] of required) {
  if (!read(file).includes(text)) fail(`${file} no longer contains required server-authoritative RPC ${text}`);
}

console.log('Supabase security regression checks passed.');
