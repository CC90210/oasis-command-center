/**
 * Cron rows whose work is really done by a dedicated PM2 daemon.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * A cron row and a PM2 process were two unrelated things to this dashboard.
 * The Automations tab read `cron_jobs.is_active` and reported it as the
 * automation's on/off state — correct for every row the shared scheduler runs,
 * and a lie for the one that moved off it.
 *
 * The Instagram DM setter moved. `scripts/scheduler.py` runs every due job
 * SEQUENTIALLY before it sleeps, so a DM reply queued behind an 84s email
 * sweep: measured gap between polls ~291s, and a prospect who typed "Yo Wsp"
 * waited 3m46s. A person watching for a reply does not tolerate a batch queue,
 * so the setter became `bravo-ig-dm` in the harness ecosystem.config.js with
 * its own tick.
 *
 * Its cron twin — "Instagram DM Closer" — is deliberately parked at
 * `is_active = 0`, and that flag is an INTERLOCK, not a preference. Two live
 * runners on one script answer every prospect twice; that happened on
 * 2026-08-20. `scripts/integrations/ig_dm_daemon.py:cron_row_is_armed()` reads
 * the row at startup and REFUSES to boot when it is armed.
 *
 * So the dashboard was showing the operator's most important automation as OFF
 * while it was actively answering real people — and the single most natural
 * correction, flipping the toggle, would have armed the scheduler's copy AND
 * bricked the daemon's next restart. One click, setter offline.
 *
 * This module is the missing link. It names, in one place:
 *   - which cron row is a parked twin,
 *   - which PM2 process actually does the work,
 *   - and therefore which rows the toggle must drive through pm2 instead of
 *     through `cron_jobs.is_active`.
 *
 * Both halves of the fix read from here: `/api/cron-jobs` attaches live daemon
 * health to the row so it renders as ON when the process is up, and
 * `/api/cron-jobs/[id]` REFUSES an `enabled` write against any row listed here
 * so the arming path does not exist rather than merely being discouraged.
 *
 * ADDING A ROW: park the cron (`is_active = 0`), add the daemon to
 * ecosystem.config.js, add the pm2 service to EXPECTED_WORKERS in
 * app/api/automations/background-workers/route.ts, and add an entry here.
 * tests/daemon-backed-crons.test.ts fails if the last two drift apart.
 */

/** A cron row that a dedicated PM2 process has taken over. */
export type DaemonBackedCron = {
  /** Exact `cron_jobs.name`. Matched case-insensitively, trimmed. */
  cronName: string;
  /** `integrations_health.service` key the bridge reports under. */
  service: string;
  /** pm2 process name — what `pm2 start|stop <name>` is given. */
  processName: string;
  /** Operator-facing name of the thing that is actually running. */
  label: string;
  /** One line: why the cron twin is parked. Rendered under the row. */
  why: string;
  /** What the operator is turning off. Shown in the stop confirmation. */
  stopWarning: string;
};

export const DAEMON_BACKED_CRONS: readonly DaemonBackedCron[] = [
  {
    cronName: "Instagram DM Closer",
    service: "pm2.bravo-ig-dm",
    processName: "bravo-ig-dm",
    label: "Instagram DM setter",
    why:
      "Runs as its own always-on process so a DM reply never waits behind the " +
      "batch jobs on the shared scheduler. The scheduler's copy of this row stays " +
      "parked on purpose — two runners would answer every prospect twice.",
    stopWarning:
      "This stops the Instagram DM setter. Prospects mid-conversation stop getting " +
      "replies until you start it again.",
  },
];

const BY_NAME = new Map<string, DaemonBackedCron>(
  DAEMON_BACKED_CRONS.map((d) => [d.cronName.trim().toLowerCase(), d]),
);

/** The daemon that owns this cron row's work, or null for a normal row. */
export function daemonBackedCronForName(
  name: string | null | undefined,
): DaemonBackedCron | null {
  return BY_NAME.get((name || "").trim().toLowerCase()) ?? null;
}

/** True when a cron row's on/off is owned by a PM2 process, not `is_active`. */
export function isDaemonBackedCronName(name: string | null | undefined): boolean {
  return daemonBackedCronForName(name) !== null;
}

/**
 * How old a health row may be and still be quoted as current.
 *
 * The bridge pushes `pm2 jlist` on every 60s heartbeat, so anything inside a
 * few minutes is a fresh reading. Past that we do NOT keep showing the last
 * value: a twenty-minute-old "healthy" is a green light pretending to be a
 * measurement, and the whole point of this work is that the tab stops
 * pretending. Stale degrades to `unknown`, with the timestamp shown so the
 * operator can see exactly how old the last reading was.
 */
export const DAEMON_HEALTH_STALE_MS = 300_000;

/** What the dashboard is willing to say about a daemon right now. */
export type DaemonRunState = "running" | "stopped" | "degraded" | "unknown";

/** Live daemon status attached to a cron row by /api/cron-jobs. */
export type DaemonState = {
  service: string;
  process_name: string;
  label: string;
  why: string;
  stop_warning: string;
  state: DaemonRunState;
  /** Raw `integrations_health.status` before the freshness test, or null. */
  reported_status: string | null;
  last_ping_at: string | null;
  /** A status was reported but is too old to quote — state is `unknown`. */
  stale: boolean;
};

/** One `integrations_health` row, narrowed to what this module reads. */
export type DaemonHealthRow = {
  status: string | null;
  last_ping_at: string | null;
} | null;

/**
 * Turn a reported health row into something honest.
 *
 * Three ways to end up at `unknown`, and all three are surfaced rather than
 * smoothed over: nothing reported at all, a timestamp we cannot parse, and a
 * reading too old to trust. `running` requires a fresh `healthy`, full stop.
 */
export function deriveDaemonState(
  def: DaemonBackedCron,
  health: DaemonHealthRow,
  now: number = Date.now(),
): DaemonState {
  const base = {
    service: def.service,
    process_name: def.processName,
    label: def.label,
    why: def.why,
    stop_warning: def.stopWarning,
  };
  if (!health || !health.status) {
    return {
      ...base,
      state: "unknown",
      reported_status: null,
      last_ping_at: health?.last_ping_at ?? null,
      stale: false,
    };
  }
  const reported = health.status;
  const pingedAt = health.last_ping_at ? Date.parse(health.last_ping_at) : NaN;
  // An unparseable timestamp is not a fresh one. Same rule as a missing one.
  const stale = !Number.isFinite(pingedAt) || now - pingedAt > DAEMON_HEALTH_STALE_MS;
  if (stale) {
    return {
      ...base,
      state: "unknown",
      reported_status: reported,
      last_ping_at: health.last_ping_at,
      stale: true,
    };
  }
  const state: DaemonRunState =
    reported === "healthy"
      ? "running"
      : reported === "down"
        ? "stopped"
        : reported === "degraded"
          ? "degraded"
          : "unknown";
  return {
    ...base,
    state,
    reported_status: reported,
    last_ping_at: health.last_ping_at,
    stale: false,
  };
}
