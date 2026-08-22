/**
 * /api/cron-jobs/poll — bearer-authed endpoint for the local bridge daemon.
 *
 * Phase I of giggly-reef harness completeness. The bridge polls this every
 * 60 seconds to pull its tenant's enabled cron jobs. Bridge resolves them
 * into local cron_engine.py SEED_JOBS and ticks them locally; this route
 * only delivers the spec, not the execution.
 *
 * Auth: same bridge_pairings bearer token /api/bridge/ping uses. No
 * session cookie — the bridge is a long-running daemon not a user agent.
 *
 * GET  → list jobs for the bridge's bound tenant.
 * POST → bridge reports back the outcome of a tick:
 *          { job_id, status: "success"|"error", output?, error? }
 *        Server stamps last_run_at / last_run_status / last_run_output /
 *        last_run_error / run_count++.
 */

import { NextRequest, NextResponse } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { bad, getClientIp, sha256 } from "@/lib/api-helpers";
import { rateLimit } from "@/lib/rate-limit";

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
  ef8d389e: "CCPC (Windows)", // OASIS — CC's PC
  aa04fa1f: "srv1723601 (Linux)", // SunBiz — the VPS
};

function isExpectedExecutor(tenantId: string, label: string): boolean {
  const expected = EXPECTED_EXECUTOR_BY_TENANT_PREFIX[tenantId.slice(0, 8)];
  // Tenants without a declared executor keep the old open behavior — this
  // gate hardens the governed tenants without bricking future ones.
  return expected === undefined || expected === label;
}

async function resolveBridge(
  req: NextRequest,
): Promise<{ tenantId: string; label: string } | null> {
  const auth = req.headers.get("authorization") || "";
  if (!auth.toLowerCase().startsWith("bearer ")) return null;
  const tokenPlain = auth.slice(7).trim();
  const tokenHash = sha256(tokenPlain);

  const db = getServiceSupabase();
  const pairing = await db
    .from("bridge_pairings")
    .select("tenant_id, label, revoked_at")
    .eq("bridge_token_hash", tokenHash)
    .maybeSingle();
  if (pairing.error || !pairing.data) return null;
  if (pairing.data.revoked_at) return null;
  return { tenantId: pairing.data.tenant_id, label: String(pairing.data.label || "") };
}

export async function GET(req: NextRequest) {
  const limited = checkPollRateLimit(req);
  if (limited) return limited;
  const bridge = await resolveBridge(req);
  if (!bridge) return bad(401, "invalid_or_revoked_bridge_token");
  if (!isExpectedExecutor(bridge.tenantId, bridge.label)) {
    // 200 with an empty list, not an error: the machine is paired and healthy,
    // it is simply not this tenant's executor. An error would make its daemon
    // retry-spin; an empty list makes it idle politely.
    return NextResponse.json({ ok: true, jobs: [], polled_at: new Date().toISOString() });
  }

  const db = getServiceSupabase();
  // Only enabled jobs go to the bridge — disabled rows still live in the
  // table for the operator to re-enable later, but they don't tick.
  const { data, error } = await db
    .from("tenant_cron_jobs")
    .select(
      "id, agent_key, name, schedule, action_type, action_payload, enabled, last_run_at, run_count",
    )
    .eq("tenant_id", bridge.tenantId)
    .eq("enabled", true)
    .order("created_at", { ascending: true });
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, jobs: data || [], polled_at: new Date().toISOString() });
}

export async function POST(req: NextRequest) {
  const limited = checkPollRateLimit(req);
  if (limited) return limited;
  const bridge = await resolveBridge(req);
  if (!bridge) return bad(401, "invalid_or_revoked_bridge_token");
  if (!isExpectedExecutor(bridge.tenantId, bridge.label)) {
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
  const status = String(body?.status || "").trim();
  if (status !== "success" && status !== "error") {
    return bad(400, "status_must_be_success_or_error");
  }
  const output = typeof body?.output === "string" ? body.output.slice(0, 8000) : null;
  const errorText = typeof body?.error === "string" ? body.error.slice(0, 2000) : null;

  const db = getServiceSupabase();
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
