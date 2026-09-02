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
export type WorkerStatusInput = {
  status: "healthy" | "degraded" | "down" | "unconfigured" | "archived";
  metadata?: Record<string, unknown> | null;
  /** Reason this worker is not meant to run on this machine, if it isn't. */
  not_expected_here?: string;
};

/**
 * The workers the healthy/total pill should actually count.
 *
 * Two tiles were permanently red for reasons that were not faults — retired
 * code kept on disk deliberately, and a daemon hosted on the VPS. Counting
 * them put the pill's best possible reading at 8/12: a gauge that can never
 * read full, which teaches the operator that some red is normal. Three
 * genuinely dead daemons then sat unnoticed behind exactly that number.
 */
export function countsTowardHealth(worker: WorkerStatusInput): boolean {
  return worker.status !== "archived" && !worker.not_expected_here;
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
