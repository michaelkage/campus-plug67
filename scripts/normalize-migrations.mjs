import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const migration = path.join(root, 'supabase/migrations/006_social_gravity.sql');
const before = fs.readFileSync(migration, 'utf8');
const invalid = `create index ticker_university_idx on public.ticker_events(university, created_at desc)\n  where expires_at > now();`;
const fixed = `create index ticker_university_idx\n  on public.ticker_events(university, expires_at, created_at desc);`;

if (before.includes(invalid)) {
  fs.writeFileSync(migration, before.replace(invalid, fixed));
  console.log('Normalized migration 006: removed volatile now() predicate from ticker_university_idx.');
} else if (before.includes(fixed)) {
  console.log('Migration 006 is already normalized.');
} else {
  throw new Error('Migration 006 ticker index definition was not found; refusing an unsafe rewrite.');
}
