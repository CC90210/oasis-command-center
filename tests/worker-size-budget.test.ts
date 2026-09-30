/**
 * tests/worker-size-budget.test.ts — CI fails when the Worker outgrows its
 * size budget, and superseded CI runs are cancelled (F0 release gate).
 *
 * `wrangler deploy --dry-run` prints the upload size and exits 0 whatever it
 * is, so the dry-run step used to claim a size check it did not make. The
 * Worker sits at about 10.27 MiB gzipped with no headroom, and Cloudflare's
 * limit is enforced only by the real upload after merge.
 * scripts/check-worker-size.ts reads the size line and fails past the budget
 * ci.yml sets. This pins the checker's verdicts, its exit codes, and the
 * wiring in ci.yml that makes the step use them.
 *
 * Run: node --conditions=react-server --import tsx tests/worker-size-budget.test.ts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkWorkerSize } from "../scripts/check-worker-size";

const root = path.resolve(__dirname, "..");

// The line as the PR's CI run printed it (run 36639255778), and as chalk
// colours it when the runner advertises colour, which GitHub Actions does.
const plain = "Total Upload: 59014.13 KiB / gzip: 10271.20 KiB\n--dry-run: exiting now.\n";
const coloured = "Total Upload: \u001b[31m59014.13 KiB / gzip: 10271.20 KiB\u001b[39m\n--dry-run: exiting now.\n";

// ── The verdicts ──────────────────────────────────────────────────────────
{
  assert.deepEqual(checkWorkerSize(plain, 10400), { ok: true, gzipKib: 10271.2, budgetKib: 10400 });
  assert.deepEqual(checkWorkerSize(coloured, 10400), { ok: true, gzipKib: 10271.2, budgetKib: 10400 }, "colour codes do not hide the size");

  const over = checkWorkerSize(plain, 10000);
  assert.equal(over.ok, false, "a Worker over the budget fails");
  assert.match(!over.ok ? over.reason : "", /10271\.20 KiB gzipped, 271\.20 KiB over the 10000 KiB budget/);
  assert.equal(checkWorkerSize(plain, 10271.2).ok, true, "exactly at the budget is within it");

  const silent = checkWorkerSize("Your Worker has access to the following bindings:\n--dry-run: exiting now.\n", 10400);
  assert.equal(silent.ok, false, "no size line is a failure: an unknown size is not under budget");
  assert.match(!silent.ok ? silent.reason : "", /unknown/);
  // Only the gzip figure counts, not the raw upload size before it.
  assert.equal(checkWorkerSize("Total Upload: 59014.13 KiB\n", 100000).ok, false, "a line without the gzip figure is not a size");

  for (const bad of [Number.NaN, 0, -1, Number.POSITIVE_INFINITY]) {
    assert.equal(checkWorkerSize(plain, bad).ok, false, `a budget of ${bad} is refused, not read as no limit`);
  }
  const twice = checkWorkerSize(`${plain}Total Upload: 60000.00 KiB / gzip: 10500.00 KiB\n`, 10400);
  assert.equal(twice.ok, false, "with more than one size line, the largest is the one checked");
}

// ── The script's exit codes, as CI runs it ────────────────────────────────
{
  const scratch = mkdtempSync(path.join(tmpdir(), "worker-size-"));
  try {
    const log = path.join(scratch, "dry-run.log");
    writeFileSync(log, coloured);
    const run = (budget: string | undefined, file = log) => {
      const env = { ...process.env };
      delete env.WORKER_GZIP_BUDGET_KIB;
      if (budget !== undefined) env.WORKER_GZIP_BUDGET_KIB = budget;
      return spawnSync(process.execPath, ["--import", "tsx", "scripts/check-worker-size.ts", file], {
        cwd: root,
        env,
        encoding: "utf8",
      });
    };
    const within = run("10400");
    assert.equal(within.status, 0, within.stderr);
    assert.match(within.stdout, /10271\.20 KiB gzipped, within the 10400 KiB budget/);
    const over = run("10000");
    assert.equal(over.status, 1, "over budget exits 1");
    assert.match(over.stderr, /271\.20 KiB over the 10000 KiB budget/);
    assert.equal(run(undefined).status, 1, "no budget in the environment exits 1, never passes as unlimited");
    assert.equal(run("").status, 1, "an empty budget exits 1");
    writeFileSync(log, "--dry-run: exiting now.\n");
    assert.equal(run("10400").status, 1, "a log with no size line exits 1");
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
  const budget = /^WORKER_GZIP_BUDGET_KIB:\s*"?([\d.]+)"?$/.exec(code.find((l) => l.startsWith("WORKER_GZIP_BUDGET_KIB:")) || "");
  assert.ok(budget && Number(budget[1]) > 0, "the dry-run step sets a numeric WORKER_GZIP_BUDGET_KIB");
  const pipefail = code.indexOf("set -o pipefail");
  const tee = code.findIndex((l) => /^npx wrangler deploy --dry-run .*2>&1 \| tee "\$RUNNER_TEMP\/wrangler-dry-run\.log"$/.test(l));
  const check = code.findIndex((l) => l === 'node --import tsx scripts/check-worker-size.ts "$RUNNER_TEMP/wrangler-dry-run.log"');
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

console.log("worker-size-budget: all passed");
