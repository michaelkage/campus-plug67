import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const migration = path.join(root, 'supabase/migrations/006_social_gravity.sql');
let before = fs.readFileSync(migration, 'utf8');

const invalid = `create index ticker_university_idx on public.ticker_events(university, created_at desc)\n  where expires_at > now();`;
const fixed = `create index ticker_university_idx\n  on public.ticker_events(university, expires_at, created_at desc);`;

if (before.includes(invalid)) {
  before = before.replace(invalid, fixed);
  console.log('Normalized migration 006: removed volatile now() predicate from ticker_university_idx.');
} else if (before.includes(fixed)) {
  console.log('Migration 006 ticker index is already normalized.');
} else {
  throw new Error('Migration 006 ticker index definition was not found; refusing an unsafe rewrite.');
}

// Migration 001 already establishes the realtime publication membership used by
// this project. Re-adding these tables makes a clean local Supabase bootstrap
// fail with SQLSTATE 42710 because PostgreSQL rejects duplicate publication
// membership. Leave publication management to the canonical schema migration.
const publicationStatements = [
  'alter publication supabase_realtime add table public.ticker_events;',
  'alter publication supabase_realtime add table public.messages;',
  'alter publication supabase_realtime add table public.trending_listings;',
];

for (const statement of publicationStatements) {
  if (!before.includes(statement)) continue;
  before = before.replace(statement, '');
  console.log(`Normalized migration 006: removed duplicate realtime publication statement for ${statement.match(/public\\.([a-z_]+)/i)?.[1] ?? 'table'}.`);
}

fs.writeFileSync(migration, before);
