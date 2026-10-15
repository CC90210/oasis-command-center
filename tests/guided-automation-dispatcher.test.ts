/** Due-slot, miss, bound, and scheduler-registration coverage. */
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

const payload = (plan: Record<string, unknown>) => JSON.stringify({ schedule: { plan } });

async function main(): Promise<void> {
  const db = createClient({ url: `file:${dbFile}` });
  await db.executeMultiple(`
    CREATE TABLE tenant_cron_jobs (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, owner_user_id TEXT, agent_key TEXT, name TEXT,
      action_type TEXT, action_payload TEXT, enabled INTEGER, last_scheduled_for TEXT,
      created_at TEXT, updated_at TEXT
    );
  `);
  const tenant = "tenant-acme";
  await db.batch([
    { sql: "INSERT INTO tenant_cron_jobs VALUES (?,?,?,?,?,?,?,?,?,?,?)", args: ["old-hourly", tenant, "owner", "sdr", "Old hourly", "department_task", payload({ mode: "every_n_hours", time: "06:00", every_hours: 1, timezone: "America/Toronto" }), 1, "2026-10-15T09:00:00.000Z", "2026-10-15T09:00:00.000Z", "2026-10-15T09:00:00.000Z"] },
    { sql: "INSERT INTO tenant_cron_jobs VALUES (?,?,?,?,?,?,?,?,?,?,?)", args: ["recent-daily", tenant, "owner", "sdr", "Recent daily", "department_task", payload({ mode: "daily", time: "09:00", timezone: "America/Toronto" }), 1, "2026-10-14T13:00:00.000Z", "2026-10-14T13:00:00.000Z", "2026-10-14T13:00:00.000Z"] },
    { sql: "INSERT INTO tenant_cron_jobs VALUES (?,?,?,?,?,?,?,?,?,?,?)", args: ["manual", tenant, "owner", "sdr", "Manual", "department_task", payload({ mode: "manual", timezone: "America/Toronto" }), 1, null, "2026-10-14T13:00:00.000Z", "2026-10-14T13:00:00.000Z"] },
    { sql: "INSERT INTO tenant_cron_jobs VALUES (?,?,?,?,?,?,?,?,?,?,?)", args: ["script-row", tenant, "owner", "sdr", "Script", "script", "{}", 1, null, "2026-10-14T13:00:00.000Z", "2026-10-14T13:00:00.000Z"] },
  ], "write");
  const { dispatchGuidedAutomations } = await import("../lib/automations/guided-dispatcher");

  await check("old slots become missed, recent slots run, manual/script rows do not, and last_scheduled advances", async () => {
    const live: string[] = [];
    const missed: string[] = [];
    let active = 0;
    let maxActive = 0;
    const summary = await dispatchGuidedAutomations({
      db,
      now: new Date("2026-10-15T14:05:00.000Z"),
      deps: {
        run: async ({ row, scheduledFor }) => {
          active += 1; maxActive = Math.max(maxActive, active);
          await new Promise((done) => setTimeout(done, 5));
          active -= 1;
          live.push(`${row.id}:${scheduledFor.toISOString()}`);
          return { runId: `run-${row.id}-${scheduledFor.getTime()}`, status: "done", finalText: "ok", wouldDraft: [], receipt: null };
        },
        recordMissed: async ({ row, scheduledFor }) => {
          missed.push(`${row.id}:${scheduledFor.toISOString()}`);
          return { runId: `miss-${row.id}-${scheduledFor.getTime()}`, created: true };
        },
      },
    });
    assert.equal(summary.scanned, 2);
    assert.ok(missed.length > 0, "an old hourly slot was not marked missed");
    assert.ok(live.some((value) => value.startsWith("recent-daily:")), "the daily due slot did not run");
    assert.ok(live.every((value) => !value.startsWith("manual:")));
    assert.ok(live.every((value) => !missed.includes(value)), "a missed slot was replayed");
    assert.ok(maxActive <= 2, `dispatcher used ${maxActive} concurrent turns`);
    const stamp = await db.execute("SELECT last_scheduled_for FROM tenant_cron_jobs WHERE id='recent-daily' AND tenant_id='tenant-acme'");
    assert.equal(stamp.rows[0].last_scheduled_for, "2026-10-15T13:00:00.000Z");
  });

  await check("the enabled-row scan is capped and reports overflow", async () => {
    const writes = Array.from({ length: 26 }, (_, index) => ({
      sql: "INSERT INTO tenant_cron_jobs VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      args: [`future-${index.toString().padStart(2, "0")}`, tenant, "owner", "sdr", "Future", "department_task", payload({ mode: "daily", time: "23:59", timezone: "America/Toronto" }), 1, null, "2026-10-15T14:00:00.000Z", "2026-10-15T14:00:00.000Z"],
    }));
    await db.batch(writes, "write");
    const summary = await dispatchGuidedAutomations({ db, now: new Date("2026-10-15T14:05:00.000Z"), deps: { run: async () => { throw new Error("manual row ran"); }, recordMissed: async () => { throw new Error("manual row missed"); } } });
    assert.equal(summary.scanned, 25);
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
