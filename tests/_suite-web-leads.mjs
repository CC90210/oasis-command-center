/**
 * Runs the web-leads suite, one node process per test.
 *
 * WHY THIS EXISTS
 * On 2026-09-08, 26 of the 27 tests/web-leads-*.test.ts files were in no npm
 * script, so CI had never executed a single one of them. That is not a
 * bookkeeping detail: it is why the owner-tier filters shipped returning zero
 * rows against 1,668 owner-named leads and stayed that way for two weeks. The
 * tier logic HAD unit tests, they were green, and nothing ran them — and even
 * run, they passed, because they fed enrichmentTier objects that already
 * carried an owner name. The projection that dropped the field was never
 * exercised. A guard nothing executes is documentation.
 *
 * WHY IT DOES NOT STOP AT THE FIRST FAILURE, unlike tests/_suite.mjs.
 * That file's fail-fast is inherited from the `&&` chain it replaced, and this
 * repo has twice paid for it — the 2026-08-07 server-only import killed the
 * 12th of 48 tests and the 37 after it never ran for a full day behind one
 * generic error. For a suite being switched on for the first time, the useful
 * question is "what is broken", not "what broke first". Every file runs; every
 * failure is named; the exit code is still non-zero if any failed.
 *
 * The list stays EXPLICIT rather than globbed, same reasoning as _suite.mjs:
 * membership is deliberate, and a glob would silently adopt a future file that
 * needs credentials or a live database.
 *
 * Adding a test: put it in the list. There is no other step.
 */
import { spawnSync } from "node:child_process";

const TESTS = [
  // The projection/filter seam — the regression this suite was switched on for.
  "tests/web-leads-projection-covers-filters.test.ts",
  "tests/web-leads-enrichment.test.ts",
  "tests/web-leads-filters.test.ts",
  "tests/web-leads-filter-memory.test.ts",
  "tests/web-leads-data.test.ts",
  "tests/web-leads-queries.test.ts",
  "tests/web-leads-list-read.test.ts",
  "tests/web-leads-counters.test.ts",
  "tests/web-leads-scores.test.ts",
  "tests/web-leads-hours.test.ts",
  "tests/web-leads-audit.test.ts",
  "tests/web-leads-remedies.test.ts",
  "tests/web-leads-battlecard.test.ts",
  "tests/web-leads-manager-battlecard.test.ts",
  "tests/web-leads-url-safety.test.ts",
  "tests/web-leads-client-cache.test.ts",
  // Access, scoping and ownership — the cross-rep boundaries.
  "tests/web-leads-scope.test.ts",
  "tests/web-leads-guards.test.ts",
  "tests/web-leads-manager-access.test.ts",
  "tests/web-leads-claim.test.ts",
  "tests/web-leads-assign-target.test.ts",
  "tests/web-leads-assign-to-rep.test.ts",
  "tests/web-leads-territory-assign.test.ts",
  "tests/web-leads-owner-verification.test.ts",
  // Call outcomes.
  "tests/web-leads-outcome.test.ts",
  "tests/web-leads-outcome-guards.test.ts",
  "tests/web-leads-outcome-idempotency.test.ts",
  // The rep-facing send path that hangs off a worked lead.
  "tests/lead-quick-email.test.ts",
];

const NODE_ARGS = ["--conditions=react-server", "--import", "tsx"];

const failures = [];
for (const file of TESTS) {
  const r = spawnSync(process.execPath, [...NODE_ARGS, file], { stdio: "inherit" });
  if (r.status !== 0) failures.push({ file, status: r.status, signal: r.signal });
}

if (failures.length) {
  console.error(`\n[test:web-leads] ${failures.length} of ${TESTS.length} test files FAILED:`);
  for (const f of failures) {
    console.error(`  - ${f.file}` + (f.signal ? ` (signal ${f.signal})` : ` (exit ${f.status})`));
  }
  process.exit(1);
}

console.log(`\n[test:web-leads] ${TESTS.length} test files passed.`);
