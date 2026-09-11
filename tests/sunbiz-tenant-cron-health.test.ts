/**
 * tests/sunbiz-tenant-cron-health.test.ts — SunBiz's scheduled jobs are watched
 * from outside the machine that runs them.
 *
 * From 2026-08-25 18:38 to 2026-09-11 17:41 UTC none of SunBiz's six enabled
 * tenant_cron_jobs ran and nothing alerted: the VPS bridge that runs them had
 * lost its SunBiz pairing, SunBiz's own Health Check was one of the dead jobs,
 * and CC's harness excludes SunBiz by design. These assertions replay that
 * outage against the new checks, using the schedules and timestamps read from
 * the live table on 2026-09-11.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  TENANT_CRON_CHECKS,
  cronGapMs,
  overdueAfterMs,
  countOverdueJobs,
  NO_PAIRING,
  type TenantCronRow,
} from "../lib/health/tenant-cron-checks";
import { evaluate } from "../lib/health/checks-core";
import {
  EXPECTED_EXECUTOR_BY_TENANT_PREFIX,
  expectedExecutorFor,
  isExpectedExecutor,
} from "../lib/automations/expected-executor";

const SUNBIZ = "aa04fa1f-ad6a-44b0-ac4b-2ff5d1067110";
const OASIS = "ef8d389e-3f15-43f2-ae00-3660f69a1452";
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const at = (iso: string) => Date.parse(iso);

// ── Schedule gaps: the longest legitimate silence ───────────────────────────
assert.equal(cronGapMs("* * * * *"), MIN);
assert.equal(cronGapMs("*/15 * * * *"), 15 * MIN);
assert.equal(cronGapMs("*/30 * * * *"), 30 * MIN);
assert.equal(cronGapMs("17 * * * *"), HOUR);
assert.equal(cronGapMs("0 */6 * * *"), 6 * HOUR);
assert.equal(cronGapMs("0 6,18 * * *"), 12 * HOUR);
assert.equal(cronGapMs("0 9 * * *"), DAY);
assert.equal(cronGapMs("30 6 * * *"), DAY);
assert.equal(cronGapMs("0 9 * * 1-5"), 3 * DAY, "a weekday job's longest gap is the weekend");
assert.equal(cronGapMs("40 13 * * 1"), 7 * DAY);
assert.ok((cronGapMs("0 0 1 * *") ?? 0) >= 28 * DAY, "a monthly job is judged in weeks, not days");
for (const bad of ["@daily", "61 * * * *", "* * *", "", "0 9 * * MON", "*/0 * * * *"]) {
  assert.equal(cronGapMs(bad), null, `"${bad}" is not a schedule this can read`);
}

// ── How late is late ─────────────────────────────────────────────────────────
assert.equal(overdueAfterMs(MIN), 20 * MIN, "every-minute jobs get a 20-minute floor");
assert.equal(overdueAfterMs(15 * MIN), 45 * MIN, "three missed fires");
assert.equal(overdueAfterMs(30 * MIN), 90 * MIN);
assert.equal(overdueAfterMs(HOUR), 3 * HOUR);
assert.equal(overdueAfterMs(DAY), 26 * HOUR, "a daily job is late after 26 hours, not three days");

// ── The live table, read 2026-09-11 22:31:43 UTC ─────────────────────────────
// The executor came back at 17:41 and the frequent jobs resumed; the three
// daily jobs had not reached their next fire time yet and last ran 2026-08-25.
const LIVE: TenantCronRow[] = [
  { name: "SunBiz Cold Outreach Runner", schedule: "*/15 * * * *", last_run_at: "2026-09-11T22:30:14.634Z", created_at: "2026-06-02T22:25:45.896697+00:00" },
  { name: "SunBiz Daily Plan Generator", schedule: "30 6 * * *", last_run_at: "2026-08-25T06:30:49.728Z", created_at: "2026-05-29T15:18:46.246299+00:00" },
  { name: "SunBiz Follow-up Generator", schedule: "0 6 * * *", last_run_at: "2026-08-25T06:01:55.916Z", created_at: "2026-05-29T15:18:42.835801+00:00" },
  { name: "SunBiz Health Check", schedule: "*/30 * * * *", last_run_at: "2026-09-11T22:30:25.418Z", created_at: "2026-06-09T03:27:58.011481+00:00" },
  { name: "SunBiz Renewal Reminder", schedule: "0 9 * * *", last_run_at: "2026-08-25T09:00:11.542Z", created_at: "2026-05-29T15:18:48.890219+00:00" },
  { name: "SunBiz Shop-Out Sender", schedule: "* * * * *", last_run_at: "2026-09-11T22:31:34.082Z", created_at: "2026-06-02T22:25:45.896697+00:00" },
];
assert.equal(countOverdueJobs(LIVE, at("2026-09-11T22:31:43.876Z")), 3, "the three daily jobs are still 17 days late");

// ── Replay of the outage: last runs as they stood when the executor died ────
const DEAD: TenantCronRow[] = LIVE.map((r) =>
  r.schedule === "* * * * *" ? { ...r, last_run_at: "2026-08-25T18:37:00Z" }
  : r.schedule!.startsWith("*/") ? { ...r, last_run_at: "2026-08-25T18:30:00Z" }
  : r,
);
assert.equal(countOverdueJobs(DEAD, at("2026-08-25T18:56:00Z")), 0, "19 minutes in: nothing is late yet");
assert.equal(countOverdueJobs(DEAD, at("2026-08-25T18:57:30Z")), 1, "the every-minute sender is late at 20 minutes");
assert.equal(countOverdueJobs(DEAD, at("2026-08-26T12:00:00Z")), 6, "by the next morning all six are late");
assert.equal(countOverdueJobs(DEAD, at("2026-09-11T17:00:00Z")), 6, "and stay late for the whole outage");

// ── Never ran, and odd timestamps ───────────────────────────────────────────
{
  const now = at("2026-09-11T22:31:43Z");
  const fresh = { schedule: "0 9 * * *", last_run_at: null, created_at: "2026-09-11T22:00:00Z" };
  const armedAndIgnored = { schedule: "*/15 * * * *", last_run_at: null, created_at: "2026-06-02T22:25:45.896697+00:00" };
  assert.equal(countOverdueJobs([fresh], now), 0, "a job created half an hour ago is not late");
  assert.equal(countOverdueJobs([armedAndIgnored], now), 1, "enabled and never run since June is caught");
  assert.equal(countOverdueJobs([{ schedule: "* * * * *", last_run_at: null, created_at: null }], now), 1,
    "no evidence of ever running counts as late, never as fine");
  // SQLite's zone-less form is UTC: 21:00 is 91 minutes before now, past 45.
  assert.equal(countOverdueJobs([{ schedule: "*/15 * * * *", last_run_at: "2026-09-11 21:00:00" }], now), 1);
  assert.equal(countOverdueJobs([{ schedule: "*/15 * * * *", last_run_at: "2026-09-11 22:20:00" }], now), 0);
  // An unreadable schedule is still expected daily.
  assert.equal(countOverdueJobs([{ schedule: "@daily", last_run_at: "2026-09-10T12:00:00Z" }], now), 1);
  assert.equal(countOverdueJobs([{ schedule: "@daily", last_run_at: "2026-09-11T12:00:00Z" }], now), 0);
}

// ── The executor map moved, unchanged ───────────────────────────────────────
assert.equal(expectedExecutorFor(SUNBIZ), "srv1723601 (Linux)");
assert.equal(expectedExecutorFor(OASIS), "CCPC (Windows)");
assert.equal(isExpectedExecutor(SUNBIZ, "srv1723601 (Linux)"), true);
assert.equal(isExpectedExecutor(SUNBIZ, "CCPC (Windows)"), false, "CC's PC must not run SunBiz's jobs");
assert.equal(isExpectedExecutor(OASIS, "srv1723601 (Linux)"), false, "the VPS must not run OASIS's jobs");
assert.equal(isExpectedExecutor("12345678-0000-0000-0000-000000000000", "anything"), true,
  "tenants with no declared executor keep the open behaviour");
assert.deepEqual(Object.keys(EXPECTED_EXECUTOR_BY_TENANT_PREFIX).sort(), ["aa04fa1f", "ef8d389e"]);
{
  const poll = readFileSync("app/api/cron-jobs/poll/route.ts", "utf8");
  assert.ok(/import \{ isExpectedExecutor \} from "@\/lib\/automations\/expected-executor";/.test(poll),
    "the poll gate and the health check must read one map");
  assert.ok(!/EXPECTED_EXECUTOR_BY_TENANT_PREFIX\s*[:=]/.test(poll), "no second copy of the map in the route");
  assert.equal((poll.match(/isExpectedExecutor\(bridge\.tenantId, bridge\.label\)/g) || []).length, 2,
    "both the GET and the POST gate still ask it");
}

// ── The checks, against a fake database ─────────────────────────────────────
type Op = [string, unknown[]];
function fakeDb(result: { data: unknown; error: unknown }, calls: Array<{ table: string; ops: Op[] }>) {
  return {
    from(table: string) {
      const call = { table, ops: [] as Op[] };
      calls.push(call);
      const chain: Record<string, unknown> = {};
      for (const op of ["select", "eq", "is", "order", "limit"]) {
        chain[op] = (...args: unknown[]) => {
          call.ops.push([op, args]);
          return chain;
        };
      }
      chain.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
        Promise.resolve(result).then(res, rej);
      return chain;
    },
  } as never;
}
const untouchable = {
  from() {
    throw new Error("must not query for a tenant that is not SunBiz");
  },
} as never;

const overdue = TENANT_CRON_CHECKS.find((c) => c.id === "sunbiz_jobs.overdue")!;
const executor = TENANT_CRON_CHECKS.find((c) => c.id === "sunbiz_jobs.executor_silent_min")!;
assert.ok(overdue && executor, "both checks are registered");
for (const c of TENANT_CRON_CHECKS) assert.equal(c.lane, "sunbiz-ops", `${c.id} pages SunBiz's lane, never CC's`);

{
  const runner = readFileSync("lib/health/runner.ts", "utf8");
  assert.ok(/\.\.\.TENANT_CRON_CHECKS/.test(runner), "TENANT_CRON_CHECKS must be in allChecks(), or it never runs");
  const suite = readFileSync("tests/_suite.mjs", "utf8");
  assert.ok(suite.includes('"tests/sunbiz-tenant-cron-health.test.ts"'), "this file must be in the suite");
}

// tsx compiles tests as CJS, so async assertions run in an IIFE that fails the
// process loudly — a rejected promise must never read as green.
(async () => {
  // Overdue jobs page, with the count.
  {
    const calls: Array<{ table: string; ops: Op[] }> = [];
    const observed = await overdue.observe(fakeDb({ data: LIVE, error: null }, calls), SUNBIZ, at("2026-09-11T22:31:43.876Z"));
    assert.equal(observed, 3);
    const r = evaluate(overdue.id, overdue.rule, observed, []);
    assert.equal(r.verdict, "failing");
    assert.match(overdue.describe(r), /3 of SunBiz's enabled scheduled jobs/);
    assert.equal(calls[0].table, "tenant_cron_jobs");
    assert.deepEqual(calls[0].ops.filter(([op]) => op === "eq"), [["eq", ["tenant_id", SUNBIZ]], ["eq", ["enabled", true]]],
      "reads only SunBiz's own enabled jobs");
  }
  // All on time is healthy.
  {
    const onTime = LIVE.filter((r) => r.schedule!.includes("*/") || r.schedule === "* * * * *");
    const observed = await overdue.observe(fakeDb({ data: onTime, error: null }, []), SUNBIZ, at("2026-09-11T22:31:43.876Z"));
    assert.equal(evaluate(overdue.id, overdue.rule, observed, []).verdict, "ok");
  }
  // A failed read is not a pass.
  {
    const observed = await overdue.observe(fakeDb({ data: null, error: { message: "boom" } }, []), SUNBIZ, Date.now());
    assert.equal(observed, null);
    const r = evaluate(overdue.id, overdue.rule, observed, []);
    assert.equal(r.verdict, "check_broken");
    assert.match(overdue.describe(r), /unknown/);
  }
  // Another company's workspace is never read and never pages SunBiz.
  assert.equal(await overdue.observe(untouchable, OASIS, Date.now()), 0);
  assert.equal(await executor.observe(untouchable, OASIS, Date.now()), 0);

  // The executor going quiet pages within 15 minutes.
  {
    const calls: Array<{ table: string; ops: Op[] }> = [];
    const quiet = fakeDb({ data: [{ last_seen_at: "2026-08-25T18:37:00Z" }], error: null }, calls);
    const observed = await executor.observe(quiet, SUNBIZ, at("2026-08-25T18:53:00Z"));
    assert.equal(observed, 16);
    const r = evaluate(executor.id, executor.rule, observed, []);
    assert.equal(r.verdict, "failing");
    assert.match(executor.describe(r), /last checked in 16 min ago/);
    assert.equal(calls[0].table, "bridge_pairings");
    const ops = calls[0].ops;
    assert.ok(ops.some(([op, a]) => op === "eq" && a[0] === "tenant_id" && a[1] === SUNBIZ));
    assert.ok(ops.some(([op, a]) => op === "eq" && a[0] === "label" && a[1] === "srv1723601 (Linux)"),
      "only the expected executor counts: an OASIS pairing on the same box is not SunBiz's");
    assert.ok(ops.some(([op, a]) => op === "is" && a[0] === "revoked_at" && a[1] === null), "revoked pairings do not count");
  }
  {
    const live = fakeDb({ data: [{ last_seen_at: "2026-09-11T22:31:29.399Z" }], error: null }, []);
    const observed = await executor.observe(live, SUNBIZ, at("2026-09-11T22:31:43.876Z"));
    assert.equal(evaluate(executor.id, executor.rule, observed, []).verdict, "ok");
  }
  // Two live rows: the freshest wins, whatever order they come back in.
  {
    const two = fakeDb({ data: [{ last_seen_at: null }, { last_seen_at: "2026-09-11T22:30:00Z" }, { last_seen_at: "2026-09-01T00:00:00Z" }], error: null }, []);
    assert.equal(await executor.observe(two, SUNBIZ, at("2026-09-11T22:31:43Z")), 1);
  }
  // No pairing at all is its own, louder message.
  {
    const observed = await executor.observe(fakeDb({ data: [], error: null }, []), SUNBIZ, Date.now());
    assert.equal(observed, NO_PAIRING);
    const r = evaluate(executor.id, executor.rule, observed, []);
    assert.equal(r.verdict, "failing");
    assert.match(executor.describe(r), /no active pairing/);
  }
  {
    const observed = await executor.observe(fakeDb({ data: null, error: { message: "boom" } }, []), SUNBIZ, Date.now());
    assert.equal(evaluate(executor.id, executor.rule, observed, []).verdict, "check_broken");
  }
})().then(
  () => console.log("sunbiz-tenant-cron-health.test.ts — all assertions passed ✓"),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
