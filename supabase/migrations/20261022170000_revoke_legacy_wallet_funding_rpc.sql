-- Disable the obsolete client-callable wallet funding RPC.
-- Verified Paystack wallet credits must flow through fund-wallet and the
-- service-role-only credit_wallet_funding_for_user function.
REVOKE ALL ON FUNCTION public.credit_wallet_funding(text, bigint)
  FROM PUBLIC, anon, authenticated;
