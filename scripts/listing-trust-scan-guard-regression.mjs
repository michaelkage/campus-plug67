import fs from 'node:fs'
import assert from 'node:assert/strict'

const migration = fs.readFileSync('supabase/migrations/20261126130000_listing_trust_scan_guard_compatibility.sql', 'utf8')
const guardStart = migration.indexOf('CREATE OR REPLACE FUNCTION public.guard_listing_lifecycle()')
const guardEnd = migration.indexOf('DROP TRIGGER IF EXISTS', guardStart)
const guard = migration.slice(guardStart, guardEnd)
const scannerStart = migration.indexOf('create or replace function public.scan_listing_trust')
const scanner = migration.slice(scannerStart)

for (const invariant of [
  'CREATE SCHEMA IF NOT EXISTS app_private AUTHORIZATION postgres',
  'CREATE TABLE IF NOT EXISTS app_private.listing_trust_scan_capabilities',
  'c.token::text = current_setting(\'app.listing_trust_scan_write\', true)',
  'c.transaction_id = txid_current()',
  'c.backend_pid = pg_backend_pid()',
  "to_jsonb(NEW) - ARRAY['plugpay_protected','visibility_score','trust_score','updated_at']",
  "to_jsonb(OLD) - ARRAY['plugpay_protected','visibility_score','trust_score','updated_at']",
  'Listing trust metadata is system-managed',
  'REVOKE ALL ON FUNCTION public.scan_listing_trust(uuid) FROM PUBLIC, anon, authenticated',
]) assert.ok(migration.includes(invariant), `Listing lifecycle guard missing: ${invariant}`)

assert.ok(migration.includes("set_config('app.listing_trust_scan_write', v_scan_capability::text, true)"))
assert.ok(migration.includes('DELETE FROM app_private.listing_trust_scan_capabilities'))
assert.ok(migration.includes("REVOKE ALL ON app_private.listing_trust_scan_capabilities FROM PUBLIC, anon, authenticated, service_role"))
assert.ok(scanner.includes('plugpay_protected = false'))
assert.ok(scanner.includes('visibility_score'))
assert.ok(scanner.includes('trust_score'))
assert.ok(scanner.includes('set_config('), 'Trust scanner must set and restore its private capability token')
assert.ok(!scanner.includes('SET status ='), 'Trust scanner must not change listing lifecycle status')

const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'))
assert.ok(packageJson.scripts['test:platform-integrity'].includes('scripts/listing-trust-scan-guard-regression.mjs'))

console.log('Listing trust scanner guard regression checks passed.')
