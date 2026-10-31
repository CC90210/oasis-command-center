/**
 * lib/automations/cron-switches.ts - the on/off switch of each scheduled cloud
 * job (2026-10-31, CC: "I must be able to turn any cloud automation on or off
 * with a single click").
 *
 * Store: cron_job_switches (bravo__251), one row per CRON_TABLE path that has
 * ever been switched. A path with no row is ON.
 *
 * Enforcement: every scheduled route calls cronPauseGate(req) right after
 * checkCronAuth, so OFF stops the work wherever the call comes from (the
 * oasis-cc-cron Worker, the GitHub rollback driver, a manual run). A paused job
 * answers 200 { skipped: "paused" } and does nothing else.
 *
 * Kept free of sessions and page code: 22 routes import it.
 */
import "server-only";
import { NextResponse } from "next/server";
import type { Client } from "@libsql/client";
import { getTursoClient, tursoConfigured } from "@/lib/turso";
import { CRON_TABLE } from "@/workers/oasis-cc-cron/src/index";
import { cronTableKeyFor } from "@/lib/automations/cloud-jobs";

export type CronSwitch = { enabled: boolean; changedAt: string; changedBy: string | null };

const KNOWN_ROUTES = new Set(CRON_TABLE.map((entry) => entry.path));

/** True for an exact CRON_TABLE path (the only routes that can be switched). */
export function isSwitchableCloudJob(route: string): boolean {
  return KNOWN_ROUTES.has(route);
}

/**
 * A database without bravo__251 has never had a switch flipped: every job is ON. Only that exact
 * error is read as "none"; any other failure still throws to the caller.
 */
function isMissingSwitchTable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String((error as { message?: unknown })?.message ?? error);
  return /no such table:\s*cron_job_switches/i.test(message);
}

function switchFromRow(row: Record<string, unknown>): CronSwitch {
  return {
    enabled: Number(row.enabled) === 1,
    changedAt: String(row.changed_at),
    changedBy: row.changed_by === null || row.changed_by === undefined ? null : String(row.changed_by),
  };
}

/** Every switch that has been flipped (a route missing from the map is ON). Throws on a failed read. */
export async function readCronSwitches(db: Client): Promise<Map<string, CronSwitch>> {
  const switches = new Map<string, CronSwitch>();
  let rs;
  try {
    rs = await db.execute({ sql: "SELECT route, enabled, changed_at, changed_by FROM cron_job_switches", args: [] });
  } catch (error) {
    if (isMissingSwitchTable(error)) return switches;
    throw error;
  }
  for (const row of rs.rows) switches.set(String(row.route), switchFromRow(row as unknown as Record<string, unknown>));
  return switches;
}

/** One route's switch, or null when it was never flipped (ON). Throws on a failed read. */
export async function readCronSwitch(db: Client, route: string): Promise<CronSwitch | null> {
  let rs;
  try {
    rs = await db.execute({
      sql: "SELECT route, enabled, changed_at, changed_by FROM cron_job_switches WHERE route = ?",
      args: [route],
    });
  } catch (error) {
    if (isMissingSwitchTable(error)) return null;
    throw error;
  }
  const row = rs.rows[0];
  return row ? switchFromRow(row as unknown as Record<string, unknown>) : null;
}

/**
 * Set one route ON or OFF. The caller has already authorized the actor and validated the route.
 *
 * Only a real change is stored: switching ON a job that was never switched writes nothing (no row is
 * ON), and saving the state a job is already in keeps its changed_at. So every changed_at is the
 * moment the switch really flipped, which recordCronRuns relies on. Returns the switch as stored
 * (changedAt null: never switched).
 */
export async function writeCronSwitch(
  db: Client,
  input: { route: string; enabled: boolean; actorUserId: string; now: Date },
): Promise<{ enabled: boolean; changedAt: string | null }> {
  if (!isSwitchableCloudJob(input.route)) throw new Error("cron_switch_unknown_route");
  const changedAt = input.now.toISOString();
  await db.execute(
    input.enabled
      ? {
          sql: "UPDATE cron_job_switches SET enabled = 1, changed_at = ?, changed_by = ? WHERE route = ? AND enabled = 0",
          args: [changedAt, input.actorUserId, input.route],
        }
      : {
          sql: `INSERT INTO cron_job_switches (route, enabled, changed_at, changed_by) VALUES (?, 0, ?, ?)
                ON CONFLICT(route) DO UPDATE SET enabled = 0, changed_at = excluded.changed_at, changed_by = excluded.changed_by
                WHERE cron_job_switches.enabled = 1`,
          args: [input.route, changedAt, input.actorUserId],
        },
  );
  const stored = await readCronSwitch(db, input.route);
  return stored ? { enabled: stored.enabled, changedAt: stored.changedAt } : { enabled: true, changedAt: null };
}

type GateDeps = { db?: () => Client | null };

/**
 * The OFF switch, enforced where the work happens. Returns the response a
 * paused route must answer with, or null to carry on.
 *
 * Fails OPEN on a failed switch read, deliberately: a job's default is ON, a
 * database the gate cannot read is almost always one the job's own work cannot
 * use either, and skipping every job on a blip would silently drop meeting
 * reminders and queued email. The failure is logged.
 */
export async function cronPauseGate(req: Request, deps: GateDeps = {}): Promise<NextResponse | null> {
  const route = cronTableKeyFor(new URL(req.url));
  if (!route) return null;
  const db = deps.db ? deps.db() : tursoConfigured() ? getTursoClient() : null;
  if (!db) return null;
  let state: CronSwitch | null;
  try {
    state = await readCronSwitch(db, route);
  } catch (error) {
    console.error("[cron.pause_gate] switch read failed; running the job", {
      route,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
  if (!state || state.enabled) return null;
  return NextResponse.json(
    { ok: true, skipped: "paused", route, paused_at: state.changedAt },
    { status: 200, headers: { "x-oasis-cron-skipped": "paused" } },
  );
}
