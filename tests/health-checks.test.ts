/**
 * tests/health-checks.test.ts — the rules that decide whether Adon gets woken.
 *
 * Written after SMS failed silently for three weeks. The failure this file
 * exists to prevent is a monitor that reports healthy while the thing it
 * watches is dead, so the assertions lean hard on the "must fail" cases.
 */

import assert from "node:assert/strict";
import { evaluate, median, worstVerdict, shouldAlert } from "../lib/health/checks-core";

// ── median ─────────────────────────────────────────────────────────────────
assert.equal(median([]), null);
assert.equal(median([5]), 5);
assert.equal(median([1, 2, 3]), 2);
assert.equal(median([1, 2, 3, 4]), 2.5);
// Median, not mean, so a single outage day cannot drag the baseline down and
// quietly normalise the failure.
assert.equal(median([20, 20, 20, 20, 0]), 20, "one zero day must not move the baseline");

// ── A check that could not run is NOT a pass ───────────────────────────────
// This is the single most important behaviour here.
for (const bad of [null, NaN]) {
  const r = evaluate("x", { kind: "must_be_above", floor: 0 }, bad as number | null, []);
  assert.equal(r.verdict, "check_broken", "an errored check must never read as ok");
}

// ── must_be_zero: invariants ───────────────────────────────────────────────
assert.equal(evaluate("x", { kind: "must_be_zero" }, 0, []).verdict, "ok");
assert.equal(evaluate("x", { kind: "must_be_zero" }, 1, []).verdict, "failing");
assert.equal(evaluate("x", { kind: "must_be_zero" }, 865, []).verdict, "failing");

// ── must_be_above: absolute floors ─────────────────────────────────────────
assert.equal(evaluate("x", { kind: "must_be_above", floor: 0 }, 5, []).verdict, "ok");
assert.equal(evaluate("x", { kind: "must_be_above", floor: 0 }, 0, []).verdict, "failing");

// ── baseline_drop ──────────────────────────────────────────────────────────
const drop = { kind: "baseline_drop", failingBelowPct: 0.25, degradedBelowPct: 0.6 } as const;
const normal = [20, 22, 18, 21, 19, 20, 20];

assert.equal(evaluate("x", drop, 20, normal).verdict, "ok");
// Thresholds are exclusive: "below 60%" means 60% itself is still ok.
assert.equal(evaluate("x", drop, 12, normal).verdict, "ok", "exactly 60% is the boundary, not a breach");
assert.equal(evaluate("x", drop, 11, normal).verdict, "degraded", "55% of baseline is degraded");
assert.equal(evaluate("x", drop, 3, normal).verdict, "failing", "15% of baseline is failing");
assert.equal(evaluate("x", drop, 0, normal).verdict, "failing", "zero is failing");

// Not enough history: report ok rather than alerting on noise for two weeks.
assert.equal(evaluate("x", drop, 0, [20, 20]).verdict, "ok");
assert.match(evaluate("x", drop, 0, [20, 20]).reason, /insufficient history/);

// A baseline of zero means nothing has ever happened here. 0 -> 0 must not be a
// permanent alert.
assert.equal(evaluate("x", drop, 0, [0, 0, 0, 0, 0, 0]).verdict, "ok");

// ── THE REGRESSION TESTS: both real outages must be detected ───────────────
// SMS, 2026-07-13 onward. Normal was ~20 delivered/day; delivered went to 0
// while the engine still reported rows as 'sent'.
{
  const r = evaluate("sms.delivered_24h", drop, 0, [20, 22, 18, 21, 19, 20, 20]);
  assert.equal(r.verdict, "failing", "the SMS outage MUST be detected on day one");
  assert.match(r.reason, /0 vs a normal 20/);
}
// The invariant that would have caught it even faster: rows marked sent with no
// provider message id. 865 of them existed.
{
  const r = evaluate("sms.sent_without_proof", { kind: "must_be_zero" }, 865, []);
  assert.equal(r.verdict, "failing");
}
// Email, 2026-08-06. ~14/day normal, went to 0 when the app password died.
{
  const r = evaluate("email.sent_24h", drop, 0, [14, 17, 13, 15, 16, 14, 12]);
  assert.equal(r.verdict, "failing", "the email outage MUST be detected within a day");
}
// And the credential probe would have caught it in minutes.
{
  const r = evaluate("email.smtp_auth", { kind: "must_be_above", floor: 0 }, 0, []);
  assert.equal(r.verdict, "failing");
}

// ── worstVerdict ───────────────────────────────────────────────────────────
assert.equal(worstVerdict([]), "ok");
assert.equal(worstVerdict([{ verdict: "ok" }, { verdict: "degraded" }] as never), "degraded");
assert.equal(worstVerdict([{ verdict: "degraded" }, { verdict: "failing" }] as never), "failing");
assert.equal(
  worstVerdict([{ verdict: "ok" }, { verdict: "check_broken" }] as never),
  "check_broken",
  "a broken check outranks a healthy one — it means we do not know",
);

// ── The alert ladder ───────────────────────────────────────────────────────
const HOUR = 3_600_000;
const NOW = 1_000 * HOUR;

// Healthy never alerts.
assert.equal(shouldAlert({ verdict: "ok", lastAlertedAtMs: null, firstFailedAtMs: null, nowMs: NOW }), false);
// First failure always alerts, immediately.
assert.equal(shouldAlert({ verdict: "failing", lastAlertedAtMs: null, firstFailedAtMs: NOW, nowMs: NOW }), true);
// Within the first hour, do not re-alert 5 minutes later.
assert.equal(
  shouldAlert({ verdict: "failing", lastAlertedAtMs: NOW - 5 * 60_000, firstFailedAtMs: NOW - 5 * 60_000, nowMs: NOW }),
  false,
  "ten checks failing must not produce ten messages a minute",
);
// After an hour of failing, re-alert hourly.
assert.equal(
  shouldAlert({ verdict: "failing", lastAlertedAtMs: NOW - 61 * 60_000, firstFailedAtMs: NOW - 61 * 60_000, nowMs: NOW }),
  true,
);
// Failing for a day: back off to daily, not hourly.
assert.equal(
  shouldAlert({ verdict: "failing", lastAlertedAtMs: NOW - 7 * HOUR, firstFailedAtMs: NOW - 30 * HOUR, nowMs: NOW }),
  false,
  "a day-old condition must not page every hour",
);
assert.equal(
  shouldAlert({ verdict: "failing", lastAlertedAtMs: NOW - 25 * HOUR, firstFailedAtMs: NOW - 30 * HOUR, nowMs: NOW }),
  true,
  "after a day the daily re-alert must still fire",
);
// A broken check alerts on the same ladder — not knowing is not healthy.
assert.equal(
  shouldAlert({ verdict: "check_broken", lastAlertedAtMs: null, firstFailedAtMs: NOW, nowMs: NOW }),
  true,
  "a check that cannot run must alert, not stay silent",
);

console.log("health-checks.test.ts — all assertions passed ✓");
