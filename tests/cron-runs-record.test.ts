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
  for (const file of ["bravo__249_cron_runs.sql", "bravo__250_cron_runs_unique_tick.sql", "bravo__251_cron_job_switches.sql"]) {
    await db.executeMultiple(readFileSync(join(process.cwd(), "database/turso", file), "utf8"));
  }
  const route = await import("../app/api/cron/runs/route");
  const runs = await import("../lib/automations/cron-runs");
  const cards = await import("../lib/automations/cloud-job-display");
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
    const tickAt = iso(Date.now() - MIN);
    const res = await post({ ...tick(["/api/cron/health-check", "/api/cron/ai-audit-tick"]), tick: tickAt }, both);
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(res.json.recorded, 2);
    assert.equal(await count(), 2, "the 15-day-old row is gone");
    const row = (await db.execute("SELECT * FROM cron_runs WHERE route = '/api/cron/ai-audit-tick'")).rows[0];
    assert.deepEqual([Number(row.ok), row.http_status, Number(row.attempts), Number(row.duration_ms)], [1, "200", 1, 340]);
    // A repeated report of the same tick (a double-fired invocation) adds nothing (bravo__250).
    const again = await post({ ...tick(["/api/cron/ai-audit-tick"], false), tick: tickAt }, both);
    assert.equal(again.status, 200);
    assert.equal(await count(), 2, "still one row per route per tick");
    assert.equal(Number((await db.execute("SELECT ok FROM cron_runs WHERE route = '/api/cron/ai-audit-tick'")).rows[0].ok), 1, "the first report is kept");
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

  await check("switches: a paused job's ticks are stored as 'paused' and are not runs", async () => {
    await db.execute("DELETE FROM cron_runs");
    const route = "/api/cron/meet-relay";
    await db.execute({ sql: "INSERT INTO cron_runs (route, tick_at, ok, http_status, duration_ms) VALUES (?, ?, 1, '200', 90)", args: [route, iso(NOW - 30 * MIN)] });
    await db.execute({
      sql: "INSERT INTO cron_job_switches (route, enabled, changed_at, changed_by) VALUES (?, 0, ?, 'auth-cc-0001')",
      args: [route, iso(NOW - 20 * MIN)],
    });
    const res = await post({ ...tick([route, "/api/cron/health-check"]), tick: iso(NOW - 10 * MIN) }, both);
    assert.equal(res.status, 200, JSON.stringify(res.json));
    const stored = (await db.execute({ sql: "SELECT http_status FROM cron_runs WHERE route = ? AND tick_at = ?", args: [route, iso(NOW - 10 * MIN)] })).rows[0];
    assert.equal(stored.http_status, runs.PAUSED_RUN_STATUS, "a 200 from a paused job is a skip, not a run");
    const other = (await db.execute({ sql: "SELECT http_status FROM cron_runs WHERE route = '/api/cron/health-check'", args: [] })).rows[0];
    assert.equal(other.http_status, "200", "a running job's tick is untouched");

    const flows = (await runs.loadCronFlows(db, NOW))!;
    const meet = flows.find((f) => f.path === route)!;
    assert.equal(meet.enabled, false);
    assert.equal(meet.pausedAt, iso(NOW - 20 * MIN));
    assert.deepEqual(meet.last, { ok: true, status: "200", ms: 90, at: iso(NOW - 30 * MIN) }, "the last REAL run");
    assert.deepEqual(meet.day, { ok: 1, total: 1 }, "skipped ticks are not counted as OK runs");
    const health = flows.find((f) => f.path === "/api/cron/health-check")!;
    assert.equal(health.enabled, true, "never switched = ON");
    assert.equal(health.pausedAt, null);

    assert.equal(cards.cloudJobName(route), "Meeting Room Cleanup");
    assert.equal(cards.cloudJobName("/api/cron/not-a-known-job"), "Not a known job", "an unknown path falls back to its words");
    const subtitle = cards.cloudJobsSubtitle(flows, true, NOW);
    assert.match(subtitle, /^25 scheduled jobs run on Cloudflare whether or not your computer is on\./);
    assert.match(subtitle, /1 paused\./);
    assert.match(subtitle, /Switch any job off or on here\.$/);
    assert.doesNotMatch(cards.cloudJobsSubtitle(flows, false, NOW), /Switch any job/, "no switch offered to a viewer who cannot use it");
    assert.equal(cards.cloudRunFreshness(meet, NOW), "paused", "an old paused run is not overdue");
    await db.execute("DELETE FROM cron_job_switches");
  });

  await check("switches: a flip while a tick is in flight is read as the route saw it at the tick", async () => {
    await db.execute("DELETE FROM cron_runs");
    const tickAt = iso(NOW - 5 * MIN);
    const stored = async (route: string) =>
      (await db.execute({ sql: "SELECT http_status FROM cron_runs WHERE route = ? AND tick_at = ?", args: [route, tickAt] })).rows[0]?.http_status;
    // Paused 20 s after the tick began: the route had already passed its gate and ran.
    await db.execute({
      sql: "INSERT INTO cron_job_switches (route, enabled, changed_at, changed_by) VALUES ('/api/cron/meet-relay', 0, ?, 'auth-cc-0001')",
      args: [iso(NOW - 5 * MIN + 20_000)],
    });
    // Switched back ON 20 s after the tick began: the route saw it OFF and skipped.
    await db.execute({
      sql: "INSERT INTO cron_job_switches (route, enabled, changed_at, changed_by) VALUES ('/api/cron/sla-check', 1, ?, 'auth-cc-0001')",
      args: [iso(NOW - 5 * MIN + 20_000)],
    });
    // Paused before the tick: skipped.
    await db.execute({
      sql: "INSERT INTO cron_job_switches (route, enabled, changed_at, changed_by) VALUES ('/api/cron/health-check', 0, ?, 'auth-cc-0001')",
      args: [iso(NOW - 9 * MIN)],
    });
    const res = await post({ ...tick(["/api/cron/meet-relay", "/api/cron/sla-check", "/api/cron/health-check"]), tick: tickAt }, both);
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(await stored("/api/cron/meet-relay"), "200", "a run that happened just before the pause is a run");
    assert.equal(await stored("/api/cron/sla-check"), runs.PAUSED_RUN_STATUS, "a skip is never shown as a run that worked");
    assert.equal(await stored("/api/cron/health-check"), runs.PAUSED_RUN_STATUS);
    await db.execute("DELETE FROM cron_job_switches");
    await db.execute("DELETE FROM cron_runs");
  });

  await check("freshness: missing reports turn old successes amber only after the schedule and retry budget", async () => {
    const baseline = (await runs.loadCronFlows(db, NOW))!.find((f) => f.path === "/api/cron/health-check")!;
    const lastAt = Date.parse("2026-10-28T12:00:00Z");
    const ordinary = { ...baseline, schedule: "* * * * *", enabled: true, resumedAt: null, last: { ok: true, status: "200", ms: 200, at: iso(lastAt) } };
    assert.equal(cards.lastRunLine(ordinary, lastAt + 6 * MIN).tone, "ok", "one minute until due plus five for two attempts/reporting");
    assert.equal(cards.lastRunLine(ordinary, lastAt + 6 * MIN + 1).tone, "overdue");
    assert.match(cards.lastRunLine(ordinary, lastAt + 7 * MIN).text, /^Overdue.*last OK report/);
    const long = { ...ordinary, path: "/api/cron/dispatch-automations" };
    assert.equal(cards.lastRunLine(long, lastAt + 31 * MIN).tone, "ok", "long dispatcher gets its full two-attempt budget");
    assert.equal(cards.lastRunLine(long, lastAt + 31 * MIN + 1).tone, "overdue");
    const failedRun = { ...ordinary, last: { ...ordinary.last, ok: false, status: "503" } };
    assert.equal(cards.lastRunLine(failedRun, lastAt + MIN).tone, "failed");
    assert.match(cards.lastRunLine(failedRun, lastAt + 7 * MIN).text, /last failed \(503\) report/);
    assert.match(cards.cloudJobsSubtitle([ordinary, { ...ordinary, enabled: false }], false, lastAt + 7 * MIN), /1 overdue for a run report/);
    for (const bad of ["not-a-time", iso(lastAt + 60 * MIN)]) {
      assert.equal(cards.lastRunLine({ ...ordinary, last: { ...ordinary.last, at: bad } }, lastAt).tone, "none", "invalid/future timestamps cannot give green assurance");
    }
    assert.equal(cards.cloudRunFreshness({ ...ordinary, enabled: null }, lastAt), "unknown");
    assert.equal(cards.cloudRunFreshness({ ...ordinary, schedule: "invalid" }, lastAt), "unknown");
    assert.equal(cards.cloudRunFreshness({ ...ordinary, last: null }, lastAt), "unmeasured");
  });

  await check("freshness: resume time comes from the stored switch, and calendar gaps are not missed runs", async () => {
    const path = "/api/cron/meet-relay";
    await db.execute({ sql: "INSERT INTO cron_job_switches (route, enabled, changed_at, changed_by) VALUES (?, 1, ?, 'auth-cc-0001')", args: [path, iso(NOW)] });
    const resumed = (await runs.loadCronFlows(db, NOW))!.find((f) => f.path === path)!;
    assert.equal(resumed.resumedAt, iso(NOW));
    assert.equal(cards.cloudRunFreshness(resumed, NOW), "fresh", "a newly enabled job gets a chance to run");
    assert.equal(cards.lastRunLine({ ...resumed, last: null }, NOW).text, "Not measured yet");
    assert.equal(cards.cloudRunFreshness({ ...resumed, schedule: "* * * * *", last: null }, NOW + 7 * MIN), "overdue", "known enable time allows detecting a first run that never reported");
    const weekday = { ...resumed, resumedAt: null, schedule: "0 9 * * 1-5", timeZone: "America/Toronto", last: { ok: true, status: "200", ms: 100, at: "2026-10-30T13:00:00Z" } };
    assert.equal(cards.cloudRunFreshness(weekday, Date.parse("2026-11-01T16:00:00Z")), "fresh", "weekend and fall DST transition are legitimate gaps");
    assert.equal(cards.cloudRunFreshness(weekday, Date.parse("2026-11-02T14:05:00Z")), "fresh");
    assert.equal(cards.cloudRunFreshness(weekday, Date.parse("2026-11-02T14:05:01Z")), "overdue", "Monday 09:00 is EST after DST, with five minutes to report");
    await db.execute("DELETE FROM cron_job_switches");
  });

  await check("next run: a fixed Toronto time shifts through the spring gap", () => {
    assert.equal(
      runs.nextRunAt("30 2 * * *", Date.parse("2026-03-08T05:00:00Z"), "America/Toronto"),
      "2026-03-08T07:30:00.000Z",
      "missing 02:30 shifts once to 03:30 EDT",
    );
  });

  await check("flow cards: words, names, and a failed read is null", async () => {
    assert.equal(runs.scheduleInWords("* * * * *"), "every minute");
    assert.equal(runs.scheduleInWords("15 * * * *"), "hourly at :15");
    assert.equal(runs.scheduleInWords("47 21 * * *"), "daily at 21:47 UTC");
    assert.equal(runs.scheduleInWords("0 9 * * *", "America/Toronto"), "daily at 09:00 Toronto time");
    assert.equal(runs.scheduleInWords("0 3 * * 1"), "cron 0 3 * * 1");
    assert.equal(
      runs.nextRunAt("0 9 * * MON-FRI", Date.parse("2026-10-30T14:00:00Z"), "America/Toronto"),
      "2026-11-02T14:00:00.000Z",
      "after Friday's run, the next weekday stays at 9 Toronto time across the Nov 1 fall-back",
    );
    assert.equal(runs.nextRunAt("0 9 * * FUNDAY", NOW, "America/Toronto"), null);
    assert.equal(runs.nextRunAt("0 9 * * MON", NOW, "America/Not_A_Zone"), null);
    assert.equal(
      runs.nextRunAt("30 1 * * *", Date.parse("2026-11-01T04:00:00Z"), "America/Toronto"),
      "2026-11-01T05:30:00.000Z",
      "fixed 01:30 chooses the first fall-back occurrence",
    );
    assert.equal(
      runs.nextRunAt("30 1 * * *", Date.parse("2026-11-01T05:31:00Z"), "America/Toronto"),
      "2026-11-02T06:30:00.000Z",
      "the repeated fall-back hour is not a second fixed run",
    );
    assert.equal(
      runs.nextRunAt("30 2 * * *", Date.parse("2026-03-08T05:00:00Z"), "America/Toronto"),
      "2026-03-08T07:30:00.000Z",
      "missing 02:30 shifts once to 03:30 EDT",
    );
    assert.equal(
      runs.nextRunAt("0 * * * *", Date.parse("2026-11-01T05:01:00Z"), "America/Toronto"),
      "2026-11-01T06:00:00.000Z",
      "every-hour keeps the second elapsed 01:00 during fall-back",
    );
    assert.equal(
      runs.nextRunAt("0 * * * *", Date.parse("2026-03-08T06:01:00Z"), "America/Toronto"),
      "2026-03-08T07:00:00.000Z",
      "every-hour advances one real hour from 01:00 EST to 03:00 EDT",
    );
    assert.equal(
      cards.nextRunText({ nextAt: "2026-11-02T14:00:00.000Z", timeZone: "America/Toronto" }),
      "next 09:00 EST",
    );
    assert.equal(
      cards.nextRunText({ nextAt: "2026-11-01T05:30:00.000Z", timeZone: "America/Toronto" }),
      "next 01:30 EDT",
    );
    assert.equal(
      cards.nextRunText({ nextAt: "2026-03-08T07:30:00.000Z", timeZone: "America/Toronto" }),
      "next 03:30 EDT",
    );
    assert.equal(cards.nextRunText({ nextAt: "2026-10-28T12:15:00.000Z", timeZone: "UTC" }), "next 12:15 UTC");
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
    // Codex review of #772: a stalled long dispatcher never holds back the quick routes' report.
    assert.match(src, /quick\.map\(\(e\) => forward\(env, origin, e\.path\)\)\)\.then\(report\)/);
    assert.match(src, /\.\.\.long\.map\(\(e\) => forward\(env, origin, e\.path\)\.then\(\(r\) => report\(\[r\]\)\)\)/);
    assert.match(src, /origin \+ "\/api\/cron\/runs"/);
  });

  console.log(`cron-runs-record: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
