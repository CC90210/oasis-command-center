/**
 * lib/automations/cron-runs.ts - what each scheduled route did (2026-10-28, Phase 7).
 *
 * The cron Worker (workers/oasis-cc-cron) posts one batch per tick to POST /api/cron/runs. This module
 * validates that batch, writes it to cron_runs (bravo__249), prunes rows older than 14 days, and reads
 * the last run and the last 24 hours of every schedule for the Automations flow cards.
 *
 * Honest numbers: a schedule with no recorded run says "not measured yet", never a guessed "OK", and a
 * failed read is a failed read (null), never a row of zeros.
 */
import type { Client } from "@libsql/client";
import { CRON_TABLE } from "@/workers/oasis-cc-cron/src/index";
import { cronMatches, isValidCronExpression, isValidTimeZone } from "@/workers/oasis-cc-cron/src/cron-match";

export const CRON_RUNS_MAX_BATCH = 60;
export const CRON_RUNS_KEEP_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

export type CronRunInput = { path: string; ok: boolean; status: string; attempts: number; ms: number | null };

const KNOWN_PATHS = new Set(CRON_TABLE.map((e) => e.path));

/** The batch a tick posts, or null when it is malformed. Unknown routes are refused, not stored. */
export function parseCronRunBatch(raw: unknown): { tickAt: string; runs: CronRunInput[] } | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const body = raw as { tick?: unknown; results?: unknown };
  const tickMs = typeof body.tick === "string" ? Date.parse(body.tick) : NaN;
  if (!Number.isFinite(tickMs) || !Array.isArray(body.results) || body.results.length === 0) return null;
  if (body.results.length > CRON_RUNS_MAX_BATCH) return null;
  const runs: CronRunInput[] = [];
  for (const item of body.results) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const r = item as Record<string, unknown>;
    if (typeof r.path !== "string" || !KNOWN_PATHS.has(r.path) || typeof r.ok !== "boolean") return null;
    const attempts = r.attempts === 2 ? 2 : 1;
    const ms = typeof r.ms === "number" && Number.isFinite(r.ms) && r.ms >= 0 ? Math.round(Math.min(r.ms, 3_600_000)) : null;
    runs.push({ path: r.path, ok: r.ok, status: String(r.status ?? "").slice(0, 160), attempts, ms });
  }
  return { tickAt: new Date(tickMs).toISOString(), runs };
}

/** Store one tick's runs and prune what is older than the keep window. Throws on a failed write. */
export async function recordCronRuns(db: Client, batch: { tickAt: string; runs: CronRunInput[] }, now: number): Promise<number> {
  await db.batch(
    [
      ...batch.runs.map((run) => ({
        // One row per route per tick (bravo__250): a repeated report of the same tick is ignored.
        sql: "INSERT OR IGNORE INTO cron_runs (route, tick_at, ok, http_status, attempts, duration_ms) VALUES (?, ?, ?, ?, ?, ?)",
        args: [run.path, batch.tickAt, run.ok ? 1 : 0, run.status, run.attempts, run.ms],
      })),
      { sql: "DELETE FROM cron_runs WHERE tick_at < ?", args: [new Date(now - CRON_RUNS_KEEP_DAYS * DAY_MS).toISOString()] },
    ],
    "write",
  );
  return batch.runs.length;
}

function timeZoneLabel(timeZone: string): string | null {
  if (!isValidTimeZone(timeZone)) return null;
  if (/^(?:Etc\/)?(?:UTC|GMT)$/i.test(timeZone)) return "UTC";
  const city = timeZone.split("/").pop();
  return city ? `${city.replace(/_/g, " ")} time` : timeZone;
}

/** "every 5 minutes", "hourly at :15", "daily at 21:47 UTC"; anything else is shown as written. PURE. */
export function scheduleInWords(expr: string, timeZone = "UTC"): string {
  const [min, hour, dom, mon, dow] = expr.trim().split(/\s+/);
  const rest = dom === "*" && mon === "*" && dow === "*";
  const zone = timeZoneLabel(timeZone);
  if (!zone) return `cron ${expr}`;
  const suffix = zone === "UTC" ? "" : `, ${zone}`;
  if (!rest) return zone === "UTC" ? `cron ${expr}` : `cron ${expr} (${zone})`;
  if (min === "*" && hour === "*") return `every minute${suffix}`;
  const step = /^\*\/(\d+)$/.exec(min ?? "");
  if (step && hour === "*") return `every ${step[1]} minutes${suffix}`;
  if (/^\d+$/.test(min ?? "") && hour === "*") return `hourly at :${String(min).padStart(2, "0")}${suffix}`;
  if (/^\d+$/.test(min ?? "") && /^\d+$/.test(hour ?? "")) {
    return `daily at ${String(hour).padStart(2, "0")}:${String(min).padStart(2, "0")} ${zone}`;
  }
  return zone === "UTC" ? `cron ${expr}` : `cron ${expr} (${zone})`;
}

/** The next minute (after `now`) the schedule fires, within the next week; null when it does not. PURE. */
export function nextRunAt(expr: string, now: number, timeZone = "UTC"): string | null {
  if (!Number.isFinite(now) || !isValidCronExpression(expr) || !isValidTimeZone(timeZone)) return null;
  const start = Math.floor(now / 60_000) * 60_000 + 60_000;
  for (let t = start; t <= start + 8 * DAY_MS; t += 60_000) {
    if (cronMatches(expr, new Date(t), timeZone)) return new Date(t).toISOString();
  }
  return null;
}

export type CronFlow = {
  path: string;
  schedule: string;
  timeZone: string;
  words: string;
  nextAt: string | null;
  last: { ok: boolean; status: string | null; ms: number | null; at: string } | null;
  day: { ok: number; total: number };
};

/** Every scheduled route with its last run and the last 24 hours, or null when the read failed. */
export async function loadCronFlows(db: Client, now: number): Promise<CronFlow[] | null> {
  try {
    const since = new Date(now - DAY_MS).toISOString();
    const [lastRs, dayRs] = await Promise.all([
      db.execute({
        sql: `SELECT c.route, c.ok, c.http_status, c.duration_ms, c.tick_at
              FROM cron_runs c
              JOIN (SELECT route, MAX(tick_at) AS t FROM cron_runs GROUP BY route) m
                ON m.route = c.route AND m.t = c.tick_at`,
        args: [],
      }),
      db.execute({
        sql: "SELECT route, SUM(ok) AS ok, COUNT(*) AS total FROM cron_runs WHERE tick_at >= ? GROUP BY route",
        args: [since],
      }),
    ]);
    const last = new Map<string, CronFlow["last"]>();
    for (const r of lastRs.rows) {
      last.set(String(r.route), {
        ok: Number(r.ok) === 1,
        status: r.http_status === null ? null : String(r.http_status),
        ms: r.duration_ms === null ? null : Number(r.duration_ms),
        at: String(r.tick_at),
      });
    }
    const day = new Map<string, CronFlow["day"]>();
    for (const r of dayRs.rows) day.set(String(r.route), { ok: Number(r.ok ?? 0), total: Number(r.total ?? 0) });
    return CRON_TABLE.map((e) => {
      const timeZone = e.timeZone ?? "UTC";
      return {
        path: e.path,
        schedule: e.schedule,
        timeZone,
        words: scheduleInWords(e.schedule, timeZone),
        nextAt: nextRunAt(e.schedule, now, timeZone),
        last: last.get(e.path) ?? null,
        day: day.get(e.path) ?? { ok: 0, total: 0 },
      };
    });
  } catch (err) {
    console.error("[automations.cron_runs]", err instanceof Error ? err.message : String(err));
    return null;
  }
}
