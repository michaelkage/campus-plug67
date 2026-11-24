# Production domain and passkey cutover

This checklist documents the configuration required before moving the public app to `campusplug.ng`. A repository name or GitHub Pages URL is not proof that DNS, hosting, Supabase Auth or Paystack are configured for that domain.

## Domain and hosting

- Confirm ownership/control of `campusplug.ng` and configure DNS with the chosen hosting provider.
- Enable HTTPS and verify the apex and any intended `www` redirect before changing the production app URL.
- Set the frontend build variable `VITE_APP_URL=https://campusplug.ng`. Keep local development pointed at localhost.
- Configure Supabase Auth **Site URL** to `https://campusplug.ng` and add only the required production callback/redirect URLs, including `https://campusplug.ng/auth/callback`. Retain localhost URLs only for development.
- Update production CORS/origin allowlists and any OAuth provider callback configuration to the exact production origin.

## WebAuthn / passkeys

The passkey Edge Function reads two server-side secrets:

- `RP_ID=campusplug.ng` — hostname only; no scheme, port or path.
- `APP_ORIGIN=https://campusplug.ng` — exact HTTPS origin used by the browser.

The RP ID must be a registrable domain or valid parent domain of the calling origin. Configure the secrets in the Supabase project only after DNS and HTTPS are live. Test registration and authentication on the production origin.

**Passkey migration warning:** WebAuthn credentials are scoped to their relying-party ID. If users registered passkeys under a different RP ID, moving to `campusplug.ng` does not transfer those credentials. Keep the old origin available during transition where possible and provide password/account recovery plus passkey re-registration.

## Paystack webhooks are a separate configuration

A custom frontend domain does not make Paystack webhooks production-ready and is not required for webhook delivery. Configure the webhook URL in the Paystack dashboard to the deployed Supabase `paystack-webhook` Edge Function endpoint. Confirm the production secret, raw-body signature verification, idempotent event handling, and successful test events before enabling live payments.

## Release gates

- Verify DNS, TLS, canonical redirects, app callback and Supabase Auth redirect allowlist.
- Verify `RP_ID` and `APP_ORIGIN` match the actual production origin.
- Verify passkey registration/authentication and account recovery.
- Verify Paystack webhook delivery independently from the frontend domain.
- Do not enable live payment or announce the custom domain until these checks pass.
