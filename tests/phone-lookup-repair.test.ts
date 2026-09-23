/**
 * Regression coverage for SMS verification holds with no lookup job.
 *
 * The repair may enqueue bounded phone-lookup work only. It must never text a
 * lead, mutate a lead/drip row, or quietly join the scheduled Live-Sub sweep.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { evaluate } from "../lib/health/checks-core";
import { DRIP_CHECKS } from "../lib/health/drip-checks";
import {
  SMS_VERIFICATION_HOLD_PATTERN,
  buildVerificationRepairJob,
  findOrphanedVerificationLeadIds,
} from "../lib/drips/phone-lookup-repair";

type Trace = { table: string; method: string; args: unknown[] };

function fakeDb(args: {
  held?: Array<{ id: string; lead_id: string }>;
  jobs?: Array<{ lead_id: string }>;
  holdError?: unknown;
  jobError?: unknown;
}) {
  const traces: Trace[] = [];
  const db = {
    from(table: string) {
      const result = table === "drip_runs"
        ? { data: args.held || [], error: args.holdError || null }
        : { data: args.jobs || [], error: args.jobError || null };
      const query: Record<string, unknown> = {};
      for (const method of ["select", "eq", "like", "order", "range", "in"] as const) {
        query[method] = (...methodArgs: unknown[]) => {
          traces.push({ table, method, args: methodArgs });
          return query;
        };
      }
      query.then = (
        resolve: (value: unknown) => unknown,
        reject: (reason: unknown) => unknown,
      ) => Promise.resolve(result).then(resolve, reject);
      return query;
    },
  };
  return { db, traces };
}

async function main() {
  // Two rows for lead-a are one held LEAD. lead-b already has a job; lead-c is
  // the second orphan. The diagnostic must be distinct and history-aware.
  const fixture = fakeDb({
    held: [
      { id: "run-1", lead_id: "lead-a" },
      { id: "run-2", lead_id: "lead-a" },
      { id: "run-3", lead_id: "lead-b" },
      { id: "run-4", lead_id: "lead-c" },
    ],
    jobs: [{ lead_id: "lead-b" }],
  });
  const scan = await findOrphanedVerificationLeadIds(
    fixture.db as never,
    "tenant-under-test",
  );
  assert.deepEqual(scan, {
    ok: true,
    heldLeadCount: 3,
    orphanLeadIds: ["lead-a", "lead-c"],
  });
  for (const table of ["drip_runs", "phone_lookup_jobs"]) {
    assert.ok(
      fixture.traces.some((trace) =>
        trace.table === table && trace.method === "eq" &&
        trace.args[0] === "tenant_id" && trace.args[1] === "tenant-under-test"),
      `${table} scan lost its tenant boundary`,
    );
  }
  assert.ok(
    fixture.traces.some((trace) =>
      trace.table === "drip_runs" && trace.method === "like" &&
      trace.args[0] === "last_error" && trace.args[1] === SMS_VERIFICATION_HOLD_PATTERN),
    "the diagnostic is not scoped to verification holds",
  );

  const broken = fakeDb({ holdError: new Error("database unavailable") });
  assert.deepEqual(
    await findOrphanedVerificationLeadIds(broken.db as never, "tenant-under-test"),
    { ok: false, error: "hold_scan_failed" },
    "an unreadable hold table must fail closed, never report zero",
  );

  const brokenHistory = fakeDb({
    held: [{ id: "run-1", lead_id: "lead-a" }],
    jobError: new Error("job history unavailable"),
  });
  assert.deepEqual(
    await findOrphanedVerificationLeadIds(brokenHistory.db as never, "tenant-under-test"),
    { ok: false, error: "job_scan_failed" },
    "an unreadable lookup history must fail closed, never spend a duplicate scrape",
  );

  // A stored office phone is NOT a reason to skip this repair: these rows are
  // held precisely because no verified mobile/candidate exists yet.
  const lead = Object.freeze({
    owner_full_name: "Rivera, Alex Q",
    owner_home_city: "Miami",
    owner_home_state: "FL",
    owner_age: 42.4,
    phone: "305-555-0100",
  });
  const built = buildVerificationRepairJob("tenant-under-test", "lead-a", lead);
  assert.equal(built.ok, true);
  if (built.ok) {
    assert.deepEqual(built.job, {
      tenant_id: "tenant-under-test",
      lead_id: "lead-a",
      query_first_name: "Alex",
      query_last_name: "Rivera",
      query_city: "Miami",
      query_state: "FL",
      query_age: 42,
      trigger_source: "drip_verification_repair",
      requested_by_email: "auto:drip_verification_repair",
    });
  }
  assert.equal(
    buildVerificationRepairJob("tenant-under-test", "lead-z", { contact_name: "Prince" }).ok,
    false,
    "a one-part name must not spend a lookup on an unsearchable query",
  );

  // The new check closes the exact false-green: an empty job queue is not green
  // when active verification holds have no matching job.
  const check = DRIP_CHECKS.find((item) => item.id === "leads.phone_lookup_unenqueued");
  assert.ok(check, "the orphan enrollment diagnostic is not registered");
  const healthFixture = fakeDb({
    held: [
      { id: "run-1", lead_id: "lead-a" },
      { id: "run-2", lead_id: "lead-b" },
    ],
    jobs: [],
  });
  const observed = await check.observe(
    healthFixture.db as never,
    "tenant-under-test",
    Date.parse("2026-09-23T16:00:00Z"),
  );
  assert.equal(observed, 2);
  assert.equal(evaluate(check.id, check.rule, observed, []).verdict, "failing");

  const route = readFileSync("app/api/cron/tps-enroll/route.ts", "utf8");
  const repair = route.slice(
    route.indexOf("async function repairOrphanVerificationHolds"),
    route.indexOf("export async function GET"),
  );
  assert.ok(repair.length > 500, "the repair implementation disappeared");
  assert.match(route, /searchParams\.get\("repair-orphan-holds"\) === "1"/);
  assert.match(route, /searchParams\.get\("write"\) === "1"/);
  assert.match(route, /const MAX_REPAIR_BATCH = 25/);
  assert.match(repair, /db\.from\(JOBS_TABLE\)\.insert\(job\)/);
  assert.doesNotMatch(repair, /\.update\s*\(/, "repair must not mutate leads or drip rows");
  assert.doesNotMatch(repair, /sendDripSms|sendMessage|lead_interactions/,
    "repair must not contact a lead");

  // The every-10-minute production schedule remains the ordinary Live-Sub
  // enrollment URL. Repair requires an explicit authenticated invocation.
  const worker = readFileSync("workers/oasis-cc-cron/src/index.ts", "utf8");
  assert.ok(worker.includes('{ path: "/api/cron/tps-enroll?write=1", schedule: "*/10 * * * *" }'));
  assert.ok(!worker.includes("repair-orphan-holds"), "repair was accidentally auto-scheduled");

  console.log("phone-lookup-repair.test.ts — all assertions passed");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
