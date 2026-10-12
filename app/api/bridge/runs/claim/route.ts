/**
 * POST /api/bridge/runs/claim - a person's own paired computer asks for ONE
 * department-chat run to answer (O4 pull dispatch). The computer calls out;
 * OCC never calls in.
 *
 * Auth: the pairing bearer (lib/bridge/pairing-auth.ts resolvePairingFromBearer).
 * NEVER a session cookie, and NEVER an Origin header (this is a machine
 * route under the public /api/bridge prefix, middleware.ts:70).
 *
 * Refusals, in order:
 *   401  the bearer is unknown, revoked, or a stale rotated token past grace
 *        (all from resolvePairingFromBearer itself)
 *   409  pairing_has_no_owner       the pairing names no person at all
 *   403  not_approved               claim_enabled_at is not set, or this is
 *                                   a signup_secret pairing (can never be approved)
 *   403  agents_owner_only          a daemon pairing whose person is not this
 *                                   workspace's agents owner (lib/agents-owner.ts)
 *   403  seat_inactive              the person's seat does not hold right now
 *   400  bad_request / unsupported_protocol / claim_too_fast-shaped body errors
 *
 * Body: { protocol: 'department_task_v1', claim_id, capacity (0..2),
 * in_flight (0..2), blocked_reason (null or a code), claude_account_hash?,
 * wait_ms (<=20000) }.
 *
 * State stamp + rate limit, ONE statement on bridge_pairings, CAS'd on
 * claim_state_at being unset or at least 1s old (the per-computer limiter;
 * replaces the per-isolate in-memory one, lib/rate-limit.ts, which keeps a
 * separate count in every Worker isolate). A claude_account_hash that
 * differs from the one recorded at approval overrides blocked_reason to
 * 'claude_account_changed', whatever the body itself said.
 *
 * Before claiming: claimCleanup (store.ts) reaps this person's own silent
 * producers and times out any chat run that has sat queued too long, so the
 * queue never holds work forever.
 *
 * Claim: ONE compare-and-swap (store.ts claimComputerRun), only this
 * person's runs, chat before test before automation, oldest first within
 * its own conversation. Idempotent: retried with the same claim_id, a run
 * still running with no producer event yet is returned again with fresh
 * tokens; once an event has landed, 409 claim_already_started. With
 * nothing to claim, long-polls (2s) until wait_ms - 2s, then {ok:true,
 * run:null}.
 */
import { type NextRequest, NextResponse } from "next/server";
import { bad, getClientIp } from "@/lib/api-helpers";
import { getServiceSupabase } from "@/lib/supabase-server";
import { getTursoClient, tursoConfigured } from "@/lib/turso";
import { isDaemonScope, pairingCanClaim, pairingLiveForClaim, resolvePairingFromBearer, type ResolvedPairing } from "@/lib/bridge/pairing-auth";
import { isAgentsOwner } from "@/lib/agents-owner";
import { currentSessionVersion, liveSeat } from "@/lib/os/seat";
import { resolveOsViewerFor } from "@/components/os/department/viewer";
import { departmentGate } from "@/components/os/department/gate";
import { OS_DEPARTMENTS } from "@/lib/os/departments";
import { resolveOwnedSlug } from "@/lib/manifest/tenant-scope";
import {
  claimCleanup,
  claimComputerRun,
  findClaimedComputerRun,
  finishProducerRun,
  producerEventsExist,
  type ClaimPairing,
  type Run,
} from "@/lib/os/runs/store";
import { failureCopy } from "@/lib/os/channel/outcome";
import { buildComputerTurn } from "@/lib/os/runs/computer-turn";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_WAIT_MS = 20_000;
const POLL_EVERY_MS = 2_000;
const CLAIM_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const BLOCKED_REASON_RE = /^[a-z0-9_]{1,80}$/;

type ClaimBody = {
  protocol?: unknown;
  claim_id?: unknown;
  capacity?: unknown;
  in_flight?: unknown;
  blocked_reason?: unknown;
  claude_account_hash?: unknown;
  wait_ms?: unknown;
};

type DepartmentTaskProtocol = "department_task_v1" | "department_task_v2";

async function pairingAdvertisesProtocol(pairingId: string, protocol: DepartmentTaskProtocol): Promise<boolean> {
  const { data, error } = await getServiceSupabase()
    .from("bridge_pairings")
    .select("claim_protocols")
    .eq("id", pairingId)
    .maybeSingle();
  if (error) throw new Error(`bridge claim protocol read failed: ${error.message}`);
  const raw = (data as { claim_protocols?: unknown } | null)?.claim_protocols;
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = [];
    }
  }
  // A missing field is the frozen v1 connector deployed before capability
  // advertisement existed. New work never targets it because canonical
  // selections require v2.
  if (protocol === "department_task_v1" && (raw == null || raw === "")) return true;
  return Array.isArray(parsed) && parsed.includes(protocol);
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : fallback;
  return Math.max(min, Math.min(max, n));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The claim's own operator identity for prompt interpolation: best-effort, never blocking on a missing profile. */
async function operatorIdentityFor(tenantId: string, userId: string): Promise<{ name: string; email: string }> {
  try {
    const { data } = await getServiceSupabase()
      .from("user_profiles")
      .select("display_name, full_name, email, deactivated_at")
      .eq("tenant_id", tenantId)
      .eq("auth_user_id", userId)
      .limit(20);
    const rows = (data || []) as Array<{ display_name: string | null; full_name: string | null; email: string | null; deactivated_at: string | null }>;
    const row = rows.find((r) => !r.deactivated_at) ?? rows[0];
    return { name: row?.display_name || row?.full_name || "Operator", email: row?.email || "" };
  } catch {
    return { name: "Operator", email: "" };
  }
}

/** The claude_account_hash recorded at this pairing's approval, for the claude_account_changed override. */
async function approvedClaudeAccountHash(pairingId: string): Promise<string | null> {
  try {
    const { data } = await getServiceSupabase().from("bridge_pairings").select("claude_account_hash").eq("id", pairingId).maybeSingle();
    const v = (data as { claude_account_hash?: unknown } | null)?.claude_account_hash;
    return typeof v === "string" && v ? v : null;
  } catch {
    return null;
  }
}

type ClaimState = { capacity: number; inFlight: number; blockedReason: string | null };

/** The state stamp + rate limit, in ONE UPDATE. null = the rate limit held (too fast), or the row was revoked between auth and here. */
async function stampClaimState(pairing: ResolvedPairing, state: ClaimState, ip: string, nowIso: string): Promise<boolean> {
  const db = getServiceSupabase();
  const cutoff = new Date(Date.parse(nowIso) - 1000).toISOString();
  const upd = await db
    .from("bridge_pairings")
    .update({
      claim_state_at: nowIso,
      claim_capacity: state.capacity,
      claim_in_flight: state.inFlight,
      claim_blocked_reason: state.blockedReason,
      last_claim_ip: ip,
    })
    .eq("id", pairing.pairingId)
    .is("revoked_at", null)
    .or(`claim_state_at.is.null,claim_state_at.lte.${cutoff}`)
    .select("id");
  if (upd.error) {
    console.error("[bridge.runs.claim] state stamp failed", upd.error.message);
    return false;
  }
  return (upd.data?.length ?? 0) > 0;
}

async function buildAndRespond(run: Run, pairing: ResolvedPairing): Promise<NextResponse> {
  const dept = OS_DEPARTMENTS.find((d) => d.key === run.department);
  const fail = async (code: string) => {
    await finishProducerRun(getTursoClient(), run, {
      status: "failed",
      errorCode: code,
      message: failureCopy(code, { canManageAi: false }).sentence,
      inputTokens: null,
      outputTokens: null,
      now: new Date(),
    });
    return NextResponse.json({ ok: true, run: null });
  };
  // Re-check the PAIRING right before building the response, not only at
  // claim time: this covers the idempotent-retry path (which bypasses the
  // CAS entirely) and the few milliseconds between a fresh claim and this
  // function returning. A disconnected computer must never receive the
  // run's conversation history or department context just because it was
  // still approved when the request started.
  if (!(await pairingLiveForClaim(run.claimedPairingId ?? pairing.pairingId))) return fail("computer_offline");
  if (!dept) return fail("department_profile_unsafe");

  // Re-check the seat AFTER claiming (O4 security rule): a removal between
  // send and claim, or between claim calls, must never hand a removed
  // person's run to any computer.
  const viewer = await resolveOsViewerFor(run.tenantId, run.userId);
  if (!viewer.ok || departmentGate(dept.slug, viewer.navInput) === null) return fail("seat_removed");

  const [tenantSlug, operator, sessionVersion] = await Promise.all([
    resolveOwnedSlug(run.tenantId),
    operatorIdentityFor(run.tenantId, run.userId),
    currentSessionVersion(run.userId),
  ]);
  if (!tenantSlug) return fail("department_profile_unsafe");

  const result = await buildComputerTurn({
    db: getTursoClient(),
    run,
    viewer,
    tenantSlug,
    dept,
    operatorName: operator.name,
    email: operator.email,
    label: pairing.label || "Your computer",
    pairingId: pairing.pairingId,
    sessionVersion: sessionVersion ?? 0,
  });
  if (!result.ok) return fail(result.error);
  return NextResponse.json({ ok: true, run: result.body });
}

export async function POST(req: NextRequest) {
  if (req.headers.get("origin")) return bad(403, "unexpected_origin_header");
  if (!tursoConfigured()) return bad(503, "database_not_configured");

  const resolved = await resolvePairingFromBearer(req);
  if (!resolved.ok) return bad(resolved.status, resolved.error);
  const { pairing } = resolved;

  if (!pairing.userId) return bad(409, "pairing_has_no_owner");
  if (!pairingCanClaim(pairing)) return bad(403, "not_approved");
  if (isDaemonScope(pairing) && !(await isAgentsOwner(pairing.tenantId, pairing.userId))) {
    return bad(403, "agents_owner_only");
  }
  const seat = await liveSeat(pairing.tenantId, pairing.userId);
  if (!seat.live) return bad(403, "seat_inactive");

  let body: ClaimBody;
  try {
    body = ((await req.json()) ?? {}) as ClaimBody;
  } catch {
    return bad(400, "invalid_json");
  }
  if (body.protocol !== "department_task_v1" && body.protocol !== "department_task_v2") return bad(400, "unsupported_protocol");
  const protocol = body.protocol as DepartmentTaskProtocol;
  try {
    if (!(await pairingAdvertisesProtocol(pairing.pairingId, protocol))) return bad(400, "unsupported_protocol");
  } catch (error) {
    console.error("[bridge.runs.claim.protocol]", error instanceof Error ? error.message : String(error));
    return bad(503, "protocol_check_unavailable");
  }
  const claimId = typeof body.claim_id === "string" && CLAIM_ID_RE.test(body.claim_id) ? body.claim_id : null;
  if (!claimId) return bad(400, "claim_id_required");
  const capacity = clampInt(body.capacity, 0, 2, 0);
  const inFlight = clampInt(body.in_flight, 0, 2, 0);
  const bodyBlockedReason =
    typeof body.blocked_reason === "string" && BLOCKED_REASON_RE.test(body.blocked_reason) ? body.blocked_reason : null;
  const claudeAccountHash = typeof body.claude_account_hash === "string" && body.claude_account_hash ? body.claude_account_hash : null;
  const waitMs = clampInt(body.wait_ms, 0, MAX_WAIT_MS, 0);

  const approvedHash = await approvedClaudeAccountHash(pairing.pairingId);
  const accountChanged = Boolean(approvedHash && claudeAccountHash && approvedHash !== claudeAccountHash);
  const blockedReason = accountChanged ? "claude_account_changed" : bodyBlockedReason;

  const now = new Date();
  const stamped = await stampClaimState(pairing, { capacity, inFlight, blockedReason }, getClientIp(req), now.toISOString());
  if (!stamped) {
    const current = await resolvePairingFromBearer(req);
    if (!current.ok) return bad(current.status, current.error);
    return NextResponse.json({ ok: false, error: "claim_too_fast" }, { status: 429 });
  }

  const claimPairing: ClaimPairing = { tenantId: pairing.tenantId, userId: pairing.userId, pairingId: pairing.pairingId };
  const db = getTursoClient();
  const scope = { tenantId: pairing.tenantId, userId: pairing.userId };

  await claimCleanup(db, scope, now);

  // The idempotent-retry lookup runs REGARDLESS of capacity/blocked_reason:
  // it answers "did I already claim something under this claim_id", which
  // has nothing to do with what this call's body reports about capacity
  // right now. Checked first, every time, so a computer that reports 0
  // capacity (or a blocked reason) right after a real claim still gets its
  // answer back rather than losing it.
  const idempotentLookup = async (): Promise<NextResponse | null> => {
    const existing = await findClaimedComputerRun(db, claimPairing, claimId, protocol);
    if (!existing) return null;
    if (await producerEventsExist(db, existing)) {
      return NextResponse.json({ ok: false, error: "claim_already_started" }, { status: 409 });
    }
    // No events posted yet under this claim_id: a safe, idempotent retry
    // (a lost answer). Fresh tokens, same run.
    return buildAndRespond(existing, pairing);
  };
  const retried = await idempotentLookup();
  if (retried) return retried;

  // "Claim only when capacity > 0 and blocked_reason is null" -- a computer
  // reporting it is full or blocked gets no work and no wait, and the CAS
  // claim below is never even attempted; it will ask again on its next
  // ping/claim cycle.
  if (capacity <= 0 || blockedReason) return NextResponse.json({ ok: true, run: null });

  const tryClaim = async (): Promise<NextResponse | null> => {
    const claimed = await claimComputerRun(db, claimPairing, claimId, new Date(), protocol);
    if (claimed) return buildAndRespond(claimed, pairing);
    // claimComputerRun returning null is ambiguous on its own: either there
    // was nothing left to claim, OR a concurrent request for this EXACT
    // (pairing, claim_id) just won the unique-index race for a DIFFERENT
    // run (Codex review, [P2]). The loser must return the WINNER's
    // assignment, never silently re-poll as if nothing happened yet.
    const wonByOther = await findClaimedComputerRun(db, claimPairing, claimId, protocol);
    return wonByOther ? buildAndRespond(wonByOther, pairing) : null;
  };
  const first = await tryClaim();
  if (first) return first;

  const deadline = Date.now() + Math.max(0, waitMs - POLL_EVERY_MS);
  while (Date.now() < deadline) {
    await sleep(POLL_EVERY_MS);
    const again = await tryClaim();
    if (again) return again;
  }
  return NextResponse.json({ ok: true, run: null });
}
