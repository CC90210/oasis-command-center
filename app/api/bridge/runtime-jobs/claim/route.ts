/**
 * A paired computer pulls one allowlisted probe/auth action addressed to that
 * exact pairing. The bearer selects the machine; no pairing id is trusted from
 * the body. A repeated claim_id returns the same live lease.
 */
import { type NextRequest, NextResponse } from "next/server";
import { bad } from "@/lib/api-helpers";
import { pairingCanClaim, resolvePairingFromBearer } from "@/lib/bridge/pairing-auth";
import {
  RUNTIME_ACTION_PROTOCOL,
  claimRuntimeJob,
  failClaimedRuntimeJobForInactiveRequester,
  hasOnlyKeys,
  isPlainObject,
  parseCapabilities,
  parseRuntimeClaimState,
  recordRuntimeClaimState,
  runtimePairingApproval,
  validRequestId,
} from "@/lib/bridge/runtime-jobs";
import { liveSeat } from "@/lib/os/seat";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_WAIT_MS = 20_000;
const POLL_MS = 500;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function POST(req: NextRequest) {
  if (req.headers.get("origin")) return bad(403, "unexpected_origin_header");
  const resolved = await resolvePairingFromBearer(req);
  if (!resolved.ok) return bad(resolved.status, resolved.error);
  const pairing = resolved.pairing;
  if (!pairing.userId) return bad(409, "pairing_has_no_owner");
  if (!pairingCanClaim(pairing)) return bad(403, "pairing_not_approved");
  if (!(await liveSeat(pairing.tenantId, pairing.userId)).live) return bad(403, "seat_inactive");

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return bad(400, "body_must_be_json");
  }
  if (!isPlainObject(raw) || !hasOnlyKeys(raw, ["protocol", "claim_id", "capabilities", "runtime_state", "wait_ms"])) {
    return bad(400, "unexpected_field");
  }
  if (raw.protocol !== RUNTIME_ACTION_PROTOCOL) return bad(400, "unsupported_protocol");
  if (!validRequestId(raw.claim_id)) return bad(400, "invalid_claim_id");
  const capabilities = parseCapabilities(raw.capabilities);
  if (!capabilities.ok) return bad(400, capabilities.code);
  const runtimeState = parseRuntimeClaimState(raw.runtime_state);
  if (!runtimeState.ok) return bad(400, runtimeState.code);
  const waitMs = raw.wait_ms === undefined ? 0 : raw.wait_ms;
  if (!Number.isInteger(waitMs) || Number(waitMs) < 0 || Number(waitMs) > MAX_WAIT_MS) return bad(400, "invalid_wait_ms");

  const stateRecorded = await recordRuntimeClaimState(pairing.tenantId, pairing.pairingId, runtimeState.state);
  if (!stateRecorded) {
    const approval = await runtimePairingApproval(pairing.tenantId, pairing.pairingId, pairing.userId);
    return bad(403, approval === "not_approved" ? "pairing_not_approved" : "pairing_revoked");
  }

  const deadline = Date.now() + Number(waitMs);
  for (;;) {
    // The bearer may stay cryptographically valid after its owner's seat is
    // removed. Re-check on every pass so an already-open long poll stops.
    if (!(await liveSeat(pairing.tenantId, pairing.userId)).live) return bad(403, "seat_inactive");
    const job = await claimRuntimeJob({
      tenantId: pairing.tenantId,
      pairingId: pairing.pairingId,
      claimId: raw.claim_id,
      capabilities: capabilities.capabilities,
    });
    if (job) {
      if (!job.leaseId || !job.deadlineAt) return bad(500, "invalid_runtime_job_state");
      const requesterSeat = await liveSeat(job.tenantId, job.userId);
      if (!requesterSeat.live) {
        const terminalized = Boolean(job.claimId) && await failClaimedRuntimeJobForInactiveRequester({
          tenantId: job.tenantId,
          pairingId: job.pairingId,
          jobId: job.id,
          claimId: job.claimId!,
          leaseId: job.leaseId,
        });
        if (!terminalized) {
          console.error("[bridge.runtime-jobs.claim.requester-seat]", {
            tenantId: job.tenantId,
            pairingId: job.pairingId,
            jobId: job.id,
            reason: requesterSeat.reason,
            error: "lease_terminalize_failed",
          });
        }
        return NextResponse.json({ ok: true, job: null });
      }
      return NextResponse.json({
        ok: true,
        job: {
          protocol: RUNTIME_ACTION_PROTOCOL,
          job_id: job.id,
          lease_id: job.leaseId,
          action: job.action,
          engine: job.engine,
          ...(job.prompt ? { prompt: job.prompt } : {}),
          deadline_at: job.deadlineAt,
        },
      });
    }
    const approval = await runtimePairingApproval(pairing.tenantId, pairing.pairingId, pairing.userId);
    if (approval !== "approved") return bad(403, approval === "not_approved" ? "pairing_not_approved" : "pairing_revoked");
    const remaining = deadline - Date.now();
    if (remaining <= 0) return NextResponse.json({ ok: true, job: null });
    await wait(Math.min(POLL_MS, remaining));
  }
}
