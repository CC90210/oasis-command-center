/**
 * tests/health-coverage.test.ts — coverage is DERIVED, not declared.
 *
 * The root cause of the 2026-08-06 incident was a hand-maintained watch list:
 * 9 services listed, ~20 cron routes in the estate, and everything not on the
 * list invisible. These assertions pin that discovery reads the real config, so
 * adding a cron cannot silently escape monitoring.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cronPathsFrom, cronCheckId, computeCoverage } from "../lib/health/coverage";

// ── Discovery reads the REAL vercel.json, not a hardcoded list ──────────────
const vercel = JSON.parse(readFileSync("vercel.json", "utf8"));
const paths = cronPathsFrom(vercel);

assert.ok(paths.length >= 15, `expected the real cron list, got ${paths.length}`);
assert.ok(paths.includes("/api/cron/dispatch-drips"), "the drip dispatcher must be discovered");
assert.ok(paths.includes("/api/cron/enroll-drips"), "the enroller must be discovered");
assert.ok(paths.includes("/api/cron/health-check"), "the health check itself is registered as a cron");

// Query strings are stripped, so ?write=1 and the bare path are one route.
assert.ok(!paths.some((p) => p.includes("?")), "query strings must not create duplicate routes");
assert.equal(new Set(paths).size, paths.length, "paths must be distinct");

// Malformed config degrades to empty rather than throwing. A discovery bug must
// not take the whole monitor down.
assert.deepEqual(cronPathsFrom(null), []);
assert.deepEqual(cronPathsFrom({}), []);
assert.deepEqual(cronPathsFrom({ crons: "nonsense" }), []);
assert.deepEqual(cronPathsFrom({ crons: [{ notpath: 1 }] }), []);

// ── Check ids are stable and derivable ─────────────────────────────────────
assert.equal(cronCheckId("/api/cron/dispatch-drips"), "cron.dispatch-drips.ran");
assert.equal(cronCheckId("/api/cron/scan-bounces"), "cron.scan-bounces.ran");

// ── The gap is REPORTABLE ──────────────────────────────────────────────────
// This is the mechanism that stops the incident recurring: anything discovered
// with no check attached is surfaced rather than silently uncovered.
{
  const cov = computeCoverage({ vercelConfig: vercel, knownCheckIds: [] });
  assert.ok(
    cov.uncovered.length > 0,
    "with no checks registered, every discovered surface must report as uncovered",
  );
  assert.ok(cov.uncovered.includes("cron.dispatch-drips.ran"));
  assert.ok(cov.uncovered.includes("brand.sunbiz.sendable"));
  assert.ok(cov.uncovered.includes("brand.bluerise.sendable"), "a new brand inherits coverage automatically");
}

// Registering a check removes it from the gap.
{
  const cov = computeCoverage({
    vercelConfig: vercel,
    knownCheckIds: ["cron.dispatch-drips.ran", "brand.sunbiz.sendable", "brand.bluerise.sendable"],
  });
  assert.ok(!cov.uncovered.includes("cron.dispatch-drips.ran"));
  assert.ok(!cov.uncovered.includes("brand.sunbiz.sendable"));
}

// The health check does not monitor itself. That would be circular and would
// always read healthy for the wrong reason.
{
  const cov = computeCoverage({ vercelConfig: vercel, knownCheckIds: [] });
  assert.ok(
    !cov.uncovered.includes("cron.health-check.ran"),
    "the monitor must not be its own coverage gap — the reverse dead-man's switch covers it",
  );
}

// Sequences discovered from the database extend coverage the same way.
{
  const cov = computeCoverage({
    vercelConfig: vercel,
    knownCheckIds: [],
    sequenceStages: ["follow_up", "signed_application"],
  });
  assert.ok(cov.uncovered.includes("drips.follow_up.sent_24h"));
  assert.ok(cov.uncovered.includes("drips.signed_application.sent_24h"));
}

console.log(`health-coverage.test.ts — ${paths.length} cron routes discovered ✓`);
