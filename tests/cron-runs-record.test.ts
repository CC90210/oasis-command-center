/**
 * tests/cron-runs-record.test.ts - the cron Worker's run report and the Automations flow cards
 * (2026-10-28, Phase 7).
 *
 * Pinned:
 *   1. POST /api/cron/runs takes the same two-leg cron auth as every cron route: no bearer, or a
 *      bearer without the Worker's attest, is a 401;
 *   2. only the Worker's own scheduled routes are stored, a batch is at most 60, and a malformed
 *      one is a 400 with nothing written;
 *   3. it applies bravo__249 for real, stores a tick, and prunes rows older than 14 days;
 *   4. the flow cards: the last run and 24 hours per route, "not measured yet" where nothing ran,
 *      the schedule in words, the next run, and a failed read is null (never zeros);
 *   5. the Worker times each forward and reports the tick after logging it.
 *
 * Run: node --conditions=react-server --import tsx tests/cron-runs-record.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { NextRequest } from "next/server";

const dbFile = join(mkdtempSync(join(tmpdir(), "cron-runs-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
for (const k of ["TURSO_DATABASE_URL", "TURSO_DB_URL", "TURSO_AUTH_TOKEN"]) delete process.env[k];
process.env.CRON_SECRET = "cron-secret-for-tests";
process.env.CRON_ATTEST_SECRET = "cron-attest-for-tests";
delete process.env.CRON_ALLOW_LOCAL;

const db = createClient({ url: `file:${dbFile}` });
const NOW = Date.parse("2026-10-28T12:00:30.000Z");
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

let passed = 0;
let failed = 0;
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${name}\n        ${String((error as Error).stack || error).split("\n").slice(0, 6).join("\n        ")}`);
  }
}

async function main(): Promise<void> {
  await db.executeMultiple(readFileSync(join(process.cwd(), "database/turso/bravo__249_cron_runs.sql"), "utf8"));
  const route = await import("../app/api/cron/runs/route");
  const runs = await import("../lib/automations/cron-runs");
  const cards = await import("../components/automations/CronFlowCards");
  const post = async (body: unknown, headers: Record<string, string>) => {
    const res = await route.POST(new NextRequest("https://app.test/api/cron/runs", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));
    return { status: res.status, json: (await res.json()) as { ok?: boolean; recorded?: number; error?: string } };
  };
  const both = { authorization: "Bearer cron-secret-for-tests", "x-oasis-cron-attest": "cron-attest-for-tests" };
  const count = async () => Number((await db.execute("SELECT count(*) AS n FROM cron_runs")).rows[0].n);
  const tick = (paths: string[], ok = true) => ({ tick: iso(NOW), results: paths.map((path) => ({ path, ok, status: ok ? "200" : "500", attempts: ok ? 1 : 2, ms: 340 })) });

  await check("POST: no bearer, or a bearer without the Worker's attest, is a 401 and writes nothing", async () => {
    assert.equal((await post(tick(["/api/cron/health-check"]), {})).status, 401);
    assert.equal((await post(tick(["/api/cron/health-check"]), { authorization: "Bearer cron-secret-for-tests" })).status, 401);
    assert.equal(await count(), 0);
  });

  await check("POST: only the Worker's own routes, at most 60, well-formed; else a 400 with nothing written", async () => {
    for (const body of [
      tick(["/api/cron/not-a-schedule"]),
      { tick: "yesterday", results: [] },
      { tick: iso(NOW), results: Array.from({ length: 61 }, () => ({ path: "/api/cron/health-check", ok: true })) },
      { tick: iso(NOW), results: [{ path: "/api/cron/health-check", ok: "yes" }] },
    ]) {
      const res = await post(body, both);
      assert.equal(res.status, 400, JSON.stringify(body).slice(0, 80));
    }
    assert.equal(await count(), 0);
  });

  await check("POST: a tick is stored, and rows older than 14 days are pruned", async () => {
    await db.execute({ sql: "INSERT INTO cron_runs (route, tick_at, ok) VALUES ('/api/cron/health-check', ?, 1)", args: [iso(Date.now() - 15 * 24 * 60 * MIN)] });
    const res = await post({ ...tick(["/api/cron/health-check", "/api/cron/ai-audit-tick"]), tick: iso(Date.now() - MIN) }, both);
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(res.json.recorded, 2);
    assert.equal(await count(), 2, "the 15-day-old row is gone");
    const row = (await db.execute("SELECT * FROM cron_runs WHERE route = '/api/cron/ai-audit-tick'")).rows[0];
    assert.deepEqual([Number(row.ok), row.http_status, Number(row.attempts), Number(row.duration_ms)], [1, "200", 1, 340]);
  });

  await check("flow cards: the last run and 24 hours per route; 'not measured yet' where nothing ran", async () => {
    await db.execute("DELETE FROM cron_runs");
    for (const [at, ok] of [[NOW - 20 * MIN, 1], [NOW - 15 * MIN, 0], [NOW - 30 * 60 * MIN, 1]] as const) {
      await db.execute({ sql: "INSERT INTO cron_runs (route, tick_at, ok, http_status, duration_ms) VALUES ('/api/cron/health-check', ?, ?, ?, 120)", args: [iso(at), ok, ok ? "200" : "500"] });
    }
    const flows = (await runs.loadCronFlows(db, NOW))!;
    const health = flows.find((f) => f.path === "/api/cron/health-check")!;
    assert.deepEqual(health.last, { ok: false, status: "500", ms: 120, at: iso(NOW - 15 * MIN) }, "the newest run");
    assert.deepEqual(health.day, { ok: 1, total: 2 }, "the 30-hour-old run is outside 24 h");
    assert.equal(health.words, "every 15 minutes");
    assert.equal(health.nextAt, "2026-10-28T12:15:00.000Z");
    const audit = flows.find((f) => f.path === "/api/cron/ai-audit-tick")!;
    assert.equal(audit.last, null);
    assert.deepEqual(cards.lastRunLine(audit, NOW), { tone: "none", text: "Not measured yet" });
    assert.equal(cards.lastRunLine(health, NOW).tone, "failed");
    assert.match(cards.lastRunLine(health, NOW).text, /^Failed \(500\) · 120 ms · /);
  });

  await check("flow cards: words, names, and a failed read is null", async () => {
    assert.equal(runs.scheduleInWords("* * * * *"), "every minute");
    assert.equal(runs.scheduleInWords("15 * * * *"), "hourly at :15");
    assert.equal(runs.scheduleInWords("47 21 * * *"), "daily at 21:47 UTC");
    assert.equal(runs.scheduleInWords("0 3 * * 1"), "cron 0 3 * * 1");
    assert.equal(cards.cronJobName("/api/cron/finance-books?job=fx-refresh"), "Finance books: FX refresh");
    assert.equal(cards.cronJobName("/api/cron/collect-cc-metrics?write=1"), "Collect CC metrics");
    assert.equal(cards.cronJobName("/api/cron/sla-check"), "SLA check");
    assert.equal(cards.cronJobName("/api/cron/ai-audit-tick"), "AI audit tick");
    const broken = createClient({ url: `file:${join(mkdtempSync(join(tmpdir(), "cron-runs-none-")), "x.db")}` });
    const original = console.error;
    console.error = () => undefined;
    try {
      assert.equal(await runs.loadCronFlows(broken, NOW), null, "no table: a failed read, never zeros");
    } finally {
      console.error = original;
    }
  });

  await check("the Worker times each forward and reports the tick after logging it", () => {
    const src = readFileSync(join(process.cwd(), "workers/oasis-cc-cron/src/index.ts"), "utf8");
    assert.match(src, /return \{ path, status: first\.status, ok: first\.ok, attempts: 1, ms: Date\.now\(\) - started \};/);
    assert.match(src, /await recordRuns\(env, origin, at\.toISOString\(\), results\);/);
    assert.match(src, /origin \+ "\/api\/cron\/runs"/);
  });

  console.log(`cron-runs-record: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
