/**
 * lib/health/tenant-cron-checks.ts — are SunBiz's own scheduled jobs running?
 *
 * WHY. SunBiz's six enabled tenant_cron_jobs — Shop-Out Sender (every minute),
 * Cold Outreach Runner (every 15 minutes), Health Check (every 30 minutes),
 * Daily Plan Generator, Follow-up Generator and Renewal Reminder (daily) — had
 * NO executor from 2026-08-25 18:38 to 2026-09-11 17:41 UTC, and nothing
 * alerted. SunBiz's own Health Check was one of the dead jobs, and CC's harness
 * check excludes SunBiz by design. Seventeen days of silence from the very jobs
 * whose purpose is to notice silence.
 *
 * So this runs in the portal's health cron, which the oasis-cc-cron worker
 * drives, and so does not die with the VPS. It asks two questions of the data,
 * and pages SunBiz's lane only:
 *   - has every enabled job run within a generous multiple of its own schedule?
 *   - has the machine that is supposed to run them checked in recently?
 * The second catches a dead executor within 15 minutes even when every job is
 * daily. The first catches an executor that is alive but not running the jobs.
 *
 * SunBiz's only. Both checks report "nothing to check" for any other tenant, so
 * the runner being called for another workspace can never page SunBiz's
 * channel about that workspace's jobs.
 */

import "server-only";
import { brandForTenant } from "@/lib/email/brand-for-tenant";
import { expectedExecutorFor } from "@/lib/automations/expected-executor";
import type { DripCheck } from "./drip-checks";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** SunBiz's executor pings every minute; this many minutes of silence pages. */
export const EXECUTOR_MAX_SILENT_MIN = 15;

/**
 * The observed value when the expected executor has no live pairing at all, as
 * opposed to one that has gone quiet. Far above any real silence, so it fails
 * the ceiling, and `describe` can name the mode from the number alone.
 */
export const NO_PAIRING = 1_000_000_000;

// ── Schedule → the longest gap between two fires ───────────────────────────

const FIELD_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 7], // day of week (0 and 7 are both Sunday)
];

/** One cron field as the set of values it fires on, or null if unreadable.
 *  Accepts the grammar /api/cron-jobs validates: *, N, N-M, a step on any of
 *  those, and comma lists of them. */
function parseField(field: string, lo: number, hi: number): Set<number> | null {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!m) return null;
    const step = m[2] === undefined ? 1 : Number(m[2]);
    let a = lo;
    let b = hi;
    if (m[1] !== "*") {
      const [x, y] = m[1].split("-");
      a = Number(x);
      // "N/S" runs from N to the end of the range, as croniter reads it.
      b = y !== undefined ? Number(y) : m[2] !== undefined ? hi : a;
    }
    if (!(step >= 1) || a < lo || b > hi || a > b) return null;
    for (let v = a; v <= b; v += step) out.add(v);
  }
  return out;
}

/**
 * The LONGEST gap, in ms, between consecutive fires of a five-field schedule,
 * or null when it cannot be read.
 *
 * The longest rather than the typical one: "0 9 * * 1-5" legitimately goes
 * three days over a weekend, and judging it against one day would call it dead
 * every Monday. Same rule as schedule_interval_seconds in the harness
 * (scripts/core/cron_health_check.py), found by walking real fire times rather
 * than a table of intervals. Day-of-month and day-of-week combine the way cron
 * does: when both are restricted, either one matching is enough.
 */
export function cronGapMs(schedule: string): number | null {
  const parts = String(schedule || "").trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const sets = parts.map((p, i) => parseField(p, FIELD_RANGES[i][0], FIELD_RANGES[i][1]));
  if (sets.some((s) => s === null)) return null;
  const [minutes, hours, doms, months, dows] = sets as Set<number>[];
  if (dows.has(7)) dows.add(0);
  const eitherDayField = !parts[2].startsWith("*") && !parts[4].startsWith("*");
  const mins = [...minutes].sort((x, y) => x - y);
  const hrs = [...hours].sort((x, y) => x - y);

  // Walk from a fixed Monday so the answer never depends on today's date, and
  // far enough to see any weekly pattern, and a yearly one twice.
  const start = Date.UTC(2026, 0, 5);
  const fires: number[] = [];
  for (let d = 0; d < 800; d++) {
    const day = new Date(start + d * DAY);
    if (!months.has(day.getUTCMonth() + 1)) continue;
    const domOk = doms.has(day.getUTCDate());
    const dowOk = dows.has(day.getUTCDay());
    if (eitherDayField ? !(domOk || dowOk) : !(domOk && dowOk)) continue;
    for (const h of hrs) for (const m of mins) fires.push(start + d * DAY + h * HOUR + m * MIN);
    // Eight days of fires shows every weekly pattern; three fires are needed to
    // see more than one gap.
    if (fires.length >= 3 && fires[fires.length - 1] - fires[0] >= 8 * DAY) break;
  }
  if (fires.length < 2) return null;
  let gap = 0;
  for (let i = 1; i < fires.length; i++) gap = Math.max(gap, fires[i] - fires[i - 1]);
  return gap;
}

/**
 * How long a job may go without running before it counts as missed.
 *
 * Three of its own gaps, or one gap plus two hours of grace, whichever comes
 * first, and never less than twenty minutes. So an every-minute job is late
 * after 20 minutes, an every-15-minutes job after 45, every 30 minutes after 90,
 * hourly after 3 hours and daily after 26. Forgiving on purpose, since a bridge
 * restart costs a fire or two and a monitor that pages on the first miss gets
 * muted, but a daily job does not get three silent days before anyone hears.
 */
export function overdueAfterMs(gapMs: number): number {
  return Math.max(20 * MIN, Math.min(3 * gapMs, gapMs + 2 * HOUR));
}

/** A schedule this cannot read is still expected to fire at least once a day. */
const UNREADABLE_SCHEDULE_GAP_MS = DAY;

/** Epoch ms for a stored timestamp, or NaN. SQLite can return
 *  "YYYY-MM-DD HH:MM:SS" with no zone, which is UTC here. */
function parseTs(v: unknown): number {
  if (typeof v !== "string" || !v.trim()) return NaN;
  let s = v.trim().replace(/(\.\d{3})\d+/, "$1");
  if (/^\d{4}-\d{2}-\d{2} \d/.test(s)) s = s.replace(" ", "T");
  if (/T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s)) s += "Z";
  return Date.parse(s);
}

export type TenantCronRow = {
  name?: string | null;
  schedule?: string | null;
  last_run_at?: string | null;
  created_at?: string | null;
};

/**
 * How many of these enabled jobs have missed their schedule as of `nowMs`.
 *
 * A job that has never run is measured from its creation, so "enabled,
 * scheduled, never once executed" is caught rather than skipped. A job with
 * neither timestamp counts as missed: nothing shows it has ever run, and a job
 * skipped here would be invisible.
 */
export function countOverdueJobs(rows: TenantCronRow[], nowMs: number): number {
  let overdue = 0;
  for (const row of rows) {
    const gap = cronGapMs(String(row.schedule ?? "")) ?? UNREADABLE_SCHEDULE_GAP_MS;
    const last = parseTs(row.last_run_at);
    const since = Number.isFinite(last) ? last : parseTs(row.created_at);
    if (!Number.isFinite(since) || nowMs - since > overdueAfterMs(gap)) overdue += 1;
  }
  return overdue;
}

function isSunbiz(tenantId: string): boolean {
  return brandForTenant({ tenantId }) === "sunbiz";
}

export const TENANT_CRON_CHECKS: DripCheck[] = [
  {
    id: "sunbiz_jobs.overdue",
    severity: "critical",
    lane: "sunbiz-ops",
    rule: { kind: "must_be_zero" },
    observe: async (db, tenantId, endMs) => {
      if (!isSunbiz(tenantId)) return 0;
      try {
        const r = await db
          .from("tenant_cron_jobs")
          .select("name, schedule, last_run_at, created_at")
          .eq("tenant_id", tenantId)
          .eq("enabled", true);
        if (r.error) return null;
        return countOverdueJobs((r.data ?? []) as TenantCronRow[], endMs);
      } catch {
        return null;
      }
    },
    describe: (r) =>
      r.verdict === "check_broken"
        ? "Could not read SunBiz's scheduled jobs, so whether they are running is unknown."
        : `${r.observed} of SunBiz's enabled scheduled jobs have stopped running on schedule. ` +
          "They are run by the VPS bridge (srv1723601): check that it is paired to the SunBiz " +
          "workspace and polling, then open Automations to see which jobs are late.",
  },
  {
    id: "sunbiz_jobs.executor_silent_min",
    severity: "critical",
    lane: "sunbiz-ops",
    rule: { kind: "must_be_below", ceiling: EXECUTOR_MAX_SILENT_MIN },
    observe: async (db, tenantId, endMs) => {
      const label = expectedExecutorFor(tenantId);
      if (!isSunbiz(tenantId) || !label) return 0;
      try {
        // Several rows, newest first, and the maximum taken here: a re-pair
        // without a revoke leaves two, and where NULL sorts under DESC differs
        // between databases.
        const r = await db
          .from("bridge_pairings")
          .select("last_seen_at")
          .eq("tenant_id", tenantId)
          .eq("label", label)
          .is("revoked_at", null)
          .order("last_seen_at", { ascending: false })
          .limit(10);
        if (r.error) return null;
        const rows = (r.data ?? []) as Array<{ last_seen_at?: string | null }>;
        const seen = Math.max(...rows.map((p) => parseTs(p.last_seen_at)).filter(Number.isFinite));
        if (!Number.isFinite(seen)) return NO_PAIRING;
        return Math.max(0, Math.floor((endMs - seen) / MIN));
      } catch {
        return null;
      }
    },
    describe: (r) =>
      r.verdict === "check_broken"
        ? "Could not read the pairing of SunBiz's job executor, so whether anything is running SunBiz's scheduled jobs is unknown."
        : r.observed >= NO_PAIRING
          ? "SunBiz's job executor (the VPS bridge, srv1723601) has no active pairing to the SunBiz " +
            "workspace, so nothing can run SunBiz's scheduled jobs. Re-pair the VPS bridge with a SunBiz pair code."
          : `SunBiz's job executor (the VPS bridge, srv1723601) last checked in ${r.observed} min ago ` +
            `(limit ${EXECUTOR_MAX_SILENT_MIN}). While it is silent, none of SunBiz's scheduled jobs run.`,
  },
];
