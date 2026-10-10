/**
 * tests/admin-agent-training.test.ts — Admin > Agent training
 * (app/admin/agent-training/page.tsx) is a platform-operator-only door, the
 * same convention every other Admin page follows
 * (lib/role-surfaces-session.ts requireOperator, proved generally in
 * tests/admin-surfaces-operator-only.test.ts): a founder of another
 * workspace and a signed-out browser both get a 404 before any read, and
 * the platform operator renders it. The server PATH that actually starts
 * the tool ("Learn from a link" is operatorOnly in lib/tools/registry.ts)
 * is gated a second time, independently, in lib/tools/session-handlers.ts;
 * that half is proved in tests/tools-worker.test.ts, against the real
 * run/jobs routes, not here.
 *
 * Runs through the real signed-session + Turso harness
 * (tests/_tools-harness.ts, which re-exports tests/_delivery-harness.ts):
 * the same next/headers and next/navigation stand-ins every page-gate test
 * in this suite uses, so requireOperator()/resolveFounder() run for real.
 *
 * Run: node --conditions=react-server --import tsx tests/admin-agent-training.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as ReactNS from "react";
import { USERS, check, finish, login, setupToolsDatabase } from "./_tools-harness";

// tsconfig.json sets jsx:"preserve", so tsx compiles page JSX with the
// classic runtime, which expects a global React (same as the other page
// checks in tests/admin-surfaces-operator-only.test.ts).
(globalThis as unknown as { React: typeof ReactNS }).React = ReactNS;

async function is404(run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run();
    return false;
  } catch (err) {
    if (/NEXT_HTTP_ERROR_FALLBACK;404/.test((err as Error).message)) return true;
    throw err;
  }
}

async function main() {
  console.log("admin-agent-training:");
  await setupToolsDatabase();
  const Page = (await import("../app/admin/agent-training/page")).default;

  await check("a founder of another workspace (not a platform operator) gets a 404", async () => {
    await login(USERS.clientA);
    assert.equal(await is404(Page), true);
  });

  await check("signed out: a 404", async () => {
    await login(null);
    assert.equal(await is404(Page), true);
  });

  await check("the platform operator renders the page (and a login that is not a founder at all also 404s)", async () => {
    await login(USERS.rep); // an OASIS opener: not an alias, not an operator
    assert.equal(await is404(Page), true);
    await login(USERS.cc);
    const tree = await Page();
    assert.ok(tree, "the operator's call returns a tree instead of throwing");
  });

  await check("requireOperator() is the page's first statement, before any read (same convention as every other Admin page)", () => {
    const src = readFileSync(join(__dirname, "..", "app/admin/agent-training/page.tsx"), "utf8");
    const body = src.match(/export default async function \w+\([^)]*\)[^{]*\{([\s\S]*)$/);
    assert.ok(body, "app/admin/agent-training/page.tsx: default export not found");
    const first = body![1]
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith("//") && !l.startsWith("/*") && !l.startsWith("*"));
    assert.equal(first, "await requireOperator();");
  });

  await check("the admin hub lists it, and the row names a real, gated href", async () => {
    const { OS_NAV_CATALOG } = await import("../lib/os/nav");
    const row = OS_NAV_CATALOG.find((e) => e.id === "admin-agent-training");
    assert.ok(row, "admin-agent-training is in the nav catalog");
    assert.deepEqual([row!.href, row!.section, row!.audience, row!.oasisOnly], ["/admin/agent-training", "admin", "operator", true]);
  });

  finish("admin-agent-training");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
