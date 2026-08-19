/**
 * tests/deploy-serves-main.test.ts — production must serve main, and the check
 * must say so the moment it doesn't.
 *
 * The regression: 2026-08-18 21:08Z, local branch fix/automations-turnkey was
 * CLI-deployed to production, silently removing the just-shipped
 * blocked-application alarm for 4.7 hours. These assertions replay that exact
 * deployment's env and demand a failing verdict.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DEPLOY_CHECKS } from "../lib/health/deploy-checks";
import { evaluate } from "../lib/health/checks-core";

const check = DEPLOY_CHECKS.find((c) => c.id === "deploy.prod_serves_main");
assert.ok(check, "the deploy-divergence check must exist");
assert.equal(check!.severity, "critical");
assert.equal(check!.rule.kind, "must_be_zero");

const db = null as never; // the check reads env only — no database involved

function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k]!;
  }
  return fn().finally(() => {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
  });
}

const run = (async () => {
  // ── healthy: production built from main ──────────────────────────────────
  await withEnv(
    { VERCEL_ENV: "production", VERCEL_GIT_COMMIT_REF: "main", VERCEL_GIT_COMMIT_SHA: "e733cbf4aa" },
    async () => {
      const observed = await check!.observe(db, "tenant", Date.now());
      assert.equal(observed, 0);
      assert.equal(evaluate(check!.id, check!.rule, observed, []).verdict, "ok");
    },
  );

  // ── THE regression: production built from a feature branch ──────────────
  await withEnv(
    { VERCEL_ENV: "production", VERCEL_GIT_COMMIT_REF: "fix/automations-turnkey", VERCEL_GIT_COMMIT_SHA: "432c2ae1ff" },
    async () => {
      const observed = await check!.observe(db, "tenant", Date.now());
      assert.equal(observed, 1, "a non-main production deployment MUST fail");
      const r = evaluate(check!.id, check!.rule, observed, []);
      assert.equal(r.verdict, "failing");
      const msg = check!.describe(r);
      assert.match(msg, /fix\/automations-turnkey/, "the page must NAME the rogue branch");
      assert.match(msg, /redeploy main/i, "the page must say what to do");
    },
  );

  // ── worse: production from a tree with no git identity at all ────────────
  await withEnv(
    { VERCEL_ENV: "production", VERCEL_GIT_COMMIT_REF: undefined, VERCEL_GIT_COMMIT_SHA: undefined },
    async () => {
      const observed = await check!.observe(db, "tenant", Date.now());
      assert.equal(observed, 1, "a git-less production deployment is the worst case, not a pass");
      assert.match(check!.describe(evaluate(check!.id, check!.rule, observed, [])), /NO git identity/);
    },
  );

  // ── previews and local dev are exempt by design ──────────────────────────
  await withEnv(
    { VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "apex/some-feature" },
    async () => {
      assert.equal(await check!.observe(db, "tenant", Date.now()), 0, "previews serve branches by design");
    },
  );
  await withEnv({ VERCEL_ENV: undefined, VERCEL_GIT_COMMIT_REF: undefined }, async () => {
    assert.equal(await check!.observe(db, "tenant", Date.now()), 0, "local dev has no Vercel identity");
  });

  // ── wired in ─────────────────────────────────────────────────────────────
  const RUNNER = readFileSync("lib/health/runner.ts", "utf8");
  assert.ok(/\.\.\.DEPLOY_CHECKS/.test(RUNNER), "DEPLOY_CHECKS must be in allChecks()");
  const SUITE = readFileSync("tests/_suite.mjs", "utf8");
  assert.ok(SUITE.includes("deploy-serves-main.test.ts"), "this test must be in the suite");
})();

run.then(
  () => console.log("deploy-serves-main: all assertions passed"),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
