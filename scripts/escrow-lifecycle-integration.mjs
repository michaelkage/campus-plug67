import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL ?? process.env.API_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SERVICE_ROLE_KEY;
const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.ANON_KEY;
if (!supabaseUrl || !serviceKey || !anonKey) {
  throw new Error("Local Supabase URL, service-role key, and anon key are required");
}

const admin = createClient(supabaseUrl, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const anonymous = createClient(supabaseUrl, anonKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const amount = 25_000;
const suffix = randomUUID();
const users = [];
const listingIds = [];
const transactionIds = [];
const caseIds = [];
const fundingReferences = [];

function failIfError(error, context) {
  if (error) throw new Error(`${context}: ${error.message}`);
}

async function insertRow(table, payload, context) {
  const { data, error } = await admin.from(table).insert(payload).select("*").single();
  failIfError(error, context);
  return data;
}

async function createUser(role) {
  const email = `escrow-${role}-${suffix}@campusplug.test`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: `CampusPlug!${randomUUID()}`,
    email_confirm: true,
    user_metadata: {
      full_name: `Escrow Integration ${role}`,
      university: "Campus Plug Integration University",
      department: "Testing",
    },
  });
  failIfError(error, `create ${role} fixture user`);
  assert.ok(data.user?.id, `Auth should create the ${role} fixture user`);
  users.push(data.user.id);
  const { data: profile, error: profileError } = await admin
    .from("profiles").select("id").eq("id", data.user.id).single();
  failIfError(profileError, `profile trigger for ${role}`);
  assert.equal(profile.id, data.user.id);
  return data.user;
}

async function createTransaction({
  buyer,
  seller,
  paymentMethod = "paystack",
  handshake = null,
  autoReleaseAt = new Date(Date.now() + 60 * 60_000).toISOString(),
  refundStatus = null,
  listingStatus = "reserved",
} = {}) {
  const listing = await insertRow("listings", {
    seller_id: seller.id,
    title: `Escrow integration fixture ${randomUUID().slice(0, 8)}`,
    description: "Disposable local database integration fixture",
    category: "Other",
    price: amount,
    university: "Campus Plug Integration University",
    status: listingStatus,
    listing_mode: "sale",
  }, "create listing");
  listingIds.push(listing.id);

  const transaction = await insertRow("transactions", {
    listing_id: listing.id,
    buyer_id: buyer.id,
    seller_id: seller.id,
    amount,
    status: "release_requested",
    payment_method: paymentMethod,
    payment_verified: true,
    payout_status: paymentMethod === "campus_wallet" ? "approved_for_settlement" : "not_applicable",
    auto_release_at: autoReleaseAt,
    handshake_receipt_buffer: handshake,
    refund_status: refundStatus,
    paystack_ref: paymentMethod === "campus_wallet" ? null : `CP-ESCROW-TEST-${randomUUID()}`,
  }, "create transaction");
  transactionIds.push(transaction.id);
  return { ...transaction, listing_id: listing.id };
}

async function createWalletHold(transaction, buyer, seller) {
  const fundingReference = randomUUID();
  fundingReferences.push(fundingReference);
  await insertRow("plug_credit_ledger", {
    user_id: buyer.id,
    amount: amount * 2,
    reason: "Escrow integration fixture funding",
    reference_id: fundingReference,
  }, "fund test wallet");

  await insertRow("plug_credit_ledger", {
    user_id: buyer.id,
    amount: -amount,
    reason: "Campus Wallet escrow hold",
    reference_id: transaction.id,
  }, "debit test wallet escrow");

  await insertRow("wallet_escrow_holds", {
    transaction_id: transaction.id,
    buyer_id: buyer.id,
    seller_id: seller.id,
    amount_kobo: amount,
    status: "held",
  }, "create test wallet hold");
}

async function openCase(transaction, claimant) {
  const { data, error } = await admin.rpc("open_escrow_dispute_case", {
    p_transaction_id: transaction.id,
    p_claimant_id: claimant.id,
    p_reason: "Integration test: item was not received as agreed",
    p_dispute_campus: "Campus Plug Integration University",
    p_evidence_messages: [],
  });
  failIfError(error, "open dispute case");
  assert.equal(data.success, true);
  caseIds.push(data.case_id);
  const { error: updateError } = await admin
    .from("jury_cases").update({ status: "deliberating" }).eq("id", data.case_id);
  failIfError(updateError, "move test case to deliberating");
  return data.case_id;
}

async function rpc(name, args) {
  return admin.rpc(name, args);
}

async function getTransaction(id) {
  const { data, error } = await admin
    .from("transactions")
    .select("status,payout_status,refund_status")
    .eq("id", id).single();
  failIfError(error, "read transaction state");
  return data;
}

async function getListingStatus(id) {
  const { data, error } = await admin.from("listings").select("status").eq("id", id).single();
  failIfError(error, "read listing state");
  return data.status;
}

async function getHoldStatus(transactionId) {
  const { data, error } = await admin
    .from("wallet_escrow_holds").select("status")
    .eq("transaction_id", transactionId).single();
  failIfError(error, "read wallet hold");
  return data.status;
}

async function getBalance(userId) {
  const { data, error } = await admin
    .from("profiles").select("plug_credit_balance").eq("id", userId).single();
  failIfError(error, "read PlugCredit balance");
  return Number(data.plug_credit_balance ?? 0);
}

async function ledgerCount(transactionId, reason) {
  const { count, error } = await admin.from("plug_credit_ledger")
    .select("id", { count: "exact", head: true })
    .eq("reference_id", transactionId)
    .eq("reason", reason);
  failIfError(error, "count transaction ledger entries");
  return count ?? 0;
}

async function assertDisputeOutcome({ buyer, seller, paymentMethod, claimantRole, winnerRole, concurrent = false }) {
  const transaction = await createTransaction({
    buyer,
    seller,
    paymentMethod,
    autoReleaseAt: new Date(Date.now() + 60 * 60_000).toISOString(),
  });
  if (paymentMethod === "campus_wallet") await createWalletHold(transaction, buyer, seller);

  const claimant = claimantRole === "buyer" ? buyer : seller;
  const winner = winnerRole === "buyer" ? buyer : seller;
  const caseId = await openCase(transaction, claimant);
  const verdict = winner.id === claimant.id ? "claimant" : "respondent";

  if (paymentMethod !== "campus_wallet" && winnerRole === "buyer") {
    const firstClaim = await rpc("claim_paystack_refund", { p_transaction_id: transaction.id });
    failIfError(firstClaim.error, "claim Paystack refund");
    assert.equal(firstClaim.data.claimed, true, "first refund claim must acquire the refund lock");

    const retryClaim = await rpc("claim_paystack_refund", { p_transaction_id: transaction.id });
    failIfError(retryClaim.error, "retry Paystack refund claim");
    assert.equal(retryClaim.data.claimed, false, "duplicate refund claim must be idempotent");
    assert.equal(retryClaim.data.status, "processing");
  }

  const buyerBalanceBefore = await getBalance(buyer.id);
  const sellerBalanceBefore = await getBalance(seller.id);
  const args = { p_case_id: caseId, p_verdict: verdict, p_admin_override: false };
  let resolution;
  if (concurrent) {
    const results = await Promise.all([rpc("resolve_dispute_verdict", args), rpc("resolve_dispute_verdict", args)]);
    for (const result of results) failIfError(result.error, "concurrent dispute resolution");
    assert.equal(results.filter(result => result.data?.success).length, 1);
    assert.equal(results.filter(result => result.data?.already_resolved).length, 1);
    resolution = results.find(result => result.data?.success).data;
  } else {
    const result = await rpc("resolve_dispute_verdict", args);
    failIfError(result.error, "resolve dispute");
    resolution = result.data;
  }

  assert.equal(resolution.winner_id, winner.id, `${claimantRole} claimant / ${winnerRole} winner must resolve to the actual participant`);
  assert.equal(resolution.winner_role, winnerRole);
  assert.equal(resolution.recipient, winner.id);
  assert.equal(resolution.payout_status, winnerRole === "seller" ? "paid" : "not_applicable");

  const state = await getTransaction(transaction.id);
  if (winnerRole === "seller") {
    assert.equal(state.status, "released");
    assert.equal(state.payout_status, "paid");
    assert.equal(await getListingStatus(transaction.listing_id), "sold");
    assert.equal(await getBalance(seller.id), sellerBalanceBefore + amount);
    assert.equal(await ledgerCount(transaction.id, "Dispute settlement: released to seller"), 1);
    if (paymentMethod === "campus_wallet") assert.equal(await getHoldStatus(transaction.id), "released");
  } else {
    assert.equal(state.status, "cancelled");
    assert.equal(state.payout_status, "not_applicable");
    assert.equal(await getListingStatus(transaction.listing_id), "active");
    if (paymentMethod === "campus_wallet") {
      assert.equal(await getBalance(buyer.id), buyerBalanceBefore + amount);
      assert.equal(await ledgerCount(transaction.id, "Dispute refund: settled in favour of buyer"), 1);
      assert.equal(await getHoldStatus(transaction.id), "refunded");
    } else {
      assert.equal(await getBalance(buyer.id), buyerBalanceBefore, "Paystack refund must not also credit PlugCredit");
      assert.equal(await ledgerCount(transaction.id, "Dispute refund: settled in favour of buyer"), 0);
      assert.equal(state.refund_status, "processing");
    }
  }

  const repeat = await rpc("resolve_dispute_verdict", args);
  failIfError(repeat.error, "idempotent dispute resolution retry");
  assert.equal(repeat.data.already_resolved, true);
  if (winnerRole === "seller") assert.equal(await ledgerCount(transaction.id, "Dispute settlement: released to seller"), 1);
  if (winnerRole === "buyer" && paymentMethod === "campus_wallet") {
    assert.equal(await ledgerCount(transaction.id, "Dispute refund: settled in favour of buyer"), 1);
  }
}

async function run() {
  const buyer = await createUser("buyer");
  const seller = await createUser("seller");

  // Both participants can open disputes, and verdicts are resolved by actual
  // winner identity rather than assuming claimant always means buyer.
  await assertDisputeOutcome({ buyer, seller, paymentMethod: "paystack", claimantRole: "buyer", winnerRole: "buyer", concurrent: true });
  await assertDisputeOutcome({ buyer, seller, paymentMethod: "paystack", claimantRole: "buyer", winnerRole: "seller" });
  await assertDisputeOutcome({ buyer, seller, paymentMethod: "paystack", claimantRole: "seller", winnerRole: "seller" });
  await assertDisputeOutcome({ buyer, seller, paymentMethod: "paystack", claimantRole: "seller", winnerRole: "buyer" });
  await assertDisputeOutcome({ buyer, seller, paymentMethod: "campus_wallet", claimantRole: "buyer", winnerRole: "buyer" });
  await assertDisputeOutcome({ buyer, seller, paymentMethod: "campus_wallet", claimantRole: "buyer", winnerRole: "seller" });
  await assertDisputeOutcome({ buyer, seller, paymentMethod: "campus_wallet", claimantRole: "seller", winnerRole: "seller" });
  await assertDisputeOutcome({ buyer, seller, paymentMethod: "campus_wallet", claimantRole: "seller", winnerRole: "buyer" });

  // An expired release window cannot be reopened as a dispute.
  const expired = await createTransaction({
    buyer, seller,
    autoReleaseAt: new Date(Date.now() - 60_000).toISOString(),
  });
  const expiredOpen = await rpc("open_escrow_dispute_case", {
    p_transaction_id: expired.id,
    p_claimant_id: buyer.id,
    p_reason: "Integration test: dispute opened after expiry",
    p_dispute_campus: "Campus Plug Integration University",
    p_evidence_messages: [],
  });
  assert.ok(expiredOpen.error, "expired dispute window must be rejected");
  assert.equal((await getTransaction(expired.id)).status, "release_requested");

  // Generic 48-hour seller release credits exactly once and cannot consume QR handoffs.
  const genericRelease = await createTransaction({
    buyer, seller,
    autoReleaseAt: new Date(Date.now() - 60_000).toISOString(),
  });
  const genericResult = await rpc("process_escrow_action", {
    p_transaction_id: genericRelease.id,
    p_action: "auto_release",
  });
  failIfError(genericResult.error, "generic seller auto-release");
  assert.equal((await getTransaction(genericRelease.id)).status, "released");
  assert.equal((await getTransaction(genericRelease.id)).payout_status, "paid");
  assert.equal(await ledgerCount(genericRelease.id, "Escrow auto-release"), 1);
  const genericRetry = await rpc("process_escrow_action", {
    p_transaction_id: genericRelease.id,
    p_action: "auto_release",
  });
  assert.ok(genericRetry.error, "second generic release must not run again");
  assert.equal(await ledgerCount(genericRelease.id, "Escrow auto-release"), 1);

  const qrInspection = await createTransaction({
    buyer, seller,
    handshake: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
    autoReleaseAt: new Date(Date.now() - 60_000).toISOString(),
  });
  const wrongWorker = await rpc("process_escrow_action", {
    p_transaction_id: qrInspection.id,
    p_action: "auto_release",
  });
  assert.ok(wrongWorker.error, "generic worker must reject QR inspection handoffs");
  const [inspectionA, inspectionB] = await Promise.all([
    rpc("settle_due_paystack_inspections", { p_limit: 100 }),
    rpc("settle_due_paystack_inspections", { p_limit: 100 }),
  ]);
  failIfError(inspectionA.error, "first QR inspection settlement worker");
  failIfError(inspectionB.error, "concurrent QR inspection settlement worker");
  assert.equal((await getTransaction(qrInspection.id)).status, "released");
  assert.equal((await getTransaction(qrInspection.id)).payout_status, "paid");
  assert.equal(await ledgerCount(qrInspection.id, "Escrow auto-release"), 1);

  // Refund locks block both the generic and QR settlement workers.
  const refundLockedGeneric = await createTransaction({
    buyer, seller,
    autoReleaseAt: new Date(Date.now() - 60_000).toISOString(),
    refundStatus: "processing",
  });
  const blockedGeneric = await rpc("process_escrow_action", {
    p_transaction_id: refundLockedGeneric.id,
    p_action: "auto_release",
  });
  assert.ok(blockedGeneric.error, "generic release must wait for an in-flight refund");
  assert.equal((await getTransaction(refundLockedGeneric.id)).status, "release_requested");
  assert.equal(await ledgerCount(refundLockedGeneric.id, "Escrow auto-release"), 0);

  const refundLockedQr = await createTransaction({
    buyer, seller,
    handshake: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
    autoReleaseAt: new Date(Date.now() - 60_000).toISOString(),
    refundStatus: "processing",
  });
  const blockedInspection = await rpc("settle_due_paystack_inspections", { p_limit: 100 });
  failIfError(blockedInspection.error, "QR worker with refund lock");
  assert.equal((await getTransaction(refundLockedQr.id)).status, "release_requested");
  assert.equal(await ledgerCount(refundLockedQr.id, "Escrow auto-release"), 0);

  // The provider refund is the buyer's only refund credit.
  const providerRefund = await createTransaction({
    buyer, seller,
    autoReleaseAt: new Date(Date.now() + 60_000).toISOString(),
    refundStatus: "processing",
    listingStatus: "sold",
  });
  const buyerBalanceBeforeRefund = await getBalance(buyer.id);
  const refundResult = await rpc("process_escrow_action", {
    p_transaction_id: providerRefund.id,
    p_action: "refund",
  });
  failIfError(refundResult.error, "Paystack escrow cancellation after provider refund claim");
  assert.equal((await getTransaction(providerRefund.id)).status, "cancelled");
  assert.equal(await getListingStatus(providerRefund.listing_id), "active");
  assert.equal(await getBalance(buyer.id), buyerBalanceBeforeRefund);
  assert.equal(await ledgerCount(providerRefund.id, "Escrow refund"), 0);

  // Race the refund claim against automatic settlement. Exactly one path may win.
  const race = await createTransaction({
    buyer, seller,
    autoReleaseAt: new Date(Date.now() - 60_000).toISOString(),
  });
  const [raceClaim, raceRelease] = await Promise.all([
    rpc("claim_paystack_refund", { p_transaction_id: race.id }),
    rpc("process_escrow_action", { p_transaction_id: race.id, p_action: "auto_release" }),
  ]);
  const claimWon = !raceClaim.error && raceClaim.data?.claimed === true;
  const releaseWon = !raceRelease.error && raceRelease.data?.success === true;
  assert.notEqual(claimWon, releaseWon, "refund claim and auto-release must be mutually exclusive");
  const raceState = await getTransaction(race.id);
  if (claimWon) {
    assert.equal(raceState.status, "release_requested");
    assert.equal(raceState.refund_status, "processing");
    assert.equal(await ledgerCount(race.id, "Escrow auto-release"), 0);
  } else {
    assert.equal(raceState.status, "released");
    assert.equal(raceState.payout_status, "paid");
    assert.equal(await ledgerCount(race.id, "Escrow auto-release"), 1);
  }

  // Sensitive financial RPCs remain unavailable to anonymous clients.
  const forbiddenCalls = await Promise.all([
    anonymous.rpc("claim_paystack_refund", { p_transaction_id: randomUUID() }),
    anonymous.rpc("resolve_dispute_verdict", { p_case_id: randomUUID(), p_verdict: "claimant", p_admin_override: false }),
    anonymous.rpc("settle_due_paystack_inspections", { p_limit: 1 }),
  ]);
  for (const result of forbiddenCalls) assert.ok(result.error, "anonymous execution must be denied");

  console.log("Escrow lifecycle database integration tests passed (Paystack + Campus Wallet, both claimant roles, refunds, inspection, idempotency, and races).");
}

async function cleanup() {
  const userIds = [...users];
  if (caseIds.length) {
    await admin.from("jury_votes").delete().in("case_id", caseIds);
    await admin.from("jury_cases").delete().in("id", caseIds);
  }
  if (transactionIds.length) {
    await admin.from("wallet_escrow_holds").delete().in("transaction_id", transactionIds);
    await admin.from("scheduled_jobs").delete().in("entity_id", transactionIds);
    await admin.from("plug_credit_ledger").delete().in("reference_id", transactionIds);
    await admin.from("audit_logs").delete().in("entity_id", transactionIds);
    await admin.from("transactions").delete().in("id", transactionIds);
  }
  if (fundingReferences.length) {
    await admin.from("plug_credit_ledger").delete().in("reference_id", fundingReferences);
  }
  if (userIds.length) {
    await admin.from("notifications").delete().in("user_id", userIds);
    await admin.from("activity_feed").delete().in("actor_id", userIds);
    await admin.from("audit_logs").delete().in("user_id", userIds);
  }
  if (listingIds.length) await admin.from("listings").delete().in("id", listingIds);
  for (const userId of userIds) await admin.auth.admin.deleteUser(userId);
}

try {
  await run();
} finally {
  await cleanup();
}
