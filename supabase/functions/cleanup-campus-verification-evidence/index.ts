import { createClient } from "https://esm.sh/@supabase/supabase-js@2.43.4";
import { isServiceRoleRequest, jsonResponse, optionsResponse } from "../_shared/auth.ts";

const BUCKET = "campus-verification-evidence";
const BATCH_SIZE = 50;

type CleanupItem = {
  id: string;
  evidence_path: string;
  evidence_cleanup_attempts: number;
  status: "approved" | "rejected" | "expired";
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return optionsResponse(req);
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405, {}, req);

  const serviceKey = Deno.env.get("EDGE_FUNCTION_SERVICE_KEY")
    || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")
    || "";
  const url = Deno.env.get("SUPABASE_URL");
  if (!serviceKey || !url) return jsonResponse({ error: "Worker is not configured" }, 500, {}, req);
  if (!isServiceRoleRequest(req)) return jsonResponse({ error: "Forbidden" }, 403, {}, req);

  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: claim, error: claimError } = await admin.rpc(
    "claim_campus_verification_evidence_cleanup",
    { p_batch_size: BATCH_SIZE },
  );
  if (claimError) {
    console.error("Campus evidence cleanup claim failed", claimError.message);
    return jsonResponse({ error: "Unable to claim evidence cleanup work" }, 500, {}, req);
  }

  const items = (claim?.claimed ?? []) as CleanupItem[];
  let deleted = 0;
  let failed = 0;

  for (const item of items) {
    const { error: storageError } = await admin.storage.from(BUCKET).remove([item.evidence_path]);
    if (storageError) {
      failed += 1;
      const { error: recordError } = await admin.rpc("fail_campus_verification_evidence_cleanup", {
        p_request_id: item.id,
        p_evidence_path: item.evidence_path,
        p_error: storageError.message,
      });
      if (recordError) console.error("Unable to record evidence cleanup failure", item.id, recordError.message);
      continue;
    }

    const { data: completed, error: completeError } = await admin.rpc(
      "complete_campus_verification_evidence_cleanup",
      { p_request_id: item.id, p_evidence_path: item.evidence_path },
    );
    if (completeError || completed !== true) {
      // The object may already be gone. Keep the DB path intact so the next run
      // can retry the idempotent Storage removal and reconcile the metadata.
      failed += 1;
      console.error("Unable to finalize evidence cleanup", item.id, completeError?.message ?? "Claim no longer active");
      if (!completeError) {
        await admin.rpc("fail_campus_verification_evidence_cleanup", {
          p_request_id: item.id,
          p_evidence_path: item.evidence_path,
          p_error: "Storage object removed but database finalization did not complete",
        });
      }
      continue;
    }
    deleted += 1;
  }

  const { data: orphanClaim, error: orphanClaimError } = await admin.rpc(
    "claim_campus_verification_orphan_cleanup",
    { p_batch_size: BATCH_SIZE },
  );
  if (orphanClaimError) {
    failed += 1;
    console.error("Campus orphan evidence cleanup claim failed", orphanClaimError.message);
  }

  const orphanItems = (orphanClaim?.claimed ?? []) as Array<{
    id: string;
    evidence_path: string;
    attempts: number;
  }>;
  let orphanDeleted = 0;
  let orphanFailed = 0;

  for (const item of orphanItems) {
    const { error: storageError } = await admin.storage.from(BUCKET).remove([item.evidence_path]);
    if (storageError) {
      orphanFailed += 1;
      failed += 1;
      const { error: recordError } = await admin.rpc("fail_campus_verification_orphan_cleanup", {
        p_job_id: item.id,
        p_evidence_path: item.evidence_path,
        p_error: storageError.message,
      });
      if (recordError) console.error("Unable to record orphan evidence cleanup failure", item.id, recordError.message);
      continue;
    }

    const { data: completed, error: completeError } = await admin.rpc(
      "complete_campus_verification_orphan_cleanup",
      { p_job_id: item.id, p_evidence_path: item.evidence_path },
    );
    if (completeError || completed !== true) {
      orphanFailed += 1;
      failed += 1;
      console.error("Unable to finalize orphan evidence cleanup", item.id, completeError?.message ?? "Claim no longer active");
      if (!completeError) {
        await admin.rpc("fail_campus_verification_orphan_cleanup", {
          p_job_id: item.id,
          p_evidence_path: item.evidence_path,
          p_error: "Storage object removed but orphan cleanup finalization did not complete",
        });
      }
      continue;
    }
    orphanDeleted += 1;
  }

  const expiredRequests = Number(claim?.expired_requests ?? 0);
  return jsonResponse({
    success: failed === 0,
    expired_requests: expiredRequests,
    claimed: items.length,
    deleted,
    failed,
    orphan_discovered: Number(orphanClaim?.discovered ?? 0),
    orphan_claimed: orphanItems.length,
    orphan_deleted: orphanDeleted,
    orphan_failed: orphanFailed,
  }, failed === 0 ? 200 : 207, {}, req);
});
