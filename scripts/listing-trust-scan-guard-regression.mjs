import fs from 'node:fs'
import assert from 'node:assert/strict'

const migration = fs.readFileSync('supabase/migrations/20261126130000_listing_trust_scan_guard_compatibility.sql', 'utf8')
const guardStart = migration.indexOf('CREATE OR REPLACE FUNCTION public.guard_listing_lifecycle()')
const guardEnd = migration.indexOf('DROP TRIGGER IF EXISTS', guardStart)
const guard = migration.slice(guardStart, guardEnd)
const scannerStart = migration.indexOf('create or replace function public.scan_listing_trust')
const scanner = migration.slice(scannerStart)

for (const invariant of [
  "current_setting('app.listing_trust_scan_write', true) = 'true'",
  "to_jsonb(NEW) - ARRAY['plugpay_protected','visibility_score','trust_score']",
  "to_jsonb(OLD) - ARRAY['plugpay_protected','visibility_score','trust_score']",
  "current_setting('app.listing_trust_scan_write', true) IS DISTINCT FROM 'true'",
  'Listing trust metadata is system-managed',
]) assert.ok(guard.includes(invariant), `Listing lifecycle guard missing: ${invariant}`)

assert.ok(scanner.includes("current_setting('app.listing_trust_scan_write', true)"))
assert.ok(scanner.includes("set_config('app.listing_trust_scan_write', 'true', true)"))
assert.ok(scanner.includes('set_config(\'app.listing_trust_scan_write\', previous_scan_flag, true)'))
assert.ok(scanner.includes('plugpay_protected = false'))
assert.ok(scanner.includes('visibility_score'))
assert.ok(scanner.includes('trust_score'))
assert.ok(!scanner.includes('SET status ='), 'Trust scanner must not change listing lifecycle status')

const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'))
assert.ok(packageJson.scripts['test:platform-integrity'].includes('scripts/listing-trust-scan-guard-regression.mjs'))

console.log('Listing trust scanner guard regression checks passed.')
