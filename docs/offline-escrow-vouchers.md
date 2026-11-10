# Offline escrow vouchers (v1)

## Scope

V1 supports reserved marketplace listings paid through Campus Wallet or Paystack. It requires both participants to complete the existing online Safe Swap Zone check-in before the buyer requests a voucher. The seller must have at least one registered passkey. Service rentals are not included in this first protocol.

## Protocol

1. The buyer requests a voucher while online.
2. The Edge Function checks the buyer, transaction, seller passkeys and current escrow state. The database RPC rechecks the transaction under a row lock, including fresh buyer/seller arrival evidence, the shared Safe Swap Zone, the reserved listing and the Campus Wallet hold where applicable.
3. The server signs a compact `CPV1` payload with Ed25519. The private PKCS8 key is generated once and stored in Supabase Vault. Only the public key is returned to the app.
4. The buyer displays the signed voucher QR. The seller's app verifies it locally using the cached server public key and checks its 30-minute validity window.
5. The seller scans the voucher and creates a receipt core containing the voucher ID/hash, transaction participants, one-time receipt nonce and scan timestamp. The WebAuthn challenge is SHA-256 of canonical JSON for that core. The seller signs it with a registered passkey using user verification.
6. The seller displays the signed receipt QR. The buyer scans and stores the receipt in an IndexedDB outbox. The seller's device also keeps its copy.
7. Either participant can sync the receipt. The server verifies the Ed25519 voucher, seller passkey assertion, participant identity, one-time nonce and current escrow state. Duplicate syncs are idempotent.

## Two-sided sync and inspection buffer

The first sync stores the verified receipt. If the seller syncs first, the receipt is marked `seller_synced`, the transaction remains `meetup_initiated`, and funds remain held. This deliberately does **not** start the buyer's inspection clock while the buyer may still be offline.

When the buyer syncs the same receipt, the receipt becomes `buyer_confirmed` and the database atomically moves the transaction to `release_requested`, setting a two-hour inspection buffer from server time. If the buyer syncs first, the same two-hour buffer starts immediately. Existing dispute and settlement workers remain responsible for dispute handling and eventual settlement. The offline handshake never releases funds locally.

## API

- `GET /functions/v1/offline-escrow/ping`: deployment health marker.
- `GET /functions/v1/offline-escrow/public-key`: authenticated public signing key for local voucher verification.
- `POST /functions/v1/offline-escrow` with `{ action: "issue_voucher", transaction_id }`: buyer-only voucher issuance.
- `POST /functions/v1/offline-escrow` with `{ action: "reconcile_receipt", voucher_token, receipt }`: buyer or seller sync.

The receipt object is `{ core, assertion }`. Both the client and server must use recursively key-sorted canonical JSON when hashing the receipt core for the WebAuthn challenge and when hashing the complete receipt for idempotency.

## Client integration contract

- Fetch and persist the public key while online; do not assume a first-time offline device already has it.
- The voucher's signed `rp_id` and `seller_credentials` are the source for the offline WebAuthn request options. Use `userVerification: "required"`.
- Verify the `CPV1` Ed25519 signature locally before accepting a voucher.
- Persist voucher and receipt outbox records in IndexedDB, not Cache Storage.
- Retry sync on foreground and `online` events. Background Sync is best-effort only.
- Display distinct states: voucher issued, receipt captured locally, seller receipt synced/awaiting buyer sync, inspection pending, disputed, released, refunded.
- Never display "paid" or "released" merely because a QR was scanned.

## Security boundaries

- The voucher proves that the server observed eligible escrow state when it issued the voucher. An offline device cannot know whether a later dispute, cancellation or revocation occurred until it reconnects.
- The receipt is provisional until server verification. A seller-first sync does not start auto-release; buyer sync is required for the inspection buffer.
- Device wall clocks can be wrong or manipulated. The server checks a bounded scan-time tolerance and sync grace, but a browser cannot provide a hardware-attested timestamp.
- The 30-second QR counter is a freshness indicator, not a secret TOTP or proof against screenshots. A copied QR may be replayed during its short acceptance window. The one-time voucher/receipt binding and atomic server redemption prevent duplicate settlement, but do not prove physical proximity.
- Browser GPS is not hardware-attested. WebAuthn proves use of a registered authenticator for the challenge; it does not prove camera sensor provenance, physical location or that an image came from a live camera.
- Sellers should not rely on an offline voucher as a guarantee of current transaction status or immediate payout, especially for high-value handoffs. If the buyer never reconnects to confirm, funds remain held for manual support resolution.
