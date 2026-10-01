/**
 * tests/client-error-reporting.test.ts - browser crashes reach the server.
 *
 * 2026-10-01: the pipeline showed "Something went wrong" with no error code
 * (a client-side crash) and the Worker logged nothing, because app/error.tsx
 * only wrote to the browser console. This pins the fix end to end:
 *   - the report contract (lib/client-errors/shape.ts) refuses junk, keeps the
 *     pathname only, clamps and de-controls every string;
 *   - the page reporter dedupes and caps (lib/client-errors/report.ts);
 *   - the stale-build reload fires once, never in a loop;
 *   - POST /api/client-errors gates on same origin, caps bytes, logs a
 *     [client.error] line and stores a row, and still answers 204 before
 *     migration bravo__198 exists;
 *   - both error screens and the root layout are wired to it;
 *   - the roster route answers 503, not an uncaught 500, when the session
 *     read fails (the live 500 that was captured).
 *
 * Run: node --conditions=react-server --import tsx tests/client-error-reporting.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dbFile = join(mkdtempSync(join(tmpdir(), "client-errors-")), "test.db");
process.env.TURSO_DB_PATH = dbFile;
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";

const ROOT = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

let failures = 0;
let passed = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${(e as Error).stack?.split("\n").slice(0, 6).join("\n        ")}`);
  }
}

async function main() {
  const shape = await import("../lib/client-errors/shape");
  const report = await import("../lib/client-errors/report");

  // -- 1. The contract ------------------------------------------------------
  await check("a valid report parses; the path keeps the pathname only", () => {
    const parsed = shape.parseClientErrorReport({
      kind: "boundary",
      name: "TypeError",
      message: "Cannot read properties of undefined (reading 'map')",
      stack: "TypeError: x\n    at a (https://oasisai.work/_next/static/chunks/1.js:1:2)",
      digest: null,
      path: "/pipeline/abc?q=jane%20doe&token=secret#frag",
    });
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.report.path, "/pipeline/abc", "no query string or hash is ever kept");
    assert.equal(parsed.report.kind, "boundary");
    assert.match(parsed.report.stack ?? "", /chunks\/1\.js/);
  });

  await check("junk is refused: unknown key, bad kind, empty message, non-object", () => {
    assert.equal(shape.parseClientErrorReport({ kind: "boundary", message: "x", path: "/", extra: 1 }).ok, false);
    assert.equal(shape.parseClientErrorReport({ kind: "nope", message: "x", path: "/" }).ok, false);
    assert.equal(shape.parseClientErrorReport({ kind: "window", message: "   ", path: "/" }).ok, false);
    assert.equal(shape.parseClientErrorReport([1, 2]).ok, false);
    assert.equal(shape.parseClientErrorReport(null).ok, false);
  });

  await check("strings are clamped and control characters cannot forge log lines", () => {
    const longMessage = "a".repeat(5_000);
    const forged = `real error${String.fromCharCode(10)}[client.error] {"forged":true}${String.fromCharCode(27)}[31m`;
    const parsed = shape.parseClientErrorReport({ kind: "window", message: forged, path: "/x", name: longMessage });
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.ok(!parsed.report.message.includes(String.fromCharCode(10)), "no newline in a message");
    assert.ok(!parsed.report.message.includes(String.fromCharCode(27)), "no escape character");
    assert.ok((parsed.report.name ?? "").length <= shape.CLIENT_ERROR_LIMITS.name);
    const clamped = shape.parseClientErrorReport({ kind: "window", message: longMessage, path: "/x" });
    assert.ok(clamped.ok && clamped.report.message.length === shape.CLIENT_ERROR_LIMITS.message);
    const stack = Array.from({ length: 40 }, (_, i) => `    at f${i} (x.js:1:1)`).join(String.fromCharCode(10));
    assert.ok((shape.clampStack(stack) ?? "").split(String.fromCharCode(10)).length <= shape.CLIENT_ERROR_LIMITS.stackLines);
  });

  await check("a digest is kept only when it looks like one", () => {
    const good = shape.parseClientErrorReport({ kind: "boundary", message: "m", path: "/", digest: "1234567890" });
    const bad = shape.parseClientErrorReport({ kind: "boundary", message: "m", path: "/", digest: "<script>" });
    assert.ok(good.ok && good.report.digest === "1234567890");
    assert.ok(bad.ok && bad.report.digest === null);
  });

  await check("stale-build errors are recognised; ordinary errors are not", () => {
    assert.equal(shape.isStaleBuildError({ name: "ChunkLoadError", message: "Loading chunk 123 failed." }), true);
    assert.equal(shape.isStaleBuildError({ name: "Error", message: "Loading chunk app/pipeline/page failed." }), true);
    assert.equal(shape.isStaleBuildError({ name: "TypeError", message: "Failed to fetch dynamically imported module: https://x/a.js" }), true);
    assert.equal(shape.isStaleBuildError({ name: "TypeError", message: "Cannot read properties of undefined" }), false);
    assert.equal(shape.isStaleBuildError(null), false);
  });

  // -- 2. The page reporter -------------------------------------------------
  await check("the same error on the same page is sent once per minute; a new page is a new report", () => {
    const sent: string[] = [];
    let t = 1_000;
    const rep = report.createClientErrorReporter((b) => sent.push(b), () => t);
    const err = new TypeError("boom");
    assert.equal(rep("boundary", err, "/pipeline"), true);
    assert.equal(rep("boundary", err, "/pipeline"), false, "deduped within the window");
    assert.equal(rep("boundary", err, "/web-leads"), true, "another page is another report");
    t += report.REPORT_DEDUPE_MS + 1;
    assert.equal(rep("boundary", err, "/pipeline"), true, "sent again after the window");
    assert.equal(sent.length, 3);
    const body = JSON.parse(sent[0]) as Record<string, unknown>;
    assert.equal(body.message, "boom");
    assert.equal(body.name, "TypeError");
    assert.equal(body.path, "/pipeline");
    assert.ok(shape.parseClientErrorReport(body).ok, "what the page sends is what the route accepts");
  });

  await check("one page load sends at most the cap, and noise is never sent", () => {
    const sent: string[] = [];
    const rep = report.createClientErrorReporter((b) => sent.push(b), () => 0);
    for (let i = 0; i < 25; i++) rep("window", new Error(`e${i}`), "/x");
    assert.equal(sent.length, report.MAX_REPORTS_PER_PAGE_LOAD);
    const quiet = report.createClientErrorReporter((b) => sent.push(b), () => 0);
    assert.equal(quiet("window", "Script error.", "/x"), false);
    assert.equal(quiet("window", "ResizeObserver loop completed with undelivered notifications.", "/x"), false);
  });

  await check("an oversize report drops its stack instead of failing", () => {
    const sent: string[] = [];
    const rep = report.createClientErrorReporter((b) => sent.push(b), () => 0);
    const err = new Error("big");
    err.stack = Array.from({ length: 15 }, () => "x".repeat(400)).join(String.fromCharCode(10));
    rep("boundary", err, "/x");
    assert.equal(sent.length, 1);
    assert.ok(sent[0].length <= shape.CLIENT_ERROR_MAX_BODY_BYTES);
  });

  await check("the stale-build reload happens once per page per minute, and never without storage", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    let reloads = 0;
    let t = 10_000;
    const go = () => report.reloadOnceForStaleBuild({ storage, path: "/pipeline", reload: () => { reloads += 1; }, now: () => t });
    assert.equal(go(), true);
    assert.equal(go(), false, "a second stale error inside the window does not reload again (no loop)");
    t += report.STALE_RELOAD_WINDOW_MS + 1;
    assert.equal(go(), true);
    assert.equal(reloads, 2);
    assert.equal(report.reloadOnceForStaleBuild({ storage: null, path: "/x", reload: () => { reloads += 1; } }), false);
    assert.equal(reloads, 2);
  });

  // -- 3. The route ---------------------------------------------------------
  const route = await import("../app/api/client-errors/route");
  const post = (body: string, headers: Record<string, string> = {}) =>
    route.POST(
      new Request("http://oasisai.work/api/client-errors", {
        method: "POST",
        headers: { host: "oasisai.work", origin: "https://oasisai.work", "content-type": "application/json", ...headers },
        body,
      }),
    );
  const valid = JSON.stringify({ kind: "boundary", name: "TypeError", message: "boom on the board", stack: "TypeError: boom", path: "/pipeline?q=x" });
  const logged: string[] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
  try {
    await check("before migration bravo__198 the route still answers 204 and logs the report", async () => {
      const res = await post(valid);
      assert.equal(res.status, 204);
      const line = logged.find((l) => l.startsWith("[client.error] "));
      assert.ok(line, "a [client.error] line is logged");
      const payload = JSON.parse(line!.slice("[client.error] ".length)) as Record<string, unknown>;
      assert.equal(payload.path, "/pipeline");
      assert.equal(payload.message, "boom on the board");
      assert.equal(payload.tenant_id, null, "no session here: anonymous, never taken from the payload");
      assert.ok(!logged.some((l) => l.startsWith("[client.error.store]")), "a missing table is expected before the migration, not an error");
    });

    const { getTursoClient } = await import("../lib/turso");
    await getTursoClient().executeMultiple(read("database/turso/bravo__198_client_error_reports.sql"));

    await check("after the migration the report is stored, pathname only", async () => {
      const res = await post(valid);
      assert.equal(res.status, 204);
      const rows = (await getTursoClient().execute("SELECT kind, name, message, path, tenant_id FROM client_error_reports")).rows;
      assert.equal(rows.length, 1);
      assert.equal(String(rows[0].path), "/pipeline");
      assert.equal(String(rows[0].message), "boom on the board");
      assert.equal(rows[0].tenant_id, null);
    });

    await check("another origin is refused before the body is read", async () => {
      const res = await post(valid, { origin: "https://evil.example" });
      assert.equal(res.status, 403);
    });

    await check("an oversize body and a malformed body are refused", async () => {
      const big = JSON.stringify({ kind: "boundary", message: "x".repeat(5_000), path: "/" });
      assert.equal((await post(big)).status, 400);
      assert.equal((await post("{not json")).status, 400);
      assert.equal((await post(JSON.stringify({ kind: "boundary", message: "m", path: "/", tenant_id: "forged" }))).status, 400, "a tenant in the payload is refused, not trusted");
    });
  } finally {
    console.error = realError;
  }

  // -- 4. Wiring -------------------------------------------------------------
  await check("both error screens report and recover from a stale build; the layout listens for the rest", () => {
    const boundary = read("app/error.tsx");
    assert.match(boundary, /reportClientError\("boundary", error\)/);
    assert.match(boundary, /if \(isStaleBuildError\(error\)\) recoverFromStaleBuild\(\)/);
    assert.match(boundary, /router\.refresh\(\);\s+reset\(\);/, "Try again refetches the route's data before re-rendering");
    assert.doesNotMatch(boundary, /The Worker's logs capture console output/, "the false claim about where the log goes is gone");
    const global = read("app/global-error.tsx");
    assert.match(global, /reportClientError\("global", error\)/);
    assert.match(global, /if \(isStaleBuildError\(error\)\) recoverFromStaleBuild\(\)/);
    const layout = read("app/layout.tsx");
    assert.match(layout, /<ClientErrorReporter \/>/);
    const listener = read("components/ClientErrorReporter.tsx");
    assert.match(listener, /addEventListener\("error", onError\)/);
    assert.match(listener, /addEventListener\("unhandledrejection", onRejection\)/);
  });

  await check("the roster route turns a failed session read into a 503, not an uncaught 500", () => {
    const src = read("app/api/web-leads/assignable-reps/route.ts");
    assert.match(src, /try \{\s+session = await resolveSessionContext\(\);\s+\} catch/);
    assert.match(src, /error: "session_unavailable" \}, \{ status: 503 \}/);
  });

  console.log(failures ? `client-error-reporting: ${failures} FAILED (${passed} ok)` : `client-error-reporting: ok (${passed} checks)`);
  if (failures) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
