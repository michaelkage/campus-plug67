/**
 * Campus Plug — process-dispute v6.7
 *
 * Cross-Campus Justice & Cash Incentives
 *
 * Key additions over v6.3:
 *
 * 1. CROSS-CAMPUS ROUTING
 *    Jurors are selected where profiles.university != dispute parties' university.
 *    Prevents a UNILAG student from judging a UNILAG trade.
 *    Fallback: if insufficient cross-campus jurors, any eligible juror used (liveness).
 *
 * 2. BLIND UI DATA
 *    Evidence messages: sender names replaced with [Claimant] / [Respondent].
 *    PII redacted via regex: phone numbers, email addresses stripped.
 *    Server-side only — jurors never see real identities.
 *
 * 3. INTEGRITY DIVIDEND (₦100 PlugCredit)
 *    On case resolution, call payout_juror_incentive(juror_id, 10000) for
 *    jurors who voted with the winning majority.
 *    Atomically increments profiles.plug_credit_balance + appends to ledger.
 *
 * All v6.3 preserved: reclaim system, rotation ceiling (max 10 → admin escalation),
 * first_opened_at immutability, anti-speedrun server timing, daily cap.
 *
 * Actions: open_case | open_for_review | submit_vote | check_verdict
 *          reclaim_silent | rotate_stale
 * GET /ping → keep-alive
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.43.4";

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Content-Type": "application/json",
};

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } }
);

const ok  = (d: unknown) => new Response(JSON.stringify(d),             { status: 200, headers: CORS });
const bad = (m: string, s = 400) => new Response(JSON.stringify({ error: m }), { status: s, headers: CORS });

const HIGH_VALUE_KOBO     = 5_000_000; // ₦50,000
const HIGH_VALUE_REVIEW_S = 20;
const STANDARD_REVIEW_S   = 5;
const RECLAIM_TIMEOUT_MS  = 30 * 60_000;
const MAX_ROTATIONS       = 10;
const JURY_PAYOUT_KOBO    = 10_000;   // ₦100

async function getUser(req: Request) {
  const t = req.headers.get("Authorization")?.replace("Bearer ", "");
  if (!t) return null;
  const { data: { user } } = await admin.auth.getUser(t);
  return user;
}

// ── PII redaction patterns ────────────────────────────────────────────────────
const PII_PATTERNS: [RegExp, string][] = [
  // Nigerian phone numbers
  [/(?:\+?234|0)(?:7|8|9)(?:0|1)\d{8}/g, "[phone redacted]"],
  // Generic 11-digit numbers
  [/\b\d{11}\b/g, "[number redacted]"],
  // Email addresses
  [/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, "[email redacted]"],
  // WhatsApp links
  [/wa\.me\/\S+/gi, "[link redacted]"],
  // Instagram handles
  [/@\w{2,}/g, "[handle redacted]"],
];

function redactPII(text: string): string {
  let out = text;
  for (const [pattern, replacement] of PII_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/**
 * Sanitize evidence messages for jurors:
 * - Replace actual sender IDs with [Claimant] / [Respondent]
 * - Redact all PII from message bodies
 * - Jurors see only: role, sanitized body, timestamp, flagged status
 */
function sanitizeEvidence(
  msgs: any[],
  claimantId: string,
  respondentId: string
): object[] {
  return (msgs || []).map(m => ({
    role:       m.sender_id === claimantId ? "[Claimant]" : "[Respondent]",
    body:       redactPII(m.flagged ? `⚠️ [FLAGGED: ${m.flag_type}] ${m.body}` : (m.body || "")),
    created_at: m.created_at,
    is_system:  !!m.is_system_msg,
    flagged:    !!m.flagged,
  }));
}

/**
 * Select cross-campus jurors.
 * HARD RULE: jurors must be from a different university than the dispute parties.
 * FALLBACK: if < required cross-campus available, fill from any campus (liveness guarantee).
 */
async function assignJurors(
  caseId:         string,
  required:       number,
  excludeIds:     string[],
  disputeCampus:  string,
  currentRotations: number
): Promise<string[]> {
  const excludeClause = excludeIds.length > 0
    ? `(${excludeIds.map(id => `'${id}'`).join(",")})`
    : "('')";

  // Phase 1: cross-campus
  const { data: crossJurors } = await admin.from("profiles")
    .select("id")
    .eq("juror_enabled", true)
    .gte("rolling_accuracy", 50)
    .lt("juror_cases_today", 5)
    .eq("collusion_flag", false)
    .neq("university", disputeCampus)
    .not("id", "in", excludeClause)
    .order("juror_cases_today", { ascending: true })
    .order("rolling_accuracy",  { ascending: false })
    .limit(required + 3);

  let selectedIds = (crossJurors || []).map(j => j.id);

  // Phase 2: fill shortfall from any campus
  if (selectedIds.length < required) {
    const shortfall = required - selectedIds.length;
    const allExclude = [...excludeIds, ...selectedIds];
    const allExcludeClause = allExclude.length > 0
      ? `(${allExclude.map(id => `'${id}'`).join(",")})`
      : "('')";

    const { data: fallbackJurors } = await admin.from("profiles")
      .select("id")
      .eq("juror_enabled", true)
      .gte("rolling_accuracy", 50)
      .lt("juror_cases_today", 5)
      .eq("collusion_flag", false)
      .not("id", "in", allExcludeClause)
      .order("juror_cases_today", { ascending: true })
      .limit(shortfall + 2);

    selectedIds = [...selectedIds, ...(fallbackJurors || []).map(j => j.id)];
  }

  const newRotationCount = currentRotations + selectedIds.length;

  // Update case
  await admin.from("jury_cases").update({
    jurors_assigned:     selectedIds,
    status:              "deliberating",
    assigned_at:         new Date().toISOString(),
    juror_rotation_count: newRotationCount,
  }).eq("id", caseId);

  // Create placeholder vote rows (first_opened_at set via open_for_review)
  if (selectedIds.length > 0) {
    await admin.from("jury_votes").upsert(
      selectedIds.map(id => ({ case_id: caseId, juror_id: id, verdict: "pending" })),
      { onConflict: "case_id,juror_id", ignoreDuplicates: true }
    );
  }

  // Notify jurors with 30-minute urgency
  if (selectedIds.length > 0) {
    await admin.from("notifications").insert(
      selectedIds.map(id => ({
        user_id: id,
        type:    "jury_assigned",
        title:   "⚖️ New Case — 30 Minutes to Respond",
        body:    "A dispute from another campus needs your verdict. Inactive jurors lose -5 PlugScore.",
        data:    { case_id: caseId, campus: disputeCampus },
      }))
    );
  }

  return selectedIds;
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method === "GET" && new URL(req.url).pathname.endsWith("/ping"))
    return ok({ status: "warm", ts: Date.now(), fn: "process-dispute-v6.7" });
  if (req.method !== "POST") return bad("Method not allowed", 405);

  let body: Record<string, unknown>;
  try { body = await req.json(); }
  catch { return bad("Invalid JSON"); }

  const { action } = body as Record<string, string>;
  const isCron = req.headers.get("Authorization") === `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`;

  // ── OPEN CASE ─────────────────────────────────────────────────────────────
  if (action === "open_case") {
    const user = await getUser(req);
    if (!user) return bad("Unauthorized", 401);

    const { transaction_id, reason } = body as Record<string, string>;
    if (!transaction_id || !reason || reason.trim().length < 20)
      return bad("Dispute reason must be at least 20 characters", 400);

    const { data: tx } = await admin.from("transactions")
      .select("*, listings(title, university)")
      .eq("id", transaction_id)
      .in("status", ["release_requested", "meetup_initiated", "locked"])
      .maybeSingle();

    if (!tx) return bad("Transaction not found or not in a disputable state", 404);
    if (tx.buyer_id !== user.id && tx.seller_id !== user.id)
      return bad("You are not a party to this transaction", 403);

    // Get claimant's campus for cross-campus routing
    const { data: claimant } = await admin.from("profiles")
      .select("university").eq("id", user.id).single();
    const disputeCampus = claimant?.university || "";

    const respondentId = tx.buyer_id === user.id ? tx.seller_id : tx.buyer_id;

    // Pull chat evidence and SANITIZE (blind + PII redaction)
    const { data: msgs } = await admin.from("messages")
      .select("id, sender_id, body, created_at, flagged, flag_type, is_system_msg")
      .eq("transaction_id", transaction_id)
      .is("deleted_at", null)
      .order("created_at", { ascending: true })
      .limit(150);

    const sanitizedEvidence = sanitizeEvidence(msgs || [], user.id, respondentId);

    // Create jury case
    const { data: juryCase, error: caseErr } = await admin.from("jury_cases").insert({
      transaction_id,
      claimant_id:       user.id,
      respondent_id:     respondentId,
      dispute_reason:    reason.trim(),
      amount:            tx.amount,
      dispute_campus:    disputeCampus,
      juror_campus_lock: true,
      assigned_at:       new Date().toISOString(),
      evidence_messages: sanitizedEvidence,
    }).select().single();

    if (caseErr) return bad("Failed to open case: " + caseErr.message, 500);

    // Lock transaction
    await admin.from("transactions").update({
      status:         "disputed",
      disputed_at:    new Date().toISOString(),
      dispute_reason: reason.trim(),
    }).eq("id", transaction_id);

    // Assign cross-campus jurors
    const required  = juryCase.high_value ? 4 : 3;
    const jurorIds  = await assignJurors(
      juryCase.id, required,
      [user.id, respondentId],
      disputeCampus, 0
    );

    // Ticker
    const uni = (tx.listings as any)?.university || disputeCampus;
    if (uni) {
      await admin.from("ticker_events").insert({
        university: uni, emoji: "⚖️",
        text:       "A dispute is being reviewed by a cross-campus jury. Justice is blind.",
        category:   "dispute",
      });
    }

    // Increment global_config counter for peer_jury
    await admin.rpc("increment_config_counter", { p_key: "peer_jury" });

    return ok({
      success:        true,
      case_id:        juryCase.id,
      jurors_count:   jurorIds.length,
      high_value:     juryCase.high_value,
      required_votes: required,
      cross_campus:   true,
      dispute_campus: disputeCampus,
    });
  }

  // ── OPEN FOR REVIEW ───────────────────────────────────────────────────────
  if (action === "open_for_review") {
    const user = await getUser(req);
    if (!user) return bad("Unauthorized", 401);

    const { case_id } = body as Record<string, string>;
    if (!case_id) return bad("Missing case_id");

    const { data: juryCase } = await admin.from("jury_cases")
      .select("id, jurors_assigned, status, high_value")
      .eq("id", case_id).eq("status", "deliberating").maybeSingle();

    if (!juryCase) return bad("Case not found or not deliberating", 404);
    if (!juryCase.jurors_assigned?.includes(user.id)) return bad("Not assigned to this case", 403);

    const { data: existingVote } = await admin.from("jury_votes")
      .select("first_opened_at, opened_count")
      .eq("case_id", case_id).eq("juror_id", user.id).maybeSingle();

    const now = new Date().toISOString();

    // first_opened_at is IMMUTABLE — set once, never overwritten (DB trigger enforces too)
    if (existingVote?.first_opened_at) {
      return ok({
        success:           true,
        first_opened_at:   existingVote.first_opened_at,
        already_opened:    true,
        required_review_s: juryCase.high_value ? HIGH_VALUE_REVIEW_S : STANDARD_REVIEW_S,
      });
    }

    // Set for the first time
    if (existingVote) {
      await admin.from("jury_votes")
        .update({ first_opened_at: now, opened_count: (existingVote.opened_count || 0) + 1 })
        .eq("case_id", case_id)
        .eq("juror_id", user.id)
        .is("first_opened_at", null); // guard: only update if still null
    } else {
      await admin.from("jury_votes").insert({
        case_id, juror_id: user.id, verdict: "pending",
        first_opened_at: now, opened_count: 1,
      }).onConflict("case_id,juror_id").ignore();
    }

    return ok({
      success:           true,
      first_opened_at:   now,
      already_opened:    false,
      required_review_s: juryCase.high_value ? HIGH_VALUE_REVIEW_S : STANDARD_REVIEW_S,
    });
  }

  // ── SUBMIT VOTE ───────────────────────────────────────────────────────────
  if (action === "submit_vote") {
    const user = await getUser(req);
    if (!user) return bad("Unauthorized", 401);

    const { case_id, verdict, reasoning } = body as Record<string, unknown>;
    if (!case_id || !verdict) return bad("Missing case_id or verdict");
    if (!["claimant", "respondent", "split"].includes(verdict as string))
      return bad("verdict must be: claimant | respondent | split");

    const [{ data: juryCase }, { data: existingVote }] = await Promise.all([
      admin.from("jury_cases")
        .select("*").eq("id", case_id).eq("status", "deliberating").maybeSingle(),
      admin.from("jury_votes")
        .select("first_opened_at, verdict, reward_given")
        .eq("case_id", case_id).eq("juror_id", user.id).maybeSingle(),
    ]);

    if (!juryCase) return bad("Case not found or not accepting votes", 404);
    if (!juryCase.jurors_assigned?.includes(user.id)) return bad("Not assigned to this case", 403);
    if (existingVote?.verdict && existingVote.verdict !== "pending")
      return bad("You have already voted on this case", 409);

    // SERVER-SIDE TIME VALIDATION — server is truth, client cannot fake this
    if (!existingVote?.first_opened_at)
      return bad("You must open the case first. Call open_for_review before voting.", 400);

    const elapsedS  = (Date.now() - new Date(existingVote.first_opened_at).getTime()) / 1000;
    const requiredS = juryCase.high_value ? HIGH_VALUE_REVIEW_S : STANDARD_REVIEW_S;

    if (elapsedS < requiredS) {
      return bad(
        `Minimum review time not met. Required: ${requiredS}s. Elapsed: ${Math.floor(elapsedS)}s. ` +
        `Wait ${Math.ceil(requiredS - elapsedS)} more seconds.`,
        400
      );
    }

    // Check daily cap
    const { data: jurorProfile } = await admin.from("profiles")
      .select("juror_cases_today").eq("id", user.id).single();
    if ((jurorProfile?.juror_cases_today || 0) >= 5)
      return bad("Daily jury limit reached (5 cases/day). Come back tomorrow.", 429);

    // Record verdict
    await admin.from("jury_votes")
      .update({ verdict: verdict as string, reasoning: (reasoning as string)?.trim() || null })
      .eq("case_id", case_id).eq("juror_id", user.id);

    await Promise.all([
      admin.from("profiles").update({
        juror_cases_today:  (jurorProfile?.juror_cases_today || 0) + 1,
        juror_last_case_at: new Date().toISOString(),
      }).eq("id", user.id),
      admin.from("jury_cases").update({ votes_cast: juryCase.votes_cast + 1 }).eq("id", case_id),
    ]);

    // Check consensus (exclude placeholder 'pending' votes)
    const { data: allVotes } = await admin.from("jury_votes")
      .select("juror_id, verdict")
      .eq("case_id", case_id)
      .neq("verdict", "pending");

    const tally: Record<string, number> = { claimant: 0, respondent: 0, split: 0 };
    for (const v of allVotes || []) {
      if (v.verdict in tally) tally[v.verdict]++;
    }

    let finalVerdict: string | null = null;
    for (const [k, count] of Object.entries(tally)) {
      if (count >= juryCase.required_votes) { finalVerdict = k; break; }
    }

    if (finalVerdict) {
      // Close case
      await admin.from("jury_cases").update({
        status:             "decided",
        verdict:            finalVerdict,
        verdict_decided_at: new Date().toISOString(),
      }).eq("id", case_id);

      // Execute verdict on transaction
      await executeVerdict(juryCase, finalVerdict);

      // Reward all jurors: PlugScore + ₦100 PlugCredit for majority voters
      for (const v of allVotes || []) {
        const correct = v.verdict === finalVerdict;
        await rewardJuror(v.juror_id, correct, case_id);
        await admin.rpc("update_juror_accuracy", { p_juror_id: v.juror_id }).catch(() => {});
      }

      // Ticker
      const minsElapsed = Math.round(
        (Date.now() - new Date(juryCase.created_at).getTime()) / 60_000
      );
      await admin.from("ticker_events").insert({
        university: juryCase.dispute_campus || "",
        emoji:      "⚖️",
        text:       `Cross-campus dispute resolved in ${minsElapsed} minutes. Justice served.`,
        category:   "dispute",
      });

      return ok({ success: true, verdict: finalVerdict, case_closed: true });
    }

    return ok({
      success:    true,
      votes_cast: juryCase.votes_cast + 1,
      verdict:    null,
      case_closed: false,
    });
  }

  // ── CHECK VERDICT ──────────────────────────────────────────────────────────
  if (action === "check_verdict") {
    const user = await getUser(req);
    if (!user) return bad("Unauthorized", 401);

    const { case_id } = body as Record<string, string>;
    const { data: juryCase } = await admin.from("jury_cases")
      .select("status, verdict, votes_cast, required_votes, verdict_decided_at, escalated_to_admin")
      .eq("id", case_id).maybeSingle();

    if (!juryCase) return bad("Case not found", 404);

    const { data: myVote } = await admin.from("jury_votes")
      .select("verdict, reward_given, plug_credit_payout")
      .eq("case_id", case_id).eq("juror_id", user.id).maybeSingle();

    return ok({
      ...juryCase,
      my_vote:       myVote?.verdict || null,
      reward_given:  myVote?.reward_given || false,
      plug_credit:   myVote?.plug_credit_payout || 0,
    });
  }

  // ── RECLAIM SILENT JURORS (cron) ──────────────────────────────────────────
  if (action === "reclaim_silent") {
    if (!isCron) return bad("Forbidden — cron only", 403);

    // Find cases where assignment was >30 min ago and still deliberating
    const { data: openCases } = await admin.from("jury_cases")
      .select("id, dispute_campus")
      .eq("status", "deliberating")
      .eq("escalated_to_admin", false)
      .lt("assigned_at", new Date(Date.now() - RECLAIM_TIMEOUT_MS).toISOString());

    let totalReclaimed = 0, escalations = 0;

    for (const c of openCases || []) {
      const { data: result } = await admin.rpc("reclaim_silent_jurors", { p_case_id: c.id });
      if (result?.escalated) escalations++;
      else totalReclaimed += result?.reclaimed || 0;
    }

    await admin.rpc("cleanup_amber_confirmations" as any).catch(() => {});
    return ok({ reclaimed: totalReclaimed, escalations, cases_processed: openCases?.length || 0 });
  }

  // ── ROTATE STALE CASES (cron) ─────────────────────────────────────────────
  if (action === "rotate_stale") {
    if (!isCron) return bad("Forbidden — cron only", 403);

    const { data: staleCases } = await admin.from("jury_cases")
      .select("id, votes_cast, required_votes, jurors_assigned, juror_rotation_count, claimant_id, respondent_id, dispute_campus")
      .eq("status", "deliberating")
      .eq("escalated_to_admin", false)
      .lt("created_at", new Date(Date.now() - 2 * 3_600_000).toISOString());

    let rotated = 0;
    for (const c of staleCases || []) {
      if (c.votes_cast >= c.required_votes) continue;

      if ((c.juror_rotation_count || 0) >= MAX_ROTATIONS) {
        // Escalate to admin
        await admin.from("jury_cases").update({
          escalated_to_admin: true,
          escalated_at:       new Date().toISOString(),
          status:             "escalated",
        }).eq("id", c.id);
        continue;
      }

      await assignJurors(
        c.id, c.required_votes,
        [c.claimant_id, c.respondent_id, ...(c.jurors_assigned || [])],
        c.dispute_campus || "",
        c.juror_rotation_count || 0
      );
      rotated++;
    }

    return ok({ rotated, total: staleCases?.length || 0 });
  }

  return bad(`Unknown action: ${action}`);
});

// ── Execute verdict on transaction ────────────────────────────────────────────
async function executeVerdict(juryCase: any, verdict: string) {
  if (verdict === "claimant") {
    await admin.from("transactions")
      .update({ status: "cancelled", cancelled_at: new Date().toISOString() })
      .eq("id", juryCase.transaction_id);
    await admin.rpc("apply_dispute_penalty", {
      p_transaction_id: juryCase.transaction_id,
      p_penalize_seller: true,
    }).catch(() => {});
  } else if (verdict === "respondent") {
    await admin.from("transactions")
      .update({ status: "released", released_at: new Date().toISOString() })
      .eq("id", juryCase.transaction_id);
  }

  const msgMap: Record<string, string> = {
    claimant:   "⚖️ The cross-campus jury found in your favour. Your escrow protection is restored.",
    respondent: "⚖️ The cross-campus jury found in the seller's favour. Funds have been released.",
    split:      "⚖️ The jury voted to split. Campus Plug will contact both parties.",
  };

  for (const uid of [juryCase.claimant_id, juryCase.respondent_id]) {
    await admin.from("notifications").insert({
      user_id: uid,
      type:    "jury_verdict",
      title:   "⚖️ Jury Verdict Delivered",
      body:    msgMap[verdict] || "The jury has reached a decision.",
      data:    { case_id: juryCase.id, verdict },
    });
  }
}

// ── Reward juror: PlugScore + ₦100 PlugCredit ─────────────────────────────────
async function rewardJuror(jurorId: string, correct: boolean, caseId: string) {
  const scoreBonus = correct ? 20 : 5;

  // PlugScore update
  const { data: p } = await admin.from("profiles")
    .select("plug_score").eq("id", jurorId).single();
  if (p) {
    await admin.from("profiles")
      .update({ plug_score: Math.min((p.plug_score || 500) + scoreBonus, 1000) })
      .eq("id", jurorId);
  }

  // ₦100 PlugCredit for correct (majority) voters — uses the RPC function
  if (correct) {
    await admin.rpc("payout_juror_incentive", {
      p_juror_id: jurorId,
      p_amount:   JURY_PAYOUT_KOBO,
    });
    // Mark vote as paid
    await admin.from("jury_votes")
      .update({ plug_credit_payout: JURY_PAYOUT_KOBO, payout_processed: true, reward_given: true })
      .eq("case_id", caseId).eq("juror_id", jurorId);
  } else {
    await admin.from("jury_votes")
      .update({ reward_given: true })
      .eq("case_id", caseId).eq("juror_id", jurorId);
  }

  await admin.from("notifications").insert({
    user_id: jurorId,
    type:    "jury_reward",
    title:   correct
      ? `⚖️ Correct Verdict! +${scoreBonus} PlugScore + ₦100 PlugCredit`
      : `⚖️ Participation Reward — +${scoreBonus} PlugScore`,
    body: correct
      ? "Your verdict matched the jury consensus. ₦100 has been added to your PlugCredit balance."
      : "Thank you for serving on this case.",
    data: { case_id: caseId, correct, score_bonus: scoreBonus, credit: correct ? JURY_PAYOUT_KOBO : 0 },
  });
}
