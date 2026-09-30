/**
 * scripts/check-worker-size.ts — fail CI when the Worker outgrows its size budget.
 * (F0 release gate, 2026-09-29)
 *
 * `wrangler deploy --dry-run` bundles the Worker and prints
 *   Total Upload: 59014.13 KiB / gzip: 10271.20 KiB
 * but never fails on size: it only colours that line red past 90% of a 3 MiB
 * reference (wrangler 4.127.1, printBundleSize). Cloudflare enforces its limit
 * on the real upload, which runs in deploy-cloudflare.yml after merge. So a
 * pull request could pass CI with a Worker production cannot take.
 *
 * This reads the dry run's output and compares the gzip figure with the budget
 * that ci.yml sets (WORKER_GZIP_BUDGET_KIB, with the reason for its value).
 * No size line is a failure, not a pass: if wrangler changes its wording or
 * stops before bundling, the size is unknown, and unknown is not under budget.
 *
 * Exit 0 = within budget; 1 = over budget, no size line, or no usable budget.
 *
 * Run: WORKER_GZIP_BUDGET_KIB=10400 node --import tsx scripts/check-worker-size.ts <dry-run log>
 */

import { readFileSync } from "node:fs";

export type SizeVerdict =
  | { ok: true; gzipKib: number; budgetKib: number }
  | { ok: false; reason: string };

// chalk colours the line when the runner advertises colour support, as
// GitHub Actions does, so the escape codes come off before matching.
const ANSI = /\u001b\[[0-9;]*m/g;
const SIZE_LINE = /Total Upload: ([\d.]+) KiB \/ gzip: ([\d.]+) KiB/g;

export function checkWorkerSize(dryRunOutput: string, budgetKib: number): SizeVerdict {
  if (!Number.isFinite(budgetKib) || budgetKib <= 0) {
    return { ok: false, reason: `the size budget is not a positive number of KiB (got ${budgetKib})` };
  }
  const sizes = [...dryRunOutput.replace(ANSI, "").matchAll(SIZE_LINE)].map((m) => Number(m[2]));
  if (sizes.length === 0 || sizes.some((n) => !Number.isFinite(n))) {
    return {
      ok: false,
      reason:
        "the dry run printed no readable 'Total Upload: ... / gzip: ... KiB' line, so the Worker's size is " +
        "unknown. Either wrangler did not reach bundling or its output format changed.",
    };
  }
  const gzipKib = Math.max(...sizes);
  if (gzipKib > budgetKib) {
    return {
      ok: false,
      reason:
        `the Worker is ${gzipKib.toFixed(2)} KiB gzipped, ${(gzipKib - budgetKib).toFixed(2)} KiB over the ` +
        `${budgetKib} KiB budget in .github/workflows/ci.yml. Shrink the bundle, or raise the budget in its ` +
        "own change with the reason, knowing the post-merge deploy is where Cloudflare's real limit is checked.",
    };
  }
  return { ok: true, gzipKib, budgetKib };
}

function main(): number {
  const logPath = process.argv[2];
  if (!logPath) {
    console.error("check-worker-size: pass the dry-run log path as the first argument");
    return 1;
  }
  const raw = process.env.WORKER_GZIP_BUDGET_KIB;
  const budget = raw === undefined || raw.trim() === "" ? Number.NaN : Number(raw);
  const verdict = checkWorkerSize(readFileSync(logPath, "utf8"), budget);
  if (!verdict.ok) {
    console.error(`check-worker-size: FAIL, ${verdict.reason}`);
    return 1;
  }
  console.log(
    `check-worker-size: ${verdict.gzipKib.toFixed(2)} KiB gzipped, within the ${verdict.budgetKib} KiB budget ` +
      `(${(verdict.budgetKib - verdict.gzipKib).toFixed(2)} KiB left)`,
  );
  return 0;
}

if (/check-worker-size\.ts$/.test(process.argv[1] || "")) {
  process.exit(main());
}
