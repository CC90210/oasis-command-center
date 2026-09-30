/**
 * scripts/check-worker-bundle.ts — fail CI when the Worker bundle would fail
 * in production. (F0 release gate, 2026-09-29)
 *
 * `wrangler deploy --dry-run --outdir <dir>` bundles the Worker exactly as the
 * deploy does, and prints
 *   Total Upload: 59014.13 KiB / gzip: 10271.20 KiB
 * but it exits 0 whatever the size (wrangler 4.127.1, printBundleSize, only
 * colours the line). Cloudflare's limit is 64 MiB UNCOMPRESSED: "There is no
 * compressed size limit. Only the uncompressed bundle size counts", and
 * wrangler's `Total Upload` is that figure (developers.cloudflare.com/workers/
 * platform/limits, 2026-09-29). The gzip figure is for reference and is not
 * checked here.
 *
 * This reads the dry run's output and compares `Total Upload` with the budget
 * ci.yml sets (WORKER_UPLOAD_BUDGET_KIB, with the reason for its value). No
 * size line is a failure, not a pass: if wrangler changes its wording or stops
 * before bundling, the size is unknown, and unknown is not under budget.
 *
 * It also reads the uploaded worker.js from the dry run's --outdir and fails
 * on any character above U+00FF. One such character makes V8 store the whole
 * ~57M-character source as UTF-16, about 109 MiB of the isolate's 128 MiB
 * instead of about 54. Isolates then die every few requests while still
 * reporting `ok`, and pages cold-start at ~2 s (#485).
 * tests/worker-source-one-byte.test.ts stops our own regex literals; this
 * catches everything else, such as a dependency that adds one.
 *
 * Exit 0 = both pass; 1 = either fails, or an input is missing or unusable.
 *
 * Run: WORKER_UPLOAD_BUDGET_KIB=64512 node --import tsx scripts/check-worker-bundle.ts <dry-run log> <outdir>
 */

import { readFileSync } from "node:fs";
import path from "node:path";

export type SizeVerdict =
  | { ok: true; uploadKib: number; budgetKib: number }
  | { ok: false; reason: string };

// chalk colours the line when the runner advertises colour support, as
// GitHub Actions does, so the escape codes come off before matching.
const ANSI = /\u001b\[[0-9;]*m/g;
const SIZE_LINE = /Total Upload: ([\d.]+) KiB \/ gzip: ([\d.]+) KiB/g;

export function checkWorkerSize(dryRunOutput: string, budgetKib: number): SizeVerdict {
  if (!Number.isFinite(budgetKib) || budgetKib <= 0) {
    return { ok: false, reason: `the size budget is not a positive number of KiB (got ${budgetKib})` };
  }
  const sizes = [...dryRunOutput.replace(ANSI, "").matchAll(SIZE_LINE)].map((m) => Number(m[1]));
  if (sizes.length === 0 || sizes.some((n) => !Number.isFinite(n))) {
    return {
      ok: false,
      reason:
        "the dry run printed no readable 'Total Upload: ... KiB / gzip: ... KiB' line, so the Worker's size is " +
        "unknown. Either wrangler did not reach bundling or its output format changed.",
    };
  }
  const uploadKib = Math.max(...sizes);
  if (uploadKib > budgetKib) {
    return {
      ok: false,
      reason:
        `the Worker upload is ${uploadKib.toFixed(2)} KiB uncompressed, ${(uploadKib - budgetKib).toFixed(2)} KiB over ` +
        `the ${budgetKib} KiB budget in .github/workflows/ci.yml (Cloudflare's hard limit is 65536 KiB). ` +
        "Shrink the bundle.",
    };
  }
  return { ok: true, uploadKib, budgetKib };
}

export type OneByteVerdict = { ok: true; chars: number } | { ok: false; reason: string };

/** The uploaded source must be Latin-1 only, so V8 keeps it at one byte per character. */
export function checkOneByteSource(source: string): OneByteVerdict {
  const wide = [...source.matchAll(/[^\u0000-ÿ]/g)];
  if (wide.length === 0) return { ok: true, chars: source.length };
  const shown = wide.slice(0, 5).map((m) => {
    const at = m.index ?? 0;
    const code = `U+${m[0].charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}`;
    return `${code} near ${JSON.stringify(source.slice(Math.max(0, at - 50), at + 10))}`;
  });
  return {
    ok: false,
    reason:
      `worker.js holds ${wide.length} character(s) above U+00FF, so V8 stores all ${source.length} characters as ` +
      `UTF-16 and isolates run out of memory (#485). Escape each as \\uXXXX where it comes from:\n  ${shown.join("\n  ")}`,
  };
}

function main(): number {
  const [logPath, outdir] = process.argv.slice(2);
  if (!logPath || !outdir) {
    console.error("check-worker-bundle: pass the dry-run log path and the dry run's --outdir");
    return 1;
  }
  const raw = process.env.WORKER_UPLOAD_BUDGET_KIB;
  const budget = raw === undefined || raw.trim() === "" ? Number.NaN : Number(raw);
  const size = checkWorkerSize(readFileSync(logPath, "utf8"), budget);
  const workerJs = path.join(outdir, "worker.js");
  let oneByte: OneByteVerdict;
  try {
    oneByte = checkOneByteSource(readFileSync(workerJs, "utf8"));
  } catch (err) {
    oneByte = { ok: false, reason: `cannot read ${workerJs} (${(err as Error).message}), so its source is unchecked` };
  }
  if (!size.ok) console.error(`check-worker-bundle: FAIL, ${size.reason}`);
  if (!oneByte.ok) console.error(`check-worker-bundle: FAIL, ${oneByte.reason}`);
  if (!size.ok || !oneByte.ok) return 1;
  console.log(
    `check-worker-bundle: ${size.uploadKib.toFixed(2)} KiB uncompressed, within the ${size.budgetKib} KiB ` +
      `budget (${(size.budgetKib - size.uploadKib).toFixed(2)} KiB left); worker.js is one-byte (${oneByte.chars} chars)`,
  );
  return 0;
}

if (/check-worker-bundle\.ts$/.test(process.argv[1] || "")) {
  process.exit(main());
}
