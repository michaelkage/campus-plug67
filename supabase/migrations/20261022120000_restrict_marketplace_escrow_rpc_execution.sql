-- Defense in depth: privileged wallet escrow RPCs must not be callable by anon or PUBLIC.
-- The functions still enforce auth.uid() and participant ownership internally; this makes
-- the intended API boundary explicit rather than relying on function-body checks alone.
REVOKE ALL ON FUNCTION public.create_wallet_micro_escrow(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_wallet_micro_escrow(uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.resolve_wallet_micro_escrow(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_wallet_micro_escrow(uuid, text) TO authenticated;

-- Paystack checkout is also signed-in-only; keep its existing boundary explicit.
REVOKE ALL ON FUNCTION public.create_pending_paystack_transaction(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_pending_paystack_transaction(uuid, text) TO authenticated;
