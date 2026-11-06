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

import { createHash, createHmac } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { bad, getClientIp, isMissingColumnError } from "@/lib/api-helpers";
import { rateLimit } from "@/lib/rate-limit";
import { isScriptActionType, SCRIPT_ACTION_TYPES } from "@/lib/automations/action-types";
import { GENERATED_SCRIPT_CAPABILITY, machineToolCapabilities } from "@/lib/automations/pipeline";
import { resolvePairingFromBearer, isDaemonScope } from "@/lib/bridge/pairing-auth";
import { liveSeat } from "@/lib/os/seat";

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

type BridgeRefusal = { status: number; message: string };
/** pairingId and userId feed O2's owner filter and last_poll_ok_at stamp. */
type BridgeOk = { pairingId: string; tenantId: string; label: string; userId: string | null };

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
  return { pairingId: pairing.pairingId, tenantId: pairing.tenantId, label: pairing.label, userId: pairing.userId };
}

function isBridgeOk(r: BridgeOk | BridgeRefusal): r is BridgeOk {
  return (r as BridgeOk).tenantId !== undefined;
}

const GENERATED_FILENAME_RE = /^[a-z][a-z0-9_]*\.py$/;

function jsonObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function presentedBearer(req: NextRequest): string {
  const auth = req.headers.get("authorization") || "";
  return auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
}

function generatedScriptMessage(jobId: string, agentKey: string, scriptPath: string, source: string): string {
  const sourceHash = createHash("sha256").update(source, "utf8").digest("hex");
  return `v1\n${jobId}\n${agentKey}\n${scriptPath}\n${sourceHash}`;
}

/**
 * Turn an operator-reviewed template into a one-poll, pairing-specific source
 * envelope. The cron row never stores executable source and none of its
 * forgeable provenance flags count as approval. The daemon must prove it has
 * the exact bearer that authenticated this poll before it writes the file.
 */
async function attachApprovedGeneratedScripts(
  db: ReturnType<typeof getServiceSupabase>,
  rows: Array<Record<string, unknown> & { owner_user_id?: string | null; target_pairing_id?: string | null }>,
  bridge: BridgeOk,
  bearer: string,
): Promise<
  | { ok: true; rows: Array<Record<string, unknown> & { owner_user_id?: string | null; target_pairing_id?: string | null }> }
  | { ok: false; error: string }
> {
  const parsedRows = rows.map((row) => {
    const payload = jsonObject(row.action_payload) || {};
    const sanitized = { ...payload };
    delete sanitized._generated_script;
    delete sanitized._generated_script_content;
    return { row, payload: sanitized, templateId: typeof sanitized._automation_template_id === "string" ? sanitized._automation_template_id.trim() : "" };
  });
  const templateIds = [...new Set(parsedRows.map((entry) => entry.templateId).filter(Boolean))];
  if (templateIds.length === 0) {
    return { ok: true, rows: parsedRows.map(({ row, payload }) => ({ ...row, action_payload: payload })) };
  }
  if (!bearer) {
    console.error("[api/cron-jobs/poll] authenticated request had no usable bearer for generated-script signing");
    await recordGeneratedDeliveryFailure(db, bridge, "generated_script_bearer_missing", { templateIds });
    return { ok: false, error: "generated_script_bearer_missing" };
  }

  const capabilityRead = await db
    .from("bridge_pairings")
    .select("tool_capabilities")
    .eq("id", bridge.pairingId)
    .eq("tenant_id", bridge.tenantId)
    .maybeSingle();
  if (capabilityRead.error) {
    console.error("[api/cron-jobs/poll] pairing capability lookup failed", {
      tenantId: bridge.tenantId,
      pairingId: bridge.pairingId,
      error: capabilityRead.error.message,
    });
    await recordGeneratedDeliveryFailure(db, bridge, "generated_script_capability_lookup_failed", { templateIds });
    return { ok: false, error: "generated_script_capability_lookup_failed" };
  }
  const capabilities = machineToolCapabilities(capabilityRead.data?.tool_capabilities);
  if (!capabilities.includes(GENERATED_SCRIPT_CAPABILITY)) {
    await recordGeneratedDeliveryFailure(db, bridge, "generated_script_capability_missing", { templateIds });
    return { ok: false, error: "generated_script_capability_missing" };
  }

  const templateRead = await db
    .from("automation_templates")
    .select("id, created_by, cron_job_id, target_pairing_id, draft_json, status")
    .eq("tenant_id", bridge.tenantId)
    .in("id", templateIds);
  if (templateRead.error) {
    console.error("[api/cron-jobs/poll] generated-template lookup failed", {
      tenantId: bridge.tenantId,
      templateCount: templateIds.length,
      error: templateRead.error.message,
    });
    await recordGeneratedDeliveryFailure(db, bridge, "generated_template_lookup_failed", { templateIds });
    return { ok: false, error: "generated_template_lookup_failed" };
  }
  const templates = new Map<string, Record<string, unknown>>(
    ((templateRead.data || []) as Array<Record<string, unknown>>).map((row) => [String(row.id), row]),
  );

  const approved: Array<Record<string, unknown> & { owner_user_id?: string | null; target_pairing_id?: string | null }> = [];
  for (const { row, payload, templateId } of parsedRows) {
    if (!templateId) {
      approved.push({ ...row, action_payload: payload });
      continue;
    }
    const template = templates.get(templateId);
    const draft = template ? jsonObject(template.draft_json) : null;
    const filename = typeof draft?.script_filename === "string" ? draft.script_filename : "";
    const source = typeof draft?.script_content === "string" ? draft.script_content : "";
    const sourceHash = createHash("sha256").update(source, "utf8").digest("hex");
    const scriptPath = `scripts/_generated/${String(row.id)}/${sourceHash.slice(0, 16)}_${filename}`;
    const agentKey = typeof draft?.agent_key === "string" ? draft.agent_key.trim().toLowerCase() : "";
    const valid = Boolean(
      template
      && template.status === "ready"
      && template.cron_job_id === row.id
      && template.target_pairing_id === bridge.pairingId
      && template.created_by === row.owner_user_id
      && row.target_pairing_id === bridge.pairingId
      && agentKey
      && agentKey === String(row.agent_key || "").trim().toLowerCase()
      && GENERATED_FILENAME_RE.test(filename)
      && payload.script === scriptPath
      && source
      && !source.includes("\0")
      && Buffer.byteLength(source, "utf8") <= 100_000
    );
    if (!valid) {
      console.error("[api/cron-jobs/poll] generated-template binding refused", { tenantId: bridge.tenantId, jobId: row.id, templateId });
      await recordGeneratedDeliveryFailure(db, bridge, "generated_template_binding_invalid", { jobId: row.id, templateId });
      return { ok: false, error: "generated_template_binding_invalid" };
    }
    delete payload.root;
    const signature = createHmac("sha256", bearer)
      .update(generatedScriptMessage(String(row.id), agentKey, scriptPath, source), "utf8")
      .digest("hex");
    approved.push({
      ...row,
      action_payload: {
        ...payload,
        script: scriptPath,
        args: [],
        _generated_script: { version: 1, source, signature },
      },
    });
  }
  return { ok: true, rows: approved };
}

/** Operator-visible signal for a poll that cannot safely deliver reviewed source. */
async function recordGeneratedDeliveryFailure(
  db: ReturnType<typeof getServiceSupabase>,
  bridge: BridgeOk,
  error: string,
  details: Record<string, unknown>,
): Promise<void> {
  try {
    const result = await db.from("agent_events").insert({
      event_type: "generated_automation_delivery_failed",
      publisher_agent: "cron-poll",
      severity: "error",
      payload: { error, pairing_id: bridge.pairingId, pairing_label: bridge.label, ...details },
      correlation_id: bridge.tenantId,
    });
    if (result.error) {
      console.error("[api/cron-jobs/poll] failed to persist generated-delivery event", {
        tenantId: bridge.tenantId,
        error: result.error.message,
      });
    }
  } catch (eventError) {
    console.error("[api/cron-jobs/poll] generated-delivery event threw", {
      tenantId: bridge.tenantId,
      error: eventError instanceof Error ? eventError.message : String(eventError),
    });
  }
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
  const expectedExecutor = isExpectedExecutor(bridge.tenantId, bridge.label);

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
  const resultWithTarget = await db
    .from("tenant_cron_jobs")
    .select(
      "id, agent_key, name, schedule, action_type, action_payload, enabled, last_run_at, run_count, owner_user_id, target_pairing_id",
    )
    .eq("tenant_id", bridge.tenantId)
    .eq("enabled", true)
    .in("action_type", [...SCRIPT_ACTION_TYPES])
    .order("created_at", { ascending: true });
  // Rollout safety: migration 225 may land after this code. Legacy rows have
  // no target and must keep polling exactly as before rather than taking the
  // scheduler down during that window.
  const result = resultWithTarget.error && isMissingColumnError(resultWithTarget.error, "target_pairing_id")
    ? await db
      .from("tenant_cron_jobs")
      .select("id, agent_key, name, schedule, action_type, action_payload, enabled, last_run_at, run_count, owner_user_id")
      .eq("tenant_id", bridge.tenantId)
      .eq("enabled", true)
      .in("action_type", [...SCRIPT_ACTION_TYPES])
      .order("created_at", { ascending: true })
    : resultWithTarget;
  const { data, error } = result;
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
  const rows = (data || []) as Array<Record<string, unknown> & { owner_user_id?: string | null; target_pairing_id?: string | null }>;
  // Untargeted rows keep the legacy, label-based executor. An exact target is
  // stronger and lets the wizard choose another compatible daemon without
  // giving that daemon access to the tenant's legacy jobs.
  const routedRows = expectedExecutor
    ? rows.filter((row) => !row.target_pairing_id || row.target_pairing_id === bridge.pairingId)
    : rows.filter((row) => row.target_pairing_id === bridge.pairingId);
  if (!expectedExecutor && routedRows.length === 0) {
    return NextResponse.json({ ok: true, jobs: [], polled_at: new Date().toISOString() });
  }
  // A row with an owner goes only to the computer whose paired user_id IS that
  // owner. A row with no owner (a legacy row the migration's backfill could
  // not resolve) keeps today's label-only rule — it has no person to prefer.
  const ownerEligible = routedRows.filter((row) => !row.owner_user_id || row.owner_user_id === bridge.userId);
  // There ARE enabled rows for this tenant, but every one of them belongs to
  // someone else: this is the computer being paired to the wrong PERSON, not
  // an empty tenant. An empty 200 here is exactly what makes Bravo's runner
  // idle in silence (cron_runner.py:505-515) — so this is a named refusal
  // instead, never the plausible-looking empty list.
  if (routedRows.length > 0 && ownerEligible.length === 0) {
    return bad(409, "owner_mismatch");
  }
  const owned = ownerEligible;
  const approved = await attachApprovedGeneratedScripts(db, owned, bridge, presentedBearer(req));
  if (!approved.ok) {
    return NextResponse.json({ ok: false, error: approved.error }, { status: 503 });
  }
  await stampLastPollOk(db, bridge.pairingId);
  const jobs = approved.rows.map(({ owner_user_id: _ownerUserId, target_pairing_id: _targetPairingId, ...job }) => job);
  return NextResponse.json({ ok: true, jobs, polled_at: new Date().toISOString() });
}

export async function POST(req: NextRequest) {
  const limited = checkPollRateLimit(req);
  if (limited) return limited;
  const bridge = await resolveBridge(req);
  if (!isBridgeOk(bridge)) return bad(bridge.status, bridge.message);

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
  // The bridge may only report on a job it could have been served. Re-check
  // its type, owner and exact target pairing before record_tenant_cron_run;
  // another daemon in the same tenant must never stamp this row by id.
  const targetedRead = await db
    .from("tenant_cron_jobs")
    .select("id, action_type, owner_user_id, target_pairing_id")
    .eq("id", jobId)
    .eq("tenant_id", bridge.tenantId)
    .maybeSingle();
  // During a rolling deploy the code can arrive just before migration 225.
  // Legacy rows have no exact target, so retain their owner gate and current
  // report behavior until the column lands.
  const jobRead = targetedRead.error && isMissingColumnError(targetedRead.error, "target_pairing_id")
    ? await db
      .from("tenant_cron_jobs")
      .select("id, action_type, owner_user_id")
      .eq("id", jobId)
      .eq("tenant_id", bridge.tenantId)
      .maybeSingle()
    : targetedRead;
  if (jobRead.error) {
    console.error("[api/cron-jobs/poll POST] job routing read failed", { tenantId: bridge.tenantId, jobId, error: jobRead.error.message });
    return NextResponse.json({ ok: false, error: "job_lookup_failed" }, { status: 500 });
  }
  if (!jobRead.data) return bad(404, "job_not_found_or_other_tenant");
  const job = jobRead.data as { action_type?: unknown; owner_user_id?: string | null; target_pairing_id?: string | null };
  if (!isScriptActionType(job.action_type)) {
    return NextResponse.json(
      {
        ok: false,
        error: "not_a_bridge_job",
        message: "This job is not run by the bridge, so the bridge cannot report on it.",
      },
      { status: 409 },
    );
  }
  if (job.owner_user_id && job.owner_user_id !== bridge.userId) {
    return bad(409, "owner_mismatch");
  }
  if (job.target_pairing_id && job.target_pairing_id !== bridge.pairingId) {
    return bad(409, "target_pairing_mismatch");
  }
  if (!job.target_pairing_id && !isExpectedExecutor(bridge.tenantId, bridge.label)) {
    // A non-default daemon may report only the exact jobs pinned to it.
    return bad(403, "executor_not_authorized_for_tenant");
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
