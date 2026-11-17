-- CP-67 AI schema context snapshot
-- Generated from the repository's committed Supabase migration history.
-- This is a lightweight structural map for AI/code-review context; migrations remain authoritative.

-- Core marketplace / transaction entities
-- public.listings: marketplace listings, seller ownership, university, images,
-- metadata_verified, verification_source_device, mobile_verification_required,
-- mobile_verification_requested_at, status and pricing fields.
-- public.transactions: marketplace transaction state machine and escrow lifecycle.
-- public.messages: marketplace/chat messages.
-- public.notifications: user notifications and workflow events.

-- Security / identity
-- public.passkey_credentials: user_id, credential_id, device_label, backed_up,
-- transports, created_at, last_used_at and WebAuthn credential metadata.
-- public.banned_devices: device_fingerprint and ban/security metadata.
-- public.campus_security_alerts: duress/security alerts and workflow metadata.
-- public.listing_exif_flags: listing image verification results including gps_lat,
-- gps_lng, gps_mismatch, timestamp_flag, make, model, software,
-- verification_source and verified_at.

-- Wallet / payments
-- public.wallet_funding_intents: Paystack funding intents and idempotency state.
-- public.processed_webhooks: processed Paystack webhook identifiers/signatures.
-- public.emergency_sale_tokens: controlled below-floor marketplace pricing tokens.

-- Offline / cross-device application state
-- Client IndexedDB database: campus-plug-local-state
-- Object store: transactions (keyPath: id)
-- Local transaction status: draft | queued | syncing | failed | synced
-- Local records must be scoped to the authenticated user before synchronization.

-- Critical authoritative database routines found in migrations:
-- is_in_safe_swap_zone
-- record_safe_arrival / record_safe_arrival_v2
-- process_escrow_action
-- activate_duress
-- claim_idempotency_key
-- consume_rate_limit
-- guard_jury_case_transition
-- guard_profile_balance_mutation
-- award_plugscore
-- check_device_ban
-- credit_wallet_funding_for_user
-- create_wallet_micro_escrow
-- resolve_dispute_verdict
-- process_plugscore_events
-- rotate_duress_qr_token

-- Safety invariant: the 50m Safe Swap boundary is server authoritative.
-- Safety invariant: escrow transitions remain guarded by the database state engine.
-- Safety invariant: client-side wallet balance mutation is prohibited.
-- Safety invariant: payment success is verified against Paystack before crediting funds.
-- Safety invariant: server-side image verification is authoritative over browser EXIF.

-- NOTE: For exact columns, constraints, indexes, RLS policies, triggers and function
-- signatures, inspect supabase/migrations/*.sql. This snapshot intentionally avoids
-- inventing schema details not recoverable from the committed migration corpus.
