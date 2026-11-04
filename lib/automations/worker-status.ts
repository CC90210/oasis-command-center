/**
 * How a worker tile reads its own state — the pure rules, extracted.
 *
 * Both functions here decide what an operator is TOLD about a background
 * worker, and both were wrong in a way that made the board lie. They live
 * outside the panel for the same reason worker-control.ts does: a rule that
 * only exists inside a React component cannot be executed by a test, and the
 * two defects below were both shipped past a green typecheck.
 *
 * No React, no fetch — importable from a plain node test.
 */

/** The subset of a worker row these rules read. */
export type WorkerHealthStatus = "healthy" | "degraded" | "down" | "pending" | "unconfigured" | "archived";

export type WorkerStatusInput = {
  status: WorkerHealthStatus;
  metadata?: Record<string, unknown> | null;
  /** Where the process executes. Missing is accepted for older API rows. */
  runtime?: WorkerRuntime;
  /** Reason this worker is not meant to run on this machine, if it isn't. */
  not_expected_here?: string;
  /** Where live status comes from; "none" means the host reports nothing here. */
  status_source?: WorkerStatusSource;
};

/**
 * The daemon VPS's bounded oneshot units: the only workers whose heartbeat may
 * carry an in-flight ("running") pass. A Meet transcription can run for hours;
 * it reads as pending work, never as healthy and never as an outage.
 */
export const VPS_ONESHOT_SERVICES: ReadonlySet<string> = new Set([
  "vps.oasis-inbox-sweep",
  "vps.oasis-ai-audit-runner",
  "vps.oasis-meet-runner",
]);

/**
 * The daemon VPS workers whose Stop or Restart takes something CC relies on offline, with what goes
 * quiet while each is off. The control route refuses a Stop or Restart of these without an explicit
 * confirm, and the panel asks with this sentence (lib/automations/vps-unit-control.ts).
 */
export const VPS_CRITICAL_WORKERS: ReadonlyMap<string, string> = new Map([
  ["vps.oasis-telegram-bridge", "Bravo stops answering you on Telegram."],
  ["vps.oasis-headless-bridge", "agent chats and Telegram replies that run on the server wait until it is back."],
  ["vps.oasis-scheduler", "the Empire schedules (the Brief, backups, health checks) stop running."],
  ["vps.oasis-workspace-scheduler", "workspace scripts, including Atlas's inbox consumer, stop running."],
  ["vps.atlas-telegram", "Atlas stops answering you on Telegram."],
  ["vps.maven-telegram", "Maven stops answering you on Telegram."],
]);

/** CC's switch for a daemon VPS worker and the server's last report on it (vps_unit_controls). */
export type ServerSwitchState = {
  desired: "on" | "off";
  changed_at: string;
  restart_requested_at: string | null;
  applied_at: string | null;
  applied_for: string | null;
  applied_ok: boolean | null;
  applied_detail: string | null;
};

/**
 * What the server said when it could NOT apply CC's latest switch, or null. A failure reported for
 * an older switch is history, not news: only a report for the newest stamp counts. PURE.
 */
export function serverSwitchFailure(sw: ServerSwitchState | undefined | null): string | null {
  if (!sw || sw.applied_ok !== false || !sw.applied_for) return null;
  const latest = [sw.changed_at, sw.restart_requested_at].filter((v): v is string => Boolean(v)).sort().pop();
  return sw.applied_for === latest ? sw.applied_detail || "systemctl failed" : null;
}

/** Decode persisted readings without trusting a cast or treating an in-flight result as success. */
export function reportedWorkerStatus(service: string, status: unknown, metadata?: Record<string, unknown> | null): WorkerHealthStatus {
  if (status === "healthy" || status === "degraded" || status === "down") return status;
  if (VPS_ONESHOT_SERVICES.has(service) && status === "unknown" && metadata?.via === "vps-heartbeat" && metadata.phase === "running") {
    return "pending";
  }
  return "unconfigured";
}

export type WorkerRuntime = "local" | "cloud" | "remote" | "retired";
/**
 * local_fleet   - this computer's supervisor, through its bridge;
 * remote_bridge - a client tenant's VPS, through the server-side bridge proxy;
 * server_switch - OASIS's daemon VPS: CC's switch is stored and the server's own
 *                 root timer applies it (lib/automations/vps-unit-control.ts);
 * none          - no lifecycle control.
 */
export type WorkerControlMode = "local_fleet" | "remote_bridge" | "server_switch" | "none";
export type WorkerStatusSource =
  | "integrations_health"
  | "website_sales_meeting_worker_health"
  | "none";
export type WorkerInventory = "oasis" | "client" | "none";

/**
 * Resolve lifecycle control without trusting a catalog entry to authorize the
 * viewer. Catalog control_mode says what the process supports; session role
 * decides whether this response may expose that control path.
 */
export function resolveWorkerControlMode(input: {
  runtime: WorkerRuntime;
  configuredMode?: WorkerControlMode;
  /** Carried for executable role-matrix tests; role text alone never grants control. */
  teamRole?: string;
  isTrueAdmin: boolean;
  adminAccess: boolean;
  remoteControlAllowed?: boolean;
  /** The viewer may switch OASIS's daemon VPS workers (the agents owner, CC). */
  serverSwitchAllowed?: boolean;
}): WorkerControlMode {
  if (
    input.runtime === "cloud" ||
    input.runtime === "retired" ||
    input.configuredMode === "none"
  ) {
    return "none";
  }
  if (input.configuredMode === "server_switch") {
    return input.runtime === "remote" && input.serverSwitchAllowed === true ? "server_switch" : "none";
  }
  if (input.runtime === "local") {
    return input.isTrueAdmin || input.adminAccess ? "local_fleet" : "none";
  }
  return input.remoteControlAllowed === true ? "remote_bridge" : "none";
}

/** OASIS slug wins if legacy profile metadata disagrees with the tenant. */
export function selectWorkerInventory(input: {
  isOasisTenant: boolean;
  isClientProfile: boolean;
}): WorkerInventory {
  if (input.isOasisTenant) return "oasis";
  if (input.isClientProfile) return "client";
  return "none";
}

/**
 * The workers the healthy/total pill should actually count.
 *
 * Active local, cloud, and remote workers count. Retired inventory does not,
 * and neither does a remote worker whose host reports no status here
 * (status_source "none"): with nothing to read it can be neither healthy nor
 * down. A LOCAL row always counts, so a local worker whose status wiring is
 * missing shows up as not reporting instead of quietly leaving the count.
 * `not_expected_here` remains as a rolling-deploy compatibility fallback so an
 * older response still cannot poison the denominator.
 */
export function countsTowardHealth(worker: WorkerStatusInput): boolean {
  return (
    worker.status !== "archived" &&
    worker.runtime !== "retired" &&
    !(worker.runtime === "remote" && worker.status_source === "none") &&
    !worker.not_expected_here
  );
}

/**
 * The supervisor's word for "the operator switched this off".
 *
 * scripts/ops/fleet_watchdog.py classify() keeps `disabled` distinct from
 * `down` precisely so a deliberate stop never pages anyone. The bridge then
 * maps disabled onto the "degraded" health value (bravo_cli/local_bridge.py),
 * and the tile turned that into "Degraded — check logs" — an alarm, about a
 * daemon the operator had stopped himself, pointing at logs that do not exist.
 *
 * The distinction survives in metadata.pm2_status, so read it there rather
 * than adding a value to the stored status vocabulary and migrating every row.
 */
export const SUPERVISOR_DISABLED = "disabled by operator";

export function isOperatorStopped(worker: WorkerStatusInput): boolean {
  if (worker.status !== "degraded") return false;
  return String(worker.metadata?.pm2_status ?? "") === SUPERVISOR_DISABLED;
}

/**
 * "last seen" that cannot disguise an old relic as a fresh outage.
 *
 * This printed toLocaleTimeString() alone, so the Skool daemon's
 * "last seen 7:31 PM" was 18 May — 106 days old — and rendered identically to
 * a worker that dropped out twenty minutes ago. A relic and a live incident
 * must not look the same.
 *
 * Today            → "3:42:10 PM"           (short; the common case)
 * Earlier this year→ "May 18, 7:31:48 PM"
 * A previous year  → "May 18, 2025, 7:31:48 PM"
 * Unparseable      → the raw value, never a silent "Invalid Date".
 *
 * `now` is injectable so the boundary is testable without freezing the clock.
 */
export function formatLastSeen(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return iso;
  const sameDay =
    then.getFullYear() === now.getFullYear() &&
    then.getMonth() === now.getMonth() &&
    then.getDate() === now.getDate();
  if (sameDay) return then.toLocaleTimeString();
  const opts: Intl.DateTimeFormatOptions =
    then.getFullYear() === now.getFullYear()
      ? { month: "short", day: "numeric" }
      : { year: "numeric", month: "short", day: "numeric" };
  return `${then.toLocaleDateString(undefined, opts)}, ${then.toLocaleTimeString()}`;
}

/** The bridge's own report on whether it could read the worker fleet. */
export const FLEET_REPORTER_SERVICE = "fleet_watchdog";

/** The authenticated pairing which last wrote fleet_watchdog, stamped by the server. */
export const REPORTER_PAIRING_ID_KEY = "_source_pairing_id";

export function reporterPairingId(metadata: unknown): string | null {
  let value = metadata;
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return null; }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const id = (value as Record<string, unknown>)[REPORTER_PAIRING_ID_KEY];
  return typeof id === "string" && id.length > 0 ? id : null;
}

/** Never infer the reporter from a user-editable device label or list order. */
export function pickLocalWorkerPairing<T extends { id?: string | null }>(
  rows: readonly T[] | null | undefined,
  pairingId: string | null,
): T | null {
  if (!pairingId) return null;
  return rows?.find((row) => row.id === pairingId) ?? null;
}

export type StatusReporter = {
  /**
   * ok      — the bridge read the fleet on its last tick.
   * failing — the bridge is pinging and says it could NOT read the fleet.
   * silent  — the bridge is pinging but its fleet report has gone stale.
   * unknown — no fleet report exists (a bridge older than this contract).
   */
  state: "ok" | "failing" | "silent" | "unknown";
  error: string | null;
  last_ping_at: string | null;
};

/**
 * Whether the worker tiles can be believed at all (2026-09-24).
 *
 * On 2026-09-23 the bridge kept pinging every minute while its process-table
 * read failed, so the twelve pm2.* rows simply stopped arriving. Each tile then
 * aged past the stale window and rendered "Down — stopped reporting" for a
 * worker that was running the whole time. Twelve false outages and no reason
 * given. The reporter's own row is what separates "these workers are down" from
 * "we cannot see these workers" — two situations that need opposite responses.
 */
export function describeStatusReporter(input: {
  row: { status: string; metadata?: Record<string, unknown> | null; last_ping_at: string | null } | undefined;
  bridgeOnline: boolean;
  now: number;
  staleMs: number;
}): StatusReporter {
  const { row } = input;
  if (!row) return { state: "unknown", error: null, last_ping_at: null };
  const pinged = row.last_ping_at ? Date.parse(row.last_ping_at) : NaN;
  const fresh = Number.isFinite(pinged) && input.now - pinged <= input.staleMs;
  if (!fresh) {
    return {
      state: input.bridgeOnline ? "silent" : "unknown",
      error: null,
      last_ping_at: row.last_ping_at,
    };
  }
  if (row.status === "healthy") return { state: "ok", error: null, last_ping_at: row.last_ping_at };
  const reported = row.metadata?.error;
  return {
    state: "failing",
    error: typeof reported === "string" && reported ? reported : "the bridge could not read the process table",
    last_ping_at: row.last_ping_at,
  };
}
