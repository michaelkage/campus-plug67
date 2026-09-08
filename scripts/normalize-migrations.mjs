import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();

function removeStatements(source, statements, label) {
  let output = source;
  for (const statement of statements) {
    if (!output.includes(statement)) continue;
    output = output.replace(statement, '');
    console.log(`Normalized ${label}: removed duplicate statement.`);
  }
  return output;
}

// Migration 006 contains two historical PostgreSQL problems:
// 1. now() is not immutable and cannot be used in an index predicate.
// 2. These realtime publication memberships are already established by 001.
const migration006Path = path.join(root, 'supabase/migrations/006_social_gravity.sql');
let migration006 = fs.readFileSync(migration006Path, 'utf8');

const invalidIndex = `create index ticker_university_idx on public.ticker_events(university, created_at desc)\n  where expires_at > now();`;
const fixedIndex = `create index ticker_university_idx\n  on public.ticker_events(university, expires_at, created_at desc);`;

if (migration006.includes(invalidIndex)) {
  migration006 = migration006.replace(invalidIndex, fixedIndex);
  console.log('Normalized migration 006: removed volatile now() predicate from ticker_university_idx.');
} else if (migration006.includes(fixedIndex)) {
  console.log('Migration 006 ticker index is already normalized.');
} else {
  throw new Error('Migration 006 ticker index definition was not found; refusing an unsafe rewrite.');
}

migration006 = removeStatements(
  migration006,
  [
    'alter publication supabase_realtime add table public.ticker_events;',
    'alter publication supabase_realtime add table public.messages;',
    'alter publication supabase_realtime add table public.trending_listings;',
  ],
  'migration 006',
);

fs.writeFileSync(migration006Path, migration006);

// Migration 009 was written as a later integration pass but repeats objects
// already created by earlier migrations. PostgreSQL rejects duplicate policy,
// rule, and realtime-publication membership statements on a clean database.
// Keep 009's new objects and realtime memberships; remove only memberships
// already created by migrations 007/008.
const migration009Path = path.join(root, 'supabase/migrations/009_v67_integration.sql');
let migration009 = fs.readFileSync(migration009Path, 'utf8');

const duplicatePoliciesRulesAndRealtime = [
  `create policy "Parties see own cases" on public.jury_cases for select\n  using (auth.uid() = claimant_id or auth.uid() = respondent_id);`,
  `create policy "Assigned jurors see cases" on public.jury_cases for select\n  using (auth.uid() = any(jurors_assigned));`,
  `create policy "Service manages cases" on public.jury_cases for all using (auth.role() = 'service_role');`,
  `create policy "Jurors see own votes" on public.jury_votes for select using (auth.uid() = juror_id);`,
  `create policy "Jurors submit votes"  on public.jury_votes for insert with check (auth.uid() = juror_id);`,
  `create policy "Service manages votes" on public.jury_votes for all using (auth.role() = 'service_role');`,
  `create rule audit_no_update as on update to public.audit_logs do instead nothing;`,
  `create rule audit_no_delete as on delete to public.audit_logs do instead nothing;`,
  'alter publication supabase_realtime add table public.jury_cases;',
  'alter publication supabase_realtime add table public.jury_votes;',
  'alter publication supabase_realtime add table public.amber_confirmations;',
];

migration009 = removeStatements(
  migration009,
  duplicatePoliciesRulesAndRealtime,
  'migration 009',
);
fs.writeFileSync(migration009Path, migration009);
