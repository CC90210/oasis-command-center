/**
 * tests/cloud-job-switches.test.ts - on/off switches and plain names for the
 * scheduled cloud jobs (2026-10-31, CC: "I must be able to turn any cloud
 * automation on or off with a single click", "names filled with developer jargon").
 *
 * Pinned:
 *   1. every CRON_TABLE job has exactly one plain-English name and description,
 *      no jargon, and the audited no-live-use jobs are the ones marked;
 *   2. a request maps to its job (the four books jobs by ?job=, ?write=1 ignored);
 *   3. EVERY scheduled route checks its switch right after the cron auth, and the
 *      run recorder never does;
 *   4. bravo__251 applies for real; a switch round-trips; only 0/1 is stored;
 *   5. the gate: OFF answers 200 "paused" and stops; ON or never-switched runs;
 *      an unscheduled route is never gated; a failed read runs (logged);
 *   6. the toggle: 401/404 for anyone but CC, 403 cross-site, 400 for an unknown
 *      job or a non-boolean, 503 on a failed write (no audit), and a good flip
 *      writes the switch and one audit row.
 *
 * Run: node --conditions=react-server --import tsx tests/cloud-job-switches.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, type Client } from "@libsql/client";

const dbFile = join(mkdtempSync(join(tmpdir(), "cloud-job-switches-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
for (const k of ["TURSO_DATABASE_URL", "TURSO_DB_URL", "TURSO_AUTH_TOKEN"]) delete process.env[k];

const db = createClient({ url: `file:${dbFile}` });
const NOW = new Date("2026-10-31T07:00:00.000Z");
const CC = { ok: true as const, tenantId: "ef8d389e-3f15-43f2-ae00-3660f69a1452", userId: "auth-cc-0001" };

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

function quietly<T>(fn: () => Promise<T>): Promise<{ value: T; logged: string[] }> {
  const original = console.error;
  const logged: string[] = [];
  console.error = (...args: unknown[]) => void logged.push(args.map(String).join(" "));
  return fn()
    .then((value) => ({ value, logged }))
    .finally(() => {
      console.error = original;
    });
}

async function main(): Promise<void> {
  const { CRON_TABLE } = await import("../workers/oasis-cc-cron/src/index");
  const jobs = await import("../lib/automations/cloud-jobs");
  const switches = await import("../lib/automations/cron-switches");
  const toggle = await import("../lib/automations/cloud-job-switch");
  await db.executeMultiple(readFileSync(join(process.cwd(), "database/turso", "bravo__251_cron_job_switches.sql"), "utf8"));

  await check("names: exactly one plain-English entry per scheduled job", () => {
    assert.deepEqual(Object.keys(jobs.CLOUD_JOBS).sort(), CRON_TABLE.map((e) => e.path).sort());
    const names = Object.values(jobs.CLOUD_JOBS).map((j) => j.name);
    assert.equal(new Set(names).size, names.length, "names are unique");
    for (const [path, job] of Object.entries(jobs.CLOUD_JOBS)) {
      assert.ok(job.name.length >= 8 && job.name.length <= 40, `${path}: name length`);
      assert.doesNotMatch(job.name, /\/|\bapi\b|cron|dispatch|materialize|relay|\btick\b/i, `${path}: no route jargon in "${job.name}"`);
      assert.doesNotMatch(job.name, /\b[a-z]+-[a-z]+\b/, `${path}: no lowercase route slug in "${job.name}"`);
      assert.match(job.description, /^[A-Z].{20,220}\.$/, `${path}: one plain sentence`);
      assert.doesNotMatch(job.description, /\/api\//, `${path}: no route in the description`);
    }
  });

  await check("names: the audited no-live-use jobs are marked, and only they are", () => {
    assert.deepEqual(
      Object.entries(jobs.CLOUD_JOBS).filter(([, j]) => j.noLiveUse).map(([path]) => path).sort(),
      [
        "/api/cron/collect-cc-metrics?write=1",
        "/api/cron/dispatch-scheduled-calls",
        "/api/cron/dispatch-scheduled-sends",
        "/api/cron/operator-email-agent?write=1",
        "/api/cron/reconcile-sms",
      ],
    );
    // "CC" in collect-cc-metrics is Constant Contact, never revenue.
    assert.match(jobs.CLOUD_JOBS["/api/cron/collect-cc-metrics?write=1"].name, /Constant Contact/);
    // The tag CC approved (2026-10-31), word for word, on the card.
    const card = readFileSync(join(process.cwd(), "components/automations/CronFlowCards.tsx"), "utf8");
    assert.ok(card.includes("No live use · Safe to pause"), "the approved tag is on the card");
  });

  await check("mapping: a request finds its job; ?job= picks the books job; ?write=1 is ignored", () => {
    const key = (u: string) => jobs.cronTableKeyFor(new URL(u, "https://oasisai.work"));
    assert.equal(key("/api/cron/finance-books?job=wise-sync"), "/api/cron/finance-books?job=wise-sync");
    assert.equal(key("/api/cron/finance-books?job=fx-refresh"), "/api/cron/finance-books?job=fx-refresh");
    assert.equal(key("/api/cron/finance-books"), null, "a books call without a job is no single job");
    assert.equal(key("/api/cron/finance-books?job=bogus"), null);
    assert.equal(key("/api/cron/collect-cc-metrics"), "/api/cron/collect-cc-metrics?write=1", "a manual dry run is the same job");
    assert.equal(key("/api/cron/collect-cc-metrics?write=1"), "/api/cron/collect-cc-metrics?write=1");
    assert.equal(key("/api/cron/sla-check?job=anything"), "/api/cron/sla-check");
    assert.equal(key("/api/cron/runs"), null, "the run recorder is not a job");
    assert.equal(key("/api/cron/snapshot-mrr"), null, "an unscheduled route is not a job");
  });

  await check("wiring: every scheduled route checks its switch right after the cron auth", () => {
    const routes = [...new Set(CRON_TABLE.map((e) => new URL(e.path, "https://x").pathname))];
    assert.equal(routes.length, 22);
    for (const route of routes) {
      const src = readFileSync(join(process.cwd(), "app", ...route.split("/").filter(Boolean), "route.ts"), "utf8");
      assert.ok(src.includes('import { cronPauseGate } from "@/lib/automations/cron-switches";'), `${route}: imports the gate`);
      assert.match(
        src,
        /const (denied|authError) = checkCronAuth\(req\);\r?\n\s*if \((denied|authError)\) return (denied|authError);\r?\n\s*const paused = await cronPauseGate\(req\);\r?\n\s*if \(paused\) return paused;/,
        `${route}: the gate runs before any work`,
      );
    }
    const runs = readFileSync(join(process.cwd(), "app/api/cron/runs/route.ts"), "utf8");
    assert.ok(!runs.includes("cronPauseGate"), "the run recorder must never be paused");
  });

  await check("store: a switch round-trips, a re-flip updates it, and only 0/1 is accepted", async () => {
    assert.equal(await switches.readCronSwitch(db, "/api/cron/sla-check"), null, "never switched = ON");
    await switches.writeCronSwitch(db, { route: "/api/cron/sla-check", enabled: false, actorUserId: CC.userId, now: NOW });
    assert.deepEqual(await switches.readCronSwitch(db, "/api/cron/sla-check"), {
      enabled: false,
      changedAt: NOW.toISOString(),
      changedBy: CC.userId,
    });
    await switches.writeCronSwitch(db, { route: "/api/cron/sla-check", enabled: true, actorUserId: CC.userId, now: NOW });
    assert.equal((await switches.readCronSwitches(db)).get("/api/cron/sla-check")?.enabled, true);

    // Only real flips are stored, so every changed_at is the moment a switch really changed.
    const later = new Date(NOW.getTime() + 60_000);
    assert.deepEqual(
      await switches.writeCronSwitch(db, { route: "/api/cron/connection-health", enabled: true, actorUserId: CC.userId, now: NOW }),
      { enabled: true, changedAt: null },
      "switching ON a never-switched job changes nothing",
    );
    assert.equal(await switches.readCronSwitch(db, "/api/cron/connection-health"), null, "and writes no row");
    await switches.writeCronSwitch(db, { route: "/api/cron/connection-health", enabled: false, actorUserId: CC.userId, now: NOW });
    assert.deepEqual(
      await switches.writeCronSwitch(db, { route: "/api/cron/connection-health", enabled: false, actorUserId: "someone-else", now: later }),
      { enabled: false, changedAt: NOW.toISOString() },
      "saving the state it is already in keeps the real flip time",
    );
    assert.equal((await switches.readCronSwitch(db, "/api/cron/connection-health"))?.changedBy, CC.userId);
    await db.execute("DELETE FROM cron_job_switches WHERE route = '/api/cron/connection-health'");
    await assert.rejects(
      switches.writeCronSwitch(db, { route: "/api/cron/not-a-job", enabled: false, actorUserId: CC.userId, now: NOW }),
      /cron_switch_unknown_route/,
    );
    await assert.rejects(
      db.execute("INSERT INTO cron_job_switches (route, enabled, changed_at) VALUES ('x', 2, 'now')"),
      /CHECK/i,
    );
  });

  await check("gate: OFF answers 200 paused and stops; ON and never-switched run", async () => {
    const gate = (u: string, gdb: Client = db) => switches.cronPauseGate(new Request(`https://oasisai.work${u}`), { db: () => gdb });
    await switches.writeCronSwitch(db, { route: "/api/cron/finance-books?job=wise-sync", enabled: false, actorUserId: CC.userId, now: NOW });
    const paused = await gate("/api/cron/finance-books?job=wise-sync");
    assert.ok(paused, "a paused job is stopped");
    assert.equal(paused.status, 200, "a skip is not a failure");
    assert.equal(paused.headers.get("x-oasis-cron-skipped"), "paused");
    assert.deepEqual(await paused.json(), {
      ok: true,
      skipped: "paused",
      route: "/api/cron/finance-books?job=wise-sync",
      paused_at: NOW.toISOString(),
    });
    assert.equal(await gate("/api/cron/finance-books?job=wise-reconcile"), null, "a sibling books job still runs");
    assert.equal(await gate("/api/cron/sla-check"), null, "switched back ON runs");
    assert.equal(await gate("/api/cron/health-check"), null, "never switched runs");
  });

  await check("gate: an unscheduled route is never gated; a failed read runs and is logged", async () => {
    let touched = false;
    const spy = { execute: async () => { touched = true; throw new Error("unused"); } } as unknown as Client;
    assert.equal(await switches.cronPauseGate(new Request("https://oasisai.work/api/cron/runs"), { db: () => spy }), null);
    assert.equal(touched, false, "no read for a route that is not a job");
    const broken = { execute: async () => { throw new Error("hrana: stream closed"); } } as unknown as Client;
    const { value, logged } = await quietly(() =>
      switches.cronPauseGate(new Request("https://oasisai.work/api/cron/meet-relay"), { db: () => broken }),
    );
    assert.equal(value, null, "fail open: the job's default is ON");
    assert.ok(logged.some((line) => line.includes("[cron.pause_gate]")), "the failure is logged");
  });

  await check("gate: a database without bravo__251 has no switches: every job runs, quietly", async () => {
    const bare = createClient({ url: `file:${join(mkdtempSync(join(tmpdir(), "cloud-job-bare-")), "x.db")}` });
    assert.equal((await switches.readCronSwitches(bare)).size, 0);
    const { value, logged } = await quietly(() =>
      switches.cronPauseGate(new Request("https://oasisai.work/api/cron/health-check"), { db: () => bare }),
    );
    assert.equal(value, null);
    assert.deepEqual(logged, [], "a missing table is 'never switched', not an incident");
  });

  const post = (body: unknown, headers: Record<string, string> = { origin: "https://oasisai.work", host: "oasisai.work" }) =>
    new Request("https://oasisai.work/api/automations/cloud-jobs", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

  await check("toggle: anyone but CC is told nothing; cross-site is refused; bad input changes nothing", async () => {
    const audits: unknown[] = [];
    const deps = (authorize: () => Promise<Awaited<ReturnType<typeof import("../lib/automations/cloud-job-control").authorizeCloudJobControl>>>) => ({
      authorize,
      db: () => db,
      audit: async (row: unknown) => (audits.push(row), { ok: true as const }),
      now: () => NOW,
    });
    const job = { route: "/api/cron/meet-relay", enabled: false };
    const signedOut = await toggle.handleCloudJobSwitch(post(job), deps(async () => ({ ok: false, status: 401, error: "unauthorized" })));
    assert.equal(signedOut.status, 401);
    const notCc = await toggle.handleCloudJobSwitch(post(job), deps(async () => ({ ok: false, status: 404, error: "not_found" })));
    assert.equal(notCc.status, 404);
    const crossSite = await toggle.handleCloudJobSwitch(post(job, { origin: "https://evil.example", host: "oasisai.work" }), deps(async () => CC));
    assert.equal(crossSite.status, 403);
    const noOrigin = await toggle.handleCloudJobSwitch(post(job, { host: "oasisai.work" }), deps(async () => CC));
    assert.equal(noOrigin.status, 403, "missing Origin and Referer fail closed");
    for (const body of [{ route: "/api/cron/runs", enabled: false }, { route: "/api/cron/meet-relay", enabled: "off" }, "{not json"]) {
      const res = await toggle.handleCloudJobSwitch(post(body), deps(async () => CC));
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    assert.equal(await switches.readCronSwitch(db, "/api/cron/meet-relay"), null, "nothing was written");
    assert.equal(audits.length, 0, "nothing was audited");
  });

  await check("toggle: CC's flip writes the switch and one audit row; a failed write changes nothing", async () => {
    const audits: Array<Record<string, unknown>> = [];
    const audit = async (row: Record<string, unknown>) => (audits.push(row), { ok: true as const });
    const res = await toggle.handleCloudJobSwitch(post({ route: "/api/cron/meet-relay", enabled: false }), {
      authorize: async () => CC,
      db: () => db,
      audit: audit as never,
      now: () => NOW,
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, route: "/api/cron/meet-relay", enabled: false, changed_at: NOW.toISOString() });
    assert.equal((await switches.readCronSwitch(db, "/api/cron/meet-relay"))?.enabled, false);
    assert.equal(audits.length, 1);
    assert.deepEqual(
      { ...audits[0] },
      {
        tenantId: CC.tenantId,
        actorUserId: CC.userId,
        actionType: "cloud_job_switch",
        targetTable: "cron_job_switches",
        targetId: "/api/cron/meet-relay",
        after: { enabled: false, job: "Meeting Room Cleanup" },
      },
    );
    const broken = { execute: async () => { throw new Error("write refused"); } } as unknown as Client;
    const { value: failedWrite } = await quietly(() =>
      toggle.handleCloudJobSwitch(post({ route: "/api/cron/meet-relay", enabled: true }), {
        authorize: async () => CC,
        db: () => broken,
        audit: audit as never,
        now: () => NOW,
      }),
    );
    assert.equal(failedWrite.status, 503);
    assert.equal(audits.length, 1, "a failed write is not audited as a change");
  });

  await check("route: the toggle route only delegates (no logic hides in the route file)", () => {
    const src = readFileSync(join(process.cwd(), "app/api/automations/cloud-jobs/route.ts"), "utf8");
    assert.match(src, /export async function POST\(req: Request\): Promise<NextResponse> \{\r?\n\s*return handleCloudJobSwitch\(req\);\r?\n\}/);
  });

  console.log(`cloud-job-switches: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
