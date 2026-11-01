/**
 * /api/cron-jobs/poll — bearer-authed endpoint for the local bridge daemon.
 *
 * Phase I of giggly-reef harness completeness. The bridge polls this every
 * 60 seconds to pull its tenant's enabled cron jobs. Bridge resolves them
 * into local cron_engine.py SEED_JOBS and ticks them locally; this route
 * only delivers the spec, not the execution.
 *
 * Auth: resolvePairingFromBearer (lib/bridge/pairing-auth.ts), the same
 * bridge_pairings bearer token /api/bridge/ping uses. No session cookie —
 * the bridge is a long-running daemon not a user agent. Polling and
 * reporting both require a DAEMON-scope pairing (O3a security rule 3): a
 * 'connector' pairing (Settings > Computers, no shell) is refused outright
 * — it never even reaches the per-tenant executor gate below. A pairing
 * with a recorded owner must also still be a LIVE seat.
 *
 * GET  → list jobs for the bridge's bound tenant.
 * POST → bridge reports back the outcome of a tick:
 *          { job_id, status: "success"|"error", output?, error? }
 *        Server stamps last_run_at / last_run_status / last_run_output /
 *        last_run_error / run_count++.
 */

import { NextRequest, NextResponse } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { bad, getClientIp, isMissingColumnError } from "@/lib/api-helpers";
import { rateLimit } from "@/lib/rate-limit";
import { isScriptActionType, SCRIPT_ACTION_TYPES } from "@/lib/automations/action-types";
import { resolvePairingFromBearer, isDaemonScope, pairingCanClaim } from "@/lib/bridge/pairing-auth";
import { liveSeat } from "@/lib/os/seat";
import { getTursoClient } from "@/lib/turso";
import { OASIS_SCRIPT_EXECUTOR, isOasisScriptExecutor, claimTenantScript,
  heartbeatTenantScript, completeTenantScript } from "@/lib/automations/tenant-script-lease";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Brute-force gate identical in shape to /api/bridge/ping. Legit
 *  bridges poll every ~60s; the bucket allows post-network-blip
 *  retries but caps anyone hammering with token guesses. */
function checkPollRateLimit(req: NextRequest): NextResponse | null {
  const ip = getClientIp(req);
  const rl = rateLimit({
    key: `cron-poll:${ip}`,
    capacity: 60,
    refillPerSec: 1,
  });
  if (!rl.allowed) {
    return NextResponse.json(
      { ok: false, error: "rate_limited", reset_in: rl.resetIn },
      { status: 429 },
    );
  }
  return null;
}

// One EXPECTED EXECUTOR per tenant. Cron jobs are machine-affine — the scripts
// live in repos that exist on exactly one machine — but ANY paired machine
// could pull the list and, worse, REPORT results. Three incidents in one week
// came through that gap: a stale-code Mac stamped "unresolvable root" over
// healthy Atlas rows, and the VPS spent 11 days paired to the wrong tenant.
// Revocation cannot close it: the Mac holds an operator session and re-pairs
// itself within the hour (three times on 2026-08-22, same machine
// fingerprint). So the gate lives here, on the job pipe itself: an unexpected
// executor receives an EMPTY job list and its result reports are refused.
// Pairing stays open for ping/health; the cron pipe is exclusive.
// Mirrors cron_health_check.EXPECTED_PAIRINGS in the harness — change both.
const EXPECTED_EXECUTOR_BY_TENANT_PREFIX: Record<string, string> = {
  aa04fa1f: "srv1723601 (Linux)", // SunBiz — the VPS
};

function isExpectedExecutor(bridge: BridgeOk): boolean {
  const { tenantId, label } = bridge;
  if (tenantId === OASIS_SCRIPT_EXECUTOR.tenantId) {
    return bridge.claimApproved && isOasisScriptExecutor(bridge);
  }
  const expected = EXPECTED_EXECUTOR_BY_TENANT_PREFIX[tenantId.slice(0, 8)];
  // Tenants without a declared executor keep the old open behavior — this
  // gate hardens the governed tenants without bricking future ones.
  return expected === undefined || expected === label;
}

type BridgeRefusal = { status: number; message: string };
/** pairingId and userId feed O2's owner filter and last_poll_ok_at stamp. */
type BridgeOk = { pairingId: string; tenantId: string; label: string; userId: string | null; claimApproved: boolean };

/**
 * The shared pairing resolver, PLUS the two gates this route adds on top:
 * daemon scope (a 'connector' pairing — Settings > Computers, no shell —
 * never reaches cron jobs at all: 403, not the bare 401 an unknown token
 * gets) and a live seat for whoever owns the pairing (also 403, O3a).
 */
async function resolveBridge(req: NextRequest): Promise<BridgeOk | BridgeRefusal> {
  const resolved = await resolvePairingFromBearer(req);
  if (!resolved.ok) return { status: resolved.status, message: resolved.error };
  const { pairing } = resolved;
  if (!isDaemonScope(pairing)) {
    return { status: 403, message: "connector_scope_cannot_poll_jobs" };
  }
  if (pairing.userId) {
    const seat = await liveSeat(pairing.tenantId, pairing.userId);
    if (!seat.live) return { status: 403, message: `seat_inactive: ${seat.reason}` };
  }
  return { pairingId: pairing.pairingId, tenantId: pairing.tenantId, label: pairing.label,
    userId: pairing.userId, claimApproved: pairingCanClaim(pairing) };
}

function isBridgeOk(r: BridgeOk | BridgeRefusal): r is BridgeOk {
  return (r as BridgeOk).tenantId !== undefined;
}

/**
 * Best-effort: the moment a poll last answered this computer with 200. Feeds
 * the agents-owner attention item "House scheduler has not fetched jobs for N
 * minutes" (lib/admin/attention.ts). Never fails the poll itself — a stamp a
 * daemon never reads is a worse outage than a late attention tile, and the
 * column is new (database/turso/bravo__211_automation_owner.sql), so a
 * deployment mid-rollout sees "no such column" here and simply keeps going.
 */
async function stampLastPollOk(db: ReturnType<typeof getServiceSupabase>, pairingId: string): Promise<void> {
  const result = await db
    .from("bridge_pairings")
    .update({ last_poll_ok_at: new Date().toISOString() })
    .eq("id", pairingId);
  if (result.error && !isMissingColumnError(result.error, "last_poll_ok_at")) {
    console.error("[api/cron-jobs/poll] last_poll_ok_at stamp failed", result.error.message);
  }
}

export async function GET(req: NextRequest) {
  const limited = checkPollRateLimit(req);
  if (limited) return limited;
  const bridge = await resolveBridge(req);
  if (!isBridgeOk(bridge)) return bad(bridge.status, bridge.message);
  const db = getServiceSupabase();
  if (!isExpectedExecutor(bridge)) {
    // 200 with an empty list, not an error: the machine is paired and healthy,
    // it is simply not this tenant's executor. An error would make its daemon
    // retry-spin; an empty list makes it idle politely. It does NOT stamp
    // last_poll_ok_at: that stamp means "the house scheduler fetched its jobs",
    // and another of the owner's computers polling must never hide the
    // executor being down (Codex review, O2).
    return NextResponse.json({ ok: true, jobs: [], polled_at: new Date().toISOString() });
  }

  // Only enabled jobs go to the bridge — disabled rows still live in the
  // table for the operator to re-enable later, but they don't tick.
  //
  // And only SCRIPT jobs, by ALLOWLIST (lib/automations/action-types.ts). The
  // same table will hold department tasks, which the server runs; the bridge
  // stamps "unknown action_type" over any row it cannot dispatch, so serving
  // one would overwrite its status with a false error every minute it matched.
  // `.in`, never `.neq("department_task")`: a type added later reaches the
  // bridge only once someone names it there.
  //
  // owner_user_id is named EXPLICITLY (not `select("*")`) on purpose: this is
  // the one place O2 needs a missing migration to be LOUD (requirement O2.3).
  // The bridge is an unattended daemon, not a person who can read a banner —
  // silently treating every row as unowned during the rollout gap would be a
  // correct-looking 200 the moment it is actually a sign the column has not
  // landed yet. A named 503 stops the daemon's retry loop from masquerading
  // as a healthy, empty tenant.
  const { data, error } = await db
    .from("tenant_cron_jobs")
    .select(
      "id, agent_key, name, schedule, action_type, action_payload, enabled, last_run_at, run_count, owner_user_id",
    )
    .eq("tenant_id", bridge.tenantId)
    .eq("enabled", true)
    .in("action_type", [...SCRIPT_ACTION_TYPES])
    .order("created_at", { ascending: true });
  if (error) {
    if (isMissingColumnError(error, "owner_user_id")) {
      return NextResponse.json(
        {
          ok: false,
          error: "automation_owner_column_missing",
          message: "The automation-owner column has not been applied to this deployment yet, so this poll cannot be answered safely. Apply database/turso/bravo__211_automation_owner.sql first.",
        },
        { status: 503 },
      );
    }
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  const rows = (data || []) as Array<Record<string, unknown> & { owner_user_id?: string | null }>;
  // A row with an owner goes only to the computer whose paired user_id IS that
  // owner. A row with no owner (a legacy row the migration's backfill could
  // not resolve) keeps today's label-only rule — it has no person to prefer.
  const cloud = bridge.tenantId === OASIS_SCRIPT_EXECUTOR.tenantId;
  const owned = rows.filter((row) => row.owner_user_id === bridge.userId || (!cloud && !row.owner_user_id));
  // There ARE enabled rows for this tenant, but every one of them belongs to
  // someone else: this is the computer being paired to the wrong PERSON, not
  // an empty tenant. An empty 200 here is exactly what makes Bravo's runner
  // idle in silence (cron_runner.py:505-515) — so this is a named refusal
  // instead, never the plausible-looking empty list.
  if (rows.length > 0 && owned.length === 0) {
    return bad(409, "owner_mismatch");
  }
  await stampLastPollOk(db, bridge.pairingId);
  const jobs = owned.map(({ owner_user_id: _ownerUserId, ...job }) => job);
  return NextResponse.json({ ok: true, jobs, polled_at: new Date().toISOString(),
    ...(cloud ? { claim_protocol: 2, timezone: OASIS_SCRIPT_EXECUTOR.timezone } : {}) });
}

export async function POST(req: NextRequest) {
  const limited = checkPollRateLimit(req);
  if (limited) return limited;
  const bridge = await resolveBridge(req);
  if (!isBridgeOk(bridge)) return bad(bridge.status, bridge.message);
  if (!isExpectedExecutor(bridge)) {
    // The WRITE side is the one that poisons rows — refuse it loudly so the
    // machine's own log says exactly why its report was not accepted.
    return bad(403, "executor_not_authorized_for_tenant");
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return bad(400, "invalid_json");
  }

  const jobId = String(body?.job_id || "").trim();
  if (!jobId) return bad(400, "missing_job_id");
  if (bridge.tenantId === OASIS_SCRIPT_EXECUTOR.tenantId) {
    try {
      const client = getTursoClient();
      if (body.operation === "claim") {
        const grant = await claimTenantScript(client, bridge, jobId);
        return NextResponse.json(grant, { status: grant.ok ? 200 : 409 });
      }
      const token = typeof body.lease_token === "string" ? body.lease_token : "";
      if (!/^[0-9a-f-]{36}$/.test(token)) return bad(400, "valid_lease_token_required");
      if (body.operation === "heartbeat") {
        const ok = await heartbeatTenantScript(client, bridge, jobId, token);
        return NextResponse.json({ ok, ...(ok ? {} : { error: "lease_lost" }) }, { status: ok ? 200 : 409 });
      }
      if (body.status !== "success" && body.status !== "error") return bad(400, "status_must_be_success_or_error");
      const result = await completeTenantScript(client, bridge, {
        jobId, token, status: body.status,
        output: typeof body.output === "string" ? body.output : null,
        error: typeof body.error === "string" ? body.error : null,
      });
      return NextResponse.json(result, { status: result.ok ? 200 : 409 });
    } catch {
      // A missing migration or database failure cannot authorize execution or
      // manufacture a completed run. No raw provider details reach the caller.
      return bad(503, "script_execution_store_unavailable");
    }
  }
  const status = String(body?.status || "").trim();
  if (status !== "success" && status !== "error") {
    return bad(400, "status_must_be_success_or_error");
  }
  const output = typeof body?.output === "string" ? body.output.slice(0, 8000) : null;
  const errorText = typeof body?.error === "string" ? body.error.slice(0, 2000) : null;

  const db = getServiceSupabase();
  // The bridge may only report on a job it could have been served. Read the
  // row's type first, tenant-scoped; anything that is not a script job is
  // refused BEFORE record_tenant_cron_run, so a department task's run_count and
  // last-run status are only ever the dispatcher's.
  const typeRead = await db
    .from("tenant_cron_jobs")
    .select("id, action_type, owner_user_id, enabled")
    .eq("id", jobId)
    .eq("tenant_id", bridge.tenantId)
    .maybeSingle();
  if (typeRead.error) {
    console.error("[api/cron-jobs/poll POST] job type read failed", { tenantId: bridge.tenantId, jobId, error: typeRead.error.message });
    return NextResponse.json({ ok: false, error: "job_lookup_failed" }, { status: 500 });
  }
  if (!typeRead.data) return bad(404, "job_not_found_or_other_tenant");
  const reportRow = typeRead.data as { owner_user_id?: string | null; enabled?: boolean | number };
  if (reportRow.owner_user_id && reportRow.owner_user_id !== bridge.userId) return bad(403, "owner_mismatch");
  if (!reportRow.enabled) return bad(409, "job_disabled");
  if (!isScriptActionType((typeRead.data as { action_type?: unknown }).action_type)) {
    return NextResponse.json(
      {
        ok: false,
        error: "not_a_bridge_job",
        message: "This job is not run by the bridge, so the bridge cannot report on it.",
      },
      { status: 409 },
    );
  }

  // Migration 087 — atomic single-statement update via record_tenant_cron_run.
  // Previous SELECT-then-UPDATE pattern raced under multi-machine pairing.
  const rpc = await db.rpc("record_tenant_cron_run", {
    p_job_id: jobId,
    p_tenant_id: bridge.tenantId,
    p_status: status,
    p_output: output,
    p_error: errorText,
  });
  if (rpc.error) {
    return NextResponse.json({ ok: false, error: rpc.error.message }, { status: 500 });
  }
  const result = rpc.data as { ok: boolean; error?: string; run_count?: number } | null;
  if (!result?.ok) {
    return bad(404, result?.error || "job_not_found_or_other_tenant");
  }
  return NextResponse.json({ ok: true, job_id: jobId, run_count: result.run_count });
}
