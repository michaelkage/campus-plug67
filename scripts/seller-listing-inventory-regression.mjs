import fs from 'node:fs'
import assert from 'node:assert/strict'

const read = path => fs.readFileSync(new URL(path, import.meta.url), 'utf8')
const migration = read('../supabase/migrations/20261123150000_harden_seller_listing_inventory_controls.sql')
const panel = read('../src/features/marketplace/SellerInventoryPanel.jsx')
const types = read('../src/types/database.ts')

assert.match(migration, /auth\.role\(\)\s*=\s*'service_role'/, 'Service-side settlement must retain authority over listing status')
assert.match(migration, /auth\.uid\(\)\s*<>\s*OLD\.seller_id/, 'Only the authenticated listing owner may manage the listing')
assert.match(migration, /OLD\.status\s*=\s*'active'\s+AND\s+NEW\.status\s*=\s*'deleted'/, 'Seller archive transition must be explicit')
assert.match(migration, /OLD\.status\s+IN\s+\('deleted','removed'\)\s+AND\s+NEW\.status\s*=\s*'active'/, 'Archived listing restoration must include legacy removed rows')
assert.match(migration, /Listing status is managed by the transaction system/, 'Seller must not mark an item reserved, sold or pending')
assert.match(migration, /status IN \('pending','locked','meetup_initiated','release_requested','disputed'\)/, 'Archive and restore must reject active transactions')
assert.match(migration, /OLD\.status\s*=\s*'reserved'/, 'Reserved inventory must remain locked')
assert.match(migration, /OLD\.status\s*=\s*'sold'/, 'Sold inventory must remain immutable')
assert.match(panel, /\.eq\('seller_id', sellerId\)/, 'Inventory reads and writes must be scoped to the seller')
assert.match(panel, /\.eq\('status', fromStatus\)/, 'Inventory status updates must be compare-and-set operations')
assert.match(panel, /toStatus: 'deleted'/, 'Seller panel must archive using the guarded status transition')
assert.match(types, /'removed' \| 'deleted'/, 'Database types must represent both archived status values')

console.log('Seller listing inventory regression checks passed.')
