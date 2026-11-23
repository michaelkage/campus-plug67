import fs from 'node:fs'

const read = file => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
const migration = read('supabase/migrations/20261123190000_trust_reputation_integrity.sql')
const rewards = read('src/components/ui/IntegrityRewards.jsx')
const dispute = read('supabase/functions/process-dispute/index.ts')

for (const invariant of [
  'ADD COLUMN IF NOT EXISTS idempotency_key text',
  'plugscore_events_idempotency_uidx',
  'ON CONFLICT (idempotency_key)',
  "p_event_type NOT IN (",
  "auth.role() <> 'service_role'",
  'guard_profile_reputation_fields',
  "current_setting('app.trust_score_write',true)",
  'get_integrity_streak_progress',
  'claim_trust_achievement',
  "status='processing' AND updated_at<=now()-interval '5 minutes'",
  "status='completed',processed_at=now(),updated_at=now()",
  "plug_score=least(1000,greatest(0,COALESCE(plug_score,500)+event_row.points))",
]) if (!migration.includes(invariant)) throw new Error(`Trust migration invariant missing: ${invariant}`)

if (!migration.includes('FOR UPDATE SKIP LOCKED')) throw new Error('PlugScore worker must lock queue rows and permit concurrent workers')
if (!migration.includes('CREATE TRIGGER guard_profile_reputation_fields')) throw new Error('Profile score/badge writes must be guarded')
if (!migration.includes("array_append(COALESCE(badges,ARRAY[]::text[]),p_achievement)")) throw new Error('Achievement claim must preserve existing badges')
if (!migration.includes("ORDER BY COALESCE(released_at,updated_at,created_at) DESC")) throw new Error('Integrity streak must use the latest seller outcomes')

if (rewards.includes("from('profiles').update({ badges") || rewards.includes('plug_score: Math.min')) {
  throw new Error('Client must not directly mutate reputation fields')
}
for (const rpc of ["claim_trust_achievement","get_integrity_streak_progress"]) {
  if (!rewards.includes(`rpc('${rpc}'`)) throw new Error(`Integrity Rewards must use server RPC: ${rpc}`)
}
if (dispute.includes('from("profiles").update({ plug_score')) throw new Error('Dispute Edge Function must not mutate PlugScore directly')
if (!dispute.includes('admin.rpc("enqueue_plugscore_event"')) throw new Error('Juror reputation must use idempotent PlugScore event queue')
console.log('Trust and reputation integrity regression checks passed.')
