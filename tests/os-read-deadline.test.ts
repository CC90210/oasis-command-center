/**
 * A Today read either answers inside its budget or becomes an error the error
 * boundary renders - never an endless skeleton.
 *
 * WHY. app/loading.tsx is a Suspense fallback around every route. A read that
 * never settles (a hung database connection, a provider that never answers)
 * kept that skeleton up with no error and no log line: the founder's "the
 * dashboard is loading" complaint (audit stage-3a critic, "loading boundary").
 * lib/os/deadline.ts gives every read a deadline; the Today loaders rethrow a
 * deadline (and only a deadline) so the page fails closed to app/error.tsx,
 * which names the timeout by digest and offers a reload.
 *
 * The hang is simulated with a never-resolving promise and node:test's fake
 * timers, so the 12 s budget costs this test nothing.
 *
 * Run: node --conditions=react-server --import tsx tests/os-read-deadline.test.ts
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { mock } from "node:test";
import {
  READ_DEADLINE_DIGEST,
  ReadDeadlineError,
  isReadDeadlineDigest,
  isReadDeadlineError,
  withDeadline,
} from "../lib/os/deadline";

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

// The loaders open a Turso client eagerly; point it at a scratch file so the
// import works, and stub the one store this test makes hang.
const dbFile = join(mkdtempSync(join(tmpdir(), "os-read-deadline-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;

function stubModule(path: string, exports: Record<string, unknown>) {
  require.cache[path] = {
    id: path,
    filename: path,
    path: dirname(path),
    loaded: true,
    children: [],
    paths: [],
    exports,
  } as unknown as NodeModule;
}
const NEVER = () => new Promise<never>(() => {});
stubModule(require.resolve("../lib/connections/store"), { listActiveConnections: NEVER });
// next/navigation builds React contexts at import time, which react-server does
// not have; something on the loaders' import path touches it. Hooks only.
const hookOnly = () => {
  throw new Error("client hook called under react-server");
};
stubModule(require.resolve("next/navigation"), {
  __esModule: true,
  useRouter: hookOnly,
  usePathname: hookOnly,
  useSearchParams: hookOnly,
  notFound: hookOnly,
  redirect: hookOnly,
});

let failures = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`  FAIL  ${name}`);
    console.error(error);
  }
}

/** Settle state of a promise after the fake clock advances by `ms`. */
async function after<T>(p: Promise<T>, ms: number): Promise<{ state: "pending" } | { state: "resolved"; value: T } | { state: "rejected"; error: unknown }> {
  let out: { state: "pending" } | { state: "resolved"; value: T } | { state: "rejected"; error: unknown } = { state: "pending" };
  p.then(
    (value) => { out = { state: "resolved", value }; },
    (error) => { out = { state: "rejected", error }; },
  );
  mock.timers.tick(ms);
  // Let the race's continuations run.
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  return out;
}

async function main() {
  console.log("os-read-deadline:");

  // ── 1. The helper ─────────────────────────────────────────────────────────
  await check("a promise that never settles rejects at the deadline with the exact message and digest", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const p = withDeadline(NEVER(), 12_000, "sales.board");
      const early = await after(p, 11_999);
      assert.equal(early.state, "pending", "rejected before the budget ran out");
      const late = await after(p, 1);
      assert.equal(late.state, "rejected", "still pending after the budget: the deadline never fired");
      const err = (late as { error: unknown }).error;
      assert.ok(err instanceof ReadDeadlineError);
      assert.equal((err as Error).message, "Read did not answer in time: sales.board");
      assert.equal((err as { digest?: string }).digest, READ_DEADLINE_DIGEST);
      assert.equal((err as Error).name, "ReadDeadlineError");
      assert.equal(isReadDeadlineError(err), true);
    } finally {
      mock.timers.reset();
    }
  });

  await check("a tiny real budget rejects the same way on the real clock", async () => {
    await assert.rejects(withDeadline(NEVER(), 5, "approvals"), {
      name: "ReadDeadlineError",
      message: "Read did not answer in time: approvals",
      digest: READ_DEADLINE_DIGEST,
    });
  });

  await check("a read that answers passes its value through and leaves no timer behind", async () => {
    const timersBefore = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
    assert.equal(await withDeadline(Promise.resolve("value"), 60_000, "cash.viewer"), "value");
    assert.equal(await withDeadline(Promise.resolve(null), 60_000, "cash.viewer"), null);
    const timersAfter = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
    assert.equal(timersAfter, timersBefore, "the deadline timer outlived the read it was guarding");
  });

  await check("a read that fails rejects with its own error, not a deadline", async () => {
    const own = new Error("lead_interactions read failed");
    await assert.rejects(withDeadline(Promise.reject(own), 60_000, "inbound"), (e: unknown) => e === own);
    assert.equal(isReadDeadlineError(own), false);
  });

  await check("the boundary recognises the digest, with or without Next's error-code suffix", () => {
    assert.equal(isReadDeadlineDigest(READ_DEADLINE_DIGEST), true);
    assert.equal(isReadDeadlineDigest(`${READ_DEADLINE_DIGEST}@E42`), true);
    assert.equal(isReadDeadlineDigest("digest-4471"), false);
    assert.equal(isReadDeadlineDigest(undefined), false);
    assert.equal(isReadDeadlineDigest(null), false);
    assert.equal(isReadDeadlineDigest("READ_DEADLINES"), false, "a different digest that merely starts the same");
    assert.equal(isReadDeadlineError({ digest: READ_DEADLINE_DIGEST }), true, "a serialised deadline still counts");
    assert.equal(isReadDeadlineError({ digest: "other" }), false);
    assert.equal(isReadDeadlineError(null), false);
  });

  // ── 2. The Today loaders: a hung read rejects, a failed read is a marker ──
  const loaders = await import("../components/os/today/loaders");
  const brief = await import("../components/os/today/brief-load");
  assert.equal(loaders.TODAY_READ_DEADLINE_MS, 12_000, "the per-read budget is 12 s");

  const silenced = console.error;
  await check("a Today read that never answers rejects with the deadline at 12 s (never a 'Couldn't load' marker, never a skeleton)", async () => {
    console.error = () => undefined;
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const p = loaders.loadConnectionAlerts("11111111-2222-4333-8444-555555555555");
      const early = await after(p, loaders.TODAY_READ_DEADLINE_MS - 1);
      assert.equal(early.state, "pending");
      const late = await after(p, 1);
      assert.equal(late.state, "rejected", "the loader swallowed the deadline into a marker, or is still pending");
      const err = (late as { error: unknown }).error;
      assert.equal(isReadDeadlineError(err), true, `rejected with ${String(err)}`);
      assert.equal((err as Error).message, "Read did not answer in time: connections");
    } finally {
      mock.timers.reset();
      console.error = silenced;
    }
  });

  await check("the Empire-lane operator check that never answers rejects too, instead of 'unknown' forever", async () => {
    console.error = () => undefined;
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const p = brief.empireRoutinesFor({ persona: "founder", tenantSlug: "oasis-ai-cc" }, NEVER);
      assert.equal((await after(p, loaders.TODAY_READ_DEADLINE_MS - 1)).state, "pending");
      const late = await after(p, 1);
      assert.equal(late.state, "rejected");
      assert.equal(isReadDeadlineError((late as { error: unknown }).error), true);
    } finally {
      mock.timers.reset();
      console.error = silenced;
    }
  });

  await check("a FAILED operator check is still 'unknown', never a rejection (the deadline changed nothing else)", async () => {
    console.error = () => undefined;
    try {
      const failing = async (): Promise<boolean> => {
        throw new Error("profile read failed");
      };
      assert.equal(await brief.empireRoutinesFor({ persona: "founder", tenantSlug: "oasis-ai-cc" }, failing), "unknown");
    } finally {
      console.error = silenced;
    }
  });

  // ── 3. Every Today read is under the deadline (source) ───────────────────
  await check("loaders.ts runs every read under the deadline and rethrows only a deadline", () => {
    const src = read("components/os/today/loaders.ts");
    assert.match(src, /value: await withDeadline\(fn\(\), TODAY_READ_DEADLINE_MS, label\)/, "read() must wrap fn() in the deadline");
    assert.match(src, /if \(isReadDeadlineError\(err\)\) throw err;\s*return \{ ok: false \};/, "a deadline is rethrown; any other error is still a marker");
    assert.match(src, /withDeadline\(resolveFinanceViewer\(\), TODAY_READ_DEADLINE_MS, "cash\.viewer"\)/, "the cash viewer resolution is under the deadline too");
    const briefSrc = read("components/os/today/brief-load.ts");
    assert.match(briefSrc, /withDeadline\(\s*loadPendingApprovals\(\{[\s\S]*?\}\),\s*TODAY_READ_DEADLINE_MS,\s*"approvals",\s*\)/, "the approvals read is under the deadline");
    assert.match(briefSrc, /withDeadline\(isOperator\(\), TODAY_READ_DEADLINE_MS, "routines\.operator"\)/, "the operator check is under the deadline");
  });

  // ── 4. The error page names the timeout, offers a reload, names no table ──
  await check("app/error.tsx and global-error.tsx key the timeout on the digest and offer a reload", () => {
    for (const file of ["app/error.tsx", "app/global-error.tsx"]) {
      const src = read(file);
      assert.match(src, /import \{ isReadDeadlineDigest \} from "@\/lib\/os\/deadline"/, `${file} must import the digest check`);
      assert.match(src, /const timedOut = isReadDeadlineDigest\(error\.digest\)/, `${file} must decide by digest, never by message (Next redacts it in production)`);
      assert.match(src, /timedOut=\{timedOut\}/, `${file} must hand the verdict to ErrorHelp`);
      assert.match(src, /window\.location\.reload\(\)/, `${file} must offer a real reload for a timeout`);
      assert.match(src, /This page timed out/, `${file} must say the page timed out`);
    }
  });

  // The surfaces a client meets when something else broke (audit stage-3a
  // critic, "surfaces outside the census"): the 404 speaks of their workspace,
  // not the pre-OS product name, and the root error page's button is the OS
  // button, not a second hard-coded blue.
  await check("the 404 and the root error page speak the OS's language", () => {
    const notFound = read("app/not-found.tsx");
    assert.match(notFound, /That page doesn&apos;t exist in your workspace\./, "the 404 copy");
    assert.doesNotMatch(notFound, /Command Center/, "the 404 names the pre-OS product");
    const globalError = read("app/global-error.tsx");
    assert.doesNotMatch(globalError, /#3b82f6|rgba\(59,130,246/i, "global-error.tsx hard-codes the accent again");
    assert.match(globalError, /className="btn-primary"/, "global-error.tsx must use the OS button class");
  });

  await check("the timed-out copy is plain English with no internal names", async () => {
    const { TIMED_OUT_COPY } = await import("../components/ErrorHelp");
    assert.match(TIMED_OUT_COPY, /workspace read timed out/i);
    assert.doesNotMatch(TIMED_OUT_COPY, /[a-z]+_[a-z]+/, "an identifier with an underscore is an internal table or column name");
    assert.doesNotMatch(TIMED_OUT_COPY, /turso|libsql|sqlite|supabase|postgrest|tenant_|cron|bravo|atlas|maven|aura/i, "names an internal system");
    const help = read("components/ErrorHelp.tsx");
    assert.match(help, /timedOut \? `\$\{TIMED_OUT_COPY\} Reload the page\.` : "Try again\."/, "the timeout lead asks for a reload; every other error keeps 'Try again'");
  });

  if (failures > 0) throw new Error(`${failures} check(s) failed`);
}

main().then(
  () => console.log("os-read-deadline: all assertions passed"),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
