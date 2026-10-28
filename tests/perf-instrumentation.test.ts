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
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  timed,
  logPerfSummary,
  navKindOf,
  startPagePerf,
  instrumentTursoClient,
  type PerfSpan,
} from "../lib/perf/server-timing";
import { NAV_KIND_HEADER, navKindFromRequestHeaders } from "../lib/perf/nav-kind";
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

    // Meta: nav kind, a well-formed cf-ray and the outcome ride along; `iso`
    // counts this isolate's lines (1-2 = a cold start) and only goes up.
    logPerfSummary("pipeline", "/pipeline", [{ label: "window", ms: 12.4 }], 40, {
      nav: "rsc",
      ray: "8f3a1b2c3d4e5f60-YUL",
      outcome: "ok",
    });
    const line = JSON.parse(cap.lines[1].slice("[perf] ".length)) as Record<string, unknown>;
    assert.equal(line.nav, "rsc");
    assert.equal(line.ray, "8f3a1b2c3d4e5f60-YUL");
    assert.equal(line.outcome, "ok");
    assert.equal(line.scope, "pipeline");
    assert.deepEqual(line.spans, { window: 12 });
    assert.equal(typeof line.iso, "number");
    const firstIso = line.iso as number;

    // A ray that is not a plain token is dropped, never logged verbatim.
    logPerfSummary("pipeline", "/pipeline", [{ label: "window", ms: 1 }], 10, { ray: "<script>alert(1)</script>" });
    const second = JSON.parse(cap.lines[2].slice("[perf] ".length)) as Record<string, unknown>;
    assert.equal("ray" in second, false, "a malformed cf-ray is not logged");
    assert.equal(second.iso, firstIso + 1, "iso counts up per line in this isolate");
  } finally {
    cap.restore();
    delete process.env.PERF_LOG;
  }
}

function testNavKind(): void {
  const h = (entries: Record<string, string>) => new Headers(entries);
  // Middleware reads the RAW request, where Next's flight headers still are.
  assert.equal(navKindFromRequestHeaders(h({})), "doc", "no RSC header is a full document load");
  assert.equal(navKindFromRequestHeaders(h({ rsc: "1" })), "rsc", "RSC alone is a client navigation (or a FULL prefetch)");
  assert.equal(navKindFromRequestHeaders(h({ rsc: "1", "next-router-prefetch": "1" })), "prefetch", "an AUTO prefetch says so");
  // Pages read what middleware forwarded: Next strips RSC from headers() (Codex review 2026-10-28).
  assert.equal(navKindOf(h({ [NAV_KIND_HEADER]: "rsc" })), "rsc", "the forwarded kind wins");
  assert.equal(navKindOf(h({ [NAV_KIND_HEADER]: "prefetch" })), "prefetch");
  assert.equal(navKindOf(h({ [NAV_KIND_HEADER]: "<script>" })), "doc", "a forwarded value that is not a kind is ignored");
  assert.equal(navKindOf(h({ rsc: "1" })), "rsc", "raw headers still count when present");
  const broken = { get: () => { throw new Error("headers broke"); } };
  assert.equal(navKindOf(broken), "doc", "a throwing headers object is fail-open");
  assert.equal(navKindFromRequestHeaders(broken), "doc");

  const mw = readFileSync(join(__dirname, "..", "middleware.ts"), "utf8");
  assert.match(mw, /const navKind = navKindFromRequestHeaders\(req\.headers\);\n\s*requestHeaders\.set\(NAV_KIND_HEADER, navKind\);/,
    "middleware decides the kind from the raw request and forwards it");
  assert.match(mw, /refreshedHeaders\.set\(NAV_KIND_HEADER, navKind\);/, "the refreshed-cookie path forwards it too");
}

function testPagePerf(): void {
  const cap = captureLogs();
  try {
    const perf = startPagePerf("pipeline", "/pipeline", new Headers({ [NAV_KIND_HEADER]: "rsc", "cf-ray": "8f3a1b2c3d4e5f60-YUL" }));
    perf.spans.push({ label: "window", ms: 7 });
    const element = { kind: "the page element" };
    assert.equal(perf.done("ok", element), element, "done() hands back exactly what it was given");
    perf.done("error");
    assert.equal(cap.lines.length, 1, "one line per render, however many times done() runs");
    const line = JSON.parse(cap.lines[0].slice("[perf] ".length)) as Record<string, unknown>;
    assert.equal(line.scope, "pipeline");
    assert.equal(line.nav, "rsc");
    assert.equal(line.outcome, "ok");
    assert.deepEqual(line.spans, { window: 7 });
  } finally {
    cap.restore();
  }
}

/** The pipeline page logs its own [perf] line through the same seam, inside its own default export. */
function testPipelineWiring(): void {
  const page = readFileSync(join(__dirname, "..", "app", "pipeline", "page.tsx"), "utf8");
  assert.match(page, /const perf = startPagePerf\("pipeline", "\/pipeline", await headers\(\)\);/);
  // The JSX stays in the default export (tests/ui-chrome.test.ts judges pages by it).
  assert.match(page, /return perf\.done\("ok", \(\n\s*<div className="animate-fade-in space-y-4">/);
  assert.equal((page.match(/return perf\.done\("error", \(/g) || []).length, 3, "every error state is logged");
  assert.match(page, /perf\.done\("redirect"\);\n\s*throw err;/, "a tenant redirect is logged before it is re-thrown");
  assert.match(page, /timed\("window", listOasisPipelineWindow\(\{/);
  const layout = readFileSync(join(__dirname, "..", "app", "layout.tsx"), "utf8");
  assert.match(layout, /nav: navKindOf\(hdrs\)/, "the layout line carries its nav kind for the join");
}

/**
 * lib/perf/nav-timing.ts in a stub browser: click -> commit -> board, each
 * reported once, credited through a redirect; a fresh load reports navigation
 * start -> board once; a board reached without a click reports nothing.
 */
async function testNavTiming(): Promise<void> {
  const sent: Array<{ name: string; path: string }> = [];
  const location = { pathname: "/pipeline", href: "https://app.test/pipeline", origin: "https://app.test" };
  const g = globalThis as Record<string, unknown>;
  const savedWindow = g.window;
  const savedNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const savedEntries = performance.getEntriesByType.bind(performance);
  g.window = { location };
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      sendBeacon: (_url: string, body: string) => {
        const parsed = JSON.parse(body) as { name: string; path: string };
        sent.push({ name: parsed.name, path: parsed.path });
        return true;
      },
    },
  });
  // The document this tab loaded was /pipeline.
  (performance as unknown as { getEntriesByType: (type: string) => unknown[] }).getEntriesByType = (type: string) =>
    type === "navigation" ? [{ name: "https://app.test/pipeline" }] : [];
  try {
    const nav = await import("../lib/perf/nav-timing");
    nav.resetNavTiming();
    const click = (href: string, extra: Partial<MouseEvent> = {}) =>
      ({
        button: 0,
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        target: { closest: () => ({ href, target: "", hasAttribute: () => false }) },
        ...extra,
      }) as unknown as MouseEvent;

    // The board that came with the first document: navigation start -> board, once.
    nav.reportRouteCommit("/pipeline");
    nav.reportBoardVisible();
    nav.reportBoardVisible();
    assert.deepEqual(sent.map((s) => s.name), ["OASIS-board-full"], "a fresh load reports the board once");

    // Clicks that are not route changes are not timed.
    location.pathname = "/today";
    nav.recordLinkClick(click("https://app.test/today?stage=x"));
    nav.recordLinkClick(click("https://evil.test/pipeline"));
    nav.recordLinkClick(click("https://app.test/pipeline", { metaKey: true }));
    assert.equal(sent.length, 1, "same-route, cross-origin and modified clicks are not timed");

    // A click to /pipeline that the server redirects to a tenant board is still credited.
    nav.recordLinkClick(click("https://app.test/pipeline"));
    nav.reportRouteCommit("/t/acme/leads");
    nav.reportRouteCommit("/t/acme/leads");
    location.pathname = "/t/acme/leads";
    nav.reportBoardVisible();
    nav.reportBoardVisible();
    assert.deepEqual(
      sent.map((s) => s.name),
      ["OASIS-board-full", "OASIS-nav-commit", "OASIS-board-soft"],
      "a click reports its commit and its board exactly once each, even through a redirect",
    );
    assert.ok(sent.every((s) => !s.path.includes("?")), "pathname only, never a query");
  } finally {
    if (savedWindow === undefined) delete g.window;
    else g.window = savedWindow;
    if (savedNavigator) Object.defineProperty(globalThis, "navigator", savedNavigator);
    (performance as unknown as { getEntriesByType: typeof savedEntries }).getEntriesByType = savedEntries;
  }
}

/**
 * A board reached by router.push with no link click (DeleteLeadButton after a
 * direct load of a lead page) has no honest start time: it reports nothing,
 * never the age of the tab (Codex review 2026-10-28). resetNavTiming() gives
 * it a fresh tab's state, so nothing from the scenario above leaks in.
 */
async function testNavTimingNoClick(): Promise<void> {
  const sent: string[] = [];
  const location = { pathname: "/pipeline/lead-1", href: "https://app.test/pipeline/lead-1", origin: "https://app.test" };
  const g = globalThis as Record<string, unknown>;
  const savedWindow = g.window;
  const savedNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const savedEntries = performance.getEntriesByType.bind(performance);
  g.window = { location };
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { sendBeacon: (_url: string, body: string) => { sent.push((JSON.parse(body) as { name: string }).name); return true; } },
  });
  (performance as unknown as { getEntriesByType: (type: string) => unknown[] }).getEntriesByType = (type: string) =>
    type === "navigation" ? [{ name: "https://app.test/pipeline/lead-1" }] : [];
  try {
    const nav = await import("../lib/perf/nav-timing");
    nav.resetNavTiming();
    nav.reportRouteCommit("/pipeline/lead-1");
    // router.push("/pipeline"): the board mounts before PerfVitals sees the new path.
    location.pathname = "/pipeline";
    nav.reportBoardVisible();
    nav.reportRouteCommit("/pipeline");
    nav.reportBoardVisible();
    assert.deepEqual(sent, [], "a board reached without a click and outside the first document reports nothing");
  } finally {
    if (savedWindow === undefined) delete g.window;
    else g.window = savedWindow;
    if (savedNavigator) Object.defineProperty(globalThis, "navigator", savedNavigator);
    (performance as unknown as { getEntriesByType: typeof savedEntries }).getEntriesByType = savedEntries;
  }
}

/**
 * A same-route click (a stage chip, Next, a queue tab) is timed once the board
 * is drawn for exactly that search: once, pathname only. The same URL, or a
 * search the server answered with something else, is never credited.
 */
async function testNavTimingQuery(): Promise<void> {
  const sent: Array<{ name: string; path: string }> = [];
  const location = { pathname: "/pipeline", search: "", href: "https://app.test/pipeline", origin: "https://app.test" };
  const g = globalThis as Record<string, unknown>;
  const savedWindow = g.window;
  const savedNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const savedEntries = performance.getEntriesByType.bind(performance);
  g.window = { location };
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      sendBeacon: (_url: string, body: string) => {
        const parsed = JSON.parse(body) as { name: string; path: string };
        sent.push({ name: parsed.name, path: parsed.path });
        return true;
      },
    },
  });
  (performance as unknown as { getEntriesByType: (type: string) => unknown[] }).getEntriesByType = (type: string) =>
    type === "navigation" ? [{ name: "https://app.test/pipeline" }] : [];
  try {
    const nav = await import("../lib/perf/nav-timing");
    nav.resetNavTiming();
    const click = (href: string) =>
      ({
        button: 0,
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        target: { closest: () => ({ href, target: "", hasAttribute: () => false }) },
      }) as unknown as MouseEvent;
    nav.reportRouteCommit("/pipeline");
    nav.reportBoardVisible();
    assert.deepEqual(sent.map((s) => s.name), ["OASIS-board-full"]);
    sent.length = 0;

    // The same URL changes nothing on screen: nothing to time.
    nav.recordLinkClick(click("https://app.test/pipeline"));
    nav.reportBoardVisible();
    assert.deepEqual(sent, [], "a click on the URL already showing is not timed");

    // A stage chip: the board, redrawn for that search, reports it once.
    nav.recordLinkClick(click("https://app.test/pipeline?stage=qualified"));
    location.search = "?stage=qualified";
    nav.reportBoardVisible();
    nav.reportBoardVisible();
    assert.deepEqual(sent, [{ name: "OASIS-board-query", path: "/pipeline" }], "once, and pathname only");

    // A search the server answered with something else is never credited.
    sent.length = 0;
    nav.recordLinkClick(click("https://app.test/pipeline?stage=won"));
    location.search = "?stage=won&page=1";
    nav.reportBoardVisible();
    assert.deepEqual(sent, [], "a board drawn for another search is not this click's");
  } finally {
    if (savedWindow === undefined) delete g.window;
    else g.window = savedWindow;
    if (savedNavigator) Object.defineProperty(globalThis, "navigator", savedNavigator);
    (performance as unknown as { getEntriesByType: typeof savedEntries }).getEntriesByType = savedEntries;
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

    // The first-party navigation metrics (lib/perf/nav-timing.ts) are accepted.
    for (const name of ["OASIS-nav-commit", "OASIS-board-soft", "OASIS-board-full", "OASIS-board-query"]) {
      const r = await vitalsPost(vitalsReq({ body: { name, value: 180, rating: null, path: "/pipeline" }, origin: "https://app.test" }));
      assert.equal(r.status, 204, `${name} is accepted`);
    }
  } finally {
    cap.restore();
  }
}

async function main(): Promise<void> {
  await testTimed();
  testSummary();
  testNavKind();
  testPagePerf();
  testPipelineWiring();
  await testNavTiming();
  await testNavTimingNoClick();
  await testNavTimingQuery();
  await testDbWrapper();
  await testVitalsRoute();
  console.log("perf-instrumentation: all assertions passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
