/**
 * lib/automations/vps-unit-control.ts - CC switches the daemon VPS's always-on workers on and off
 * from the Automations page (2026-11-03, CC: "for the background workers i'm unable to like turn
 * them off and on which is like not good").
 *
 * TWO HALVES, ONE TABLE (vps_unit_controls, database/turso/bravo__253_vps_unit_controls.sql).
 *
 *   The panel. Start / Stop / Restart on a "vps.*" tile POSTs the existing control route
 *   (app/api/automations/background-workers/control), which hands a vps.* service to
 *   handleVpsUnitSwitch: the agents owner (CC) only, in an OASIS workspace, from this site
 *   (authorizeCloudJobControl, the rule behind the cloud-job switches), a registered VPS worker, and
 *   an explicit confirm for the workers whose stop silences Telegram, chats or the schedules. It
 *   writes the worker's row and an audit row. It reaches into nothing.
 *
 *   The server. A root timer on the VPS (BEA scripts/ops/vps_unit_control.py,
 *   deploy/oasis-unit-control.timer, every 30 s) calls POST /api/internal/vps-control, signed like
 *   the heartbeat (HMAC over "<timestamp>.<raw body>" with CRON_SECRET, 300 s window), reports what
 *   it did last time and gets the rows back. It runs systemctl on its own allowlist only. OFF is
 *   held (a unit found running is stopped again); ON and Restart act once per stamp, so the
 *   applier never fights systemd's own crash handling. A worker with no row is left alone.
 *
 * The heartbeat (lib/automations/vps-health.ts) then reports a switched-off unit as "disabled by
 * operator" instead of "down", so the tile says "Off — you stopped this", not an outage.
 */
import "server-only";
import { NextResponse } from "next/server";
import type { Client } from "@libsql/client";
import { authorizeCloudJobControl, sameOrigin, type CloudJobControl } from "@/lib/automations/cloud-job-control";
import { logTenantAudit } from "@/lib/audit/activity-feed";
import { getTursoClient, tursoConfigured } from "@/lib/turso";
import { authenticateVpsRequest, VPS_HEALTH_SERVICES, type VpsHealthService } from "@/lib/automations/vps-health";
// Stopping one of these takes something CC relies on offline: a Stop or Restart needs confirm: true.
import { VPS_CRITICAL_WORKERS } from "@/lib/automations/worker-status";

export const VPS_CONTROL_BODY_MAX_BYTES = 8 * 1024;
const DETAIL_MAX = 200;

export type VpsUnitAction = "start" | "stop" | "restart";
export type VpsUnitControl = {
  service: VpsHealthService;
  desired: "on" | "off";
  changed_at: string;
  restart_requested_at: string | null;
  applied_at: string | null;
  applied_for: string | null;
  applied_ok: boolean | null;
  applied_detail: string | null;
};

export function isVpsWorkerService(service: unknown): service is VpsHealthService {
  return typeof service === "string" && (VPS_HEALTH_SERVICES as readonly string[]).includes(service);
}

function rowToControl(r: Record<string, unknown>): VpsUnitControl | null {
  const service = String(r.service ?? "");
  const desired = String(r.desired ?? "");
  if (!isVpsWorkerService(service) || (desired !== "on" && desired !== "off")) return null;
  const text = (v: unknown) => (v === null || v === undefined || v === "" ? null : String(v));
  const ok = r.applied_ok;
  return {
    service,
    desired,
    changed_at: String(r.changed_at ?? ""),
    restart_requested_at: text(r.restart_requested_at),
    applied_at: text(r.applied_at),
    applied_for: text(r.applied_for),
    applied_ok: ok === null || ok === undefined ? null : Number(ok) === 1,
    applied_detail: text(r.applied_detail),
  };
}

/** Every switch row for a registered worker. Throws on a failed read. */
export async function readVpsUnitControls(db: Client): Promise<VpsUnitControl[]> {
  const rs = await db.execute(
    `SELECT service, desired, changed_at, restart_requested_at, applied_at, applied_for, applied_ok, applied_detail
       FROM vps_unit_controls ORDER BY service`,
  );
  return rs.rows.map((r) => rowToControl(r as unknown as Record<string, unknown>)).filter((c): c is VpsUnitControl => c !== null);
}

/**
 * Write CC's switch. Stop = desired off; Start = desired on (a new changed_at, acted on once);
 * Restart = desired on plus a new restart stamp. Throws on a failed write.
 */
export async function writeVpsUnitSwitch(
  db: Client,
  input: { service: VpsHealthService; action: VpsUnitAction; actorUserId: string; now: Date },
): Promise<{ desired: "on" | "off"; changedAt: string; restartRequestedAt: string | null }> {
  const at = input.now.toISOString();
  const desired = input.action === "stop" ? "off" : "on";
  const restart = input.action === "restart" ? at : null;
  await db.execute({
    sql: `INSERT INTO vps_unit_controls (service, desired, changed_at, changed_by, restart_requested_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (service) DO UPDATE SET
            desired = excluded.desired, changed_at = excluded.changed_at, changed_by = excluded.changed_by,
            restart_requested_at = COALESCE(excluded.restart_requested_at, vps_unit_controls.restart_requested_at)`,
    args: [input.service, desired, at, input.actorUserId, restart],
  });
  return { desired, changedAt: at, restartRequestedAt: restart };
}

export type VpsUnitSwitchDeps = {
  authorize?: () => Promise<CloudJobControl>;
  db?: () => Client | null;
  audit?: typeof logTenantAudit;
  now?: () => Date;
};

function refuse(status: number, error: string, message: string): NextResponse {
  return NextResponse.json({ ok: false, error, message }, { status });
}

/**
 * The panel's Start / Stop / Restart for a vps.* worker. Order: who is asking (404 for anyone but
 * CC), same-site only, a registered worker and a known action, the confirm for a critical worker,
 * then the write, then the audit row. A refused or failed request changes nothing.
 */
export async function handleVpsUnitSwitch(
  req: Request,
  body: { service?: unknown; action?: unknown; confirm?: unknown },
  deps: VpsUnitSwitchDeps = {},
): Promise<NextResponse> {
  const control = await (deps.authorize ?? authorizeCloudJobControl)();
  if (!control.ok) {
    return NextResponse.json(
      { ok: false, error: control.status === 401 ? "unauthenticated" : control.error },
      { status: control.status },
    );
  }
  if (!sameOrigin(req)) return refuse(403, "cross_origin_refused", "Open the dashboard directly and try again.");
  const { service, action, confirm } = body;
  if (!isVpsWorkerService(service)) return refuse(400, "unknown_worker", "That isn't one of the server's workers. Nothing changed.");
  if (action !== "start" && action !== "stop" && action !== "restart") {
    return refuse(400, "invalid_action", "Say Start, Stop or Restart. Nothing changed.");
  }
  if (action !== "start" && VPS_CRITICAL_WORKERS.has(service) && confirm !== true) {
    return refuse(409, "confirm_required", "This worker needs a confirmation before it is stopped or restarted. Nothing changed.");
  }
  const db = deps.db ? deps.db() : tursoConfigured() ? getTursoClient() : null;
  if (!db) return refuse(503, "database_not_configured", "The database is not configured. Nothing changed.");
  let saved;
  try {
    saved = await writeVpsUnitSwitch(db, { service, action, actorUserId: control.userId, now: (deps.now ?? (() => new Date()))() });
  } catch (error) {
    console.error("[automations.vps_unit_switch] write failed", {
      service,
      error: error instanceof Error ? error.message : String(error),
    });
    return refuse(503, "switch_write_failed", "The switch could not be saved. Nothing changed; try again.");
  }
  const audit = await (deps.audit ?? logTenantAudit)({
    tenantId: control.tenantId,
    actorUserId: control.userId,
    actionType: "vps_worker_switch",
    targetTable: "vps_unit_controls",
    targetId: service,
    after: { action, desired: saved.desired, changed_at: saved.changedAt },
  });
  if (!audit.ok) console.error("[automations.vps_unit_switch.audit]", audit.error);
  const output =
    action === "stop"
      ? "switched off; the server stops it within 30 seconds"
      : action === "restart"
        ? "restart requested; the server restarts it within 30 seconds"
        : "switched on; the server starts it within 30 seconds";
  return NextResponse.json({ ok: true, output, service, desired: saved.desired, changed_at: saved.changedAt });
}

type ApplierResult = { service: VpsHealthService; applied_for: string; ok: boolean; detail: string };

/** The applier's report, or the field it got wrong. PURE. */
export function parseApplierPoll(body: unknown): { ok: true; host: string; results: ApplierResult[] } | { ok: false; field: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, field: "body" };
  const { host, results } = body as { host?: unknown; results?: unknown };
  if (typeof host !== "string" || !/^[A-Za-z0-9][A-Za-z0-9.-]{0,62}$/.test(host)) return { ok: false, field: "host" };
  if (results !== undefined && (!Array.isArray(results) || results.length > VPS_HEALTH_SERVICES.length * 2)) {
    return { ok: false, field: "results" };
  }
  const out: ApplierResult[] = [];
  for (const raw of (results as unknown[] | undefined) ?? []) {
    if (!raw || typeof raw !== "object") return { ok: false, field: "results" };
    const { service, applied_for, ok, detail } = raw as Record<string, unknown>;
    if (!isVpsWorkerService(service)) return { ok: false, field: "service" };
    if (typeof applied_for !== "string" || !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(applied_for)) return { ok: false, field: "applied_for" };
    if (typeof ok !== "boolean") return { ok: false, field: "ok" };
    if (detail !== undefined && typeof detail !== "string") return { ok: false, field: "detail" };
    out.push({
      service,
      applied_for,
      ok,
      detail: String(detail ?? "").replace(/[\u0000-\u001f]+/g, " ").trim().slice(0, DETAIL_MAX),
    });
  }
  return { ok: true, host, results: out };
}

export type VpsControlPollDeps = {
  env?: Record<string, string | undefined>;
  now?: () => Date;
  db?: () => Client | null;
};

function json(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

/**
 * POST /api/internal/vps-control - the server's applier. Order: secret -> size -> signature ->
 * JSON -> fields -> record its results -> return the rows. Results are recorded only against the
 * stamp they answer, so a slow report never marks a newer switch as applied.
 */
export async function handleVpsControlPoll(req: Request, deps: VpsControlPollDeps = {}): Promise<Response> {
  const env = deps.env ?? process.env;
  const now = (deps.now ?? (() => new Date()))();
  const auth = await authenticateVpsRequest(req, env, now, VPS_CONTROL_BODY_MAX_BYTES);
  if (!auth.ok) return auth.response;
  let body: unknown;
  try {
    body = JSON.parse(auth.raw);
  } catch {
    return json(422, { ok: false, error: "invalid_json" });
  }
  const parsed = parseApplierPoll(body);
  if (!parsed.ok) return json(422, { ok: false, error: "invalid_payload", field: parsed.field });
  const db = deps.db ? deps.db() : tursoConfigured() ? getTursoClient() : null;
  if (!db) return json(503, { ok: false, error: "not_installed", detail: "database_not_configured" });
  try {
    if (parsed.results.length > 0) {
      await db.batch(
        parsed.results.map((r) => ({
          sql: `UPDATE vps_unit_controls SET applied_at = ?, applied_for = ?, applied_ok = ?, applied_detail = ?
                 WHERE service = ? AND (changed_at = ? OR restart_requested_at = ?)`,
          args: [now.toISOString(), r.applied_for, r.ok ? 1 : 0, r.detail || null, r.service, r.applied_for, r.applied_for],
        })),
        "write",
      );
    }
    const controls = await readVpsUnitControls(db);
    return json(200, {
      ok: true,
      controls: controls.map((c) => ({
        service: c.service,
        desired: c.desired,
        changed_at: c.changed_at,
        restart_requested_at: c.restart_requested_at,
      })),
    });
  } catch (error) {
    console.error("[vps-control] read/write failed", error instanceof Error ? error.message : String(error));
    return json(503, { ok: false, error: "unavailable" });
  }
}
