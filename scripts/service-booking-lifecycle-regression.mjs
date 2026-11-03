import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const read = file => fs.readFileSync(path.join(root, file), 'utf8')
const fail = message => { throw new Error(message) }
const includes = (source, value, message) => {
  if (!source.includes(value)) fail(message || `Missing invariant: ${value}`)
}

const migration = read('supabase/migrations/20261103100000_service_booking_quotes_and_delivery.sql')
const actions = read('src/components/services/ServiceBookingActions.jsx')
const databaseTypes = read('src/types/database.ts')
const page = read('src/pages/Gigs.jsx')
const packageJson = JSON.parse(read('package.json'))

for (const value of [
  'CREATE TABLE IF NOT EXISTS public.service_booking_quotes',
  'REFERENCES public.gig_bookings(id) ON DELETE CASCADE',
  'CREATE OR REPLACE FUNCTION public.notify_service_booking_quote_created()',
  'AFTER INSERT ON public.service_booking_quotes',
  "IF NEW.status = 'quoted' THEN RETURN NEW; END IF;",
  'ALTER COLUMN status SET NOT NULL',
  "v_booking.status IS DISTINCT FROM 'quoted'",
  "v_booking.status IS DISTINCT FROM 'confirmed'",
  "v_booking.status IS DISTINCT FROM 'in_progress'",
  "v_booking.status IS DISTINCT FROM 'delivered'",
  'ALTER TABLE public.service_booking_quotes ENABLE ROW LEVEL SECURITY',
  'Booking parties read service quotes',
  'REVOKE UPDATE ON public.gig_bookings FROM authenticated',
  'DROP POLICY IF EXISTS "Parties update bookings" ON public.gig_bookings',
  "AND status = 'pending'",
  'AND gig_bookings.amount = g.starting_price',
  'CREATE OR REPLACE FUNCTION public.send_gig_booking_quote',
  'CREATE OR REPLACE FUNCTION public.respond_gig_booking_quote',
  'CREATE OR REPLACE FUNCTION public.transition_gig_booking',
  "current_user = 'postgres'",
  "p_expires_at > now() + interval '7 days'",
  'An accepted quote already exists for this booking',
  'An accepted final quote is required',
  'Only the customer can confirm delivery',
  'A service cannot be cancelled after work has started',
  'DO $publication',
  'ALTER PUBLICATION supabase_realtime ADD TABLE public.service_booking_quotes',
  '-- Lock booking before quote, matching quote creation and cancellation.',
  'service_quote_received',
  'service_delivered',
  'REVOKE ALL ON FUNCTION public.send_gig_booking_quote',
  'GRANT EXECUTE ON FUNCTION public.transition_gig_booking',
  'Quote acceptance does not collect or escrow payment',
]) includes(migration, value, `Service booking migration missing invariant: ${value}`)

const guardStart = migration.indexOf('CREATE OR REPLACE FUNCTION public.guard_gig_booking_update()')
const privilegedWrite = migration.indexOf("IF current_user = 'postgres' THEN", guardStart)
const immutableFieldGuard = migration.indexOf('IF NEW.id IS DISTINCT FROM OLD.id', guardStart)
if (guardStart < 0 || privilegedWrite < 0 || immutableFieldGuard < 0 || privilegedWrite > immutableFieldGuard) {
  fail('Validated SECURITY DEFINER booking RPCs must pass the guard before immutable-field checks')
}

for (const value of [
  "callRpc('send_gig_booking_quote'",
  "'respond_gig_booking_quote'",
  "'transition_gig_booking'",
  'p_amount_kobo: toKobo(numericAmount)',
  'Accept quote',
  'Decline quote',
  'Start service',
  'Mark delivered',
  'Confirm service received',
  'do not collect or protect funds yet',
  'The customer has 24 hours to accept or decline',
]) includes(actions, value, `Service booking UI missing invariant: ${value}`)

includes(actions, ".eq('status', 'accepted')", 'Accepted quotes must be fetched independently of the recent quote history limit')
includes(actions, '.maybeSingle()', 'Accepted quote lookup must return the authoritative accepted quote')
includes(databaseTypes, 'service_booking_quotes:', 'Database types must include service booking quotes')
includes(databaseTypes, "'quoted' | 'confirmed' | 'in_progress' | 'delivered' | 'completed'", 'Database types must include the full service booking state machine')
includes(page, "import { ServiceBookingActions } from '@/components/services/ServiceBookingActions'", 'Gigs page must use the server-authoritative booking controls')
includes(page, "table: 'service_booking_quotes'", 'Gigs page must subscribe to quote realtime events')
includes(page, "table: 'gig_bookings'", 'Gigs page must subscribe to booking realtime events')
includes(actions, 'This booking was confirmed before final quotes were introduced', 'Legacy confirmed bookings without an accepted quote must be clearly identified to the customer')
includes(actions, 'isLoading: quotesLoading', 'Booking actions must wait until the accepted quote lookup completes')
includes(page, 'provider sends a final quote with the exact scope and price', 'Service journey must explain in-app quote creation and acceptance')
includes(page, 'customer confirms that the service was received', 'Service journey must explain customer delivery confirmation')

if (page.includes(".from('gig_bookings').update(")) fail('Direct client-side booking status updates must remain disabled')
if (actions.includes(".from('service_booking_quotes').insert(") || actions.includes(".from('service_booking_quotes').update(")) {
  fail('Quote writes must go through the server-authoritative RPCs')
}
if (actions.includes("transition('completed')") || actions.includes("update({ status: 'completed' })")) {
  fail('Customer confirmation must use the delivery confirmation RPC')
}
if (!packageJson.scripts['test:platform-integrity'].includes('service-booking-lifecycle-regression.mjs')) {
  fail('Service booking regression must run in the platform-integrity suite')
}


const availabilityMigration = read('supabase/migrations/20261103190000_service_booking_server_availability.sql')
for (const value of [
  'CREATE OR REPLACE FUNCTION public.create_gig_booking_request',
  "v_actor uuid := auth.uid()",
  'FROM public.gigs',
  'FOR UPDATE',
  'WHERE b.seller_id = v_gig.seller_id',
  'FROM public.profiles WHERE id = v_gig.seller_id FOR UPDATE',
  "v_requested_at AT TIME ZONE 'Africa/Lagos'",
  "to_char(v_requested_at, 'FMDay')",
  'v_weekday = ANY(v_gig.available_days)',
  "b.status IN ('pending', 'quoted', 'confirmed', 'in_progress', 'delivered')",
  'gig_bookings_one_active_provider_slot_uidx',
  'GET STACKED DIAGNOSTICS v_constraint_name = CONSTRAINT_NAME',
  'REVOKE INSERT ON public.gig_bookings FROM PUBLIC, anon, authenticated',
  'GRANT EXECUTE ON FUNCTION public.create_gig_booking_request',
  'slot_unavailable',
  'Does not collect or escrow payment',
]) includes(availabilityMigration, value, `Availability migration missing invariant: ${value}`)

includes(page, "supabase.rpc('create_gig_booking_request'", 'Booking requests must use the server-authoritative availability RPC')
includes(page, 'p_slot_date: booking.date', 'Booking RPC must receive the selected date')
includes(page, 'p_slot_time: booking.time', 'Booking RPC must receive the selected time')
if (page.includes(".from('gig_bookings').insert(")) fail('Client-side booking inserts must remain disabled')

console.log('Service booking quote, availability and delivery lifecycle regression checks passed.')
