import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const read = file => fs.readFileSync(path.join(root, file), 'utf8')
const fail = message => { throw new Error(message) }
const includes = (source, value, message) => {
  if (!source.includes(value)) fail(message || `Missing invariant: ${value}`)
}

const migrationPath = 'supabase/migrations/20261103100000_service_booking_quotes_and_delivery.sql'
const migration = read(migrationPath)
const actions = read('src/components/services/ServiceBookingActions.jsx')
const page = read('src/pages/Gigs.jsx')
const packageJson = JSON.parse(read('package.json'))

for (const value of [
  'CREATE TABLE IF NOT EXISTS public.service_booking_quotes',
  'ALTER TABLE public.gig_bookings',
  "'quoted'::text",
  "'in_progress'::text",
  "'delivered'::text",
  'ALTER TABLE public.service_booking_quotes ENABLE ROW LEVEL SECURITY',
  'Booking parties read service quotes',
  'REVOKE UPDATE ON public.gig_bookings FROM authenticated',
  'CREATE OR REPLACE FUNCTION public.send_gig_booking_quote',
  'CREATE OR REPLACE FUNCTION public.respond_gig_booking_quote',
  'CREATE OR REPLACE FUNCTION public.transition_gig_booking',
  'current_user = \'postgres\'',
  'p_expires_at > now() + interval \'7 days\'',
  'An accepted quote already exists for this booking',
  'An accepted final quote is required',
  'Only the customer can confirm delivery',
  'A service cannot be cancelled after work has started',
  'ALTER PUBLICATION supabase_realtime ADD TABLE public.service_booking_quotes',
  'service_quote_received',
  'service_delivered',
  'REVOKE ALL ON FUNCTION public.send_gig_booking_quote',
  'GRANT EXECUTE ON FUNCTION public.transition_gig_booking',
  'Quote acceptance does not collect or escrow payment',
]) includes(migration, value, `Service booking migration missing invariant: ${value}`)

for (const value of [
  "supabase.rpc('send_gig_booking_quote'",
  "supabase.rpc('respond_gig_booking_quote'",
  "supabase.rpc('transition_gig_booking'",
  "p_amount_kobo: toKobo(numericAmount)",
  'Accept quote',
  'Decline quote',
  'Start service',
  'Mark delivered',
  'Confirm service received',
  'does not collect or protect funds yet',
  'The customer has 24 hours to accept or decline',
]) includes(actions, value, `Service booking UI missing invariant: ${value}`)

includes(page, "import { ServiceBookingActions } from '@/components/services/ServiceBookingActions'", 'Gigs page must use the server-authoritative booking controls')
includes(page, "table: 'service_booking_quotes'", 'Gigs page must subscribe to quote realtime events')
includes(page, "table: 'gig_bookings'", 'Gigs page must subscribe to booking realtime events')
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

console.log('Service booking quote and delivery lifecycle regression checks passed.')
