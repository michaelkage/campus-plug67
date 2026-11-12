import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.43.4";
import { isServiceRoleRequest, jsonResponse, optionsResponse } from "../_shared/auth.ts";

type Body = Record<string, unknown>;
type EvidenceMessage = { sender_id: string; body: string | null; created_at: string; flagged: boolean | null; flag_type: string | null; is_system_msg: boolean | null };
type Evidence = { role: "[Claimant]" | "[Respondent]"; body: string; created_at: string; is_system: boolean; flagged: boolean };
type DisputeCase = { id: string; transaction_id: string; claimant_id: string; respondent_id: string; jurors_assigned: string[] | null; high_value: boolean; required_votes: number; votes_cast: number; created_at: string; dispute_reason: string; status: string; verdict: string | null; dispute_campus: string; escalated_to_admin: boolean };
type TransactionRow = { id: string; buyer_id: string; seller_id: string; amount: number; listings: { title?: string; university?: string | null } | null };

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const HIGH_VALUE_REVIEW_S = 20;
const STANDARD_REVIEW_S = 5;
const RECLAIM_TIMEOUT_MS = 30 * 60_000;
const MAX_ROTATIONS = 10;
const JURY_PAYOUT_KOBO = 10_000;
const ok = (req: Request, data: unknown) => jsonResponse(data, 200, {}, req);
const bad = (req: Request, message: string, status = 400) => jsonResponse({ error: message }, status, {}, req);

async function getUser(req: Request) {
  const token = req.headers.get("Authorization")?.replace("Bearer ", "");
  if (!token) return null;
  const { data: { user } } = await admin.auth.getUser(token);
  return user;
}

const PII_PATTERNS: [RegExp, string][] = [
  [/(?:\+?234|0)(?:7|8|9)(?:0|1)\d{8}/g, "[phone redacted]"],
  [/\b\d{11}\b/g, "[number redacted]"],
  [/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, "[email redacted]"],
  [/wa\.me\/\S+/gi, "[link redacted]"],
  [/@\w{2,}/g, "[handle redacted]"],
];
function redactPII(text: string): string { return PII_PATTERNS.reduce((value, [pattern, replacement]) => value.replace(pattern, replacement), text); }
function sanitizeEvidence(messages: EvidenceMessage[], claimantId: string): Evidence[] {
  return messages.map(message => ({ role: message.sender_id === claimantId ? "[Claimant]" : "[Respondent]", body: redactPII(message.flagged ? `⚠️ [FLAGGED: ${message.flag_type}] ${message.body ?? ""}` : message.body ?? ""), created_at: message.created_at, is_system: message.is_system_msg ?? false, flagged: message.flagged ?? false }));
}

async function assignJurors(caseId: string, required: number, excludeIds: string[], disputeCampus: string, currentRotations: number): Promise<string[]> {
  const excluded = excludeIds.length ? `(${excludeIds.map(id => `'${id}'`).join(",")})` : "('')";
  const { data: crossJurors } = await admin.from("profiles").select("id").eq("juror_enabled", true).gte("rolling_accuracy", 50).lt("juror_cases_today", 5).eq("collusion_flag", false).neq("university", disputeCampus);
  let selected = (crossJurors ?? []).map(row => row.id as string);
  if (selected.length < required) {
    const allExcluded = [...excludeIds, ...selected];
    const exclusion = allExcluded.length ? `(${allExcluded.map(id => `'${id}'`).join(",")})` : "('')";
    const { data: fallback } = await admin.from("profiles").select("id").eq("juror_enabled", true).gte("rolling_accuracy", 50).lt("juror_cases_today", 5).eq("collusion_flag", false).not("id", "in", exclusion);
    selected = [...selected, ...(fallback ?? []).map(row => row.id as string)];
  }
  await admin.from("jury_cases").update({ jurors_assigned: selected, status: "deliberating", assigned_at: new Date().toISOString(), juror_rotation_count: currentRotations + selected.length }).eq("id", caseId);
  if (selected.length) {
    await admin.from("jury_votes").upsert(selected.map(id => ({ case_id: caseId, juror_id: id, verdict: "pending" })));
    await admin.from("notifications").insert(selected.map(id => ({ user_id: id, type: "jury_assigned", title: "⚖️ New Case — 30 Minutes to Respond", body: "A dispute from another campus needs your judgment." })));
  }
  return selected;
}

async function fetchPaystackRefund(secret: string, reference: string): Promise<Record<string, unknown> | null> {
  const query = new URLSearchParams({ reference, perPage: "1", page: "1" });
  const response = await fetch(`https://api.paystack.co/refund?${query.toString()}`, {
    headers: { Authorization: `Bearer ${secret}` },
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.status || !Array.isArray(payload.data)) return null;
  return payload.data.find((item: Record<string, unknown>) =>
    typeof item.reference === "string" && item.reference.toLowerCase() === reference.toLowerCase()
  ) ?? null;
}

async function executeVerdict(juryCase: DisputeCase, verdict: string) {
  if (verdict === "claimant") {
    const { data: tx, error: txError } = await admin.from("transactions")
      .select("id,amount,payment_method,paystack_ref,refund_status")
      .eq("id", juryCase.transaction_id).single();
    if (txError || !tx) throw txError ?? new Error("Transaction not found");
    if ((tx.payment_method ?? "paystack") !== "campus_wallet") {
      const { data: claim, error: claimError } = await admin.rpc("claim_paystack_refund", { p_transaction_id: tx.id });
      if (claimError) throw claimError;
      if (claim?.status === "needs-attention") {
        throw new Error("The Paystack refund needs verified customer bank details before this dispute can be financially settled");
      }
      if (claim?.claimed || claim?.status === "processing") {
        const requestReference = claim?.request_reference as string | undefined;
        if (!requestReference || !/^[A-Za-z0-9_-]{8,64}$/.test(requestReference)) {
          throw new Error("The Paystack refund idempotency reference is missing; manual reconciliation is required");
        }
        const secret = Deno.env.get("PAYSTACK_SECRET_KEY");
        if (!secret) throw new Error("Paystack refund service is not configured");
        let refund = claim.claimed ? null : await fetchPaystackRefund(secret, requestReference);
        if (!refund) {
          let response: Response | null = null;
          let payload: Record<string, unknown> | null = null;
          try {
            response = await fetch("https://api.paystack.co/refund", {
              method: "POST",
              headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
              body: JSON.stringify({
                transaction: tx.paystack_ref,
                amount: tx.amount,
                reference: requestReference,
                customer_note: `Campus Plug dispute refund for ${tx.paystack_ref}`,
                merchant_note: `Campus Plug dispute refund for transaction ${tx.id}`,
              }),
              signal: AbortSignal.timeout(15_000),
            });
            payload = await response.json().catch(() => null);
          } catch (error) {
            console.error("Dispute refund request outcome is ambiguous", error);
            refund = await fetchPaystackRefund(secret, requestReference);
            if (!refund) throw new Error("Dispute refund is still being reconciled against its stable Paystack reference");
          }
          if (!refund && response?.status === 409) {
            refund = await fetchPaystackRefund(secret, requestReference);
            if (!refund) throw new Error("Paystack reports this dispute refund reference already exists but it is not yet retrievable");
          } else if (!refund && response && (!response.ok || !payload?.status || !payload?.data)) {
            const message = typeof payload?.message === "string" ? payload.message : "Paystack rejected the dispute refund";
            if (response.status >= 500 || response.status === 408) {
              throw new Error("Paystack returned an ambiguous server response; the same refund reference is retained for reconciliation");
            }
            const { error: failureRecordError } = await admin.rpc("record_paystack_refund", {
              p_transaction_reference: tx.paystack_ref,
              p_refund_reference: null,
              p_status: "failed",
              p_amount: tx.amount,
              p_currency: "NGN",
            });
            if (failureRecordError) {
              console.error("Paystack dispute refund rejection could not be recorded atomically", failureRecordError.message);
              throw new Error("Paystack rejected the dispute refund, but local state could not be reconciled; the stable reference remains available for recovery");
            }
            throw new Error(message);
          } else if (!refund && payload?.data && typeof payload.data === "object") {
            refund = payload.data as Record<string, unknown>;
          }
        }
        if (!refund) throw new Error("Paystack dispute refund could not yet be confirmed");
        const { error: recordError } = await admin.rpc("record_paystack_refund", {
          p_transaction_reference: tx.paystack_ref,
          p_refund_reference: refund.id != null ? String(refund.id) : null,
          p_status: typeof refund.status === "string" ? refund.status.toLowerCase().replaceAll("_", "-") : "pending",
          p_amount: Number(refund.amount ?? tx.amount),
          p_currency: typeof refund.currency === "string" ? refund.currency.toUpperCase() : "NGN",
        });
        if (recordError) {
          console.error("Dispute refund was initiated but could not be recorded", recordError.message);
          throw new Error("Dispute refund exists but its provider state could not be recorded; retry will reconcile the same provider reference");
        }
      }
    }
  }
  const { data, error } = await admin.rpc("resolve_dispute_verdict", { p_case_id: juryCase.id, p_verdict: verdict, p_admin_override: false });
  if (error) throw error;
  const messages: Record<string, string> = { claimant: "⚖️ The cross-campus jury found in your favour. Your escrow protection is restored.", respondent: "⚖️ The cross-campus jury found against you. The escrow has been released." };
  for (const userId of [juryCase.claimant_id, juryCase.respondent_id]) await admin.from("notifications").insert({ user_id: userId, type: "jury_verdict", title: "⚖️ Jury Verdict Delivered", body: messages[userId === juryCase.claimant_id ? "claimant" : "respondent"] });
  return data;
}

async function rewardJuror(jurorId: string, correct: boolean, caseId: string) {
  const scoreBonus = correct ? 20 : 5;
  const { data: profile } = await admin.from("profiles").select("plug_score").eq("id", jurorId).single();
  if (profile) await admin.from("profiles").update({ plug_score: Math.min((profile.plug_score ?? 500) + scoreBonus, 1000) }).eq("id", jurorId);
  if (correct) {
    await admin.rpc("payout_juror_incentive", { p_juror_id: jurorId, p_amount: JURY_PAYOUT_KOBO });
    await admin.from("jury_votes").update({ plug_credit_payout: JURY_PAYOUT_KOBO, payout_processed: true, reward_given: true }).eq("case_id", caseId).eq("juror_id", jurorId);
  } else await admin.from("jury_votes").update({ reward_given: true }).eq("case_id", caseId).eq("juror_id", jurorId);
  await admin.from("notifications").insert({ user_id: jurorId, type: "jury_reward", title: correct ? `⚖️ Correct Verdict! +${scoreBonus} PlugScore + ₦100 PlugCredit` : `⚖️ Participation Rewarded! +${scoreBonus} PlugScore` });
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return optionsResponse(req);
  if (req.method === "GET" && new URL(req.url).pathname.endsWith("/ping")) return ok(req, { status: "warm", ts: Date.now(), fn: "process-dispute-v6.8" });
  if (req.method !== "POST") return bad(req, "Method not allowed", 405);
  let body: Body; try { body = await req.json(); } catch { return bad(req, "Invalid JSON"); }
  const action = typeof body.action === "string" ? body.action : "";
  const isCron = isServiceRoleRequest(req);

  if (action === "open_case") {
    const user = await getUser(req); if (!user) return bad(req, "Unauthorized", 401);
    const transactionId = typeof body.transaction_id === "string" ? body.transaction_id : "";
    const reason = typeof body.reason === "string" ? body.reason : "";
    if (!transactionId || reason.trim().length < 20) return bad(req, "Dispute reason must be at least 20 characters");
    const { data: rawTx } = await admin.from("transactions").select("*, listings(title, university)").eq("id", transactionId).in("status", ["release_requested", "meetup_initiated", "locked", "disputed"]).maybeSingle();
    const tx = rawTx as TransactionRow | null;
    if (!tx) return bad(req, "Transaction not found or not in a disputable state", 404);
    if (tx.buyer_id !== user.id && tx.seller_id !== user.id) return bad(req, "You are not a party to this transaction", 403);
    const { data: claimant } = await admin.from("profiles").select("university").eq("id", user.id).single();
    const disputeCampus = claimant?.university ?? "";
    const respondentId = tx.buyer_id === user.id ? tx.seller_id : tx.buyer_id;
    const { data: rawMessages } = await admin.from("messages").select("id, sender_id, body, created_at, flagged, flag_type, is_system_msg").eq("transaction_id", transactionId).is("deleted_at", null);
    const evidence = sanitizeEvidence((rawMessages ?? []) as EvidenceMessage[], user.id);
    const { data: opened, error: openError } = await admin.rpc("open_escrow_dispute_case", {
      p_transaction_id: transactionId,
      p_claimant_id: user.id,
      p_reason: reason.trim(),
      p_dispute_campus: disputeCampus,
      p_evidence_messages: evidence,
    });
    if (openError || !opened?.success || !opened.case_id) {
      return bad(req, "Failed to open case: " + (openError?.message ?? "Unknown error"), 409);
    }

    const caseId = opened.case_id as string;
    const highValue = Boolean(opened.high_value);
    const required = Number(opened.required_votes) || (highValue ? 4 : 3);
    let jurors = Array.isArray(opened.jurors_assigned) ? opened.jurors_assigned as string[] : [];
    if (!opened.already_open || jurors.length === 0) {
      jurors = await assignJurors(caseId, required, [user.id, respondentId], disputeCampus, 0);
    }

    const university = tx.listings?.university ?? disputeCampus;
    if (!opened.already_open && university) {
      await admin.from("ticker_events").insert({
        university,
        emoji: "⚖️",
        text: "A dispute is being reviewed by a cross-campus jury. Justice is blind.",
        category: "dispute",
      });
      await admin.rpc("increment_config_counter", { p_key: "peer_jury" });
    }

    return ok(req, {
      success: true,
      case_id: caseId,
      jurors_count: jurors.length,
      high_value: highValue,
      required_votes: required,
      cross_campus: true,
      dispute_campus: disputeCampus,
      already_open: Boolean(opened.already_open),
    });
  }

  if (action === "open_for_review") {
    const user = await getUser(req); if (!user) return bad(req, "Unauthorized", 401);
    const caseId = typeof body.case_id === "string" ? body.case_id : "";
    const { data: juryCase } = await admin.from("jury_cases").select("id, jurors_assigned, status, high_value").eq("id", caseId).eq("status", "deliberating").maybeSingle();
    if (!juryCase) return bad(req, "Case not found or not deliberating", 404);
    if (!(juryCase.jurors_assigned as string[] | null)?.includes(user.id)) return bad(req, "Not assigned to this case", 403);
    const { data: existingVote } = await admin.from("jury_votes").select("first_opened_at, opened_count").eq("case_id", caseId).eq("juror_id", user.id).maybeSingle();
    if (existingVote?.first_opened_at) return ok(req, { success: true, first_opened_at: existingVote.first_opened_at, already_opened: true, required_review_s: juryCase.high_value ? HIGH_VALUE_REVIEW_S : STANDARD_REVIEW_S });
    const now = new Date().toISOString();
    if (existingVote) await admin.from("jury_votes").update({ first_opened_at: now, opened_count: (existingVote.opened_count ?? 0) + 1 }).eq("case_id", caseId).eq("juror_id", user.id).is("first_opened_at", null);
    else await admin.from("jury_votes").upsert({ case_id: caseId, juror_id: user.id, verdict: "pending", first_opened_at: now, opened_count: 1 });
    return ok(req, { success: true, first_opened_at: now, already_opened: false, required_review_s: juryCase.high_value ? HIGH_VALUE_REVIEW_S : STANDARD_REVIEW_S });
  }

  if (action === "submit_vote") {
    const user = await getUser(req); if (!user) return bad(req, "Unauthorized", 401);
    const caseId = typeof body.case_id === "string" ? body.case_id : "";
    const verdict = typeof body.verdict === "string" ? body.verdict : "";
    const reasoning = typeof body.reasoning === "string" ? body.reasoning.trim() : null;
    if (!caseId || !verdict) return bad(req, "Missing case_id or verdict");
    if (!["claimant", "respondent", "split"].includes(verdict)) return bad(req, "verdict must be: claimant | respondent | split");
    const [{ data: rawCase }, { data: existingVote }] = await Promise.all([
      admin.from("jury_cases").select("*").eq("id", caseId).eq("status", "deliberating").maybeSingle(),
      admin.from("jury_votes").select("first_opened_at, verdict, reward_given").eq("case_id", caseId).eq("juror_id", user.id).maybeSingle(),
    ]);
    const juryCase = rawCase as DisputeCase | null;
    if (!juryCase) return bad(req, "Case not found or not accepting votes", 404);
    if (!(juryCase.jurors_assigned ?? []).includes(user.id)) return bad(req, "Not assigned to this case", 403);
    if (existingVote?.verdict && existingVote.verdict !== "pending") return bad(req, "You have already voted on this case", 409);
    if (!existingVote?.first_opened_at) return bad(req, "You must open the case first. Call open_for_review before voting.");
    const elapsedS = (Date.now() - new Date(existingVote.first_opened_at).getTime()) / 1000;
    const requiredS = juryCase.high_value ? HIGH_VALUE_REVIEW_S : STANDARD_REVIEW_S;
    if (elapsedS < requiredS) return bad(req, `Minimum review time not met. Required: ${requiredS}s. Elapsed: ${Math.floor(elapsedS)}s.`);
    const { data: profile } = await admin.from("profiles").select("juror_cases_today").eq("id", user.id).single();
    if ((profile?.juror_cases_today ?? 0) >= 5) return bad(req, "Daily jury limit reached (5 cases/day). Come back tomorrow.", 429);
    await admin.from("jury_votes").update({ verdict, reasoning }).eq("case_id", caseId).eq("juror_id", user.id);
    await Promise.all([
      admin.from("profiles").update({ juror_cases_today: (profile?.juror_cases_today ?? 0) + 1, juror_last_case_at: new Date().toISOString() }).eq("id", user.id),
      admin.from("jury_cases").update({ votes_cast: juryCase.votes_cast + 1 }).eq("id", caseId),
    ]);
    const { data: votes } = await admin.from("jury_votes").select("juror_id, verdict").eq("case_id", caseId).neq("verdict", "pending");
    const tally: Record<string, number> = { claimant: 0, respondent: 0, split: 0 };
    for (const vote of votes ?? []) if (vote.verdict in tally) tally[vote.verdict]++;
    const finalVerdict = Object.entries(tally).find(([, count]) => count >= juryCase.required_votes)?.[0] ?? null;
    if (!finalVerdict) return ok(req, { success: true, votes_cast: juryCase.votes_cast + 1, verdict: null, case_closed: false });
    if (finalVerdict === "split") {
      const { error: escalationError } = await admin.from("jury_cases").update({
        status: "escalated",
        escalated_to_admin: true,
        escalated_at: new Date().toISOString(),
      }).eq("id", juryCase.id).eq("status", "deliberating");
      if (escalationError) throw escalationError;
      for (const userId of [juryCase.claimant_id, juryCase.respondent_id]) {
        await admin.from("notifications").insert({
          user_id: userId,
          type: "jury_escalated",
          title: "⚖️ Dispute referred for admin review",
          body: "The jury vote was split. Your escrow remains protected while the case is reviewed.",
        });
      }
      return ok(req, { success: true, verdict: "split", case_closed: true, escalated: true });
    }
    // resolve_dispute_verdict owns the locked, atomic case + escrow settlement.
    // Marking the case decided here first would make the RPC return already_resolved
    // and skip the financial and transaction-state changes entirely.
    await executeVerdict(juryCase, finalVerdict);
    for (const vote of votes ?? []) { const correct = vote.verdict === finalVerdict; await rewardJuror(vote.juror_id, correct, caseId); await admin.rpc("update_juror_accuracy", { p_juror_id: vote.juror_id }); }
    const minsElapsed = Math.round((Date.now() - new Date(juryCase.created_at).getTime()) / 60_000);
    await admin.from("ticker_events").insert({ university: juryCase.dispute_campus ?? "", emoji: "⚖️", text: `Cross-campus dispute resolved in ${minsElapsed} minutes. Justice served.`, category: "dispute" });
    return ok(req, { success: true, verdict: finalVerdict, case_closed: true });
  }

  if (action === "check_verdict") {
    const user = await getUser(req); if (!user) return bad(req, "Unauthorized", 401);
    const caseId = typeof body.case_id === "string" ? body.case_id : "";
    const { data: juryCase } = await admin.from("jury_cases").select("status, verdict, votes_cast, required_votes, verdict_decided_at, escalated_to_admin").eq("id", caseId).maybeSingle();
    if (!juryCase) return bad(req, "Case not found", 404);
    const { data: myVote } = await admin.from("jury_votes").select("verdict, reward_given, plug_credit_payout").eq("case_id", caseId).eq("juror_id", user.id).maybeSingle();
    return ok(req, { ...juryCase, my_vote: myVote?.verdict ?? null, reward_given: myVote?.reward_given ?? false, plug_credit: myVote?.plug_credit_payout ?? 0 });
  }

  if (action === "reclaim_silent") {
    if (!isCron) return bad(req, "Forbidden — cron only", 403);
    const { data: cases } = await admin.from("jury_cases").select("id").eq("status", "deliberating").eq("escalated_to_admin", false).lt("assigned_at", new Date(Date.now() - RECLAIM_TIMEOUT_MS).toISOString());
    let reclaimed = 0, escalations = 0;
    for (const item of cases ?? []) { const { data: result } = await admin.rpc("reclaim_silent_jurors", { p_case_id: item.id }); if (result?.escalated) escalations++; else reclaimed += result?.reclaimed ?? 0; }
    try {
      await admin.rpc("cleanup_amber_confirmations");
    } catch {
      // Silently ignore cleanup errors
    }
    return ok(req, { reclaimed, escalations, cases_processed: cases?.length ?? 0 });
  }

  if (action === "rotate_stale") {
    if (!isCron) return bad(req, "Forbidden — cron only", 403);
    const { data: cases } = await admin.from("jury_cases").select("id, votes_cast, required_votes, jurors_assigned, juror_rotation_count, claimant_id, respondent_id, dispute_campus").eq("status", "deliberating").eq("escalated_to_admin", false).lt("assigned_at", new Date(Date.now() - RECLAIM_TIMEOUT_MS).toISOString());
    let rotated = 0;
    for (const item of cases ?? []) {
      if (item.votes_cast >= item.required_votes) continue;
      const rotations = item.juror_rotation_count ?? 0;
      if (rotations >= MAX_ROTATIONS) { await admin.from("jury_cases").update({ escalated_to_admin: true, escalated_at: new Date().toISOString(), status: "escalated" }).eq("id", item.id); continue; }
      await assignJurors(item.id, item.required_votes, [item.claimant_id, item.respondent_id, ...(item.jurors_assigned ?? [])], item.dispute_campus ?? "", rotations);
      rotated++;
    }
    return ok(req, { rotated, total: cases?.length ?? 0 });
  }

  return bad(req, `Unknown action: ${action}`);
});
