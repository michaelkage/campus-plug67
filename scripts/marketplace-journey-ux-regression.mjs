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
const serviceActions = read('src/components/services/ServiceBookingActions.jsx');
const inbox = read('src/pages/Chat.jsx');
assertIncludes(listing, 'liveTx?.id === existingTx?.id ? liveTx : existingTx',
  'Listing detail must not reuse realtime transaction state from a previous listing');

assertIncludes(listing, 'How a protected purchase works',
  'Marketplace checkout must explain the buyer/seller journey before payment');
assertIncludes(listing, 'PlugPay holds the money',
  'Marketplace guidance must explain that payment is held before pickup');
assertIncludes(listing, 'Inspect the item first.',
  'Buyer guidance must require item inspection before QR confirmation');
assertIncludes(listing, 'The separate seller-requested release option unlocks after 24 hours.',
  'Marketplace guidance must retain the 24-hour eligibility gate for seller-requested release');
assertIncludes(listing, 'No 24-hour wait is required for buyer QR confirmation.',
  'Buyer QR handoff must not inherit the seller-requested release eligibility gate');
assertIncludes(listing, '48 hours to dispute',
  'Marketplace guidance must disclose the dispute window');
assertIncludes(listing, '6. Settlement is confirmed',
  'Marketplace guidance must distinguish the inspection deadline from confirmed settlement');
assertIncludes(listing, 'not proof that the seller has already been paid',
  'Marketplace guidance must not equate transaction resolution with seller payout');
assertIncludes(listing, 'server settlement is triggered at the deadline. Seller payout confirmation follows separately.',
  'Seller-requested release must distinguish the settlement deadline from confirmed payout');
if (listing.includes('funds auto-release at the deadline') || listing.includes('automatically releases the funds when the timer ends')) {
  fail('Seller-requested release must not imply that transaction resolution guarantees completed payout');
}
assertIncludes(listing, 'Server settlement is still being confirmed.',
  'Expired inspection deadlines must not be presented as completed payouts');
if (listing.includes('Auto-releases in ')) {
  fail('Escrow countdown must describe the dispute/inspection deadline, not promise immediate payout');
}

for (const label of ['Funds held', 'Pickup', 'Protected release window', 'Resolved']) {
  assertIncludes(states, `label: '${label}'`,
    `Marketplace progress must include the ${label} step`);
assertIncludes(states, "label: 'Resolved'",
  'Transaction resolution must not be presented as confirmed payout');
}

assertIncludes(gigs, 'How service bookings work',
  'Service listings must explain the booking journey');
assertIncludes(gigs, 'does not charge your wallet or hold money in escrow',
  'Service booking UI must disclose that it does not collect or hold payment');
assertIncludes(gigs, 'Message {isSeller ? \'customer\' : \'provider\'}',
  'Both service booking participants must have a direct chat action');
assertIncludes(serviceActions, 'Mark delivered',
  'Provider must explicitly mark service delivery');
assertIncludes(serviceActions, 'Confirm service received',
  'Customer must explicitly confirm service receipt');

for (const source of [gigs, booking]) {
  if (source.includes('Payment collected on confirmation via PlugPay')) {
    fail('Service booking UI must not claim PlugPay collects payment when no service escrow exists');
  }
}
assertIncludes(booking, 'No payment is collected or held here',
  'Alternate booking component must disclose request-only behavior');
assertIncludes(booking, 'Send booking request',
  'Alternate booking CTA must not imply instant paid booking');
assertIncludes(inbox, 'chat-inbox:',
  'Chat inbox must subscribe to realtime message and read-receipt changes');
assertIncludes(inbox, "invalidateQueries({ queryKey: ['chat-inbox', user.id] })",
  'Realtime message events must refresh the actual inbox query');

console.log('Marketplace and service journey UX regression checks passed.');
