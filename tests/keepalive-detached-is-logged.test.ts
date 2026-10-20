/**
 * keepalive-detached-is-logged.test.ts — when keepAlive cannot hand work to the
 * platform on Cloudflare, it says so, every time, with the caller's label.
 *
 * WHY. keepAlive (lib/os/runs/keepalive.ts) hands work to ctx.waitUntil so it
 * outlives the response; failing that, to Next's after(); failing both it
 * returns "detached" and the work runs unheld. On Cloudflare an unheld promise
 * is cancelled when the response ends, which is the loss keepAlive exists to
 * prevent, and it happens exactly when the request context is already gone (as
 * inside a stream's cancel()). No caller reads the returned mode, so before
 * this the loss was silent (review of #721, 2026-10-20).
 *
 * Run: node --conditions=react-server --import tsx tests/keepalive-detached-is-logged.test.ts
 */
import assert from "node:assert/strict";
import { keepAlive } from "../lib/os/runs/keepalive";

const CLOUDFLARE_CONTEXT = Symbol.for("__cloudflare-context__");
const platformGlobals = globalThis as unknown as Record<symbol, unknown>;
const handed: Promise<unknown>[] = [];
const withContext = () => {
  platformGlobals[CLOUDFLARE_CONTEXT] = { env: {}, cf: {}, ctx: { waitUntil: (w: Promise<unknown>) => void handed.push(w) } };
};
const withoutContext = () => {
  delete platformGlobals[CLOUDFLARE_CONTEXT];
};

let failures = 0;
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${(e as Error).message.split("\n").slice(0, 6).join("\n        ")}`);
  }
}

/** The console.error lines a call makes (console.warn is keepAlive's one-time no-context note, not counted). */
async function errorsDuring(fn: () => Promise<unknown>): Promise<{ result: unknown; errors: unknown[][] }> {
  const errors: unknown[][] = [];
  const original = { error: console.error, warn: console.warn };
  console.error = (...args: unknown[]) => void errors.push(args);
  console.warn = () => undefined;
  try {
    const result = await fn();
    return { result, errors };
  } finally {
    console.error = original.error;
    console.warn = original.warn;
  }
}

const detachedLines = (errors: unknown[][]) => errors.filter((a) => String(a[0]).includes("detached on Cloudflare"));

function platform(name: "cloudflare" | "vercel" | "unknown") {
  delete process.env.VERCEL;
  delete process.env.DEPLOY_PLATFORM;
  if (name === "cloudflare") process.env.DEPLOY_PLATFORM = "cloudflare";
  if (name === "vercel") process.env.VERCEL = "1";
}

async function main() {
  // The first keepAlive does a cold import of "@opennextjs/cloudflare"; take it here.
  await import("@opennextjs/cloudflare");

  await check("off Cloudflare (a test, a script) a detached registration stays quiet", async () => {
    platform("unknown");
    withoutContext();
    const { result, errors } = await errorsDuring(() => keepAlive(Promise.resolve(), "probe-quiet"));
    assert.equal(result, "detached");
    assert.deepEqual(detachedLines(errors), []);
  });

  await check("on Cloudflare a detached registration is logged with the caller's label, every time", async () => {
    platform("cloudflare");
    withoutContext();
    for (const label of ["probe-a", "probe-b", "probe-a"]) {
      const { result, errors } = await errorsDuring(() => keepAlive(Promise.resolve(), label));
      assert.equal(result, "detached");
      const lines = detachedLines(errors);
      assert.equal(lines.length, 1, `one line for ${label}, got ${lines.length}`);
      assert.deepEqual(lines[0][1], { label });
    }
  });

  await check("on Cloudflare work handed to waitUntil logs nothing", async () => {
    platform("cloudflare");
    withContext();
    handed.length = 0;
    const { result, errors } = await errorsDuring(() => keepAlive(Promise.resolve(), "probe-held"));
    assert.equal(result, "waitUntil");
    assert.equal(handed.length, 1);
    assert.deepEqual(errors, []);
    withoutContext();
  });

  await check("on Vercel a detached registration is not reported as a Cloudflare loss", async () => {
    platform("vercel");
    withoutContext();
    const { result, errors } = await errorsDuring(() => keepAlive(Promise.resolve(), "probe-vercel"));
    assert.equal(result, "detached");
    assert.deepEqual(detachedLines(errors), []);
  });

  platform("unknown");
  if (failures > 0) {
    console.log(`\nkeepalive-detached-is-logged.test.ts — ${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nkeepalive-detached-is-logged.test.ts — an unheld registration on Cloudflare is always said ✓");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
