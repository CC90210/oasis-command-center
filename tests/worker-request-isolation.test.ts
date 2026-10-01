/**
 * tests/worker-request-isolation.test.ts - no request waits on another request's I/O.
 *
 * 2026-10-01 (the pipeline incident): Cloudflare canceled /pipeline, /,
 * /team/*, /money, /agents and /api/web-leads requests with "The Workers
 * runtime canceled this request because it detected that your Worker's code
 * had hung", and logged "A promise was resolved or rejected from a different
 * request context than the one it was created in" at the same seconds. A
 * streamed page cut off mid-flight shows "Something went wrong" with no error
 * code. Two kinds of module-level sharing caused it:
 *   1. the ONE libSQL client per isolate queued statements behind a shared
 *      concurrency limit of 20, so one request's statement was started by
 *      another request's completion;
 *   2. two finance memos (ensureFinanceSeed and the entity table) shared a
 *      PENDING promise across requests, and kept it for the isolate's lifetime
 *      when the request that started it was aborted.
 *
 * This pins:
 *   - settledOnce shares only settled values: a second caller never waits on
 *     a first caller's pending load, a failure is not remembered, and reset()
 *     wins over a load already in flight;
 *   - a libSQL client built with LIBSQL_CLIENT_OPTIONS starts every statement
 *     at once, while the library default queues the 21st (so this can fail);
 *   - every module-scope libSQL client passes LIBSQL_CLIENT_OPTIONS;
 *   - no server module keeps a promise, or a map of promises, at module scope.
 *     (The scan reads declarations. A promise stored in a plain object field
 *     is not detected; settled-once.ts is the pattern to use instead.)
 *
 * Run: node --conditions=react-server --import tsx tests/worker-request-isolation.test.ts
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { createClient } from "@libsql/client";
import { settledOnce } from "../lib/runtime/settled-once";
import { LIBSQL_CLIENT_OPTIONS } from "../lib/turso";

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
    console.log(`  FAIL  ${name}\n        ${(e as Error).message.split("\n").join("\n        ")}`);
  }
}

function within<T>(ms: number, p: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: still waiting after ${ms} ms`)), ms);
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

/** Server source files: app/, lib/ and middleware.ts, without tests. */
function serverSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "__tests__" || name.startsWith(".")) continue;
      const abs = join(dir, name);
      if (statSync(abs).isDirectory()) walk(abs);
      else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(relative(ROOT, abs).split(sep).join("/"));
    }
  };
  walk(join(ROOT, "app"));
  walk(join(ROOT, "lib"));
  out.push("middleware.ts");
  return out;
}

const USE_CLIENT = /^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*["']use client["']/;

/** The text of the call that starts at `open` (the index of its "("), parentheses balanced. */
function callText(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === "(") depth += 1;
    else if (src[i] === ")") {
      depth -= 1;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return src.slice(open);
}

async function main() {
  console.log("worker request isolation");

  // -- settledOnce ---------------------------------------------------------
  await check("a second caller never waits on a first caller's pending load", async () => {
    let calls = 0;
    const once = settledOnce(async () => {
      calls += 1;
      // The first load hangs forever, like a read whose request was aborted.
      if (calls === 1) return new Promise<number>(() => {});
      return 7;
    });
    void once.get();
    assert.equal(await within(500, once.get(), "the second caller"), 7);
    assert.equal(calls, 2, "each caller ran its own load");
  });

  await check("a settled value is shared without loading again", async () => {
    let calls = 0;
    const once = settledOnce(async () => {
      calls += 1;
      return ["book"];
    });
    const a = await once.get();
    const b = await once.get();
    assert.equal(a, b);
    assert.equal(calls, 1);
  });

  await check("a failed load is not remembered", async () => {
    let calls = 0;
    const once = settledOnce(async () => {
      calls += 1;
      if (calls === 1) throw new Error("turso unreachable");
      return 1;
    });
    await assert.rejects(once.get(), /turso unreachable/);
    assert.equal(await once.get(), 1);
    assert.equal(calls, 2);
  });

  await check("reset() wins over a load that was already in flight", async () => {
    let release: ((v: string) => void) | undefined;
    let calls = 0;
    const once = settledOnce(async () => {
      calls += 1;
      if (calls === 1) return new Promise<string>((resolve) => { release = resolve; });
      return "fresh";
    });
    const inFlight = once.get();
    await Promise.resolve();
    once.reset();
    release?.("stale");
    assert.equal(await inFlight, "stale", "the caller that started it still gets its answer");
    assert.equal(await once.get(), "fresh", "later callers do not inherit it");
  });

  // -- the libSQL client's statement queue ----------------------------------
  // A fetch that never answers stands in for statements still in flight on a
  // busy page; counting calls shows which statements were started at all.
  async function startedStatements(extra: Record<string, unknown>, statements: number): Promise<number> {
    let started = 0;
    const neverAnswers = (() => {
      started += 1;
      return new Promise<Response>(() => {});
    }) as unknown as typeof fetch;
    const client = createClient({ url: "https://request-isolation.invalid", authToken: "test", fetch: neverAnswers, ...extra });
    for (let i = 0; i < statements; i += 1) void client.execute("SELECT 1").catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 100));
    return started;
  }

  await check("the library default queues the 21st statement behind 20 in flight (why the option exists)", async () => {
    assert.equal(
      await startedStatements({}, 25),
      20,
      "@libsql/client no longer queues by default; re-check whether LIBSQL_CLIENT_OPTIONS is still needed",
    );
  });

  await check("with LIBSQL_CLIENT_OPTIONS every statement starts at once", async () => {
    assert.equal(await startedStatements({ ...LIBSQL_CLIENT_OPTIONS }, 25), 25);
  });

  // -- static guards -------------------------------------------------------
  await check("every module-scope libSQL client passes LIBSQL_CLIENT_OPTIONS", () => {
    const moduleScope: string[] = [];
    const missing: string[] = [];
    for (const file of serverSources()) {
      const src = read(file);
      if (!/import\s*\{[^}]*\bcreateClient\b[^}]*\}\s*from\s*["']@libsql\/client["']/.test(src)) continue;
      const topLevel = new Set([...src.matchAll(/^(?:export\s+)?(?:let|var|const)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]));
      for (const m of src.matchAll(/\bcreateClient\(/g)) {
        const at = m.index ?? 0;
        const lineStart = src.lastIndexOf("\n", at) + 1;
        const line = src.slice(lineStart, at);
        const decl = /^(\s*)(?:export\s+)?(?:let|var|const)\s+([A-Za-z_$][\w$]*)/.exec(line);
        const assign = /^\s*([A-Za-z_$][\w$]*)\s*=/.exec(line);
        const atModuleScope = decl ? decl[1].length === 0 : Boolean(assign && topLevel.has(assign[1]));
        if (!atModuleScope) continue;
        const where = `${file}:${src.slice(0, at).split("\n").length}`;
        moduleScope.push(where);
        if (!callText(src, at + "createClient".length).includes("LIBSQL_CLIENT_OPTIONS")) missing.push(where);
      }
    }
    for (const known of ["lib/turso.ts", "app/api/ingest/automation-log/route.ts"]) {
      assert.ok(moduleScope.some((w) => w.startsWith(`${known}:`)), `the scan no longer finds the module-scope client in ${known}`);
    }
    assert.deepEqual(missing, [], "module-scope libSQL clients without LIBSQL_CLIENT_OPTIONS (a shared statement queue)");
  });

  await check("no server module keeps a promise or a map of promises at module scope", () => {
    const offenders: string[] = [];
    const patterns = [
      /^(?:export\s+)?(?:let|var)\s+([A-Za-z_$][\w$]*)\s*:[^=;\n]*\bPromise</gm,
      /^(?:export\s+)?(?:let|var|const)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]*)?=\s*new\s+(?:Map|WeakMap)\s*<[^\n]*\bPromise</gm,
    ];
    for (const file of serverSources()) {
      const src = read(file);
      if (USE_CLIENT.test(src)) continue;
      for (const re of patterns) {
        for (const m of src.matchAll(re)) {
          offenders.push(`${file}:${src.slice(0, m.index ?? 0).split("\n").length} ${m[1]}`);
        }
      }
    }
    assert.deepEqual(offenders, [], "use lib/runtime/settled-once.ts (and React cache() for one request) instead");
  });

  await check("the finance seed and the entity table share only settled values", () => {
    for (const f of ["lib/founders-finances/seed-io.ts", "lib/founders-finances/access-io.ts"]) {
      assert.match(read(f), /settledOnce\(\s*cache\(/, `${f} must load through settledOnce(cache(...))`);
    }
  });

  console.log(`\n${passed} passed, ${failures} failed`);
  if (failures) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
