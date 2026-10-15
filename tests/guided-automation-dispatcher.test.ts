/** Due-slot, miss, bound, starvation, and scheduler-registration coverage. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createClient } from "@libsql/client";

const dbFile = join(mkdtempSync(join(tmpdir(), "guided-dispatcher-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;

function stub(request: string, exports: Record<string, unknown>): void {
  const path = require.resolve(request);
  require.cache[path] = { id: path, filename: path, path: dirname(path), loaded: true, children: [], paths: [], exports } as unknown as NodeModule;
}
stub("next/headers", { cookies: async () => ({ get: () => undefined }), headers: async () => new Headers(), draftMode: async () => ({ isEnabled: false }) });
stub("next/navigation", { notFound: () => undefined, redirect: () => undefined });

let passed = 0;
let failed = 0;
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); passed += 1; console.log(`  ok    ${name}`); }
  catch (error) { failed += 1; console.log(`  FAIL  ${name}\n        ${String((error as Error).stack || error).split("\n").slice(0, 8).join("\n        ")}`); }
}

const payload = (plan: Record<string, unknown>, cap?: number) => JSON.stringify({ ...(cap ? { runtime_cap_sec: cap } : {}), schedule: { plan } });
const DAILY = { mode: "daily", time: "09:00", timezone: "America/Toronto" };
const WEEKLY_MONDAY = { mode: "weekly", time: "09:00", days: [1], timezone: "America/Toronto" };
const HOURLY = { mode: "every_n_hours", time: "06:00", every_hours: 1, timezone: "America/Toronto" };

async function main(): Promise<void> {
  const db = createClient({ url: `file:${dbFile}` });
  await db.executeMultiple(`
    CREATE TABLE tenant_cron_jobs (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, owner_user_id TEXT, agent_key TEXT, name TEXT,
      action_type TEXT, action_payload TEXT, enabled INTEGER, last_scheduled_for TEXT,
      created_at TEXT, updated_at TEXT
    );
    CREATE TABLE dept_chat_runs (
      id TEXT PRIMARY KEY, tenant_id TEXT, automation_id TEXT, scheduled_for TEXT, status TEXT
    );
  `);
  const tenant = "tenant-acme";
  const addRow = (id: string, action_payload: string, stamp: string | null, over: { enabled?: number; type?: string } = {}) =>
    db.execute({
      sql: "INSERT INTO tenant_cron_jobs VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      args: [id, tenant, "owner", "sdr", id, over.type ?? "department_task", action_payload, over.enabled ?? 1, stamp, stamp ?? "2026-10-01T00:00:00.000Z", stamp ?? "2026-10-01T00:00:00.000Z"],
    });
  const wipe = async () => {
    await db.execute("DELETE FROM tenant_cron_jobs");
    await db.execute("DELETE FROM dept_chat_runs");
  };
  const { dispatchGuidedAutomations } = await import("../lib/automations/guided-dispatcher");
  const { GuidedPreflightUnavailable } = await import("../lib/os/runs/guided-run");
  type RunInput = { row: { id: string }; scheduledFor: Date };
  const done = (row: { id: string }, scheduledFor: Date) => ({ runId: `run-${row.id}-${scheduledFor.getTime()}`, status: "done" as const, finalText: "ok", wouldDraft: [], receipt: null });
  const lastStamp = async (id: string) => String((await db.execute({ sql: "SELECT last_scheduled_for FROM tenant_cron_jobs WHERE id = ?", args: [id] })).rows[0].last_scheduled_for);

  await check("a slot inside the 30 minute grace runs, an older one is recorded missed and never replayed, manual/script rows do nothing, and last_scheduled advances", async () => {
    await wipe();
    await addRow("old-hourly", payload(HOURLY), "2026-10-15T09:00:00.000Z");
    await addRow("recent-daily", payload(DAILY), "2026-10-14T13:00:00.000Z");
    await addRow("manual", payload({ mode: "manual", timezone: "America/Toronto" }), null);
    await addRow("script-row", "{}", null, { type: "script" });
    const live: string[] = [];
    const missed: string[] = [];
    let active = 0;
    let maxActive = 0;
    const summary = await dispatchGuidedAutomations({
      db,
      now: new Date("2026-10-15T13:20:00.000Z"),
      deps: {
        run: async ({ row, scheduledFor }: RunInput) => {
          active += 1; maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active -= 1;
          live.push(`${row.id}:${scheduledFor.toISOString()}`);
          return done(row, scheduledFor);
        },
        recordMissed: async ({ row, scheduledFor }) => {
          missed.push(`${row.id}:${scheduledFor.toISOString()}`);
          return { runId: `miss-${row.id}-${scheduledFor.getTime()}`, created: true };
        },
      } as never,
    });
    assert.equal(summary.scanned, 2, "manual and script rows are not even read");
    assert.deepEqual(missed.sort(), ["old-hourly:2026-10-15T10:00:00.000Z", "old-hourly:2026-10-15T11:00:00.000Z", "old-hourly:2026-10-15T12:00:00.000Z"]);
    assert.deepEqual(live.sort(), ["old-hourly:2026-10-15T13:00:00.000Z", "recent-daily:2026-10-15T13:00:00.000Z"]);
    assert.ok(live.every((value) => !missed.includes(value)), "a missed slot was replayed");
    assert.ok(maxActive <= 2, `dispatcher used ${maxActive} concurrent turns`);
    assert.equal(await lastStamp("recent-daily"), "2026-10-15T13:00:00.000Z");
    assert.equal(await lastStamp("old-hourly"), "2026-10-15T13:00:00.000Z");
  });

  await check("a daily slot more than 30 minutes late is missed, not run late (it used to run up to 48 hours late)", async () => {
    await wipe();
    await addRow("late-daily", payload(DAILY), "2026-10-14T13:00:00.000Z");
    const live: string[] = [];
    const missed: string[] = [];
    await dispatchGuidedAutomations({
      db,
      now: new Date("2026-10-15T14:05:00.000Z"),
      deps: {
        run: async ({ row, scheduledFor }: RunInput) => { live.push(row.id); return done(row, scheduledFor); },
        recordMissed: async ({ scheduledFor }) => { missed.push(scheduledFor.toISOString()); return { runId: "m", created: true }; },
      } as never,
    });
    assert.deepEqual(live, []);
    assert.deepEqual(missed, ["2026-10-15T13:00:00.000Z"]);
    assert.equal(await lastStamp("late-daily"), "2026-10-15T13:00:00.000Z", "and it moves on");
  });

  await check("rows that are not due cannot hide a row that is: 40 weekly rows stamped long ago do not starve a due daily row", async () => {
    await wipe();
    // Forty rows whose next slot is days away, all stamped EARLIER than the due row: the old "oldest 25" window held only these.
    for (let i = 0; i < 40; i += 1) await addRow(`weekly-${String(i).padStart(2, "0")}`, payload(WEEKLY_MONDAY), "2026-10-12T13:00:00.000Z");
    await addRow("fresh-due", payload(DAILY), "2026-10-14T13:00:00.000Z");
    const live: string[] = [];
    const summary = await dispatchGuidedAutomations({
      db,
      now: new Date("2026-10-15T13:05:00.000Z"),
      deps: { run: async ({ row, scheduledFor }: RunInput) => { live.push(row.id); return done(row, scheduledFor); }, recordMissed: async () => { throw new Error("nothing is missed"); } } as never,
    });
    assert.equal(summary.scanned, 41);
    assert.deepEqual(live, ["fresh-due"]);
  });

  await check("at most 8 runs start per tick, oldest due slot first; the rest are deferred, not lost", async () => {
    await wipe();
    // Twelve due rows with distinct stamps, id order the REVERSE of age order, so only the age sort can produce the expected order.
    for (let i = 0; i < 12; i += 1) await addRow(`due-${String(11 - i).padStart(2, "0")}`, payload(DAILY), `2026-10-14T13:${String(i).padStart(2, "0")}:00.000Z`);
    const order: string[] = [];
    const summary = await dispatchGuidedAutomations({
      db,
      now: new Date("2026-10-15T13:10:00.000Z"),
      concurrency: 1,
      deps: { run: async ({ row, scheduledFor }: RunInput) => { order.push(row.id); return done(row, scheduledFor); }, recordMissed: async () => ({ runId: "m", created: true }) } as never,
    });
    assert.equal(summary.started.length, 8);
    assert.equal(order.length, 8);
    // The slot is the same wall time for every row (09:00 Toronto), so age is the stamp: due-11 (minute 00) is oldest.
    assert.deepEqual(order, ["due-11", "due-10", "due-09", "due-08", "due-07", "due-06", "due-05", "due-04"]);
    assert.equal(summary.deferred.length, 4, "the other four wait for the next minute");
    assert.equal(await lastStamp("due-03"), "2026-10-14T13:08:00.000Z", "a deferred row's slot is still open");
    assert.equal(await lastStamp("due-11"), "2026-10-15T13:00:00.000Z");
  });

  await check("a run starts only if its own time limit and a reserve fit in what is left of the tick", async () => {
    await wipe();
    await addRow("long-cap", payload(DAILY, 240), "2026-10-14T13:00:00.000Z");
    await addRow("short-cap", payload(DAILY, 60), "2026-10-14T13:01:00.000Z");
    const live: string[] = [];
    const summary = await dispatchGuidedAutomations({
      db,
      now: new Date("2026-10-15T13:05:00.000Z"),
      budgetMs: 100_000,
      concurrency: 1,
      deps: { run: async ({ row, scheduledFor }: RunInput) => { live.push(row.id); return done(row, scheduledFor); }, recordMissed: async () => ({ runId: "m", created: true }) } as never,
    });
    assert.deepEqual(live, ["short-cap"], "240s + reserve does not fit in 100s; 60s + reserve does");
    assert.ok(summary.deferred.some((d) => d.startsWith("long-cap:")));
    assert.equal(await lastStamp("long-cap"), "2026-10-14T13:00:00.000Z", "and its slot stays open");
  });

  await check("a slot that already has a run is not work: one still going is skipped, a finished one is only stamped", async () => {
    await wipe();
    await addRow("going", payload(DAILY), "2026-10-14T13:00:00.000Z");
    await addRow("finished", payload(DAILY), "2026-10-14T13:00:00.000Z");
    await addRow("fresh", payload(DAILY), "2026-10-14T13:30:00.000Z");
    const slot = "2026-10-15T13:00:00.000Z";
    await db.execute({ sql: "INSERT INTO dept_chat_runs VALUES ('r1', ?, 'going', ?, 'running')", args: [tenant, slot] });
    await db.execute({ sql: "INSERT INTO dept_chat_runs VALUES ('r2', ?, 'finished', ?, 'done')", args: [tenant, slot] });
    // A "missed" note beside a slot is not a run: it does not claim the slot.
    await db.execute({ sql: "INSERT INTO dept_chat_runs VALUES ('r3', ?, 'fresh', ?, 'missed')", args: [tenant, slot] });
    const live: string[] = [];
    const summary = await dispatchGuidedAutomations({
      db,
      now: new Date("2026-10-15T13:05:00.000Z"),
      deps: { run: async ({ row, scheduledFor }: RunInput) => { live.push(row.id); return done(row, scheduledFor); }, recordMissed: async () => ({ runId: "m", created: true }) } as never,
    });
    assert.deepEqual(live, ["fresh"]);
    assert.equal(summary.alreadyClaimed.length, 2);
    assert.equal(await lastStamp("finished"), slot, "the finished-but-unstamped row moves on");
    assert.equal(await lastStamp("going"), "2026-10-14T13:00:00.000Z", "a run in progress keeps its slot until it ends");
  });

  await check("a row paused, edited or deleted after the scan is not run: it is read again just before its turn", async () => {
    await wipe();
    await addRow("a-first", payload(DAILY), "2026-10-14T13:00:00.000Z");
    await addRow("b-paused-meanwhile", payload(DAILY), "2026-10-14T13:01:00.000Z");
    await addRow("c-deleted-meanwhile", payload(DAILY), "2026-10-14T13:02:00.000Z");
    const live: string[] = [];
    const summary = await dispatchGuidedAutomations({
      db,
      now: new Date("2026-10-15T13:05:00.000Z"),
      concurrency: 1,
      deps: {
        run: async ({ row, scheduledFor }: RunInput) => {
          live.push(row.id);
          // While the first run is going, someone pauses one automation and deletes another.
          await db.execute("UPDATE tenant_cron_jobs SET enabled = 0 WHERE id = 'b-paused-meanwhile'");
          await db.execute("DELETE FROM tenant_cron_jobs WHERE id = 'c-deleted-meanwhile'");
          return done(row, scheduledFor);
        },
        recordMissed: async () => ({ runId: "m", created: true }),
      } as never,
    });
    assert.deepEqual(live, ["a-first"]);
    assert.deepEqual(summary.skipped.sort(), ["b-paused-meanwhile", "c-deleted-meanwhile"]);
  });

  await check("a failed READ in the preflight leaves the slot open for the next minute and never counts as a run or a failure", async () => {
    await wipe();
    await addRow("flaky", payload(DAILY), "2026-10-14T13:00:00.000Z");
    await addRow("steady", payload(DAILY), "2026-10-14T13:01:00.000Z");
    const live: string[] = [];
    const summary = await dispatchGuidedAutomations({
      db,
      now: new Date("2026-10-15T13:05:00.000Z"),
      concurrency: 1,
      deps: {
        run: async ({ row, scheduledFor }: RunInput) => {
          if (row.id === "flaky") throw new GuidedPreflightUnavailable("connector");
          live.push(row.id);
          return done(row, scheduledFor);
        },
        recordMissed: async () => ({ runId: "m", created: true }),
      } as never,
    });
    assert.deepEqual(live, ["steady"], "one row's hiccup does not stop the others");
    assert.deepEqual(summary.retrying, ["flaky:2026-10-15T13:00:00.000Z"]);
    assert.deepEqual(summary.failed, []);
    assert.equal(await lastStamp("flaky"), "2026-10-14T13:00:00.000Z", "the slot is still open");
  });

  await check("any other throw is a failure and also leaves the slot open", async () => {
    await wipe();
    await addRow("broken", payload(DAILY), "2026-10-14T13:00:00.000Z");
    const summary = await dispatchGuidedAutomations({
      db,
      now: new Date("2026-10-15T13:05:00.000Z"),
      deps: { run: async () => { throw new Error("db down"); }, recordMissed: async () => ({ runId: "m", created: true }) } as never,
    });
    assert.deepEqual(summary.failed, ["broken:2026-10-15T13:00:00.000Z"]);
    assert.equal(await lastStamp("broken"), "2026-10-14T13:00:00.000Z");
  });

  await check("the scan is capped and says so when it is hit", async () => {
    await wipe();
    for (let i = 0; i < 6; i += 1) await addRow(`future-${i}`, payload({ mode: "daily", time: "23:59", timezone: "America/Toronto" }), "2026-10-15T14:00:00.000Z");
    const summary = await dispatchGuidedAutomations({ db, now: new Date("2026-10-15T14:05:00.000Z"), scanLimit: 5, deps: { run: async () => { throw new Error("nothing is due"); }, recordMissed: async () => { throw new Error("nothing is due"); } } as never });
    assert.equal(summary.scanned, 5);
    assert.equal(summary.overLimit, true);
  });

  await check("the route is registered in the registry, Worker, and rollback workflow with the long timeout", () => {
    const root = resolve(process.cwd());
    const route = readFileSync(join(root, "app/api/cron/dispatch-automations/route.ts"), "utf8");
    const registry = readFileSync(join(root, "config/cron-registry.json"), "utf8");
    const worker = readFileSync(join(root, "workers/oasis-cc-cron/src/index.ts"), "utf8");
    const workflow = readFileSync(join(root, ".github/workflows/cron-driver.yml"), "utf8");
    assert.match(route, /checkCronAuth/);
    assert.match(route, /export const GET = handle/);
    assert.match(route, /export const POST = handle/);
    assert.match(registry, /"path": "\/api\/cron\/dispatch-automations"[\s\S]*"schedule": "\* \* \* \* \*"/);
    assert.match(worker, /dispatch-automations[\s\S]*840_000/);
    assert.match(workflow, /dispatch-automations[\s\S]*timeout_s=840/);
  });

  console.log(`guided-automation-dispatcher: ${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

void main();
