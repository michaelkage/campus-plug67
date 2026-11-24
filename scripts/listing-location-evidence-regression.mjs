import fs from 'node:fs';

const read = path => fs.readFileSync(path, 'utf8');
const fail = message => { throw new Error(message); };
const edge = read('supabase/functions/verify-listing-images/index.ts');
const marketplace = read('src/pages/Marketplace.jsx');
const security = read('src/lib/security.ts');

for (const required of [
  'has_capture_timestamp',
  'const metadataComplete = results.length > 0',
  'result.gps_lat !== null && result.gps_lng !== null && result.has_capture_timestamp',
  'metadata_verified:metadataComplete&&!needsMobile',
  "verification_source:'browser_geolocation'",
  'location_evidence_submitted:locationIsPlausible',
  'location_evidence_in_campus_bounds:locationInCampusBounds',
]) if (!edge.includes(required)) fail(`Server listing verification invariant missing: ${required}`);

if (edge.includes('const clean=results.every(result=>!result.gps_mismatch&&!result.timestamp_flag)')) {
  fail('Missing EXIF must never be interpreted as clean verified metadata');
}
if (!edge.includes('This is untrusted corroborating evidence')) fail('Browser geolocation must remain explicitly untrusted evidence');
if (!edge.includes('accuracy <= 100') || !edge.includes('now - locationTime <= 5 * 60_000')) fail('Browser location evidence must be accuracy- and freshness-bounded');

for (const required of [
  'capture="environment"',
  'navigator.geolocation.getCurrentPosition',
  'enableHighAccuracy: true',
  'Location evidence captured',
  'cameraCaptureReported: images.some(image => image.capturedByCamera)',
]) if (!marketplace.includes(required)) fail(`Marketplace camera/location fallback missing: ${required}`);

if (!security.includes('browser_location: evidence.browserLocation ?? null')) fail('Browser location evidence must reach the server verifier');
console.log('Listing location evidence regression checks passed.');
