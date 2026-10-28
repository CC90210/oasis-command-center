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
 *     the legacy spelling 'warning' read as 'warn';
 *   - the workspace's outcome checks (OASIS: the founder-booking check): a
 *     failing, stale or never-run check, an open alert, or a read that failed.
 *     /health lists them in its outcome card; both pages count them.
 * Plus the pipeline bucket both pages show: cold leads, by COUNT(*), never the
 * length of a capped display list. needsYouCount is the one count: /health's
 * header and /operations' "All clear" both read it.
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
import { loadOutcomeChecks, type OutcomeCheckData } from "@/lib/health/outcome-panel-data";
import { CALENDAR_CHECKS } from "@/lib/health/calendar-checks";
import { WEBDEV_TENANT_ID } from "@/lib/oasis-tenant";
import { machineState, type MachineState } from "@/lib/devices/presence";

export type AdminDb = ReturnType<typeof getServiceSupabase>;

export const ATTENTION_WINDOW_MS = 24 * 60 * 60 * 1000;
export const COLD_LEAD_MS = 14 * 24 * 60 * 60 * 1000;
/** Display cap for the lists. Counts are always COUNT(*), never a list length. */
export const ATTENTION_LIST_LIMIT = 50;

/**
 * O2 (2026-10-11): who is asking. House (cron_jobs) failures, workers down
 * and untenanted agent events are CC's alone. The former platform operator
 * was revoked on 2026-10-21; the per-viewer boundary remains defense in depth. A workspace
 * automation's (tenant_cron_jobs) failure counts for ITS OWNER, same
 * grandfather rule GET /api/cron-jobs uses: a legacy row with no recorded
 * owner is everyone's to see, same as before O2.
 *
 * OPTIONAL and additive: every function below defaults to its PRE-O2
 * behaviour when `viewer` is omitted, so existing callers (lib/admin/
 * system-health.ts, /health) are unchanged until they are updated to pass
 * one — omission is not a silent narrowing.
 */
export type AttentionViewer = { authUserId: string | null; isAgentsOwner: boolean };

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

// The one online rule every screen uses (lib/devices/presence.ts).
export { machineState, type MachineState };

export type PairedMachine = { label: string; lastSeenAt: string | null; state: MachineState };

/**
 * The workspace's paired computers, freshest first. Throws on a failed read.
 *
 * `viewer` (O3b): omitted, this is the pre-O3b behaviour -- every non-revoked
 * pairing in the tenant (whoever paired it). Passed, this is scoped to THAT
 * PERSON's own computers, PLUS any LEGACY pairing with no recorded owner
 * (user_id NULL, every row that predates O0's proven-identity pairing): a
 * legacy row is nobody's in particular, so hiding it from a viewer who is
 * not its owner would hide nothing it was ever scoped to, while showing it
 * keeps CC's operator view of CCPC exactly as it is today (O3b rule 6) with
 * no dependency on workspace_agents_owner being populated. Two EXPLICITLY
 * owned pairings (CC's daemon and any historical connector) are still kept apart: the
 * bug this fixes is /health describing whichever pairing is newest in the
 * shared OASIS workspace, never one person's computer to another person
 * (Codex, O3b -- the same bug class O2 already fixed for Automations).
 */
export async function loadMachines(db: AdminDb, tenantId: string, now: number, viewer?: AttentionViewer): Promise<PairedMachine[]> {
  let query = db.from("bridge_pairings").select("label, last_seen_at").eq("tenant_id", tenantId).is("revoked_at", null);
  if (viewer?.authUserId) {
    // Spliced into an `.or()` filter string below: charset-allowlisted first,
    // not merely UUID-shaped (a legacy auth id in this codebase's own test
    // fixtures is not always a real UUID) -- the allowlist is what keeps the
    // filter grammar safe, same discipline as the tenantId check just below.
    if (!/^[A-Za-z0-9_-]+$/.test(viewer.authUserId)) throw new Error("loadMachines: the viewer's auth id has an unexpected shape");
    query = query.or(`user_id.eq.${viewer.authUserId},user_id.is.null`);
  }
  const r = await query.order("last_seen_at", { ascending: false });
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
 *
 * `viewer` (O2): omitted, this is the pre-O2 behaviour. Passed and not the
 * agents owner, these are CC's OASIS workers, not "unknown" (that reads as a
 * read failure) and not a fault — zero known problems, for a question that
 * simply is not the viewer's to ask.
 */
export function describeBackground(
  workerRows: Map<string, HealthRow> | null,
  machines: PairedMachine[] | null,
  now: number,
  viewer?: AttentionViewer,
): { workers: WorkerHealth[] | null; reporter: StatusReporter | null; workersDown: number | null } {
  if (viewer && !viewer.isAgentsOwner) return { workers: [], reporter: null, workersDown: 0 };
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
 *
 * `viewer` (O2): omitted, this is the pre-O2 behaviour (every tenant failure
 * counts, the platform/house lane always queried). Passed: the platform
 * (house, cron_jobs) lane is queried only for the agents owner — skipped
 * entirely otherwise, the same "query only for the owner" rule GET
 * /api/cron-jobs follows — and a workspace (tenant_cron_jobs) failure counts
 * only for its owner, or for everyone when it has no recorded owner (a
 * legacy row, same grandfather rule as the API).
 */
export async function loadCronFailures(
  db: AdminDb,
  tenantId: string,
  now: number,
  viewer?: AttentionViewer,
): Promise<{ count: number; rows: CronFailure[] }> {
  const since = new Date(now - ATTENTION_WINDOW_MS).toISOString();
  const queryPlatform = !viewer || viewer.isAgentsOwner;
  const [platform, workspace] = await Promise.all([
    queryPlatform
      ? db
          .from("cron_jobs")
          .select("id, name, schedule, action_type, owner_agent_key, last_run_at, last_result, fail_count")
          .eq("tenant_id", tenantId)
          .gte("last_run_at", since)
          .order("last_run_at", { ascending: false })
      : Promise.resolve({ data: [] as EmpireCronRow[], error: null }),
    // `select("*")`, not a named column list: owner_user_id is a column
    // bravo__211_automation_owner.sql adds, and a workspace whose migration
    // has not landed yet must still answer with every failure, not
    // "no such column" — the pre-O2 rule for a table with no owner concept.
    // With a viewer, the owner filter runs in JS, so every row in the 24 h
    // window is read: capping before the filter let another owner's newer
    // failures push the viewer's own out of the count (CodeRabbit, PR #585).
    // The displayed list is still capped below.
    (() => {
      const q = db
        .from("tenant_cron_jobs")
        .select("*", { count: "exact" })
        .eq("tenant_id", tenantId)
        .eq("last_run_status", "error")
        .gte("last_run_at", since)
        .order("last_run_at", { ascending: false });
      return viewer ? q : q.limit(ATTENTION_LIST_LIMIT);
    })(),
  ]);
  if (platform.error) throw new Error(`cron_jobs read failed: ${platform.error.message}`);
  if (workspace.error) throw new Error(`tenant_cron_jobs read failed: ${workspace.error.message}`);
  // Declared as strings; the shim decodes JSON text into objects, so every
  // text value is coerced before a string method touches it.
  type WorkspaceRow = {
    id: string;
    name: unknown;
    schedule: unknown;
    last_run_at: string | null;
    last_run_error: unknown;
    owner_user_id?: string | null;
  };
  const platformFailed = ((platform.data || []) as EmpireCronRow[])
    .map((row) => normalizeEmpireRow(row))
    .filter((job) => job.last_run_status === "error");
  const ownedWorkspaceRows = ((workspace.data || []) as WorkspaceRow[]).filter((row) => {
    if (!viewer) return true;
    const ownerUserId = typeof row.owner_user_id === "string" && row.owner_user_id ? row.owner_user_id : null;
    return !ownerUserId || ownerUserId === viewer.authUserId;
  });
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
    ...ownedWorkspaceRows.map((c) => {
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
  // Without a viewer, the DB's exact count (every matching row, not just the
  // capped list) is the true total. With one, the owner filter ran in JS over
  // every row in the window (no query cap above), so its length is exact.
  const workspaceFailureCount = viewer ? ownedWorkspaceRows.length : Number(workspace.count ?? 0);
  return { count: platformFailed.length + workspaceFailureCount, rows };
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
 *
 * `viewer` (O2): omitted, this is the pre-O2 behaviour — this tenant's events
 * plus the platform's own untenanted ones. Passed and not the agents owner,
 * the untenanted half is dropped: those are the house's own events (no
 * tenant to scope them to), not this person's to see.
 */
export async function loadAttentionEvents(
  db: AdminDb,
  tenantId: string,
  now: number,
  viewer?: AttentionViewer,
): Promise<{ errors: number; warnings: number; rows: AttentionEvent[] }> {
  // The id is spliced into the or() grammar below; only a uuid may go there.
  if (!UUID.test(tenantId)) throw new Error("attention events: the tenant id is not a uuid");
  const since = new Date(now - ATTENTION_WINDOW_MS).toISOString();
  const includeUntenanted = !viewer || viewer.isAgentsOwner;
  const thisTenant = includeUntenanted
    ? `correlation_id.eq.${tenantId},correlation_id.is.null`
    : `correlation_id.eq.${tenantId}`;
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
  /** O2: present only for the agents owner (undefined for everyone else —
   *  there is no house scheduler item to show a non-owner, not even a null
   *  "couldn't check" one). See loadHouseSchedulerStatus. */
  houseScheduler?: HouseSchedulerStatus;
};

/** How stale is too stale for the house scheduler's poll. The bridge polls
 *  roughly every 60 s, so 15 minutes is about 15 missed polls in a row —
 *  long enough that a single network blip or restart never pages, short
 *  enough that a scheduler that has actually stopped is caught same-session. */
export const HOUSE_SCHEDULER_STALE_MS = 15 * 60 * 1000;

/** null = not the agents owner (nothing to report), or the read itself failed
 *  (logged, never read as "fine"). */
export type HouseSchedulerStatus = { stalled: boolean; lastPollOkAt: string | null } | null;

/**
 * The agents-owner-only attention item: "House scheduler has not fetched
 * jobs for N minutes", from bridge_pairings.last_poll_ok_at (O2, the cron
 * poll route stamps it on every 200). Reads the OWNER's own pairings — same
 * "whose computer" scoping as everywhere else in O2, not the newest pairing
 * in the workspace. Never a row at all (no pairing, or last_poll_ok_at
 * missing because the migration or a never-polling bridge) reads as stalled:
 * a silent house scheduler must show here even before it has ever reported
 * once.
 */
export async function loadHouseSchedulerStatus(
  db: AdminDb,
  tenantId: string,
  now: number,
  viewer: AttentionViewer,
): Promise<HouseSchedulerStatus> {
  if (!viewer.isAgentsOwner) return null;
  // A scheduler with nothing switched on to fetch cannot be stalled in a way
  // that needs anyone: the item applies only while enabled house jobs exist.
  // A read error throws (the caller's safe() turns it into "unknown").
  const active = await db
    .from("cron_jobs")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId)
    .eq("is_active", 1);
  if (active.error) throw new Error(`cron_jobs active count failed: ${active.error.message}`);
  if ((active.count ?? 0) === 0) return { stalled: false, lastPollOkAt: null };
  const r = await db
    .from("bridge_pairings")
    .select("last_poll_ok_at")
    .eq("tenant_id", tenantId)
    .eq("user_id", viewer.authUserId)
    .is("revoked_at", null)
    .order("last_poll_ok_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (r.error) throw new Error(`bridge_pairings last_poll_ok_at read failed: ${r.error.message}`);
  const lastPollOkAt = (r.data as { last_poll_ok_at?: string | null } | null)?.last_poll_ok_at ?? null;
  const age = lastPollOkAt ? now - Date.parse(lastPollOkAt) : NaN;
  const stalled = !Number.isFinite(age) || age > HOUSE_SCHEDULER_STALE_MS;
  return { stalled, lastPollOkAt };
}

/**
 * The outcome checks a workspace's "needs you" counts (lib/health/
 * outcome-panel-data.ts): OASIS its founder-booking (calendar) check; a SunBiz
 * workspace (retired, so a stale session only) its delivery outcomes without
 * the calendar row; any other workspace none (null). /health loads it once for
 * its outcome card and its header; /operations loads it for "All clear". A
 * load that throws is a blind read (logged): one signal, never a clean board.
 */
export async function loadWorkspaceOutcome(
  tenantId: string,
  profileSlug: string | null,
  now: number,
): Promise<OutcomeCheckData | null> {
  const calendarCheckIds = CALENDAR_CHECKS.map((check) => check.id);
  const filter =
    tenantId === WEBDEV_TENANT_ID
      ? { includeCheckIds: calendarCheckIds }
      : profileSlug === "sun"
        ? { excludeCheckIds: calendarCheckIds }
        : null;
  if (!filter) return null;
  try {
    return await loadOutcomeChecks(tenantId, now, filter);
  } catch (err) {
    console.error("[attention.outcome_checks]", err);
    return { rows: [], openAlerts: [], readFailed: true, readError: err instanceof Error ? err.message : String(err), signalCount: 1 };
  }
}

/**
 * THE count of what needs you: the alarm counts (errors, failed automations,
 * workers down) plus the outcome checks' signals (0 for a workspace without
 * outcome checks). null when an alarm count could not be read. /health's
 * header and /operations' "All clear" both come from here, so one page cannot
 * say "1 needs you" while the other says "All clear". Warnings and cold leads
 * are signals, not alarms.
 */
export function needsYouCount(s: AttentionSummary, outcome: Pick<OutcomeCheckData, "signalCount"> | null): number | null {
  const alarms = [s.errors, s.cronFailures, s.workersDown];
  if (alarms.some((n) => n === null)) return null;
  // O2 (Codex review): the house scheduler counts too. Its read failing for
  // the owner is "unknown", never all clear; stalled is one thing needing you.
  if (s.houseScheduler === null) return null;
  const scheduler = s.houseScheduler?.stalled ? 1 : 0;
  return alarms.reduce<number>((sum, n) => sum + (n ?? 0), 0) + scheduler + (outcome?.signalCount ?? 0);
}

/** "Nothing needs you": every alarm count read and zero, and no outcome signal. */
export function nothingNeedsYou(s: AttentionSummary, outcome: Pick<OutcomeCheckData, "signalCount"> | null): boolean {
  return needsYouCount(s, outcome) === 0;
}

/**
 * The attention tiles for /operations: the same reads and rules /health uses.
 * Never throws.
 *
 * `viewer` (O2): omitted, every read keeps its pre-O2, unscoped behaviour —
 * existing callers (system-health.ts builds its own AttentionSummary by
 * calling the readers above directly, not this function) are unaffected.
 * Passed, house (platform) failures/workers/untenanted events are the agents
 * owner's alone, a workspace failure counts for its owner, and
 * `houseScheduler` is populated for the owner only.
 */
export async function loadAttentionSummary(
  tenantId: string,
  deps: { db?: AdminDb; now?: number; viewer?: AttentionViewer } = {},
): Promise<AttentionSummary> {
  const db = deps.db ?? getServiceSupabase();
  const now = deps.now ?? Date.now();
  const viewer = deps.viewer;
  const [machines, workerRows, cron, events, coldLeads, houseScheduler] = await Promise.all([
    safe("attention.machines", loadMachines(db, tenantId, now), null),
    safe("attention.workers", loadWorkerRows(db, tenantId), null),
    safe("attention.cron_failures", loadCronFailures(db, tenantId, now, viewer), null),
    safe("attention.events", loadAttentionEvents(db, tenantId, now, viewer), null),
    safe("attention.cold_leads", countColdLeads(db, tenantId, now), null),
    // Only the agents owner gets the item: undefined for everyone else, so a
    // null here means one thing only, "the owner's read failed" (Codex, O2).
    viewer?.isAgentsOwner ? safe("attention.house_scheduler", loadHouseSchedulerStatus(db, tenantId, now, viewer), null) : Promise.resolve(undefined),
  ]);
  return {
    errors: events?.errors ?? null,
    warnings: events?.warnings ?? null,
    cronFailures: cron?.count ?? null,
    workersDown: describeBackground(workerRows, machines, now, viewer).workersDown,
    coldLeads,
    // Omitted entirely (not even `undefined`) when no viewer was given, so a
    // caller that builds its OWN AttentionSummary without this field (lib/
    // admin/system-health.ts) stays deepEqual-comparable to this one.
    ...(viewer ? { houseScheduler } : {}),
  };
}
