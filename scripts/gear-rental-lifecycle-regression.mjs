import fs from 'node:fs'
import assert from 'node:assert/strict'

const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const migration = read('supabase/migrations/20261103200000_secure_gear_rental_lifecycle.sql')

const required = [
  'CREATE OR REPLACE FUNCTION public.create_gear_rental_request',
  'CREATE OR REPLACE FUNCTION public.create_gear_rental_pickup_code',
  'CREATE OR REPLACE FUNCTION public.confirm_gear_rental_pickup',
  'CREATE OR REPLACE FUNCTION public.create_gear_rental_return_code',
  'CREATE OR REPLACE FUNCTION public.confirm_gear_rental_return',
  'CREATE OR REPLACE FUNCTION public.cancel_gear_rental_request',
  'CREATE OR REPLACE FUNCTION public.open_gear_rental_dispute',
  'CREATE OR REPLACE FUNCTION public.resolve_gear_rental_dispute',
  'gear_rentals_borrower_request_key_uidx',
  'daterange(r.start_date, r.end_date, \'[]\') && daterange(p_start_date, p_end_date, \'[]\')',
  'FOR UPDATE',
  "t.status IN ('pending','locked','meetup_initiated','release_requested','disputed')",
  'ORDER BY p.id',
  'extensions.gen_random_bytes(4)',
  'extensions.digest(v_code, \'sha256\')',
  'pickup_code_expires_at < now()',
  'pickup_code_attempts + 1 >= 5',
  'Pickup is not available before the reserved start date',
  'The reserved rental period has expired',
  'return_code_expires_at < now()',
  'return_code_attempts + 1 >= 5',
  'Campus Plug gear rental escrow hold',
  'Gear rental fee released after return',
  'Gear rental security deposit returned',
  'Service role required',
  'IF p_admin_id IS NULL THEN RAISE EXCEPTION \'Admin identity is required\'; END IF;',
  'resolved_by = p_admin_id',
  'guard_listing_sale_during_rental',
  "v_listing.listing_mode <> 'both'",
  "r.rental_status IN ('funds_escrowed','active','return_pending','disputed')",
  'REVOKE INSERT, UPDATE, DELETE ON public.gear_rentals, public.gear_rental_holds',
  'GRANT EXECUTE ON FUNCTION public.resolve_gear_rental_dispute(uuid,integer,uuid) TO service_role',
]
for (const item of required) assert.ok(migration.includes(item), `Missing rental lifecycle invariant: ${item}`)

assert.ok(migration.indexOf('INSERT INTO public.gear_rental_holds') < migration.indexOf('INSERT INTO public.plug_credit_ledger (user_id, amount, reason, reference_id)\n  VALUES (v_borrower'), 'Rental hold and debit must be committed in the same RPC transaction')
assert.ok(migration.includes("UPDATE public.gear_rentals\n     SET rental_status = 'completed', current_state = 'returned_to_owner'"), 'Return confirmation must complete custody')
assert.ok(migration.includes("UPDATE public.gear_rental_holds SET status = 'settled', settled_at = now()"), 'Settlement must be one-time')
assert.ok(!migration.includes('public.transactions ('), 'Rentals must not enter purchase transaction settlement')


const marketplace = read('src/pages/Marketplace.jsx')
for (const item of [
  "listing_mode: 'sale'",
  'rental_daily_rate_kobo:',
  'rental_security_deposit_kobo:',
  "option value=\"both\">Sell and rent</option>",
  'Rental rate per day (₦)',
]) assert.ok(marketplace.includes(item), `Marketplace listing form missing: ${item}`)

const detail = read('src/pages/ListingDetail.jsx')
assert.ok(detail.includes("import GearRentalPanel from '@/components/gear/GearRentalPanel'"), 'Listing detail must expose the rental workflow')
assert.ok(detail.includes('{listing.listing_mode === \'both\' && <GearRentalPanel listing={listing} />}'), 'Dual-mode listings must show rental actions')

const panel = read('src/components/gear/GearRentalPanel.tsx')
for (const item of [
  "create_gear_rental_request",
  "create_gear_rental_pickup_code",
  "confirm_gear_rental_pickup",
  "create_gear_rental_return_code",
  "confirm_gear_rental_return",
  "cancel_gear_rental_request",
  "open_gear_rental_dispute",
  "Campus Wallet escrow",
  "15 minutes",
]) assert.ok(panel.includes(item), `Rental UI missing lifecycle action: ${item}`)


const app = read('src/App.tsx')
assert.ok(app.includes("const MyRentals=lazy(()=>import('@/pages/MyRentals'))"), 'My Rentals page must be lazy-loaded')
assert.ok(app.includes('<Route path="rentals" element={<MyRentals/>}/>'), 'My Rentals route must be registered')

const nav = read('src/components/layout/TopNav.jsx')
assert.ok(nav.includes("['/rentals','Rentals']"), 'Rentals must be discoverable in primary navigation')
assert.ok(nav.includes('to="/rentals"'), 'My Rentals must be available from the account menu')

const dashboard = read('src/pages/MyRentals.jsx')
for (const item of ['gear_rentals', 'GearRentalPanel', 'allowRequest={false}', 'My Rentals', 'Campus Wallet only']) {
  assert.ok(dashboard.includes(item), `My Rentals dashboard missing: ${item}`)
}
console.log('Secure gear rental lifecycle regression checks passed.')
