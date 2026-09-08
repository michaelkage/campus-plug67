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

const publicationStatements = [
  'alter publication supabase_realtime add table public.ticker_events;',
  'alter publication supabase_realtime add table public.messages;',
  'alter publication supabase_realtime add table public.trending_listings;',
];

for (const statement of publicationStatements) {
  if (!before.includes(statement)) continue;

  const match = statement.match(/add table public\.([a-z_]+);/i);
  if (!match) throw new Error(`Could not parse realtime publication statement: ${statement}`);

  const table = match[1];
  const safeBlock = `do $$\nbegin\n  if not exists (\n    select 1\n    from pg_publication_tables\n    where pubname = 'supabase_realtime'\n      and schemaname = 'public'\n      and tablename = '${table}'\n  ) then\n    alter publication supabase_realtime add table public.${table};\n  end if;\nend;\n$$;`;

  before = before.replace(statement, safeBlock);
}

fs.writeFileSync(migration, before);
console.log('Normalized migration 006: made supabase_realtime publication membership idempotent.');
