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
 * separate count in every Worker isolate). For Claude work only, a
 * claude_account_hash that differs from the pairing's recorded value blocks
 * execution as 'claude_account_changed'. Codex and local v2 work ignore that
 * Claude-only block. A pairing with NO recorded hash yet binds the FIRST one
 * a Claude claim reports here (bindFirstClaudeAccountHash, Codex review P1,
 * 2026-10-12) --
 * this is the only enforcement point for a connector pairing, which is
 * auto-approved on redeem and never passes through POST
 * /api/devices/[id]/approve, the route this used to depend on entirely.
 * Refused ('claude_account_shared') if another approved, non-revoked
 * pairing in the same tenant already carries that hash under a different
 * person.
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
  claimCleanupForPairing,
  claimComputerRun,
  findClaimedComputerRun,
  finishProducerRun,
  peekComputerRun,
  producerEventsExist,
  type ClaimPairing,
  type Run,
} from "@/lib/os/runs/store";
import { failureCopy } from "@/lib/os/channel/outcome";
import { buildComputerTurn } from "@/lib/os/runs/computer-turn";
import { parseRuntimeClaimState, type RuntimeClaimState } from "@/lib/bridge/runtime-jobs/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_WAIT_MS = 20_000;
const POLL_EVERY_MS = 2_000;
const CLAIM_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const BLOCKED_REASON_RE = /^[a-z0-9_]{1,80}$/;
const CLAUDE_ACCOUNT_HASH_RE = /^[a-f0-9]{64}$/;

type ClaimBody = {
  protocol?: unknown;
  claim_id?: unknown;
  capacity?: unknown;
  in_flight?: unknown;
  blocked_reason?: unknown;
  claude_account_hash?: unknown;
  runtime_state?: unknown;
  wait_ms?: unknown;
};

type DepartmentTaskProtocol = "department_task_v1" | "department_task_v2";
type ClaudeAccountBlockReason = "claude_account_shared" | "claude_account_changed";

async function pairingAdvertisesProtocol(
  pairing: Pick<ResolvedPairing, "pairingId" | "tenantId">,
  protocol: DepartmentTaskProtocol,
): Promise<boolean> {
  const { data, error } = await getServiceSupabase()
    .from("bridge_pairings")
    .select("claim_protocols")
    .eq("tenant_id", pairing.tenantId)
    .eq("id", pairing.pairingId)
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

/** The claude_account_hash recorded at this pairing's approval. A failed read is never equivalent to NULL. */
async function approvedClaudeAccountHash(
  pairing: Pick<ResolvedPairing, "pairingId" | "tenantId">,
): Promise<{ ok: true; hash: string | null } | { ok: false }> {
  try {
    const { data, error } = await getServiceSupabase()
      .from("bridge_pairings")
      .select("claude_account_hash")
      .eq("tenant_id", pairing.tenantId)
      .eq("id", pairing.pairingId)
      .maybeSingle();
    if (error) {
      console.error("[bridge.runs.claim] claude-account binding read failed", error.message);
      return { ok: false };
    }
    if (!data) return { ok: false };
    const v = (data as { claude_account_hash?: unknown } | null)?.claude_account_hash;
    if (v == null || v === "") return { ok: true, hash: null };
    if (typeof v !== "string" || !CLAUDE_ACCOUNT_HASH_RE.test(v)) {
      console.error("[bridge.runs.claim] stored claude-account hash is invalid", pairing.pairingId);
      return { ok: false };
    }
    return { ok: true, hash: v };
  } catch (error) {
    console.error("[bridge.runs.claim] claude-account binding read threw", error instanceof Error ? error.message : String(error));
    return { ok: false };
  }
}

type ClaudeHashRow = {
  id: string;
  user_id: string | null;
  claim_enabled_at: string | null;
  created_at: string | null;
};

async function activeClaudeHashRows(
  pairing: Pick<ResolvedPairing, "tenantId">,
  hash: string,
): Promise<{ ok: true; rows: ClaudeHashRow[] } | { ok: false }> {
  try {
    const result = await getServiceSupabase()
      .from("bridge_pairings")
      .select("id, user_id, claim_enabled_at, created_at")
      .eq("tenant_id", pairing.tenantId)
      .eq("claude_account_hash", hash)
      .is("revoked_at", null);
    if (result.error) {
      console.error("[bridge.runs.claim] claude-account collision read failed", result.error.message);
      return { ok: false };
    }
    return {
      ok: true,
      rows: ((result.data || []) as ClaudeHashRow[]).filter((row) => Boolean(row.user_id && row.claim_enabled_at)),
    };
  } catch (error) {
    console.error("[bridge.runs.claim] claude-account collision read threw", error instanceof Error ? error.message : String(error));
    return { ok: false };
  }
}

/** Clear only the binding this reconciliation observed; a newer value always wins. */
async function clearClaudeHashIfStill(
  pairing: Pick<ResolvedPairing, "pairingId" | "tenantId">,
  hash: string,
): Promise<boolean> {
  try {
    const result = await getServiceSupabase()
      .from("bridge_pairings")
      .update({ claude_account_hash: null })
      .eq("tenant_id", pairing.tenantId)
      .eq("id", pairing.pairingId)
      .eq("claude_account_hash", hash)
      .is("revoked_at", null)
      .select("id, claude_account_hash");
    if (result.error) {
      console.error("[bridge.runs.claim] claude-account collision cleanup failed", result.error.message);
      return false;
    }
    if ((result.data?.length ?? 0) > 0) return true;
    const reread = await approvedClaudeAccountHash(pairing);
    return reread.ok && reread.hash !== hash;
  } catch (error) {
    console.error("[bridge.runs.claim] claude-account collision cleanup threw", error instanceof Error ? error.message : String(error));
    return false;
  }
}

/**
 * Reconcile the only cross-row race a per-pairing CAS cannot prevent. SQLite
 * serializes the writes, then this deterministic pass retains the oldest
 * approved owner's binding and CAS-clears every different owner's loser.
 */
async function reconcileClaudeHashOwners(
  pairing: Pick<ResolvedPairing, "pairingId" | "tenantId" | "userId">,
  hash: string,
): Promise<{ ok: true } | { ok: false; blockedReason: ClaudeAccountBlockReason }> {
  const bindings = await activeClaudeHashRows(pairing, hash);
  if (!bindings.ok) return { ok: false, blockedReason: "claude_account_changed" };
  if (!bindings.rows.some((row) => row.id === pairing.pairingId)) {
    // This pairing was cleared/de-approved between its CAS/read and this
    // reconciliation. Another pairing carrying the hash is not proof that
    // THIS caller is bound to it.
    return { ok: false, blockedReason: "claude_account_changed" };
  }
  const owners = new Set(bindings.rows.map((row) => row.user_id).filter((userId): userId is string => Boolean(userId)));
  if (owners.size <= 1) return { ok: true };

  const ordered = [...bindings.rows].sort((a, b) => {
    const byCreated = String(a.created_at || "").localeCompare(String(b.created_at || ""));
    return byCreated || a.id.localeCompare(b.id);
  });
  const winningUserId = ordered[0]?.user_id ?? null;
  if (!winningUserId) return { ok: false, blockedReason: "claude_account_changed" };

  const losers = bindings.rows.filter((row) => row.user_id !== winningUserId);
  const cleared = await Promise.all(
    losers.map((row) => clearClaudeHashIfStill({ pairingId: row.id, tenantId: pairing.tenantId }, hash)),
  );
  if (cleared.some((ok) => !ok)) return { ok: false, blockedReason: "claude_account_shared" };
  return pairing.userId === winningUserId
    ? { ok: true }
    : { ok: false, blockedReason: "claude_account_shared" };
}

/**
 * First-seen Claude account binding (Codex review, P1, 2026-10-12).
 *
 * POST /api/devices/[id]/approve used to be the ONLY place a
 * claude_account_hash was ever recorded or checked against another
 * person's approved pairing (security rule: two people sharing one Claude
 * sign-in is not "their own subscription"). D0's connector auto-approve
 * (lib/turso-rpc-shim.ts redeem_pair_code) skips that route entirely, so a
 * connector pairing could claim work under a shared Claude account forever
 * with nothing ever checking it -- this call site, not the approve route,
 * is the one every connector pairing actually passes through.
 *
 * Runs ONLY when the pairing has NO recorded hash yet (the caller checks
 * `!approvedHash` first) -- a pairing that already has one takes the
 * existing claude_account_changed path below instead, unchanged.
 *
 * The ownership check and bind are deliberately ONE SQLite statement. A
 * prior read-then-CAS implementation still let two different people's first
 * claims both write during the gap between those statements. SQLite
 * serializes these conditional UPDATEs, so the second writer observes the
 * first binding in NOT EXISTS and affects zero rows.
 *
 * This also covers the re-pair case the review flagged: lib/turso-rpc-
 * shim.ts clears claude_account_hash to NULL on every rotate (including a
 * connector-scope one, which keeps approval across the rotate) -- a cleared
 * hash is NOT a cleared BINDING, it is "unbound again," and the very next
 * claim call re-runs this exact check before anything can claim work.
 *
 * And the pre-existing gap the review also named: a pairing approved
 * before this feature existed (NULL hash, daemon scope included) records
 * its hash the same way, on its very first claim call after this ships.
 */
async function bindFirstClaudeAccountHash(
  pairing: Pick<ResolvedPairing, "pairingId" | "tenantId" | "userId">,
  hash: string,
): Promise<{ ok: true } | { ok: false; blockedReason: ClaudeAccountBlockReason }> {
  try {
    const write = await getTursoClient().execute({
      sql: `UPDATE bridge_pairings
               SET claude_account_hash = ?
             WHERE id = ? AND tenant_id = ?
               AND claude_account_hash IS NULL
               AND revoked_at IS NULL
               AND claim_enabled_at IS NOT NULL
               AND NOT EXISTS (
                 SELECT 1
                   FROM bridge_pairings other
                  WHERE other.tenant_id = ?
                    AND other.claude_account_hash = ?
                    AND other.user_id IS NOT ?
                    AND other.revoked_at IS NULL
                    AND other.claim_enabled_at IS NOT NULL
               )`,
      args: [hash, pairing.pairingId, pairing.tenantId, pairing.tenantId, hash, pairing.userId],
    });
    if (write.rowsAffected === 1) return { ok: true };
  } catch (error) {
    console.error("[bridge.runs.claim] claude-account bind write threw", error instanceof Error ? error.message : String(error));
    return { ok: false, blockedReason: "claude_account_changed" };
  }

  // Zero rows has exactly three safe interpretations. A concurrent request
  // may have bound this same pairing to the same hash; a different hash means
  // the account changed; a still-NULL row means NOT EXISTS found another
  // person's active binding and this account is shared.
  const winner = await approvedClaudeAccountHash(pairing);
  if (!winner.ok) return { ok: false, blockedReason: "claude_account_changed" };
  if (winner.hash === hash) return { ok: true };
  return {
    ok: false,
    blockedReason: winner.hash === null ? "claude_account_shared" : "claude_account_changed",
  };
}

async function claudeAccountBlockReason(
  pairing: Pick<ResolvedPairing, "pairingId" | "tenantId" | "userId">,
  hash: string | null,
): Promise<ClaudeAccountBlockReason | null> {
  if (!hash) return null;
  const approved = await approvedClaudeAccountHash(pairing);
  if (!approved.ok) return "claude_account_changed";
  if (approved.hash && approved.hash !== hash) return "claude_account_changed";
  if (!approved.hash) {
    const bound = await bindFirstClaudeAccountHash(pairing, hash);
    return bound.ok ? null : bound.blockedReason;
  }
  const reconciled = await reconcileClaudeHashOwners(pairing, hash);
  return reconciled.ok ? null : reconciled.blockedReason;
}

function isClaudeAccountBlockReason(reason: string | null): reason is ClaudeAccountBlockReason {
  return reason === "claude_account_changed" || reason === "claude_account_shared";
}

function runUsesClaude(run: Run, protocol: DepartmentTaskProtocol): boolean {
  return protocol === "department_task_v1" || (run.runtimeEngineKind === "cli" && run.runtimeEngineName === "claude");
}

/**
 * Turn the connector's bounded, fresh runtime snapshot into the same
 * availability reason the queue follower understands. A v2 task is ready
 * only when the exact snapshotted CLI/model says it can execute now;
 * installation or an auth artifact alone is deliberately insufficient.
 */
function runtimeBlockReason(run: Pick<Run, "runtimeEngineKind" | "runtimeEngineName">, state: RuntimeClaimState): string | null {
  const name = run.runtimeEngineName;
  if (run.runtimeEngineKind === "cli" && (name === "claude" || name === "codex" || name === "gemini")) {
    const runtime = state[name];
    if (runtime.state === "unsupported") return "cli_account_unsupported";
    if (!runtime.installed || runtime.state === "not_installed") return "cli_not_found";
    if (!runtime.authenticated || runtime.state === "needs_sign_in") return "subscription_auth_failure";
    if (runtime.state === "rate_limited") return "subscription_limit";
    return runtime.state === "ready" ? null : "department_profile_unsupported";
  }
  if (run.runtimeEngineKind === "local" && name) {
    const model = state.local_models?.find((candidate) => candidate.ref === name);
    return model?.state === "ready" ? null : "department_profile_unsupported";
  }
  return "department_profile_unsupported";
}

type ClaimState = {
  capacity: number;
  inFlight: number;
  blockedReason: string | null;
  runtimeState: RuntimeClaimState | null;
};

/** The state stamp + rate limit, in ONE UPDATE. null = the rate limit held (too fast), or the row was revoked between auth and here. */
async function stampClaimState(pairing: ResolvedPairing, state: ClaimState, ip: string, nowIso: string): Promise<boolean> {
  const db = getServiceSupabase();
  const cutoff = new Date(Date.parse(nowIso) - 1000).toISOString();
  const update: Record<string, unknown> = {
    claim_state_at: nowIso,
    claim_capacity: state.capacity,
    claim_in_flight: state.inFlight,
    claim_blocked_reason: state.blockedReason,
    last_claim_ip: ip,
  };
  if (state.runtimeState) update.claim_runtime_state = JSON.stringify(state.runtimeState);
  const upd = await db
    .from("bridge_pairings")
    .update(update)
    .eq("tenant_id", pairing.tenantId)
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

/**
 * Record why the exact runtime for the next v2 run cannot answer. The
 * claim_state_at equality is a stale-writer guard: an older long poll must
 * never overwrite a newer claim call that already repaired the runtime.
 */
async function recordRuntimeBlock(
  pairing: ResolvedPairing,
  runtimeState: RuntimeClaimState,
  blockedReason: string,
  claimStateAt: string,
): Promise<boolean> {
  // A subscription quota belongs to one CLI, not the whole computer. Keep
  // the exact verdict in claim_runtime_state so the queued-run follower can
  // activate that run's explicit fallback without making a ready sibling
  // runtime (for example Codex while Claude is limited) unclaimable.
  const pairingWideReason = blockedReason === "subscription_limit" ? null : blockedReason;
  const upd = await getServiceSupabase()
    .from("bridge_pairings")
    .update({
      claim_runtime_state: JSON.stringify(runtimeState),
      claim_blocked_reason: pairingWideReason,
    })
    .eq("tenant_id", pairing.tenantId)
    .eq("id", pairing.pairingId)
    .eq("claim_state_at", claimStateAt)
    .is("revoked_at", null)
    .select("id");
  if (upd.error) {
    console.error("[bridge.runs.claim] runtime block stamp failed", upd.error.message);
    return false;
  }
  return (upd.data?.length ?? 0) > 0;
}

async function failClaimedRun(run: Run, code: string): Promise<NextResponse> {
  const copyCode = code === "claude_account_shared" ? "claude_account_changed" : code;
  await finishProducerRun(getTursoClient(), run, {
    status: "failed",
    errorCode: copyCode,
    message: failureCopy(copyCode, { canManageAi: false }).sentence,
    inputTokens: null,
    outputTokens: null,
    now: new Date(),
  });
  return NextResponse.json({ ok: true, run: null });
}

async function buildAndRespond(run: Run, pairing: ResolvedPairing): Promise<NextResponse> {
  const dept = OS_DEPARTMENTS.find((d) => d.key === run.department);
  if (!dept) return failClaimedRun(run, "department_profile_unsafe");

  // Re-check the seat AFTER claiming (O4 security rule): a removal between
  // send and claim, or between claim calls, must never hand a removed
  // person's run to any computer.
  const viewer = await resolveOsViewerFor(run.tenantId, run.userId);
  if (!viewer.ok || departmentGate(dept.slug, viewer.navInput) === null) return failClaimedRun(run, "seat_removed");

  const [tenantSlug, operator, sessionVersion] = await Promise.all([
    resolveOwnedSlug(run.tenantId),
    operatorIdentityFor(run.tenantId, run.userId),
    currentSessionVersion(run.userId),
  ]);
  if (!tenantSlug) return failClaimedRun(run, "department_profile_unsafe");

  // Final disclosure gate. The request may have spent 20 seconds in its
  // long poll, and workspace-default work may belong to someone other than
  // this computer's owner. Re-check BOTH the pairing and that owner's seat
  // after all setup reads and immediately before buildComputerTurn creates
  // the prompt, history and MCP credentials returned to the connector.
  const [pairingLive, pairingOwnerSeat] = await Promise.all([
    pairingLiveForClaim(run.claimedPairingId ?? pairing.pairingId, pairing.tenantId),
    pairing.userId ? liveSeat(pairing.tenantId, pairing.userId) : Promise.resolve({ live: false as const }),
  ]);
  if (!pairingLive) return failClaimedRun(run, "computer_offline");
  if (!pairingOwnerSeat.live) return failClaimedRun(run, "seat_removed");

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
  if (!result.ok) return failClaimedRun(run, result.error);
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
    if (!(await pairingAdvertisesProtocol(pairing, protocol))) return bad(400, "unsupported_protocol");
  } catch (error) {
    console.error("[bridge.runs.claim.protocol]", error instanceof Error ? error.message : String(error));
    return bad(503, "protocol_check_unavailable");
  }
  const claimId = typeof body.claim_id === "string" && CLAIM_ID_RE.test(body.claim_id) ? body.claim_id : null;
  if (!claimId) return bad(400, "claim_id_required");
  const parsedRuntimeState = protocol === "department_task_v2" ? parseRuntimeClaimState(body.runtime_state) : null;
  if (parsedRuntimeState && !parsedRuntimeState.ok) return bad(400, parsedRuntimeState.code);
  if (protocol === "department_task_v2" && !parsedRuntimeState?.state) return bad(400, "runtime_state_required");
  const runtimeState = parsedRuntimeState?.state ?? null;
  const capacity = clampInt(body.capacity, 0, 2, 0);
  const inFlight = clampInt(body.in_flight, 0, 2, 0);
  const bodyBlockedReason =
    typeof body.blocked_reason === "string" && BLOCKED_REASON_RE.test(body.blocked_reason) ? body.blocked_reason : null;
  const hasClaudeAccountHash = Object.prototype.hasOwnProperty.call(body, "claude_account_hash");
  if (
    hasClaudeAccountHash &&
    (typeof body.claude_account_hash !== "string" || !CLAUDE_ACCOUNT_HASH_RE.test(body.claude_account_hash))
  ) {
    return bad(400, "claude_account_hash_invalid");
  }
  const claudeAccountHash = hasClaudeAccountHash ? (body.claude_account_hash as string) : null;
  const waitMs = clampInt(body.wait_ms, 0, MAX_WAIT_MS, 0);

  // V2 derives availability from the exact queued run's engine below. A
  // pairing-wide free-form block could otherwise let one signed-out CLI
  // poison a different ready CLI or local model on the same computer.
  let blockedReason = protocol === "department_task_v2" ? null : bodyBlockedReason;
  if (protocol === "department_task_v1") {
    // V1 is Claude-only, so its account identity remains a pairing-wide
    // claim block. V2 defers this until it knows the claimed run's engine;
    // otherwise a Claude mismatch would incorrectly stop Codex/local work.
    const accountBlock = await claudeAccountBlockReason(
      { pairingId: pairing.pairingId, tenantId: pairing.tenantId, userId: pairing.userId },
      claudeAccountHash,
    );
    if (accountBlock) blockedReason = accountBlock;
  }

  const now = new Date();
  const claimStateAt = now.toISOString();
  const stamped = await stampClaimState(
    pairing,
    { capacity, inFlight, blockedReason, runtimeState },
    getClientIp(req),
    claimStateAt,
  );
  if (!stamped) {
    const current = await resolvePairingFromBearer(req);
    if (!current.ok) return bad(current.status, current.error);
    return NextResponse.json({ ok: false, error: "claim_too_fast" }, { status: 429 });
  }

  const claimPairing: ClaimPairing = { tenantId: pairing.tenantId, userId: pairing.userId, pairingId: pairing.pairingId };
  const db = getTursoClient();
  const scope = { tenantId: pairing.tenantId, userId: pairing.userId };

  if (protocol === "department_task_v2") {
    await claimCleanupForPairing(db, { tenantId: pairing.tenantId, pairingId: pairing.pairingId }, now);
  } else {
    await claimCleanup(db, scope, now);
  }

  const respondToClaimedRun = async (run: Run): Promise<NextResponse> => {
    if (protocol === "department_task_v2") {
      const runtimeReason = runtimeBlockReason(run, runtimeState!);
      if (runtimeReason) {
        await recordRuntimeBlock(pairing, runtimeState!, runtimeReason, claimStateAt);
        // This branch is reachable for an idempotent retry whose runtime
        // changed after its original lease. It is already claimed, so close
        // it without ever rebuilding/disclosing the prompt.
        return failClaimedRun(run, runtimeReason);
      }
    }
    if (protocol === "department_task_v2" && runUsesClaude(run, protocol)) {
      // V2 advertises per-run engines, so a connector may legitimately omit
      // Claude identity while claiming Codex/local work. Once the exact run
      // is known to be Claude, however, the account proof is mandatory. A
      // heartbeat/auth-file check is not sufficient to execute tenant work.
      if (!claudeAccountHash) return failClaimedRun(run, "department_profile_unsupported");
      const accountBlock = await claudeAccountBlockReason(
        { pairingId: pairing.pairingId, tenantId: pairing.tenantId, userId: pairing.userId },
        claudeAccountHash,
      );
      const claudeOnlyBlock = accountBlock ?? (isClaudeAccountBlockReason(bodyBlockedReason) ? bodyBlockedReason : null);
      if (claudeOnlyBlock) return failClaimedRun(run, claudeOnlyBlock);
    }
    return buildAndRespond(run, pairing);
  };

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
    return respondToClaimedRun(existing);
  };
  const retried = await idempotentLookup();
  if (retried) return retried;

  // "Claim only when capacity > 0 and blocked_reason is null" -- a computer
  // reporting it is full or blocked gets no work and no wait, and the CAS
  // claim below is never even attempted; it will ask again on its next
  // ping/claim cycle.
  if (capacity <= 0 || blockedReason) return NextResponse.json({ ok: true, run: null });

  const tryClaim = async (): Promise<NextResponse | null> => {
    // V2 peeks the exact row selected by the queue ordering, validates that
    // row's immutable engine snapshot against THIS claim's fresh bounded
    // runtime state, then pins the row id into the claim CAS. If queue order
    // changes in between, the CAS refuses rather than disclose a different
    // engine that was never checked.
    const candidate = protocol === "department_task_v2"
      ? await peekComputerRun(db, claimPairing, protocol)
      : null;
    if (protocol === "department_task_v2" && !candidate) return null;
    if (candidate) {
      const runtimeReason = runtimeBlockReason(candidate, runtimeState!);
      if (runtimeReason) {
        await recordRuntimeBlock(pairing, runtimeState!, runtimeReason, claimStateAt);
        return NextResponse.json({ ok: true, run: null });
      }
    }
    const claimed = await claimComputerRun(db, claimPairing, claimId, new Date(), protocol, candidate?.id ?? null);
    if (claimed) return respondToClaimedRun(claimed);
    // claimComputerRun returning null is ambiguous on its own: either there
    // was nothing left to claim, OR a concurrent request for this EXACT
    // (pairing, claim_id) just won the unique-index race for a DIFFERENT
    // run (Codex review, [P2]). The loser must return the WINNER's
    // assignment, never silently re-poll as if nothing happened yet.
    const wonByOther = await findClaimedComputerRun(db, claimPairing, claimId, protocol);
    return wonByOther ? respondToClaimedRun(wonByOther) : null;
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
