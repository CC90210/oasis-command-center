import { type NextRequest, NextResponse } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { getTursoClient, tursoConfigured } from "@/lib/turso";
import { isAgentsOwner } from "@/lib/agents-owner";
import { isDaemonScope, pairingCanClaim, pairingLiveForClaim, resolvePairingFromBearer } from "@/lib/bridge/pairing-auth";
import {
  claimHarnessJob,
  failClaimedHarnessJobForInactivePairingOwner,
  failClaimedHarnessJobForInactiveRequester,
  HARNESS_PROTOCOL,
  validClaimId,
} from "@/lib/bridge/harness-jobs";
import { liveHarnessPairingOwner } from "@/lib/bridge/harness-jobs/producer-auth";
import { liveSeat } from "@/lib/os/seat";
import { mintRunCredential, runSigningKey } from "@/lib/os/runs/producer-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_WAIT_MS = 20_000;
const POLL_MS = 1_000;

function json(status: number, body: Record<string, unknown>) {
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}

function claimBody(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const allowed = new Set(["protocol", "claim_id", "capacity", "wait_ms"]);
  return Object.keys(record).every((key) => allowed.has(key)) ? record : null;
}

async function advertises(pairingId: string, tenantId: string): Promise<boolean> {
  const result = await getServiceSupabase()
    .from("bridge_pairings")
    .select("claim_protocols")
    .eq("tenant_id", tenantId)
    .eq("id", pairingId)
    .maybeSingle();
  if (result.error) throw new Error(result.error.message);
  const raw = (result.data as { claim_protocols?: unknown } | null)?.claim_protocols;
  try {
    const protocols = typeof raw === "string" ? JSON.parse(raw) : raw;
    return Array.isArray(protocols) && protocols.includes(HARNESS_PROTOCOL);
  } catch {
    return false;
  }
}

export async function POST(req: NextRequest) {
  if (req.headers.get("origin")) return json(403, { ok: false, error: "unexpected_origin_header" });
  if (!tursoConfigured()) return json(503, { ok: false, error: "database_not_configured" });
  const resolved = await resolvePairingFromBearer(req);
  if (!resolved.ok) return json(resolved.status, { ok: false, error: resolved.error });
  const { pairing } = resolved;
  if (!pairing.userId) return json(409, { ok: false, error: "pairing_has_no_owner" });
  if (!pairingCanClaim(pairing)) return json(403, { ok: false, error: "not_approved" });
  if (isDaemonScope(pairing) && !(await isAgentsOwner(pairing.tenantId, pairing.userId))) {
    return json(403, { ok: false, error: "agents_owner_only" });
  }
  if (!(await liveSeat(pairing.tenantId, pairing.userId)).live) return json(403, { ok: false, error: "seat_inactive" });
  try {
    if (!(await advertises(pairing.pairingId, pairing.tenantId))) return json(400, { ok: false, error: "unsupported_protocol" });
  } catch (error) {
    console.error("[bridge.harness.claim.protocol]", error instanceof Error ? error.message : String(error));
    return json(503, { ok: false, error: "protocol_check_unavailable" });
  }

  let decoded: unknown;
  try {
    decoded = await req.json();
  } catch {
    return json(400, { ok: false, error: "invalid_json" });
  }
  const body = claimBody(decoded);
  if (!body) return json(400, { ok: false, error: "invalid_body" });
  if (body.protocol !== HARNESS_PROTOCOL) return json(400, { ok: false, error: "unsupported_protocol" });
  if (!validClaimId(body.claim_id)) return json(400, { ok: false, error: "claim_id_required" });
  const capacity = Number.isFinite(Number(body.capacity)) ? Math.max(0, Math.min(1, Math.floor(Number(body.capacity)))) : 0;
  const waitMs = Number.isFinite(Number(body.wait_ms)) ? Math.max(0, Math.min(MAX_WAIT_MS, Math.floor(Number(body.wait_ms)))) : 0;
  if (capacity === 0) return json(200, { ok: true, job: null });

  const db = getTursoClient();
  const tryClaim = () => claimHarnessJob({
    tenantId: pairing.tenantId,
    pairingId: pairing.pairingId,
    claimId: body.claim_id as string,
  }, db);
  let job = await tryClaim();
  const deadline = Date.now() + Math.max(0, waitMs - POLL_MS);
  while (!job && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    job = await tryClaim();
  }
  if (!job) return json(200, { ok: true, job: null });
  const requesterSeat = await liveSeat(job.tenantId, job.userId);
  if (!requesterSeat.live) {
    const terminalized = Boolean(job.claimId && job.leaseId) && await failClaimedHarnessJobForInactiveRequester({
      tenantId: job.tenantId,
      pairingId: job.pairingId,
      jobId: job.id,
      claimId: job.claimId!,
      leaseId: job.leaseId!,
    }, db);
    if (!terminalized) {
      console.error("[bridge.harness.claim.requester-seat]", {
        tenantId: job.tenantId,
        pairingId: job.pairingId,
        jobId: job.id,
        reason: requesterSeat.reason,
        error: "lease_terminalize_failed",
      });
    }
    return json(200, { ok: true, job: null });
  }
  if (!(await pairingLiveForClaim(job.pairingId, job.tenantId))) {
    return json(403, { ok: false, error: "pairing_revoked" });
  }
  // The request-start owner check can be twenty seconds old after a long
  // poll. Re-read both pairing ownership and seat liveness after the lease was
  // acquired and before the prompt/context is disclosed to the connector.
  const pairingOwnerSeat = await liveHarnessPairingOwner(job.tenantId, job.pairingId, pairing.userId);
  if (!pairingOwnerSeat.live) {
    if (pairingOwnerSeat.reason === "unavailable") {
      return json(503, { ok: false, error: "pairing_owner_check_unavailable" });
    }
    const terminalized = Boolean(job.claimId && job.leaseId) && await failClaimedHarnessJobForInactivePairingOwner({
      tenantId: job.tenantId,
      pairingId: job.pairingId,
      jobId: job.id,
      claimId: job.claimId!,
      leaseId: job.leaseId!,
    }, db);
    if (!terminalized) {
      console.error("[bridge.harness.claim.pairing-owner]", {
        tenantId: job.tenantId,
        pairingId: job.pairingId,
        jobId: job.id,
        reason: pairingOwnerSeat.reason,
        error: "lease_terminalize_failed",
      });
    }
    return json(403, { ok: false, error: "pairing_owner_inactive" });
  }
  const signingKey = await runSigningKey();
  if (!signingKey) return json(503, { ok: false, error: "producer_not_configured" });
  const ttlSec = Math.max(1, Math.min(15 * 60, Math.floor((Date.parse(job.deadlineAt) - Date.now()) / 1000) + 30));
  const runToken = await mintRunCredential(signingKey, { runId: job.id, tenantId: job.tenantId, ttlSec });
  return json(200, {
    ok: true,
    job: {
      protocol: HARNESS_PROTOCOL,
      job_id: job.id,
      claim_id: job.claimId,
      lease_id: job.leaseId,
      deadline_at: job.deadlineAt,
      engine: job.engine,
      agent: job.agentKey,
      messages: job.request.messages,
      attachments: job.request.attachments,
      session_id: job.request.session_id,
      tab_id: job.request.tab_id,
      chat_mode: job.chatMode,
      disallowed_tools: job.request.disallowed_tools,
      task: job.repoWrites
        ? { kind: "coding", repo_scope: { kind: "agent_root", agent: job.agentKey } }
        : { kind: "conversation", repo_scope: null },
      sandbox: job.repoWrites
        ? { mode: "workspace_write", repo_writes: true }
        : { mode: "read_only", repo_writes: false },
      events_url: `/api/bridge/harness-jobs/${job.id}/events`,
      heartbeat_url: `/api/bridge/harness-jobs/${job.id}/heartbeat`,
      run_token: runToken,
    },
  });
}
