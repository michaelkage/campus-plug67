import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const fail = (message) => { throw new Error(message); };

const migration = read('supabase/migrations/062_platform_integrity_ledger_observability.sql');
for (const required of [
  'create table if not exists public.payment_events',
  'unique (provider, event_id)',
  'create table if not exists public.financial_ledger',
  'create table if not exists public.transaction_state_transitions',
  'create table if not exists public.device_security_signals',
  'create table if not exists public.platform_observability_events',
  'record_transaction_state_transition',
  'record_financial_ledger_entry',
  'financial_ledger_balance',
  'alter table public.payment_events enable row level security',
  'alter table public.financial_ledger enable row level security',
  'alter table public.transaction_state_transitions enable row level security',
  'alter table public.device_security_signals enable row level security',
  'alter table public.platform_observability_events enable row level security',
]) if (!migration.includes(required)) fail(`Platform integrity migration missing: ${required}`);

const adminConsole = read('src/pages/AdminConsole.jsx');
if (!adminConsole.includes("['admin','platform_admin'].includes(String(user?.app_metadata?.role ?? ''))")) {
  fail('Admin console visibility must match the database platform-admin JWT role check');
}
if (adminConsole.includes("profile?.badges?.includes('Community Hero')") || adminConsole.includes("profile?.badges?.includes('Plug Dev')")) {
  fail('Public profile badges must not grant admin-console access');
}

const machine = read('src/lib/transactionStateMachine.ts');
for (const state of ['PENDING','LOCKED','MEETUP_INITIATED','RELEASE_REQUESTED','RELEASED','CANCELLED','DISPUTED','REFUNDED']) {
  if (!machine.includes(`'${state}'`)) fail(`Transaction state missing: ${state}`);
}

const config = read('supabase/config.toml');
if (!config.includes('project_id = "etwsfdovcgofhqseejjo"')) fail('Supabase project ref mismatch');


const groupsMigration = read('supabase/migrations/20261014180000_skills_department_groups_bulletin_and_purchase_conflicts.sql');
for (const required of [
  'CREATE POLICY "Users join matching department groups"',
  'DROP POLICY IF EXISTS "Owners update group chats" ON public.group_chats',
  'CREATE POLICY "Owners update matching department groups"',
  'g.university = p.university',
  'g.department = public.canonical_academic_department(p.department)',
  'department = public.canonical_academic_department(\n      (SELECT p.department FROM public.profiles p WHERE p.id = (SELECT auth.uid()))\n    )',
  'CREATE OR REPLACE FUNCTION public.canonical_academic_department(p_department text)',
  "WHEN 'Computer Science' THEN 'Sciences'",
  "WHEN 'Accounting' THEN 'Management Sciences'",
  "WHEN 'Nursing Science' THEN 'Medicine & Health Sciences'",
  'CREATE POLICY "Members read matching department messages"',
  'CREATE POLICY "Members send matching department messages"',
  'sender_id = (SELECT auth.uid())',
]) if (!groupsMigration.includes(required)) fail(`Department group RLS missing: ${required}`);

const atomicGroups = read('supabase/migrations/20261022193500_atomic_department_group_creation.sql');
for (const required of [
  'CREATE OR REPLACE FUNCTION public.create_department_group_with_owner',
  'INSERT INTO public.group_chats',
  "INSERT INTO public.group_chat_members (group_id, user_id, role)",
  'public.canonical_academic_department(v_profile.department)',
  "VALUES (v_group.id, v_user, 'owner')",
  'REVOKE ALL ON FUNCTION public.create_department_group_with_owner(text, text) FROM PUBLIC, anon',
  'GRANT EXECUTE ON FUNCTION public.create_department_group_with_owner(text, text) TO authenticated',
]) if (!atomicGroups.includes(required)) fail(`Atomic group creation invariant missing: ${required}`);

const campusHub = read('src/pages/CampusHub.tsx');
for (const required of [
  "const LEGACY_DEPARTMENT_GROUPS",
  "'Computer Science'",
  "'Nursing Science'",
  "'Accounting'",
  'LEGACY_DEPARTMENT_TO_FACULTY[department?.trim()]',
  ".eq('department',canonicalAcademicDepartment(department))",
  "queryKey:['groups',university,canonicalAcademicDepartment(department)]",
]) if (!campusHub.includes(required)) fail(`Campus Hub legacy department filter missing: ${required}`);

if (!campusHub.includes("supabase.rpc('create_department_group_with_owner'")) {
  fail('Campus Hub must use the atomic group-creation RPC');
}


const featureMigration = read('supabase/migrations/20261014180000_skills_department_groups_bulletin_and_purchase_conflicts.sql');
for (const protectedRpc of [
  'create_wallet_micro_escrow',
  'create_pending_paystack_transaction',
  'resolve_wallet_micro_escrow',
]) {
  if (new RegExp('CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+public\\.' + protectedRpc + '\\s*\\(', 'i').test(featureMigration)) {
    fail(`Feature migration must not replace main's protected wallet RPC: ${protectedRpc}`);
  }
}


const bulletinMigration = read('supabase/migrations/20261014180000_skills_department_groups_bulletin_and_purchase_conflicts.sql');
for (const required of [
  'ALTER TABLE public.campus_bulletins ENABLE ROW LEVEL SECURITY',
  'CREATE POLICY "Campus users read bulletins"',
  'CREATE POLICY "Trusted campus moderators publish bulletins"',
  "created_by = (SELECT auth.uid())",
  "university = (SELECT p.university FROM public.profiles p WHERE p.id = (SELECT auth.uid()))",
  "COALESCE(p.badges, ARRAY[]::text[]) @> ARRAY['Plug Dev']",
  "COALESCE(p.badges, ARRAY[]::text[]) @> ARRAY['Community Hero']",
  'CREATE POLICY "Bulletin authors update own posts"',
  'CREATE POLICY "Bulletin authors delete own posts"',
]) if (!bulletinMigration.includes(required)) fail(`Bulletin security invariant missing: ${required}`);

const bulletinDeletePolicy = bulletinMigration.split('CREATE POLICY "Bulletin authors delete own posts"')[1] || '';
if (!bulletinDeletePolicy.includes('university = (SELECT p.university FROM public.profiles p WHERE p.id = (SELECT auth.uid()))')) {
  fail('Bulletin delete policy must enforce the author’s current campus boundary');
}
if (!bulletinDeletePolicy.includes('created_by = (SELECT auth.uid())')) {
  fail('Bulletin delete policy must restrict deletion to the author');
}

const bulletinPage = read('src/pages/NewsBulletin.tsx');
for (const required of [
  "profile?.badges?.includes('Plug Dev')",
  "profile?.badges?.includes('Community Hero')",
  ".eq('university',profile.university)",
  ".eq('created_by',profile?.id)",
]) if (!bulletinPage.includes(required)) fail(`Bulletin UI invariant missing: ${required}`);

const deployWorkflow = read('.github/workflows/deploy-supabase.yml');
for (const required of [
  'pull_request:',
  'types: [closed]',
  "if: github.event_name != 'pull_request' || github.event.pull_request.merged == true",
  'supabase db push --linked --include-all',
]) if (!deployWorkflow.includes(required)) fail(`Supabase deployment workflow missing merged-PR safety invariant: ${required}`);

console.log('Platform integrity regression checks passed.');


const auditWriter = read('supabase/migrations/20261027110000_scope_client_audit_writer.sql');
for (const required of [
  "trim(p_entity_type) <> 'message' OR trim(p_action) NOT IN ('edit', 'delete')",
  'm.sender_id = actor',
  'm.id = p_entity_id',
  'metadata_value->>\'original_content\' IS DISTINCT FROM current_content',
  "metadata_value->>'new_content' IS NULL",
  "length(metadata_value->>'new_content') > 10000",
  "REVOKE ALL ON FUNCTION public.write_security_audit(text, uuid, text, jsonb) FROM PUBLIC, anon",
  "GRANT EXECUTE ON FUNCTION public.write_security_audit(text, uuid, text, jsonb) TO authenticated, service_role",
]) if (!auditWriter.includes(required)) fail(`Audit writer scope invariant missing: ${required}`);

if (!auditWriter.includes('FOR UPDATE')) fail('Audit writer must lock the owned message while validating its original content');
if (!auditWriter.includes("IF auth.role() <> 'service_role' THEN")) fail('Generic audit writes must remain limited to trusted service-role callers');

const skuRpcPrivileges = read('supabase/migrations/20261027120000_restrict_global_sku_rpc.sql');
for (const required of [
  'REVOKE ALL ON FUNCTION public.match_global_sku(text) FROM PUBLIC, anon',
  'GRANT EXECUTE ON FUNCTION public.match_global_sku(text) TO authenticated',
]) if (!skuRpcPrivileges.includes(required)) fail(`Global SKU RPC privilege invariant missing: ${required}`);
