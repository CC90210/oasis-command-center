import "server-only";
import type { NextRequest } from "next/server";
import { pairingLiveForClaim } from "@/lib/bridge/pairing-auth";
import { liveSeat } from "@/lib/os/seat";
import { runSigningKey, verifyRunCredential } from "@/lib/os/runs/producer-auth";
import { getServiceSupabase } from "@/lib/supabase-server";
import { failClaimedHarnessJobForInactivePairingOwner, readHarnessJobForProducer } from "./store";
import type { HarnessJob } from "./types";

export type HarnessPairingOwnerSeat =
  | { live: true; userId: string }
  | {
      live: false;
      reason:
        | "pairing_not_found"
        | "pairing_owner_missing"
        | "pairing_owner_changed"
        | "seat_inactive"
        | "unavailable";
    };

/** Re-read the pairing owner and that owner's seat immediately before any
 * harness payload or producer mutation. The bearer resolution at claim start
 * is intentionally not reused across a long poll. */
export async function liveHarnessPairingOwner(
  tenantId: string,
  pairingId: string,
  expectedOwnerId?: string,
): Promise<HarnessPairingOwnerSeat> {
  try {
    const result = await getServiceSupabase()
      .from("bridge_pairings")
      .select("user_id")
      .eq("tenant_id", tenantId)
      .eq("id", pairingId)
      .maybeSingle();
    if (result.error) throw new Error(result.error.message);
    const ownerId = String((result.data as { user_id?: string | null } | null)?.user_id || "");
    if (!result.data) return { live: false, reason: "pairing_not_found" };
    if (!ownerId) return { live: false, reason: "pairing_owner_missing" };
    if (expectedOwnerId && ownerId !== expectedOwnerId) {
      return { live: false, reason: "pairing_owner_changed" };
    }
    const seat = await liveSeat(tenantId, ownerId);
    if (!seat.live) {
      return { live: false, reason: seat.reason === "unavailable" ? "unavailable" : "seat_inactive" };
    }
    return { live: true, userId: ownerId };
  } catch (error) {
    console.error("[bridge.harness.pairing-owner]", {
      tenantId,
      pairingId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { live: false, reason: "unavailable" };
  }
}

async function terminalizeInactivePairingOwner(job: HarnessJob): Promise<void> {
  if (!job.claimId || !job.leaseId) return;
  const terminalized = await failClaimedHarnessJobForInactivePairingOwner({
    tenantId: job.tenantId,
    pairingId: job.pairingId,
    jobId: job.id,
    claimId: job.claimId,
    leaseId: job.leaseId,
  });
  if (!terminalized) {
    console.error("[bridge.harness.producer.pairing-owner]", {
      tenantId: job.tenantId,
      pairingId: job.pairingId,
      jobId: job.id,
      error: "lease_terminalize_failed",
    });
  }
}

export async function authorizeHarnessProducer(
  req: NextRequest,
  jobId: string,
): Promise<{ ok: true; job: HarnessJob } | { ok: false; status: number; error: string }> {
  if (req.headers.get("origin")) return { ok: false, status: 403, error: "forbidden" };
  const key = await runSigningKey();
  if (!key) return { ok: false, status: 503, error: "producer_not_configured" };
  const presented = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "")?.[1];
  if (!presented) return { ok: false, status: 401, error: "unauthorized" };
  const checked = await verifyRunCredential(key, presented);
  if (!checked.ok || checked.claims.rid !== jobId) return { ok: false, status: 401, error: "unauthorized" };
  const job = await readHarnessJobForProducer({ tenantId: checked.claims.tid, jobId });
  if (!job) return { ok: false, status: 404, error: "job_not_found" };
  if (!(await pairingLiveForClaim(job.pairingId, job.tenantId))) return { ok: false, status: 403, error: "pairing_revoked" };
  const ownerSeat = await liveHarnessPairingOwner(job.tenantId, job.pairingId);
  if (!ownerSeat.live) {
    if (ownerSeat.reason === "unavailable") {
      return { ok: false, status: 503, error: "pairing_owner_check_unavailable" };
    }
    await terminalizeInactivePairingOwner(job);
    return { ok: false, status: 403, error: "pairing_owner_inactive" };
  }
  if (!(await liveSeat(job.tenantId, job.userId)).live) return { ok: false, status: 403, error: "seat_inactive" };
  return { ok: true, job };
}
