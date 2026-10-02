/**
 * tests/worker-bundle-checks.test.ts — CI fails when the Worker outgrows
 * Cloudflare's size limit, and superseded CI runs are cancelled (F0 release gate).
 *
 * `wrangler deploy --dry-run` prints the upload size and exits 0 whatever it
 * is. Cloudflare's limit is 64 MiB UNCOMPRESSED (wrangler's `Total Upload`),
 * and there is no compressed limit. scripts/check-worker-bundle.ts reads the
 * uncompressed figure and fails past the budget that ci.yml sets. This pins
 * the checker's verdicts, its exit codes, and the ci.yml wiring that makes the
 * step use them.
 *
 * Run: node --conditions=react-server --import tsx tests/worker-bundle-checks.test.ts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkOneByteSource, checkWorkerSize } from "../scripts/check-worker-bundle";

const root = path.resolve(__dirname, "..");

// The line as the PR's CI run printed it (run 36639255778), and as chalk
// colours it when the runner advertises colour, which GitHub Actions does.
const plain = "Total Upload: 59014.13 KiB / gzip: 10271.20 KiB\n--dry-run: exiting now.\n";
const coloured = "Total Upload: \u001b[31m59014.13 KiB / gzip: 10271.20 KiB\u001b[39m\n--dry-run: exiting now.\n";

// ── The verdicts ──────────────────────────────────────────────────────────
{
  assert.deepEqual(checkWorkerSize(plain, 64512), { ok: true, uploadKib: 59014.13, budgetKib: 64512 });
  assert.deepEqual(checkWorkerSize(coloured, 64512), { ok: true, uploadKib: 59014.13, budgetKib: 64512 }, "colour codes do not hide the size");

  // The uncompressed figure is the one checked. The gzip figure is never compared:
  // a budget between the two numbers must fail on the upload, not pass on gzip.
  const over = checkWorkerSize(plain, 50000);
  assert.equal(over.ok, false, "a Worker over the budget fails");
  assert.match(!over.ok ? over.reason : "", /59014\.13 KiB uncompressed, 9014\.13 KiB over the 50000 KiB budget/);
  assert.equal(checkWorkerSize(plain, 59014.13).ok, true, "exactly at the budget is within it");
  assert.equal(checkWorkerSize(plain, 10400).ok, false, "a gzip-sized budget is not satisfied by the gzip figure");

  const silent = checkWorkerSize("Your Worker has access to the following bindings:\n--dry-run: exiting now.\n", 64512);
  assert.equal(silent.ok, false, "no size line is a failure: an unknown size is not under budget");
  assert.match(!silent.ok ? silent.reason : "", /unknown/);
  assert.equal(checkWorkerSize("Total Upload: 59014.13 KiB\n", 100000).ok, false, "a line in another format is not a size");

  for (const bad of [Number.NaN, 0, -1, Number.POSITIVE_INFINITY]) {
    assert.equal(checkWorkerSize(plain, bad).ok, false, `a budget of ${bad} is refused, not read as no limit`);
  }
  const twice = checkWorkerSize(`${plain}Total Upload: 65000.00 KiB / gzip: 10500.00 KiB\n`, 64512);
  assert.equal(twice.ok, false, "with more than one size line, the largest is the one checked");

  // One-byte source: Latin-1 (including U+00A0..U+00FF) passes; anything above fails, and says where.
  const latin1 = 'const a = /[\\u2014]/; const b = "café  ÿ";';
  assert.deepEqual(checkOneByteSource(latin1), { ok: true, chars: latin1.length }, "an escaped regex and Latin-1 text pass");
  const wide = checkOneByteSource("x".repeat(80) + "/[—–]/g" + "y".repeat(20));
  assert.equal(wide.ok, false, "a character above U+00FF fails");
  assert.match(!wide.ok ? wide.reason : "", /holds 2 character\(s\) above U\+00FF/);
  // 50 characters before the first wide one and 10 from it: 48 x's, "/[", then "—–]/g" and 5 y's.
  assert.match(!wide.ok ? wide.reason : "", /U\+2014 near "x{48}\/\[—–\]\/gy{5}"/, "it names the character and shows where");
  assert.equal(checkOneByteSource("﻿").ok, false, "a BOM counts: U+FEFF is above U+00FF");
}

// ── The script's exit codes, as CI runs it ────────────────────────────────
{
  const scratch = mkdtempSync(path.join(tmpdir(), "worker-bundle-"));
  try {
    const log = path.join(scratch, "dry-run.log");
    const outdir = path.join(scratch, "dry-run-out");
    mkdirSync(outdir);
    const workerJs = path.join(outdir, "worker.js");
    writeFileSync(log, coloured);
    writeFileSync(workerJs, 'export default { fetch() { return new Response("ok"); } };');
    const run = (budget: string | undefined, file = log, dir: string | null = outdir) => {
      const env = { ...process.env };
      delete env.WORKER_UPLOAD_BUDGET_KIB;
      if (budget !== undefined) env.WORKER_UPLOAD_BUDGET_KIB = budget;
      const args = ["--import", "tsx", "scripts/check-worker-bundle.ts", file, ...(dir === null ? [] : [dir])];
      return spawnSync(process.execPath, args, { cwd: root, env, encoding: "utf8" });
    };
    const within = run("64512");
    assert.equal(within.status, 0, within.stderr);
    assert.match(within.stdout, /59014\.13 KiB uncompressed, within the 64512 KiB budget.*worker\.js is one-byte/);
    const over = run("50000");
    assert.equal(over.status, 1, "over budget exits 1");
    assert.match(over.stderr, /9014\.13 KiB over the 50000 KiB budget/);
    assert.equal(run(undefined).status, 1, "no budget in the environment exits 1, never passes as unlimited");
    assert.equal(run("").status, 1, "an empty budget exits 1");
    assert.equal(run("64512", log, null).status, 1, "no --outdir argument exits 1: the source would go unchecked");
    assert.equal(run("64512", log, path.join(scratch, "missing")).status, 1, "an outdir with no worker.js exits 1");
    writeFileSync(workerJs, 'const r = /[—]/; export default { fetch() { return new Response("ok"); } };');
    const wideRun = run("64512");
    assert.equal(wideRun.status, 1, "a wide character in the upload exits 1 even when the size is fine");
    assert.match(wideRun.stderr, /above U\+00FF/);
    writeFileSync(workerJs, "export default {};");
    writeFileSync(log, "--dry-run: exiting now.\n");
    assert.equal(run("64512").status, 1, "a log with no size line exits 1");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// ── ci.yml wires the check into the dry-run step ──────────────────────────
{
  const ci = readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8").replace(/\r\n/g, "\n");
  // Each step's lines with comments dropped: a comment that mentions the dry
  // run or the checker runs nothing.
  const steps = ci.split(/\n      - /).map((s) =>
    s
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#")),
  );
  const dryRun = steps.filter((code) => code.some((l) => l.includes("wrangler deploy --dry-run")));
  assert.equal(dryRun.length, 1, "exactly one step runs the wrangler dry run");
  const code = dryRun[0];
  const budget = /^WORKER_UPLOAD_BUDGET_KIB:\s*"?([\d.]+)"?$/.exec(code.find((l) => l.startsWith("WORKER_UPLOAD_BUDGET_KIB:")) || "");
  assert.ok(budget && Number(budget[1]) > 0, "the dry-run step sets a numeric WORKER_UPLOAD_BUDGET_KIB");
  assert.ok(Number(budget![1]) <= 65536, "the budget never exceeds Cloudflare's 64 MiB uncompressed limit");
  const pipefail = code.indexOf("set -o pipefail");
  const tee = code.findIndex((l) => /^npx wrangler deploy --dry-run .*2>&1 \| tee "\$RUNNER_TEMP\/wrangler-dry-run\.log"$/.test(l));
  const check = code.findIndex(
    (l) => l === 'node --import tsx scripts/check-worker-bundle.ts "$RUNNER_TEMP/wrangler-dry-run.log" .wrangler/ci-dry-run',
  );
  assert.ok(
    code.some((l) => l.includes("wrangler deploy --dry-run --outdir .wrangler/ci-dry-run")),
    "the check reads worker.js from the same --outdir the dry run writes",
  );
  assert.ok(pipefail >= 0, "pipefail is set, so a failed dry run is not swallowed by tee");
  assert.ok(tee > pipefail, "the dry run's output (stdout and stderr) goes to the log the check reads");
  assert.ok(check > tee, "the size check runs on that log, after the dry run");
  assert.ok(
    ci.indexOf("npx opennextjs-cloudflare build") < ci.indexOf("wrangler deploy --dry-run"),
    "the dry run bundles the OpenNext build, so it comes after it",
  );

  // A newer push to the same ref cancels the older run. On main this keeps
  // an older commit's late CI success from starting a deploy after a newer one.
  const concurrency = /^concurrency:\n((?: {2}.*\n)+)/m.exec(ci);
  assert.ok(concurrency, "ci.yml has a top-level concurrency block");
  assert.match(concurrency[1], /^ {2}group: ci-\$\{\{ github\.ref \}\}$/m, "one group per ref");
  assert.match(concurrency[1], /^ {2}cancel-in-progress: true$/m, "a newer push cancels the run in progress");
}

// -- next.config.js: one copy of each server module in the Worker ----------
// Next splits the Node server compile with { chunks: "all", minChunks: 2 } on
// top of webpack's browser-tuned defaults (minSize 20 KB, at most 30 chunks per
// entry), so modules shared by many routes were copied into each route entry,
// and OpenNext packs every entry into the one Worker. next.config.js lifts the
// two limits for the Worker build only. This pins that override, that nothing
// else is touched, and the two facts it relies on.
{
  const requireHere = createRequire(__filename);
  const configPath = path.join(root, "next.config.js");
  const loadConfig = (cfBuild: boolean) => {
    const saved = process.env.CF_MIGRATION_BUILD;
    if (cfBuild) process.env.CF_MIGRATION_BUILD = "1";
    else delete process.env.CF_MIGRATION_BUILD;
    delete requireHere.cache[configPath];
    try {
      return requireHere(configPath) as {
        experimental: { webpackBuildWorker?: boolean };
        webpack: (config: WebpackConfig, ctx: Record<string, unknown>) => WebpackConfig;
      };
    } finally {
      if (saved === undefined) delete process.env.CF_MIGRATION_BUILD;
      else process.env.CF_MIGRATION_BUILD = saved;
    }
  };
  type WebpackConfig = { plugins: unknown[]; optimization: { splitChunks: Record<string, unknown> } };
  // What Next hands the webpack function for a production server compile.
  const nextServerSplit = () => ({ filename: "[name].js", chunks: "all", minChunks: 2 });
  const fresh = (): WebpackConfig => ({ plugins: [], optimization: { splitChunks: nextServerSplit() } });
  const NODE_SERVER = { dev: false, isServer: true, nextRuntime: "nodejs" };

  const cf = loadConfig(true);
  assert.equal(
    cf.experimental.webpackBuildWorker,
    true,
    "with a webpack function in the config, Next turns the build worker off unless this is set",
  );
  const server = cf.webpack(fresh(), NODE_SERVER).optimization.splitChunks;
  assert.deepEqual(
    server,
    { ...nextServerSplit(), minSize: 0, maxInitialRequests: Infinity, maxAsyncRequests: Infinity },
    "the Worker's server compile keeps Next's split and lifts only the size and request limits",
  );
  assert.equal(
    server.cacheGroups,
    undefined,
    "no cache group: a named chunk is not a numeric file, OpenNext's runtime patch skips it, and it fails as 'Unknown chunk'",
  );
  for (const ctx of [
    { dev: false, isServer: true, nextRuntime: "edge" },
    { dev: false, isServer: false },
    { dev: true, isServer: true, nextRuntime: "nodejs" },
  ]) {
    assert.deepEqual(
      cf.webpack(fresh(), ctx).optimization.splitChunks,
      nextServerSplit(),
      `only the production Node server compile changes, not ${JSON.stringify(ctx)}`,
    );
  }
  assert.deepEqual(
    loadConfig(false).webpack(fresh(), NODE_SERVER).optimization.splitChunks,
    nextServerSplit(),
    "a build without CF_MIGRATION_BUILD=1 (not the Worker) is unchanged",
  );

  // Fact 1: this extends Next's own production server split. If a Next
  // upgrade changes it, re-check the override before updating this pattern.
  const nextWebpackConfig = readFileSync(requireHere.resolve("next/dist/build/webpack-config.js"), "utf8");
  assert.match(
    nextWebpackConfig,
    /if \(isNodeServer \|\| isEdgeServer\) \{\s*return \{\s*filename: `\$\{isEdgeServer \? `edge-chunks\/` : ''\}\[name\]\.js`,\s*chunks: 'all',\s*minChunks: 2\s*\};/,
    "Next's production server splitChunks is no longer { filename, chunks: 'all', minChunks: 2 }",
  );
  // Fact 2: OpenNext inlines only numerically named chunk files into the Worker.
  const openNextRuntimePatch = readFileSync(
    path.join(root, "node_modules/@opennextjs/cloudflare/dist/cli/build/patches/ast/webpack-runtime.js"),
    "utf8",
  );
  assert.ok(
    openNextRuntimePatch.includes(String.raw`.filter((chunk) => /^\d+\.js$/.test(chunk))`),
    "OpenNext's webpack-runtime patch no longer selects chunks by numeric file name; re-check the server split",
  );
}

console.log("worker-bundle-checks: all passed");
