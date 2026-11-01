/** Real cron handlers and scheduler; providers, databases and senders are fixtures. */
import assert from "node:assert/strict";
import { NextRequest, NextResponse } from "next/server";
process.env.CRON_SECRET = "outcomes-fixture";
process.env.CRON_ATTEST_SECRET = "outcomes-fixture-attest";
delete process.env.CRON_ALLOW_LOCAL;
const mock = (path: string, exports: object) => {
  const id = require.resolve(path); require.cache[id] = { id, filename: id, loaded: true, exports } as NodeModule;
};
let paused = false, configured = true, failed = true, throws = false, enabled = true, ready = true;
let reconciliationThrows = false, readFailures = 0, brokenChecks = 0, fallbackErrors = false;
const calls: Record<string, number> = {};
function entered(key: string) { calls[key] = (calls[key] ?? 0) + 1; if (throws) throw new Error("fixture_failure"); }
mock("../lib/automations/cron-switches", { cronPauseGate: async () => paused ? NextResponse.json({ ok: true, mode: "paused" }) : null });
mock("../lib/turso", { tursoConfigured: () => configured, getTursoClient: () => ({}) });
mock("../lib/os/runs/fallback-dispatcher", { dispatchDueEngineFallbacks: async () => { entered("fallback"); return { failed: failed ? ["failed-run"] : [], errors: fallbackErrors ? ["read-failed-run"] : [], started: [], deferred: ["waiting-run"] }; } });
mock("../lib/drips/enroller", { runEnrollDrips: async () => { entered("enroll"); return { live: false, perSequence: failed ? [{ error: "read_failed" }] : [], totals: { enrolled: 0 } }; } });
mock("../lib/supabase-server", { getServiceSupabase: () => ({
  from: () => ({ select: () => ({
    eq: async () => { entered("plans"); return { data: [{ profile_id: "p1" }, { profile_id: "p2" }], error: null }; },
    in: async () => ({ data: [{ id: "p1", tenant_id: "fixture" }, { id: "p2", tenant_id: "fixture" }], error: null }),
  }) }),
  rpc: async (_name: string, args: { p_profile_id: string }) => ({ data: "plan", error: failed && args.p_profile_id === "p1" ? { message: "plan_write_failed" } : null }),
}) });
mock("../lib/marketing/maven-publish-contract", { mavenPublishEnabled: () => enabled, mavenPublishLiveReadiness: () => ({ ready, reason: ready ? "ready" : "not_configured" }) });
mock("../lib/marketing/maven-publish-cloud", { CloudLatePublisher: class {}, TursoMavenPublishStore: class {}, mavenPublishQueueBinding: async () => ({ send: async () => undefined }) });
mock("../lib/marketing/maven-publish-reconcile", { reconcileMavenPublishes: async () => { if (reconciliationThrows) throw new Error("fixture_reconcile_failed"); return { readFailures }; } });
mock("../lib/marketing/maven-publish-queue", { runMavenPublishProducer: async ({ dryRun }: { dryRun: boolean }) => {
  entered("maven"); return { mode: dryRun ? "dry" : "live", queued: 0, reaped: { failed: failed && !dryRun ? 1 : 0, requeued: 0 } };
} });
mock("../lib/founders-finances/books-cron", {
  isFinanceBookJob: (value: unknown) => ["fx-refresh", "stripe-reconcile", "wise-sync", "wise-reconcile"].includes(String(value)),
  runFinanceBookJob: async () => { entered("finance"); return { dry_run: true, errors: failed ? 1 : 0 }; },
  financeBookJobFailure: () => ({ code: "job_failed", status: 500 }),
});
mock("../lib/sms/reply-agent", { runSmsReplyAgentWorker: async () => { entered("sms"); return { ok: !failed, failed: failed ? 1 : 0, pending: 0 }; }, smsAgentSafeErrorCode: () => "fixture_failure" });
const summary = () => ({ ran: 1, failedAlerts: failed ? 1 : 0, alerted: [], recovered: [],
  results: [{ id: "fixture", verdict: brokenChecks ? "check_broken" : "failing", observed: 1, baseline: 0, reason: "fixture" }] });
mock("../lib/health/runner", { OASIS_GLOBAL_CHECKS: [], ESTATE_WIDE_CHECKS: [], runHealthChecks: async () => { entered("health"); return summary(); } });
mock("../lib/health/department-chat-run", { runDepartmentChatHealth: async () => [], brokenSummary: () => ({ ...summary(), failedAlerts: 0 }) });
const headers = { authorization: `Bearer ${process.env.CRON_SECRET}`, "x-oasis-cron-attest": process.env.CRON_ATTEST_SECRET! };
const request = (path: string, auth = true) => new NextRequest(`https://fixture.invalid${path}`, { headers: auth ? headers : {} });
let checks = 0;
async function check(label: string, run: () => Promise<void>) { await run(); checks++; console.log(`ok ${label}`); }
async function main() {
  const cases = [
    { key: "fallback", path: "/api/cron/dispatch-engine-fallbacks", route: await import("../app/api/cron/dispatch-engine-fallbacks/route"), tick: "12:15" },
    { key: "enroll", path: "/api/cron/enroll-drips", route: await import("../app/api/cron/enroll-drips/route"), tick: "12:15" },
    { key: "plans", path: "/api/cron/materialize-plans", route: await import("../app/api/cron/materialize-plans/route"), tick: "03:00" },
    { key: "maven", path: "/api/cron/maven-publish-queue", route: await import("../app/api/cron/maven-publish-queue/route"), tick: "12:15" },
    { key: "finance", path: "/api/cron/finance-books?job=wise-reconcile", route: await import("../app/api/cron/finance-books/route"), tick: "22:07" },
    { key: "finance", path: "/api/cron/finance-books?job=wise-sync", route: await import("../app/api/cron/finance-books/route"), tick: "22:29" },
    { key: "sms", path: "/api/cron/sms-reply-agent", route: await import("../app/api/cron/sms-reply-agent/route"), tick: "12:15" },
    { key: "health", path: "/api/cron/health-check", route: await import("../app/api/cron/health-check/route"), tick: "12:15" },
  ];
  const originalError = console.error; console.error = () => undefined;
  try {
    await check("all affected routes authenticate and honor pause before work", async () => {
      for (const item of cases) {
        const before = calls[item.key] ?? 0;
        assert.equal((await item.route.GET(request(item.path, false))).status, 401, item.path);
        paused = true; assert.equal((await item.route.GET(request(item.path))).status, 200); paused = false;
        assert.equal(calls[item.key] ?? 0, before);
      }
    });
    await check("partial business failures return409 for GET and POST, preserving result counts", async () => {
      for (const item of cases) for (const method of ["GET", "POST"] as const) {
        const response = await item.route[method](request(item.path)); const body = await response.json();
        assert.equal(response.status, 409, item.path); assert.equal(body.ok, false);
        if (item.key === "plans") { assert.equal(body.count, 1); assert.equal(body.failed, 1); }
        if (item.key === "health") assert.equal(body.failed_alerts, 2);
      }
    });
    await check("preview, waiting and clean no-work remain successful; unhealthy monitored service alone is not a failed monitor", async () => {
      failed = false;
      for (const item of cases) assert.equal((await item.route.GET(request(item.path))).status, 200, item.path);
      fallbackErrors = true; const fallback = cases.find(item => item.key === "fallback")!;
      assert.equal((await fallback.route.GET(request(fallback.path))).status, 409); fallbackErrors = false;
      failed = true;
    });
    await check("Maven disabled/preview modes and transient pre-work configuration failures retain their meaning", async () => {
      const maven = cases.find(item => item.key === "maven")!;
      enabled = false; assert.equal((await (await maven.route.GET(request(maven.path))).json()).enabled, false); enabled = true;
      ready = false; assert.equal((await maven.route.GET(request(maven.path))).status, 503); ready = true;
      configured = false;
      for (const key of ["maven", "fallback"]) { const item = cases.find(item => item.key === key)!; assert.equal((await item.route.GET(request(item.path))).status, 503); }
      configured = true; assert.equal((await maven.route.GET(request(`${maven.path}?dry=1`))).status, 200);
      failed = false; readFailures = 1; assert.equal((await maven.route.GET(request(maven.path))).status, 409); readFailures = 0;
      reconciliationThrows = true; assert.equal((await maven.route.GET(request(maven.path))).status, 409); reconciliationThrows = false;
      brokenChecks = 1; const health = cases.find(item => item.key === "health")!;
      assert.equal((await health.route.GET(request(health.path))).status, 409); brokenChecks = 0; failed = true;
    });
    await check("unexpected pre-summary exceptions remain retryable", async () => {
      throws = true;
      for (const item of cases.filter(item => item.key !== "plans")) assert.equal((await item.route.GET(request(item.path))).status, 500, item.path);
      throws = false;
    });
    await check("real scheduler records every affected409 once without rerunning the work", async () => {
      const worker = (await import("../workers/oasis-cc-cron/src/index")).default;
      const original = { fetch: globalThis.fetch, log: console.log };
      console.log = () => undefined;
      try {
        for (const item of cases) {
          let invocations = 0; const reports: Array<{ path: string; status: string; attempts: number; ok: boolean }> = [];
          globalThis.fetch = async (url, init) => {
            const target = new URL(String(url)); assert.equal(target.origin, "https://fixture.invalid");
            if (target.pathname === "/api/cron/runs") { reports.push(...JSON.parse(String(init?.body)).results); return Response.json({ ok: true }); }
            if (`${target.pathname}${target.search}` === item.path) {
              failed = ++invocations === 1; // A retry would misleadingly find no failure.
              return item.route.GET(new NextRequest(target, { headers: init?.headers }));
            }
            return Response.json({ ok: true });
          };
          const pending: Promise<unknown>[] = [];
          await worker.scheduled({ scheduledTime: Date.parse(`2026-11-01T${item.tick}:00Z`), cron: "* * * * *" },
            { APP_ORIGIN: "https://fixture.invalid", CRON_FORWARD: "on", CRON_SECRET: process.env.CRON_SECRET, CRON_ATTEST_SECRET: process.env.CRON_ATTEST_SECRET },
            { waitUntil: promise => { pending.push(promise); } });
          await Promise.all(pending);
          assert.equal(invocations, 1, item.path);
          assert.deepEqual(reports.filter(row => row.path === item.path).map(row => [row.ok, row.status, row.attempts]), [[false, "409", 1]], item.path);
        }
      } finally { globalThis.fetch = original.fetch; console.log = original.log; }
    });
  } finally { console.error = originalError; }
  console.log(`cron-route-outcomes: ${checks} checks passed across ${cases.length} scheduled jobs`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
