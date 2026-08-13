#!/usr/bin/env node
/**
 * Test runner for tests/*.test.ts.
 *
 * Replaces a ~90-command `tsx a && tsx b && tsx c ...` chain in package.json,
 * which had three defects that between them hid a four-day production outage:
 *
 *  1. `&&` stops at the FIRST failure. One unloadable file masked every test
 *     after it. When tests/team-invites.test.ts started throwing on import,
 *     roughly fifty later tests silently stopped running and the suite still
 *     looked like a single ordinary failure.
 *
 *  2. Plain `tsx` does not set the `react-server` export condition, so any test
 *     transitively importing a module with `import "server-only"` throws before
 *     a single assertion runs. server-only maps that condition to an empty
 *     module and everything else to a file that throws by design. Eight tests
 *     were in that state; all eight pass once the condition is set, and all
 *     the others were measured to still pass with it set, so it is applied
 *     uniformly rather than as per-file special cases that rot.
 *
 *  3. The list was hand-maintained, so a test only ran if someone remembered to
 *     add it. Twenty-four files on disk were wired into no script at all,
 *     including the tenant-access and role-permission tests. Discovery removes
 *     that failure mode: writing the file is enough.
 *
 * Runs every file even after one fails, so a run reports ALL failures at once.
 * Exits non-zero if any failed.
 *
 * Usage:
 *   node scripts/run-tests.mjs              # every tests/*.test.ts
 *   node scripts/run-tests.mjs drip brand   # only files matching a substring
 */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TESTS_DIR = join(ROOT, "tests");

const filters = process.argv.slice(2).filter((a) => !a.startsWith("-"));

const files = readdirSync(TESTS_DIR)
  .filter((f) => f.endsWith(".test.ts"))
  .filter((f) => filters.length === 0 || filters.some((p) => f.includes(p)))
  .sort();

if (files.length === 0) {
  console.error(
    filters.length
      ? `no tests/*.test.ts matched: ${filters.join(", ")}`
      : "no tests/*.test.ts found"
  );
  process.exit(1);
}

const started = Date.now();
const failed = [];

for (const file of files) {
  // argv array, never a shell string: no interpolation, nothing to quote.
  const res = spawnSync(
    process.execPath,
    ["--conditions=react-server", "--import", "tsx", join("tests", file)],
    { cwd: ROOT, encoding: "utf8", windowsHide: true }
  );
  const ok = res.status === 0;
  if (ok) {
    console.log(`  ok    ${file}`);
  } else {
    console.log(`  FAIL  ${file}`);
    failed.push({ file, output: `${res.stdout ?? ""}${res.stderr ?? ""}`.trim() });
  }
}

const secs = ((Date.now() - started) / 1000).toFixed(1);

if (failed.length) {
  console.log(`\n${"=".repeat(70)}`);
  for (const f of failed) {
    console.log(`\n--- ${f.file} ---`);
    // First 30 lines is enough to identify the assertion or the import that blew up.
    console.log(f.output.split("\n").slice(0, 30).join("\n"));
  }
  console.log(`\n${"=".repeat(70)}`);
  console.log(`${files.length - failed.length}/${files.length} passed in ${secs}s`);
  console.log(`FAILED (${failed.length}): ${failed.map((f) => f.file).join(", ")}`);
  process.exit(1);
}

console.log(`\n${files.length}/${files.length} passed in ${secs}s`);
