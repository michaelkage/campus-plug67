import fs from 'node:fs'
import assert from 'node:assert/strict'

const migration = fs.readFileSync('supabase/migrations/20261126130000_listing_trust_scan_guard_compatibility.sql', 'utf8')
const guardStart = migration.indexOf('CREATE OR REPLACE FUNCTION public.guard_listing_lifecycle()')
const guardEnd = migration.indexOf('DROP TRIGGER IF EXISTS', guardStart)
const guard = migration.slice(guardStart, guardEnd)
const scannerStart = migration.indexOf('create or replace function public.scan_listing_trust')
const scanner = migration.slice(scannerStart)

for (const invariant of [
  'pg_trigger_depth() > 1',
  "to_jsonb(NEW) - ARRAY['plugpay_protected','visibility_score','trust_score','updated_at']",
  "to_jsonb(OLD) - ARRAY['plugpay_protected','visibility_score','trust_score','updated_at']",
  'Listing trust metadata is system-managed',
  'REVOKE ALL ON FUNCTION public.scan_listing_trust(uuid) FROM PUBLIC, anon, authenticated',
]) assert.ok(migration.includes(invariant), `Listing lifecycle guard missing: ${invariant}`)

assert.ok(!migration.includes('listing_trust_scan_write'), 'No client-settable custom GUC may authorize trust metadata writes')
assert.ok(scanner.includes('plugpay_protected = false'))
assert.ok(scanner.includes('visibility_score'))
assert.ok(scanner.includes('trust_score'))
assert.ok(!scanner.includes('set_config('), 'Trust scanner must not rely on a client-settable session flag')
assert.ok(!scanner.includes('SET status ='), 'Trust scanner must not change listing lifecycle status')

const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'))
assert.ok(packageJson.scripts['test:platform-integrity'].includes('scripts/listing-trust-scan-guard-regression.mjs'))

console.log('Listing trust scanner guard regression checks passed.')
