/**
 * tests/cron-driver-coverage.test.ts — every registered cron must have a driver.
 *
 * WHY THIS EXISTS
 * ---------------
 * Vercel's scheduler stopped executing for this project on 2026-08-06.
 * .github/workflows/cron-driver.yml replaced it, but only for the four routes
 * whose absence was noticed at the time. The other eighteen registered in
 * vercel.json stayed dead for five days.
 *
 * That gap is invisible by construction: a cron that never fires emits no
 * error, no log line and no alert. It is only detectable by comparing the two
 * lists — which is precisely the comparison nobody was making, and which is
 * cheap to make automatic.
 *
 * The failure it produced: scan-bounces and scan-funmate-replies stopped, and
 * 55 lender threads sat at 'sent' with replies nobody read.
 *
 * This test is the reason that cannot recur. Add a cron to vercel.json without
 * adding it to the driver and CI fails here, naming the route.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const vercelJson = JSON.parse(readFileSync("vercel.json", "utf8")) as {
  crons?: Array<{ path: string; schedule: string }>;
};
const driver = readFileSync(".github/workflows/cron-driver.yml", "utf8");

const crons = vercelJson.crons ?? [];
assert.ok(crons.length > 0, "vercel.json must register at least one cron");

// ── 1. Every registered cron is driven, query string included ──────────────
//
// The FULL path is compared, not the base path. An earlier version of this
// test stripped the query string, which made it pass while
// /api/cron/kixie-compliance-scan?mode=weekly was not driven at all: the
// daily scan shares its base path, so the weekly scorecard silently never
// ran. A query string is not decoration — it selects a different code path,
// and two registrations that differ only by query are two different jobs.
// (Codex review, 2026-08-11.)
const undriven: string[] = [];
for (const cron of crons) {
  if (!driver.includes(cron.path)) undriven.push(cron.path);
}
assert.deepEqual(
  undriven,
  [],
  `these crons are registered in vercel.json but nothing drives them, so they will never run:\n` +
    undriven.map((p) => `  - ${p}`).join("\n"),
);

// ── 2. Cron expressions must be valid ──────────────────────────────────────
// A malformed field is ignored by schedulers rather than rejected, so a typo
// like an hour of 25 produces the same quiet nothing as an undriven route:
// no error, no log, no run. Every entry currently passes; this exists so that
// stays true, since the failure is undetectable by reading the file.
const RANGES: Array<[string, number, number]> = [
  ["minute", 0, 59],
  ["hour", 0, 23],
  ["day-of-month", 1, 31],
  ["month", 1, 12],
  ["day-of-week", 0, 7],
];
for (const cron of crons) {
  const fields = cron.schedule.trim().split(/\s+/);
  assert.equal(fields.length, 5, `${cron.path}: cron needs 5 fields, got "${cron.schedule}"`);
  fields.forEach((field, i) => {
    const [name, lo, hi] = RANGES[i];
    for (const part of field.split(",")) {
      const spec = part.split("/")[0]; // strip step
      if (spec === "*") continue;
      for (const n of spec.split("-")) {
        const v = Number(n);
        assert.ok(
          Number.isInteger(v) && v >= lo && v <= hi,
          `${cron.path}: ${name} "${n}" is outside ${lo}-${hi} in "${cron.schedule}" — this entry can never fire`,
        );
      }
    }
  });
}

// ── 3. The watchdog itself must be driven ──────────────────────────────────
// If health-check stops running, every other check in the system goes quiet
// while reporting nothing wrong. It is the one route whose absence hides all
// the others.
assert.ok(
  driver.includes("/api/cron/health-check"),
  "health-check MUST be driven — without it no check in the fleet can alert",
);

console.log(
  `cron-driver-coverage.test.ts — ${crons.length} crons registered, all driven, all schedules valid ✓`,
);
