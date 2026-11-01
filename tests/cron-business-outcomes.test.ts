/** Real cron routes + real scheduler; only their execution dependencies are synthetic. */
import assert from "node:assert/strict";
import { NextRequest, NextResponse } from "next/server";

process.env.CRON_SECRET = "cron-business-fixture-secret";
process.env.CRON_ATTEST_SECRET = "cron-business-fixture-attest";
delete process.env.CRON_ALLOW_LOCAL;
for (const key of ["TURSO_DATABASE_URL", "TURSO_DB_URL", "TURSO_AUTH_TOKEN"]) delete process.env[key];

let paused = false;
let throws = false;
let failures = 1;
let retryPending = 0, creditHalted = false;
const calls = { drips: 0, automations: 0 };
const mock = (path: string, exports: object) => {
  const id = require.resolve(path);
  require.cache[id] = { id, filename: id, loaded: true, exports } as NodeModule;
};
mock("../lib/automations/cron-switches", {
  cronPauseGate: async () => paused ? NextResponse.json({ ok: true, mode: "paused" }) : null,
});
mock("../lib/turso", { tursoConfigured: () => true, getTursoClient: () => ({}) });
mock("../lib/drips/executor", {
  runDispatchDrips: async () => {
    calls.drips++;
    if (throws) throw new Error("fixture_executor_failure");
    return { ok: true, sent: 2, failed: failures, retryPending, creditHalted };
  },
});
mock("../lib/automations/guided-dispatcher", {
  dispatchGuidedAutomations: async () => {
    calls.automations++;
    if (throws) throw new Error("fixture_executor_failure");
    return { started: ["fixture-run"], failed: failures ? ["fixture-failed-run"] : [], alreadyClaimed: [] };
  },
});

const headers = { authorization: `Bearer ${process.env.CRON_SECRET}`, "x-oasis-cron-attest": process.env.CRON_ATTEST_SECRET! };
const paths = { drips: "/api/cron/dispatch-drips", automations: "/api/cron/dispatch-automations" };
let passed = 0;
async function check(name: string, run: () => Promise<void>) {
  await run(); passed++; console.log(`ok ${name}`);
}
async function main() {
  const routes = {
    drips: await import("../app/api/cron/dispatch-drips/route"),
    automations: await import("../app/api/cron/dispatch-automations/route"),
  };
  const request = (path: string, authenticated = true) => new NextRequest(`https://fixture.invalid${path}`, { headers: authenticated ? headers : {} });
  await check("auth and pause gates prevent either executor from running", async () => {
    for (const key of ["drips", "automations"] as const) {
      const before = calls[key];
      assert.equal((await routes[key].GET(request(paths[key], false))).status, 401);
      paused = true;
      const res = await routes[key].GET(request(paths[key]));
      assert.equal(res.status, 200); assert.equal((await res.json()).mode, "paused");
      assert.equal(calls[key], before); paused = false;
    }
  });
  await check("GET and POST report durable business failures as non-retryable 409", async () => {
    failures = 1;
    for (const key of ["drips", "automations"] as const) for (const method of ["GET", "POST"] as const) {
      const res = await routes[key][method](request(paths[key]));
      assert.equal(res.status, 409); const body = await res.json(); assert.equal(body.ok, false);
      assert.deepEqual(body.failed, key === "drips" ? 1 : ["fixture-failed-run"]);
    }
  });
  await check("successful outcomes remain 200 and keep their execution summaries", async () => {
    failures = 0;
    for (const key of ["drips", "automations"] as const) {
      const res = await routes[key].GET(request(paths[key]));
      assert.equal(res.status, 200); const body = await res.json(); assert.equal(body.ok, true);
      assert.equal(key === "drips" ? body.sent : body.started.length, key === "drips" ? 2 : 1);
    }
  });
  await check("unexpected executor failures remain retryable 500", async () => {
    throws = true;
    const original = console.error; console.error = () => undefined;
    try {
      for (const key of ["drips", "automations"] as const) {
        const res = await routes[key].GET(request(paths[key]));
        assert.equal(res.status, 500); assert.equal((await res.json()).ok, false);
      }
    } finally { throws = false; console.error = original; }
  });
  await check("retryable failed attempts and provider credit stops remain visible without immediate scheduler replay", async () => {
    failures = 0; retryPending = 1;
    assert.equal((await routes.drips.GET(request(paths.drips))).status, 409);
    retryPending = 0; creditHalted = true;
    assert.equal((await routes.drips.GET(request(paths.drips))).status, 409);
    creditHalted = false;
  });
  await check("real scheduler records each durable failure once without retrying or hiding it", async () => {
    const worker = (await import("../workers/oasis-cc-cron/src/index")).default;
    failures = 1; calls.drips = 0; calls.automations = 0;
    const reports: Array<{ path: string; ok: boolean; status: string; attempts: number }> = [];
    const original = { fetch: globalThis.fetch, log: console.log, error: console.error };
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.origin, "https://fixture.invalid", "test never contacts a real provider");
      if (url.pathname === "/api/cron/runs") {
        reports.push(...JSON.parse(String(init?.body)).results);
        return Response.json({ ok: true });
      }
      for (const key of ["drips", "automations"] as const) if (url.pathname === paths[key]) {
        // A second execution would find no work and turn green, exactly the
        // failure-masking retry this regression must prevent.
        failures = calls[key] === 0 ? 1 : 0;
        return routes[key].GET(new NextRequest(url, { headers: init?.headers }));
      }
      return Response.json({ ok: true });
    };
    console.log = () => undefined; console.error = () => undefined;
    try {
      const pending: Promise<unknown>[] = [];
      await worker.scheduled({ scheduledTime: Date.parse("2026-11-01T12:05:00Z"), cron: "* * * * *" },
        { APP_ORIGIN: "https://fixture.invalid", CRON_FORWARD: "on", CRON_SECRET: process.env.CRON_SECRET, CRON_ATTEST_SECRET: process.env.CRON_ATTEST_SECRET },
        { waitUntil: promise => { pending.push(promise); } });
      await Promise.all(pending);
      for (const key of ["drips", "automations"] as const) {
        assert.equal(calls[key], 1, "no immediate duplicate execution");
        const receipts = reports.filter(row => row.path === paths[key]);
        assert.equal(receipts.length, 1); assert.equal(receipts[0].ok, false);
        assert.equal(receipts[0].status, "409"); assert.equal(receipts[0].attempts, 1);
      }
    } finally { globalThis.fetch = original.fetch; console.log = original.log; console.error = original.error; }
  });
  console.log(`cron-business-outcomes: ${passed} checks passed`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
