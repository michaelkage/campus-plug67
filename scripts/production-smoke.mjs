const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Production smoke: missing environment variable ${name}`);
  return value.replace(/\/$/, '');
};

const url = required('SUPABASE_URL');
const anon = required('SUPABASE_ANON_KEY');
const email = process.env.E2E_TEST_EMAIL;
const password = process.env.E2E_TEST_PASSWORD;

const request = async (path, options = {}) => {
  const response = await fetch(`${url}${path}`, {
    ...options,
    headers: {
      apikey: anon,
      Authorization: `Bearer ${anon}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch {}
  return { response, body, text };
};

const securityGate = await request('/functions/v1/security-gate', {
  method: 'POST',
  body: JSON.stringify({ action: 'check' }),
});
if (!securityGate.response.ok) {
  throw new Error(`Production smoke: security-gate returned ${securityGate.response.status}: ${securityGate.text.slice(0, 500)}`);
}

const listings = await request('/rest/v1/listings?select=id,title,university,status&status=eq.active&limit=5');
if (!listings.response.ok) {
  throw new Error(`Production smoke: listings read returned ${listings.response.status}: ${listings.text.slice(0, 500)}`);
}
if (!Array.isArray(listings.body)) {
  throw new Error('Production smoke: listings endpoint did not return an array');
}
for (const listing of listings.body) {
  if (!listing.university) throw new Error(`Production smoke: active listing ${listing.id} has no university`);
}

if (email && password) {
  const login = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: anon, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const loginText = await login.text();
  let loginBody = null;
  try { loginBody = loginText ? JSON.parse(loginText) : null; } catch {}
  if (!login.ok || !loginBody?.access_token || !loginBody?.user?.id) {
    throw new Error(`Production smoke: authenticated login failed with ${login.status}: ${loginText.slice(0, 500)}`);
  }

  const profile = await fetch(
    `${url}/rest/v1/profiles?id=eq.${encodeURIComponent(loginBody.user.id)}&select=id,university,is_verified&limit=1`,
    {
      headers: {
        apikey: anon,
        Authorization: `Bearer ${loginBody.access_token}`,
      },
    },
  );
  const profileText = await profile.text();
  let profileBody = null;
  try { profileBody = profileText ? JSON.parse(profileText) : null; } catch {}
  if (!profile.ok) throw new Error(`Production smoke: profile read failed with ${profile.status}: ${profileText.slice(0, 500)}`);
  if (!Array.isArray(profileBody) || profileBody.length !== 1) {
    throw new Error('Production smoke: authenticated user has no readable profile');
  }
  if (!profileBody[0].university) throw new Error('Production smoke: authenticated profile has no university');

  const scopedListings = await fetch(
    `${url}/rest/v1/listings?select=id,university&university=eq.${encodeURIComponent(profileBody[0].university)}&status=eq.active&limit=5`,
    {
      headers: {
        apikey: anon,
        Authorization: `Bearer ${loginBody.access_token}`,
      },
    },
  );
  if (!scopedListings.ok) {
    const body = await scopedListings.text();
    throw new Error(`Production smoke: authenticated marketplace read failed with ${scopedListings.status}: ${body.slice(0, 500)}`);
  }
}

console.log(`Production smoke passed: security-gate healthy, ${listings.body.length} active listing(s) readable, and authenticated profile/listing access verified when E2E credentials are configured.`);
