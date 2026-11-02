import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const fail = (message) => { throw new Error(message); };
const assertIncludes = (source, text, message) => {
  if (!source.includes(text)) fail(message || `Missing journey guidance: ${text}`);
};

const listing = read('src/pages/ListingDetail.jsx');
const states = read('src/lib/escrowState.js');
const gigs = read('src/pages/Gigs.jsx');
const booking = read('src/components/ui/GigBooking.tsx');

assertIncludes(listing, 'How a protected purchase works',
  'Marketplace checkout must explain the buyer/seller journey before payment');
assertIncludes(listing, 'Funds are protected',
  'Marketplace guidance must explain that payment is held before pickup');
assertIncludes(listing, 'Inspect the item before confirming receipt',
  'Buyer guidance must require item inspection before QR confirmation');
assertIncludes(listing, 'QR release unlocks 24 hours',
  'Marketplace guidance must disclose the 24-hour release gate');
assertIncludes(listing, '48 hours to dispute',
  'Marketplace guidance must disclose the dispute window');

for (const label of ['Funds held', 'Pickup', 'Handoff', 'Complete']) {
  assertIncludes(states, `label: '${label}'`,
    `Marketplace progress must include the ${label} step`);
}

assertIncludes(gigs, 'How service bookings work',
  'Service listings must explain the booking journey');
assertIncludes(gigs, 'does not charge your wallet or hold money in escrow',
  'Service booking UI must disclose that it does not collect or hold payment');
assertIncludes(gigs, 'Message {isSeller ? \'customer\' : \'provider\'}',
  'Both service booking participants must have a direct chat action');
assertIncludes(gigs, 'Mark service complete',
  'Provider completion action must be explicit');

for (const source of [gigs, booking]) {
  if (source.includes('Payment collected on confirmation via PlugPay')) {
    fail('Service booking UI must not claim PlugPay collects payment when no service escrow exists');
  }
}
assertIncludes(booking, 'No payment is collected or held here',
  'Alternate booking component must disclose request-only behavior');
assertIncludes(booking, 'Send booking request',
  'Alternate booking CTA must not imply instant paid booking');

console.log('Marketplace and service journey UX regression checks passed.');
