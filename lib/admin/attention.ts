/**
 * lib/admin/attention.ts — the ONE definition of "needs you" for the OASIS
 * operator (2026-09-30). /operations draws its tiles from loadAttentionSummary
 * and /health draws its tiles and lists from the same readers, so the two pages
 * can no longer disagree about how many automations failed.
 *
 * What needs you, in the last 24 hours:
 *   - cron failures: the OASIS platform schedules (cron_jobs) and this
 *     workspace's own (tenant_cron_jobs) whose run in the window errored, by
 *     the same classifier /automations draws them with (lib/cron-empire-row),
 *     each with a one-line "what to do";
 *   - workers down: an OASIS background process (lib/automations/oasis-workers)
 *     whose heartbeat is older than five minutes, or that reports itself down.
 *     When the bridge's own fleet reporter says it cannot read the process
 *     table, the count is unknown, never "all down" (2026-09-23);
 *   - error and warning events: agent_events at severity error or warn, with
 *     the legacy spelling 'warning' read as 'warn'.
 * Plus the pipeline bucket both pages show: cold leads, by COUNT(*), never the
 * length of a capped display list.
 *
 * TENANT. Every read is scoped to the tenant the caller got from the session.
 * cron_jobs carries tenant_id (every row is OASIS's); agent_events has no
 * tenant column, so an event counts when its correlation_id is this tenant or
 * it carries no tenant at all (the platform's own untenanted events). An event
 * stamped with ANOTHER tenant's id is never counted here. The old /health read
 * filtered on publisher only, and the old /operations tile counted every
 * tenant's cron_jobs all-time; both are gone.
 *
 * FAIL LOUD. Each reader throws on a failed read; loadAttentionSummary turns a
 * throw into null through safe(), which logs it. An unread count is never 0.
 */

import "server-only";

import { safe } from "@/lib/api-helpers";
import { getServiceSupabase } from "@/lib/supabase-server";
import { normalizeEmpireRow, type EmpireCronRow } from "@/lib/cron-empire-row";
import { coerceInferResultText } from "@/lib/infer-result-text";
import { OASIS_WORKERS } from "@/lib/automations/oasis-workers";
import { DAEMON_HEALTH_STALE_MS } from "@/lib/automations/daemon-backed-crons";
import {
  FLEET_REPORTER_SERVICE,
  SUPERVISOR_DISABLED,
  describeStatusReporter,
  type StatusReporter,
} from "@/lib/automations/worker-status";

export type AdminDb = ReturnType<typeof getServiceSupabase>;

export const ATTENTION_WINDOW_MS = 24 * 60 * 60 * 1000;
export const COLD_LEAD_MS = 14 * 24 * 60 * 60 * 1000;
/** Display cap for the lists. Counts are always COUNT(*), never a list length. */
export const ATTENTION_LIST_LIMIT = 50;
/** The /operations thresholds against the bridge's 60 s heartbeat. */
export const BRIDGE_ONLINE_MS = 90_000;
export const BRIDGE_IDLE_MS = 5 * 60_000;

/** A JSON column as an object, or null. A string that is not JSON is logged, not guessed at. */
export function metadataObject(raw: unknown): Record<string, unknown> | null {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw === "string" && raw.trim()) {
    try {
      const v = JSON.parse(raw) as unknown;
      return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    } catch (err) {
      console.error("[admin.metadata] not JSON", err instanceof Error ? err.message : err);
      return null;
    }
  }
  return null;
}

// ── Paired computers ──────────────────────────────────────────────────────

export type MachineState = "online" | "idle" | "offline";

export function machineState(lastSeenAt: string | null, now: number): MachineState {
  const t = lastSeenAt ? Date.parse(lastSeenAt) : NaN;
  if (!Number.isFinite(t)) return "offline";
  const age = now - t;
  if (age < BRIDGE_ONLINE_MS) return "online";
  if (age < BRIDGE_IDLE_MS) return "idle";
  return "offline";
}

export type PairedMachine = { label: string; lastSeenAt: string | null; state: MachineState };

/** The workspace's paired computers, freshest first. Throws on a failed read. */
export async function loadMachines(db: AdminDb, tenantId: string, now: number): Promise<PairedMachine[]> {
  const r = await db
    .from("bridge_pairings")
    .select("label, last_seen_at")
    .eq("tenant_id", tenantId)
    .is("revoked_at", null)
    .order("last_seen_at", { ascending: false });
  if (r.error) throw new Error(`bridge_pairings read failed: ${r.error.message}`);
  return ((r.data || []) as Array<{ label: string | null; last_seen_at: string | null }>).map((p) => ({
    label: p.label || "Unnamed computer",
    lastSeenAt: p.last_seen_at,
    state: machineState(p.last_seen_at, now),
  }));
}

// ── Workers ───────────────────────────────────────────────────────────────

export type WorkerState = "running" | "stopped_by_you" | "trouble" | "down" | "stale" | "no_report";

export type WorkerHealth = {
  service: string;
  label: string;
  state: WorkerState;
  lastPingAt: string | null;
  sentence: string;
};

export type HealthRow = { service: string; status: string | null; last_ping_at: string | null; metadata: unknown };

/** The OASIS workers the operator's machine supervises (not retired, not cloud). */
export const LOCAL_OASIS_WORKERS = OASIS_WORKERS.filter(
  (w) => w.service.startsWith("pm2.") && w.runtime !== "retired" && w.runtime !== "cloud" && !w.not_expected_here,
);

/** PURE. One worker's state from its latest row. */
export function describeWorker(
  worker: { service: string; label: string },
  row: HealthRow | undefined,
  now: number,
): WorkerHealth {
  const base = { service: worker.service, label: worker.label, lastPingAt: row?.last_ping_at ?? null };
  if (!row) return { ...base, state: "no_report", sentence: "No report from your computer yet." };
  const pinged = row.last_ping_at ? Date.parse(row.last_ping_at) : NaN;
  if (!Number.isFinite(pinged) || now - pinged > DAEMON_HEALTH_STALE_MS) {
    return {
      ...base,
      state: "stale",
      sentence: Number.isFinite(pinged) ? `Stopped reporting since ${new Date(pinged).toISOString()}.` : "Stopped reporting.",
    };
  }
  if (row.status === "healthy") return { ...base, state: "running", sentence: "Running." };
  if (row.status === "degraded" && String(metadataObject(row.metadata)?.pm2_status ?? "") === SUPERVISOR_DISABLED) {
    return { ...base, state: "stopped_by_you", sentence: "Stopped by you." };
  }
  if (row.status === "degraded") return { ...base, state: "trouble", sentence: "Running with problems." };
  if (row.status === "down") return { ...base, state: "down", sentence: "Down: your computer reports it isn't running." };
  return { ...base, state: "no_report", sentence: "No usable report from your computer yet." };
}

/**
 * The newest heartbeat per worker service (and the fleet reporter's). Stale
 * duplicates (profile_id NULL rows from 2026-08) must not shadow the heartbeat
 * the bridge sends every minute. Throws on a failed read.
 */
export async function loadWorkerRows(db: AdminDb, tenantId: string): Promise<Map<string, HealthRow>> {
  const services = [...LOCAL_OASIS_WORKERS.map((w) => w.service), FLEET_REPORTER_SERVICE];
  const r = await db
    .from("integrations_health")
    .select("service, status, last_ping_at, metadata")
    .eq("tenant_id", tenantId)
    .in("service", services)
    .order("last_ping_at", { ascending: false });
  if (r.error) throw new Error(`worker heartbeats read failed: ${r.error.message}`);
  const latest = new Map<string, HealthRow>();
  for (const row of (r.data || []) as HealthRow[]) {
    if (!latest.has(row.service)) latest.set(row.service, row);
  }
  return latest;
}

/**
 * PURE. The workers, the fleet reporter's verdict, and how many are down. A
 * reporter that says it cannot read the process table makes every tile under
 * it unknown, so the down count is unknown too.
 */
export function describeBackground(
  workerRows: Map<string, HealthRow> | null,
  machines: PairedMachine[] | null,
  now: number,
): { workers: WorkerHealth[] | null; reporter: StatusReporter | null; workersDown: number | null } {
  if (workerRows === null) return { workers: null, reporter: null, workersDown: null };
  const pc = machines?.[0] ?? null;
  const reporterRow = workerRows.get(FLEET_REPORTER_SERVICE);
  const reporter = describeStatusReporter({
    row: reporterRow
      ? { status: reporterRow.status ?? "", metadata: metadataObject(reporterRow.metadata), last_ping_at: reporterRow.last_ping_at }
      : undefined,
    bridgeOnline: pc !== null && pc.state !== "offline",
    now,
    staleMs: DAEMON_HEALTH_STALE_MS,
  });
  const workers = LOCAL_OASIS_WORKERS.map((w) => describeWorker(w, workerRows.get(w.service), now));
  const blind = reporter.state === "failing" || reporter.state === "silent";
  return {
    workers,
    reporter,
    workersDown: blind ? null : workers.filter((w) => w.state === "down" || w.state === "stale").length,
  };
}

// ── Cron failures ─────────────────────────────────────────────────────────

export type CronFailure = {
  id: string;
  name: string;
  schedule: string;
  lastRunAt: string | null;
  lastResult: string | null;
  /** platform = cron_jobs (runs on the operator's machine); workspace = tenant_cron_jobs. */
  source: "platform" | "workspace";
  whatToDo: string;
};

/**
 * One line on what to do about a failed run, from the words of its result. It
 * names an action, never a cause the result does not state. The result is
 * coerced first: the Turso shim hands back JSON text as an object, and a
 * string method on it threw, which blanked every cron tile for a day.
 */
export function whatToDoForCronFailure(result: unknown): string {
  const r = coerceInferResultText(result).toLowerCase();
  if (/^reported /.test(r)) {
    return "It ran, but its own summary reports failures. Open its log on your computer to see which items failed; it retries on its next run.";
  }
  if (/timed out|timeout/.test(r)) {
    return "It ran past its time limit. Open its log on your computer, then speed the script up or raise the job's time limit.";
  }
  if (/unknown_action_type/.test(r)) {
    return "The scheduler doesn't know this job's action. Fix the action, or pause the job in Automations.";
  }
  if (/not found|no such file|enoent/.test(r)) {
    return "The script it runs couldn't be found. Check the path in the job, or pause it in Automations.";
  }
  if (/exit \d+|traceback|error:/.test(r)) {
    return "The script stopped with an error. Open the log named in the result on your computer, fix the cause, and it retries on its next run.";
  }
  return "Open the job in Automations and read its last result, then fix it or pause it.";
}

/**
 * Cron runs in the window that failed, newest first, with their total. Throws on a failed read.
 *
 * A platform job failed when normalizeEmpireRow (lib/cron-empire-row.ts), the
 * normaliser /automations draws the same job with, says so: the ERROR/FAILED
 * prefix, a JSON summary reporting its own errors, ok:false or status:error, a
 * "failed: N" counter, or unresolved failures on the counter. A LIKE 'ERROR%'
 * filter saw only the first, so Inbound Email Sweep's {"errors": 3} was red on
 * /automations and "Nothing needs you" here. The shapes can't be filtered in
 * SQL, so this reads the tenant's jobs that ran in the window (a few dozen at
 * most) and counts in code.
 */
export async function loadCronFailures(
  db: AdminDb,
  tenantId: string,
  now: number,
): Promise<{ count: number; rows: CronFailure[] }> {
  const since = new Date(now - ATTENTION_WINDOW_MS).toISOString();
  const [platform, workspace] = await Promise.all([
    db
      .from("cron_jobs")
      .select("id, name, schedule, action_type, owner_agent_key, last_run_at, last_result, fail_count")
      .eq("tenant_id", tenantId)
      .gte("last_run_at", since)
      .order("last_run_at", { ascending: false }),
    db
      .from("tenant_cron_jobs")
      .select("id, name, schedule, last_run_at, last_run_error", { count: "exact" })
      .eq("tenant_id", tenantId)
      .eq("last_run_status", "error")
      .gte("last_run_at", since)
      .order("last_run_at", { ascending: false })
      .limit(ATTENTION_LIST_LIMIT),
  ]);
  if (platform.error) throw new Error(`cron_jobs read failed: ${platform.error.message}`);
  if (workspace.error) throw new Error(`tenant_cron_jobs read failed: ${workspace.error.message}`);
  // Declared as strings; the shim decodes JSON text into objects, so every
  // text value is coerced before a string method touches it.
  type WorkspaceRow = { id: string; name: unknown; schedule: unknown; last_run_at: string | null; last_run_error: unknown };
  const platformFailed = ((platform.data || []) as EmpireCronRow[])
    .map((row) => normalizeEmpireRow(row))
    .filter((job) => job.last_run_status === "error");
  const rows: CronFailure[] = [
    ...platformFailed.map((job) => ({
      id: String(job.id),
      name: job.name,
      schedule: job.schedule,
      lastRunAt: job.last_run_at,
      lastResult: job.last_run_error,
      source: "platform" as const,
      whatToDo: whatToDoForCronFailure(job.last_run_error),
    })),
    ...((workspace.data || []) as WorkspaceRow[]).map((c) => {
      const error = c.last_run_error == null ? null : coerceInferResultText(c.last_run_error);
      return {
        id: String(c.id),
        name: coerceInferResultText(c.name),
        schedule: coerceInferResultText(c.schedule),
        lastRunAt: c.last_run_at,
        lastResult: error,
        source: "workspace" as const,
        whatToDo: whatToDoForCronFailure(error),
      };
    }),
  ]
    .sort((a, b) => (Date.parse(b.lastRunAt || "") || 0) - (Date.parse(a.lastRunAt || "") || 0))
    .slice(0, ATTENTION_LIST_LIMIT);
  return { count: platformFailed.length + Number(workspace.count ?? 0), rows };
}

// ── Error and warning events ──────────────────────────────────────────────

export type AttentionEvent = {
  id: string;
  eventType: string;
  severity: "critical" | "error" | "warn";
  publisherAgent: string | null;
  payload: Record<string, unknown> | null;
  publishedAt: string;
};

/** 'warning' is the legacy spelling of 'warn'; anything else passes through lower-cased. */
export function normaliseSeverity(raw: unknown): string {
  const s = String(raw ?? "").trim().toLowerCase();
  return s === "warning" ? "warn" : s;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The severities that count as errors. The event bus accepts "critical" above
 * "error" (BEA scripts/core/event_bus.py; the inbound classifier publishes
 * BRAVO_CLASSIFIER_DEGRADED at critical on a bug) and the Feed already draws it
 * as Failed. Reading only "error" left the most urgent events out of "needs
 * you", so a critical one read as "Nothing needs you".
 */
export const ERROR_SEVERITIES = ["critical", "error"] as const;

/** A row's severity as the page labels it: critical, error, or (warn and the legacy warning) warn. */
export function attentionSeverity(raw: unknown): AttentionEvent["severity"] {
  const s = normaliseSeverity(raw);
  return s === "critical" || s === "error" ? s : "warn";
}

/**
 * Errors and warnings in the window: exact counts per severity, plus the newest
 * rows for display. Throws on a failed read.
 */
export async function loadAttentionEvents(
  db: AdminDb,
  tenantId: string,
  now: number,
): Promise<{ errors: number; warnings: number; rows: AttentionEvent[] }> {
  // The id is spliced into the or() grammar below; only a uuid may go there.
  if (!UUID.test(tenantId)) throw new Error("attention events: the tenant id is not a uuid");
  const since = new Date(now - ATTENTION_WINDOW_MS).toISOString();
  const thisTenant = `correlation_id.eq.${tenantId},correlation_id.is.null`;
  const [errors, warnings, rows] = await Promise.all([
    db
      .from("agent_events")
      .select("id", { count: "exact", head: true })
      .or(thisTenant)
      .in("severity", [...ERROR_SEVERITIES])
      .gte("published_at", since),
    db
      .from("agent_events")
      .select("id", { count: "exact", head: true })
      .or(thisTenant)
      .in("severity", ["warn", "warning"])
      .gte("published_at", since),
    db
      .from("agent_events")
      .select("id, event_type, severity, publisher_agent, payload, published_at")
      .or(thisTenant)
      .in("severity", [...ERROR_SEVERITIES, "warn", "warning"])
      .gte("published_at", since)
      .order("published_at", { ascending: false })
      .limit(ATTENTION_LIST_LIMIT),
  ]);
  if (errors.error) throw new Error(`agent_events error count failed: ${errors.error.message}`);
  if (warnings.error) throw new Error(`agent_events warning count failed: ${warnings.error.message}`);
  if (rows.error) throw new Error(`agent_events read failed: ${rows.error.message}`);
  type Row = { id: string; event_type: string; severity: string; publisher_agent: string | null; payload: unknown; published_at: string };
  return {
    errors: Number(errors.count ?? 0),
    warnings: Number(warnings.count ?? 0),
    rows: ((rows.data || []) as Row[]).map((e) => ({
      id: String(e.id),
      eventType: e.event_type,
      severity: attentionSeverity(e.severity),
      publisherAgent: e.publisher_agent,
      payload: typeof e.payload === "string" && e.payload.trim() && !e.payload.trim().startsWith("{")
        ? { text: e.payload }
        : metadataObject(e.payload),
      publishedAt: e.published_at,
    })),
  };
}

// ── Cold leads ────────────────────────────────────────────────────────────

/** Leads untouched for 14 days: COUNT(*). Throws on a failed read. */
export async function countColdLeads(db: AdminDb, tenantId: string, now: number): Promise<number> {
  const r = await db
    .from("tenant_records")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId)
    .eq("entity_type", "lead")
    .lt("updated_at", new Date(now - COLD_LEAD_MS).toISOString());
  if (r.error) throw new Error(`tenant_records cold-lead count failed: ${r.error.message}`);
  return Number(r.count ?? 0);
}

// ── The summary both pages draw ───────────────────────────────────────────

/** null = that read failed: the tile says "Couldn't check", never 0. */
export type AttentionSummary = {
  errors: number | null;
  warnings: number | null;
  cronFailures: number | null;
  workersDown: number | null;
  coldLeads: number | null;
};

/** "Nothing needs you" needs every alarm count read and zero. Warnings and cold leads are signals, not alarms. */
export function nothingNeedsYou(s: AttentionSummary): boolean {
  return [s.errors, s.cronFailures, s.workersDown].every((n) => n === 0);
}

/** The attention tiles for /operations: the same reads and rules /health uses. Never throws. */
export async function loadAttentionSummary(
  tenantId: string,
  deps: { db?: AdminDb; now?: number } = {},
): Promise<AttentionSummary> {
  const db = deps.db ?? getServiceSupabase();
  const now = deps.now ?? Date.now();
  const [machines, workerRows, cron, events, coldLeads] = await Promise.all([
    safe("attention.machines", loadMachines(db, tenantId, now), null),
    safe("attention.workers", loadWorkerRows(db, tenantId), null),
    safe("attention.cron_failures", loadCronFailures(db, tenantId, now), null),
    safe("attention.events", loadAttentionEvents(db, tenantId, now), null),
    safe("attention.cold_leads", countColdLeads(db, tenantId, now), null),
  ]);
  return {
    errors: events?.errors ?? null,
    warnings: events?.warnings ?? null,
    cronFailures: cron?.count ?? null,
    workersDown: describeBackground(workerRows, machines, now).workersDown,
    coldLeads,
  };
}
