-- Wallet credits must only be issued by the server-side Paystack verification flow.
-- The legacy authenticated RPC trusts caller-supplied reference/amount and does not
-- independently verify payment with Paystack. Keep the function definition for
-- migration compatibility, but make it non-executable by all API roles.
REVOKE ALL ON FUNCTION public.credit_wallet_funding(text, bigint)
  FROM PUBLIC, anon, authenticated, service_role;
