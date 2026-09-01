/**
 * P0 instrumentation contract tests (instant-load plan, 2026-09-01).
 *
 * Pins the load-bearing guarantees, not the log format:
 *   1. timed() is transparent — value through, rejection through, and a
 *      throwing sink/logger can never break the wrapped call (fail-open).
 *   2. instrumentTursoClient() never logs bound args. Lead PII lives in
 *      the bindings; the sentinel test proves a secret arg value cannot
 *      reach a log line even in verbose mode.
 *   3. The vitals route fails closed: cross-origin, oversized, unknown-key
 *      and malformed payloads are rejected before anything is logged.
 */

import assert from "node:assert/strict";
import {
  timed,
  logPerfSummary,
  instrumentTursoClient,
  type PerfSpan,
} from "../lib/perf/server-timing";
import { POST as vitalsPost } from "../app/api/perf/vitals/route";
import type { Client } from "@libsql/client";

function captureLogs(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  return { lines, restore: () => (console.log = orig) };
}

const SENTINEL = "PII_SENTINEL_do_not_log_9f3a";

async function testTimed(): Promise<void> {
  const spans: PerfSpan[] = [];
  const out = await timed("a", Promise.resolve(42), spans);
  assert.equal(out, 42, "timed passes the value through");
  assert.equal(spans.length, 1);
  assert.equal(spans[0].label, "a");
  assert.ok(spans[0].ms >= 0);

  const spans2: PerfSpan[] = [];
  await assert.rejects(
    () => timed("boom", Promise.reject(new Error("original failure")), spans2),
    /original failure/,
    "timed must propagate rejection untouched",
  );
  assert.equal(spans2.length, 1, "rejected calls still record a span");

  // A sink whose push throws must not break the wrapped call (fail-open).
  const evilSink = { push: () => { throw new Error("sink broke"); } } as unknown as PerfSpan[];
  const out2 = await timed("evil", Promise.resolve("ok"), evilSink);
  assert.equal(out2, "ok", "throwing sink never breaks the request");
}

function testSummary(): void {
  const cap = captureLogs();
  try {
    process.env.PERF_LOG = "0";
    logPerfSummary("layout", "/x", [{ label: "p", ms: 100 }], 100);
    assert.equal(cap.lines.length, 0, "PERF_LOG=0 disables the summary");
    delete process.env.PERF_LOG;
    logPerfSummary("layout", "/x", [{ label: "p", ms: 100 }], 100);
    assert.equal(cap.lines.length, 1, "summary logs by default");
    assert.ok(cap.lines[0].includes("[perf]"));
    logPerfSummary("layout", "/quiet", [], 1);
    assert.equal(cap.lines.length, 1, "trivial empty scopes are skipped");
  } finally {
    cap.restore();
    delete process.env.PERF_LOG;
  }
}

async function testDbWrapper(): Promise<void> {
  const received: Array<{ sql: string; args: unknown[] }> = [];
  const fake = {
    execute: async (stmt: { sql: string; args: unknown[] }) => {
      received.push(stmt);
      return { rows: [{ n: 1 }] };
    },
    batch: async () => [],
    close: () => {},
  } as unknown as Client;
  const wrapped = instrumentTursoClient(fake);

  const cap = captureLogs();
  try {
    process.env.PERF_DB_VERBOSE = "1";
    const res = await wrapped.execute({
      sql: 'SELECT data FROM "tenant_records" WHERE tenant_id = ?',
      args: [SENTINEL],
    } as never);
    assert.equal((res as { rows: unknown[] }).rows.length, 1, "result passes through");
    assert.ok(received[0].args.includes(SENTINEL), "args reach the real client untouched");
    assert.equal(cap.lines.length, 1, "verbose mode logs one line per query");
    assert.ok(cap.lines[0].includes("tenant_records"), "sql text is logged");
    assert.ok(!cap.lines[0].includes(SENTINEL), "bound args are NEVER logged");

    process.env.PERF_DB_VERBOSE = "0";
    await wrapped.execute({ sql: "SELECT 1", args: [] } as never);
    assert.equal(cap.lines.length, 1, "non-verbose mode logs nothing");
  } finally {
    cap.restore();
    delete process.env.PERF_DB_VERBOSE;
  }

  // Transaction-scoped queries are timed too (Codex P2 2026-09-01: the
  // SMS reply agent and RPC shim run tx.execute — those must not vanish
  // from the baseline).
  const txReceived: Array<{ sql: string; args: unknown[] }> = [];
  const fakeTx = {
    transaction: async () => ({
      execute: async (stmt: { sql: string; args: unknown[] }) => {
        txReceived.push(stmt);
        return { rows: [] };
      },
      commit: async () => {},
      rollback: async () => {},
    }),
  } as unknown as Client;
  const wrappedTx = instrumentTursoClient(fakeTx);
  const capTx = captureLogs();
  try {
    process.env.PERF_DB_VERBOSE = "1";
    const tx = await wrappedTx.transaction("write" as never);
    await tx.execute({ sql: 'UPDATE "x" SET y = ?', args: [SENTINEL] } as never);
    await tx.commit();
    assert.equal(txReceived.length, 1, "tx.execute reaches the real transaction");
    assert.equal(capTx.lines.length, 1, "tx.execute is logged in verbose mode");
    assert.ok(capTx.lines[0].includes("tx.execute"), "tx queries carry their own kind");
    assert.ok(!capTx.lines[0].includes(SENTINEL), "tx bound args are NEVER logged");
  } finally {
    capTx.restore();
    delete process.env.PERF_DB_VERBOSE;
  }

  // Logger explosion must not break the query (fail-open).
  const fake2 = { execute: async () => ({ rows: [] }) } as unknown as Client;
  const wrapped2 = instrumentTursoClient(fake2);
  const orig = console.log;
  console.log = () => { throw new Error("logger broke"); };
  try {
    process.env.PERF_DB_VERBOSE = "1";
    const res = await wrapped2.execute("SELECT 1" as never);
    assert.ok(res, "a throwing logger never fails the query");
  } finally {
    console.log = orig;
    delete process.env.PERF_DB_VERBOSE;
  }
}

function vitalsReq(opts: {
  body?: unknown;
  rawBody?: string;
  origin?: string | null;
  referer?: string | null;
}): Request {
  const headers = new Headers({ host: "app.test", "content-type": "application/json" });
  if (opts.origin) headers.set("origin", opts.origin);
  if (opts.referer) headers.set("referer", opts.referer);
  return new Request("https://app.test/api/perf/vitals", {
    method: "POST",
    headers,
    body: opts.rawBody ?? JSON.stringify(opts.body),
  });
}

const GOOD = { name: "LCP", value: 1234.5, rating: "good", path: "/pipeline" };

async function testVitalsRoute(): Promise<void> {
  const cap = captureLogs();
  try {
    // No origin AND no referer → fail closed before reading the body.
    let res = await vitalsPost(vitalsReq({ body: GOOD, origin: null, referer: null }));
    assert.equal(res.status, 403, "missing origin/referer is rejected");

    res = await vitalsPost(vitalsReq({ body: GOOD, origin: "https://evil.test" }));
    assert.equal(res.status, 403, "cross-origin is rejected");
    assert.equal(cap.lines.length, 0, "nothing logged for rejected posts");

    res = await vitalsPost(vitalsReq({ body: GOOD, origin: "https://app.test" }));
    assert.equal(res.status, 204, "valid same-origin metric accepted");
    assert.equal(cap.lines.length, 1);
    assert.ok(cap.lines[0].includes("[perf.vitals]"));
    assert.ok(cap.lines[0].includes("/pipeline"));

    // Referer alone (sendBeacon can omit Origin) also passes.
    res = await vitalsPost(vitalsReq({ body: GOOD, referer: "https://app.test/pipeline" }));
    assert.equal(res.status, 204, "same-origin referer accepted");

    const badCases: Array<[string, Request]> = [
      ["unknown key", vitalsReq({ body: { ...GOOD, extra: "x" }, origin: "https://app.test" })],
      ["bad metric name", vitalsReq({ body: { ...GOOD, name: "EVIL" }, origin: "https://app.test" })],
      ["non-numeric value", vitalsReq({ body: { ...GOOD, value: "12" }, origin: "https://app.test" })],
      ["negative value", vitalsReq({ body: { ...GOOD, value: -1 }, origin: "https://app.test" })],
      ["bad rating", vitalsReq({ body: { ...GOOD, rating: "great" }, origin: "https://app.test" })],
      ["path with query", vitalsReq({ body: { ...GOOD, path: "/x?q=1" }, origin: "https://app.test" })],
      ["path with markup", vitalsReq({ body: { ...GOOD, path: "/<script>" }, origin: "https://app.test" })],
      ["array body", vitalsReq({ body: [GOOD], origin: "https://app.test" })],
      ["broken json", vitalsReq({ rawBody: "{nope", origin: "https://app.test" })],
      ["oversized", vitalsReq({ rawBody: JSON.stringify(GOOD) + " ".repeat(2000), origin: "https://app.test" })],
      ["empty body", vitalsReq({ rawBody: "", origin: "https://app.test" })],
    ];
    const before = cap.lines.length;
    for (const [label, req] of badCases) {
      const r = await vitalsPost(req);
      assert.equal(r.status, 400, `${label} is rejected`);
    }
    assert.equal(cap.lines.length, before, "rejected payloads never log");
  } finally {
    cap.restore();
  }
}

async function main(): Promise<void> {
  await testTimed();
  testSummary();
  await testDbWrapper();
  await testVitalsRoute();
  console.log("perf-instrumentation: all assertions passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
