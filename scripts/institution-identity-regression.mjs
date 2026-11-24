import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = file => fs.readFileSync(path.join(root, file), 'utf8')
const migration = read('supabase/migrations/20261123200000_multi_university_identity.sql')
const settings = read('src/pages/Settings.jsx')
const campusPanel = read('src/components/settings/CampusVerificationPanel.jsx')
const auth = read('src/contexts/AuthContext.tsx')
const types = read('src/types/database.ts')
const keys = read('src/lib/queryKeys.ts')

for (const invariant of [
  'CREATE TABLE IF NOT EXISTS public.institutions',
  'CREATE TABLE IF NOT EXISTS public.institution_memberships',
  'ADD COLUMN IF NOT EXISTS institution_id uuid',
  'allowed_domains_institution_id_fkey',
  'CREATE UNIQUE INDEX IF NOT EXISTS institution_memberships_one_primary_uidx',
  'ALTER TABLE public.institutions ENABLE ROW LEVEL SECURITY',
  'ALTER TABLE public.institution_memberships ENABLE ROW LEVEL SECURITY',
  'user_id = auth.uid()',
  'auth.users',
  'email_confirmed_at',
  'public.claim_my_institution_membership()',
  'public.set_my_primary_institution(uuid)',
  "current_setting('app.institution_write', true)",
  'verified_email_domain',
  "status = 'suspended'",
]) {
  if (!migration.includes(invariant)) throw new Error(`Missing institution identity SQL invariant: ${invariant}`)
}
if (migration.includes('GRANT INSERT ON public.institution_memberships TO authenticated')) {
  throw new Error('Clients must not directly create institution memberships')
}
if (migration.includes('GRANT UPDATE ON public.institution_memberships TO authenticated')) {
  throw new Error('Clients must not directly update institution memberships')
}
for (const invariant of [
  "supabase.rpc('claim_my_institution_membership')",
  "supabase.rpc('set_my_primary_institution'",
  "from('institution_memberships')",
  "from('institutions')",
  'Verified memberships',
]) {
  if (!campusPanel.includes(invariant)) throw new Error(`Campus settings integration is missing: ${invariant}`)
}
if (campusPanel.includes('setUniversity') || campusPanel.includes('saveUniversity')) {
  throw new Error('Settings must not expose free-text university identity editing')
}
if (auth.includes("update({university:") || auth.includes('university:university||detectedUni')) {
  throw new Error('Auth client must not write client-supplied university identity')
}
if (!auth.includes("supabase.rpc('claim_my_institution_membership')")) {
  throw new Error('Auth hydration must claim membership only through the verified-email RPC')
}
for (const invariant of ['institution_memberships: {','institutions: {','primary_institution_id?: string | null']) {
  if (!types.includes(invariant)) throw new Error(`Database contract is missing: ${invariant}`)
}
for (const invariant of ['directory:', 'memberships: (userId: string)']) {
  if (!keys.includes(invariant)) throw new Error(`Institution query key is missing: ${invariant}`)
}
console.log('Multi-university identity and campus infrastructure regression checks passed.')
