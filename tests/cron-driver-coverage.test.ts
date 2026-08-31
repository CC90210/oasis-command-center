/**
 * tests/cron-driver-coverage.test.ts — every registered cron must have a driver.
 *
 * WHY THIS EXISTS
 * ---------------
 * Vercel's scheduler stopped executing for this project on 2026-08-06.
 * .github/workflows/cron-driver.yml replaced it, but only for the four routes
 * whose absence was noticed at the time. The other eighteen registered in
 * vercel.json stayed dead for five days. The oasis-cc-cron Worker is now the
 * live minute scheduler; GitHub remains a manual rollback path only.
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
import { CRON_TABLE } from "../workers/oasis-cc-cron/src/index";

// 2026-08-30 (PR #347): the crons moved OUT of vercel.json into an inert
// registry. Vercel's scheduler died silently on 08-06 while reporting the
// registrations enabled; leaving them in vercel.json meant every deploy
// re-armed a zombie that would double-fire the moment Vercel fixed itself.
// The registry carries the same intent with nothing to resurrect.
//
// Deliberately NOT derived from cron-driver.yml: this test exists to compare
// two INDEPENDENT lists (intent vs driver). Deriving intent from the driver
// would make the comparison a tautology - everything the driver drives is
// driven - which is the exact presence-not-contribution blindness that let
// eighteen crons die invisibly the first time.
const vercelJson = JSON.parse(readFileSync("config/cron-registry.json", "utf8")) as {
  crons?: Array<{ path: string; schedule: string }>;
};
const driver = readFileSync(".github/workflows/cron-driver.yml", "utf8");
const workerConfig = readFileSync("workers/oasis-cc-cron/wrangler.jsonc", "utf8");

const crons = vercelJson.crons ?? [];
assert.ok(crons.length > 0, "the cron registry must carry at least one cron");

// ── 0. The disarm itself is pinned: vercel.json must stay cron-free ─────────
//
// The registrations were removed because Vercel re-registers whatever this
// file carries on every deploy, and its scheduler already failed silently
// once in each direction. If a crons block ever reappears here, that is the
// zombie coming back - fail naming it, before a deploy re-arms it.
const liveVercel = JSON.parse(readFileSync("vercel.json", "utf8")) as { crons?: unknown[] };
assert.ok(
  !liveVercel.crons || liveVercel.crons.length === 0,
  "vercel.json must not register crons: Vercel's scheduler is retired here. Add routes to config/cron-registry.json + the driver instead.",
);

/** "/api/cron/scan-bounces?write=1" -> "/api/cron/scan-bounces" */
const basePathOf = (p: string) => p.split("?")[0];

// ── 1. The inert registry and live Worker table must match exactly ─────────
//
// The FULL path is compared, not the base path. An earlier version of this
// test stripped the query string, which made it pass while
// /api/cron/kixie-compliance-scan?mode=weekly was not driven at all: the
// daily scan shares its base path, so the weekly scorecard silently never
// ran. A query string is not decoration — it selects a different code path,
// and two registrations that differ only by query are two different jobs.
// (Codex review, 2026-08-11.)
assert.deepEqual(
  [...CRON_TABLE],
  crons,
  "config/cron-registry.json and the oasis-cc-cron Worker table must match path-for-path and schedule-for-schedule",
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

// ── 3. Cloudflare is live; GitHub is manual-only ───────────────────────────
//
// One Cloudflare minute tick evaluates every expression in CRON_TABLE. Keeping
// GitHub schedule triggers armed at the same time double-fires every due job.
assert.match(
  workerConfig,
  /"crons"\s*:\s*\[\s*"\* \* \* \* \*"\s*\]/,
  "oasis-cc-cron must retain its every-minute trigger",
);
assert.match(
  workerConfig,
  /"global_fetch_strictly_public"/,
  "oasis-cc-cron must route Worker-to-Worker fetches through Cloudflare's public front door",
);
const workflowTriggers = driver.slice(driver.indexOf("on:"), driver.indexOf("concurrency:"));
assert.ok(
  workflowTriggers.includes("workflow_dispatch:"),
  "cron-driver.yml must remain manually runnable as the rollback path",
);
assert.ok(
  !/^\s*schedule:\s*$/m.test(workflowTriggers),
  "cron-driver.yml must not retain schedule triggers after the Cloudflare Worker is live",
);

// Keep the full historical mapping in the manual fallback so a rollback does
// not require reconstructing route/cadence pairings under pressure.
for (const cron of crons) {
  assert.ok(driver.includes(cron.path), `${cron.path} is missing from the manual rollback driver`);
  assert.ok(
    driver.includes(`"${cron.schedule.trim()}")`),
    `the manual rollback driver lost the ${cron.schedule} schedule mapping`,
  );
}

// ── 4. Every driven route must export the method the driver uses ───────────
//
// The driver sent POST to every route. Four of them export GET only, so those
// scheduled runs returned 405 and did no work — "driven" in the workflow,
// dead in production, and green in this test until it started checking.
// Every cron route exports GET; only some export POST. (Codex review,
// 2026-08-11.)
const usesGet = /curl -sS -o \/tmp\/out\.json[^\n]*\n\s*"\$\{BASE\}\$\{path\}"/.test(driver);
assert.ok(
  usesGet && !/-X POST "\$\{BASE\}/.test(driver),
  "the driver must call cron routes with GET — four of them export GET only and 405 on POST",
);

for (const cron of crons) {
  const route = `app${basePathOf(cron.path)}/route.ts`;
  let src: string;
  try {
    src = readFileSync(route, "utf8");
  } catch {
    assert.fail(`${cron.path} is registered but ${route} does not exist`);
  }
  assert.ok(
    /export\s+(async\s+function|const)\s+GET\b/.test(src),
    `${cron.path} is driven with GET but ${route} does not export GET — it will 405 and do nothing`,
  );
}

// ── 5. Concurrency must be keyed per schedule ──────────────────────────────
//
// GitHub keeps one running and one pending run per concurrency group, and a
// new run evicts the pending one. Many of these schedules fire simultaneously
// (minute 0 of each hour lands */5, */10, */15, */30 and the hourly entry at
// once), so a single shared group would silently drop most of them.
assert.ok(
  /group:\s*cron-driver-\$\{\{\s*github\.event\.schedule/.test(driver),
  "concurrency must be keyed by github.event.schedule, or simultaneous schedules evict each other",
);

// ── 6. The watchdog itself must be driven ──────────────────────────────────
// If health-check stops running, every other check in the system goes quiet
// while reporting nothing wrong. It is the one route whose absence hides all
// the others.
assert.ok(
  driver.includes("/api/cron/health-check"),
  "health-check MUST be driven — without it no check in the fleet can alert",
);

console.log(
  `cron-driver-coverage.test.ts — ${crons.length} crons registered, Worker-driven, GitHub manual-only, all schedules valid ✓`,
);
