/**
 * tests/health-formula.test.ts — the scoring contract.
 *
 * The formula engine is pure, so all of this runs with no database and no clock.
 * These assertions encode the rules that are easy to "simplify" into bugs later.
 */
import assert from "node:assert/strict";
import {
  median,
  normalizeErrorRate,
  normalizeLatency,
  normalizeOutcome,
  scoreObservation,
} from "../lib/health/formula";
import { DEFAULT_THRESHOLDS, DEFAULT_WEIGHTS, type HealthWeights } from "../lib/health/types";

const BANDS = { healthyAt: 0.8, degradedAt: 0.5 };

/* -------------------------------------------------------------- */
/* Latency                                                         */
/* -------------------------------------------------------------- */
assert.equal(normalizeLatency(500, 2000), 1, "under budget is full marks");
assert.equal(normalizeLatency(2000, 2000), 1, "at budget is still full marks");
assert.equal(normalizeLatency(6000, 2000), 0, "3x budget is zero");
assert.ok(
  normalizeLatency(4000, 2000) > 0 && normalizeLatency(4000, 2000) < 1,
  "between budget and 3x decays rather than cliffing",
);
assert.equal(normalizeLatency(99999, 0), 1, "no budget configured means latency cannot fail");

/* -------------------------------------------------------------- */
/* Error rate                                                      */
/* -------------------------------------------------------------- */
assert.equal(normalizeErrorRate(0, 0.1), 1, "no errors is full marks");
assert.equal(normalizeErrorRate(0.1, 0.1), 0, "at the ceiling is zero");
assert.equal(normalizeErrorRate(0.5, 0.1), 0, "past the ceiling stays zero, never negative");
assert.equal(normalizeErrorRate(0.05, 0.1), 0.5, "halfway to the ceiling is half marks");

/* -------------------------------------------------------------- */
/* Outcome — the component that catches silent failure             */
/* -------------------------------------------------------------- */
const T = DEFAULT_THRESHOLDS;
assert.equal(normalizeOutcome(100, 100, T), 1, "at the median is healthy");
assert.equal(normalizeOutcome(200, 100, T), 1, "above the median caps at 1, never rewards a spike");
assert.equal(normalizeOutcome(0, 100, T), 0, "produced nothing against a live median is zero");
assert.equal(normalizeOutcome(25, 100, T), 0, "at the 25% floor is zero");
assert.ok(normalizeOutcome(60, 100, T) > 0, "a partial drop degrades rather than breaching");

// A brand-new check has no baseline. It must not page.
assert.equal(normalizeOutcome(0, undefined, T), 1, "no median yet cannot manufacture an outage");
assert.equal(normalizeOutcome(0, 0, T), 1, "a zero median is not a usable baseline");

// Low-volume escape hatch: with a median of 2, one quiet tick is noise.
assert.equal(
  normalizeOutcome(1, 100, { outcome_floor_pct: 0.25, min_absolute: 1 }),
  1,
  "min_absolute overrides the median-relative rule",
);

/* -------------------------------------------------------------- */
/* THE load-bearing rule: unreported != zero                       */
/* -------------------------------------------------------------- */
{
  // A check that reports ONLY outcome, and reports it perfectly, must score
  // 1.0 — not 0.4 (its outcome weight). Without renormalization every
  // single-component check would look permanently broken.
  const r = scoreObservation({ outcomeValue: 100, outcomeMedian: 100 }, DEFAULT_WEIGHTS, T, BANDS);
  assert.equal(r.score, 1, "a healthy single-component check scores 1.0, not its raw weight");
  assert.equal(r.status, "healthy");
  assert.deepEqual(
    r.breakdown.excluded.sort(),
    ["error_rate", "latency", "uptime"],
    "unreported components are recorded as excluded",
  );
  assert.equal(
    r.breakdown.components.outcome?.effectiveWeight,
    1,
    "the surviving component absorbs the full weight",
  );
}

{
  // Regression guard for the tempting "just default missing components to 0"
  // simplification: it would score this healthy check at 0.4 and page.
  const r = scoreObservation({ uptime: 1 }, DEFAULT_WEIGHTS, T, BANDS);
  assert.equal(r.status, "healthy", "an up check with no other signal is healthy, not degraded");
}

/* -------------------------------------------------------------- */
/* Zero weight means excluded, not "counted as zero"               */
/* -------------------------------------------------------------- */
{
  const weights: HealthWeights = { uptime: 1, error_rate: 0, latency: 0, outcome: 0 };
  const r = scoreObservation({ uptime: 1, latencyP95Ms: 999_999 }, weights, T, BANDS);
  assert.equal(r.score, 1, "a zero-weighted component cannot drag the score down");
  assert.ok(r.breakdown.excluded.includes("latency"), "zero-weighted latency is excluded");
}

/* -------------------------------------------------------------- */
/* Observer failure is 'unknown', never 'down'                     */
/* -------------------------------------------------------------- */
{
  const r = scoreObservation({ error: "query_failed: relation missing" }, DEFAULT_WEIGHTS, T, BANDS);
  assert.equal(
    r.status,
    "unknown",
    "the monitor failing to look must never be reported as the feature being down",
  );
  assert.notEqual(r.status, "down");
}

{
  // Nothing scoreable reported at all is also unknown, not a false green.
  const r = scoreObservation({}, DEFAULT_WEIGHTS, T, BANDS);
  assert.equal(r.status, "unknown", "an empty observation is unknown, not healthy");
}

/* -------------------------------------------------------------- */
/* A silently-dead feature scores DOWN even while fast and clean   */
/* -------------------------------------------------------------- */
{
  // This is the exact shape of both 2026 outages: process up, no errors,
  // fast responses, and zero actual output.
  const r = scoreObservation(
    { uptime: 1, errorRate: 0, latencyP95Ms: 50, outcomeValue: 0, outcomeMedian: 500 },
    DEFAULT_WEIGHTS,
    T,
    BANDS,
  );
  assert.equal(
    r.status,
    "down",
    "up + fast + error-free + producing nothing must score DOWN, or this system has no reason to exist",
  );
  assert.equal(
    r.breakdown.dominantFailure,
    "outcome",
    "and the reason must be recorded, so a 60%-scoring DOWN check is explainable",
  );

  // Prove the override is what produces 'down' — the raw average alone does
  // not. Without the dominant rule this scores 0.6 and reports 'degraded',
  // which is an ignorable amber for a completely dead feature.
  assert.ok(
    r.score >= 0.5,
    `the weighted average alone would have said 'degraded' (score ${r.score}); the dominant-component override is doing the work`,
  );

  const withoutOverride = scoreObservation(
    { uptime: 1, errorRate: 0, latencyP95Ms: 50, outcomeValue: 0, outcomeMedian: 500 },
    DEFAULT_WEIGHTS,
    { ...T, dominant_zero_is_down: false },
    BANDS,
  );
  assert.equal(
    withoutOverride.status,
    "degraded",
    "with the override disabled the average hides the outage — this is the bug the rule exists to prevent",
  );
}

/* -------------------------------------------------------------- */
/* A non-dominant component at zero does NOT force down            */
/* -------------------------------------------------------------- */
{
  // Latency is weighted 0.1. A slow-but-producing feature is degraded at
  // worst, never 'down' — otherwise every minor component becomes a pager.
  const r = scoreObservation(
    { uptime: 1, errorRate: 0, latencyP95Ms: 999_999, outcomeValue: 500, outcomeMedian: 500 },
    DEFAULT_WEIGHTS,
    T,
    BANDS,
  );
  assert.equal(r.status, "healthy", "a minor component at zero must not force down");
  assert.equal(r.breakdown.dominantFailure, undefined);
}

/* -------------------------------------------------------------- */
/* Garbage in cannot poison the score                              */
/* -------------------------------------------------------------- */
{
  const r = scoreObservation(
    { uptime: Number.NaN, errorRate: -5, latencyP95Ms: -1, outcomeValue: 10, outcomeMedian: 10 },
    DEFAULT_WEIGHTS,
    T,
    BANDS,
  );
  assert.ok(Number.isFinite(r.score), "score stays finite against NaN/negative input");
  assert.ok(r.score >= 0 && r.score <= 1, "score stays inside [0,1]");
}

/* -------------------------------------------------------------- */
/* Median                                                          */
/* -------------------------------------------------------------- */
assert.equal(median([]), undefined, "no samples means no baseline");
assert.equal(median([5]), 5);
assert.equal(median([1, 3, 5]), 3);
assert.equal(median([1, 2, 3, 4]), 2.5);
assert.equal(median([10, 1, 5]), 5, "median sorts before picking");

console.log("health-formula.test.ts: all assertions passed");
