import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const fail = (message) => { throw new Error(message); };
const exists = (file) => fs.existsSync(path.join(root, file));
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

// 1. Canonical repository inputs must exist.
for (const file of [
  'package.json',
  'package-lock.json',
  'supabase/config.toml',
  '.github/workflows/production-validation.yml',
  '.github/workflows/maintenance.yml',
  '.github/workflows/deploy-supabase.yml',
  'RECOVERY_PLAN.md',
]) {
  if (!exists(file)) fail(`Production readiness: required file missing: ${file}`);
}

// 2. Migration filenames must have unique numeric versions.
const migrationDir = path.join(root, 'supabase', 'migrations');
const versions = new Map();
for (const name of fs.readdirSync(migrationDir)) {
  if (!name.endsWith('.sql')) continue;
  const match = name.match(/^(\d+)_/);
  if (!match) fail(`Production readiness: migration has no numeric version prefix: ${name}`);
  const version = match[1];
  const previous = versions.get(version);
  if (previous) fail(`Production readiness: duplicate migration version ${version}: ${previous} and ${name}`);
  versions.set(version, name);
}

// 3. The validation workflow must remain a real clean-room gate.
const validation = read('.github/workflows/production-validation.yml');
for (const required of [
  'supabase start',
  'supabase db reset --local',
  'deno@2.1.4 check',
  'gitleaks/gitleaks-action@v2',
  'npm run typecheck',
  'npm run build',
]) {
  if (!validation.includes(required)) fail(`Production readiness: validation workflow lost required gate: ${required}`);
}

// 4. Production deployment must not silently run without credential checks.
const deploy = read('.github/workflows/deploy-supabase.yml');
for (const secret of ['SUPABASE_ACCESS_TOKEN', 'SUPABASE_DB_PASSWORD', 'SUPABASE_URL', 'SUPABASE_ANON_KEY']) {
  if (!deploy.includes(`secrets.${secret}`)) fail(`Production readiness: deploy workflow is missing secret reference: ${secret}`);
}

// 5. Maintenance must use the service-role key only through GitHub Actions secrets.
const maintenance = read('.github/workflows/maintenance.yml');
if (!maintenance.includes('secrets.SUPABASE_SERVICE_ROLE_KEY')) fail('Production readiness: maintenance service-role secret is not configured');
if (!maintenance.includes('secrets.SUPABASE_URL')) fail('Production readiness: maintenance Supabase URL secret is not configured');
if (!maintenance.includes('cancel-in-progress: false')) fail('Production readiness: maintenance concurrency must not cancel cleanup runs');

// 6. The service-role key must never be represented as a VITE/browser variable.
const envExample = read('.env.example');
if (/VITE_[A-Z0-9_]*(SERVICE_ROLE|SECRET|PRIVATE|PASSWORD)/i.test(envExample)) {
  fail('Production readiness: service-role/private credential exposed as VITE environment variable');
}

// 7. Edge Function inventory must contain real entrypoints; shared code is excluded.
const functionsDir = path.join(root, 'supabase', 'functions');
const functions = fs.readdirSync(functionsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name !== '_shared')
  .map((entry) => entry.name)
  .sort();
if (functions.length === 0) fail('Production readiness: no Edge Functions found');
for (const fn of functions) {
  if (!exists(`supabase/functions/${fn}/index.ts`)) fail(`Production readiness: Edge Function ${fn} has no index.ts`);
}

// 8. Config must explicitly identify service-to-service functions whose platform JWT verifier is disabled.
const config = read('supabase/config.toml');
for (const fn of ['passkey-auth', 'paystack-webhook', 'release-escrow', 'calculate-trending', 'process-dispute', 'maintenance-cleanup']) {
  if (!config.includes(`[functions.${fn}]`) || !config.includes(`verify_jwt = false`)) {
    fail(`Production readiness: function config missing explicit verify_jwt=false entry for ${fn}`);
  }
}

// 9. The recovery plan must not be mistaken for the current source of truth.
// It is historical documentation, so Phase 18 records the current production state separately.
const recovery = read('RECOVERY_PLAN.md');
if (!recovery.includes('Recovery Status')) fail('Production readiness: recovery document lost its status marker');

// 10. Required production secrets cannot be inspected through the repository API.
// The workflow itself is the authoritative runtime check; never invent secret values in source.
console.log(`Production readiness checks passed: ${versions.size} unique migrations, ${functions.length} Edge Functions, CI/deploy/maintenance gates present.`);
console.log('Runtime-only checks remain: GitHub secret presence, real staging authorization tests, and backup restoration.');
