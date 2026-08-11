/**
 * tests/health-checks.test.ts — the rules that decide whether Adon gets woken.
 *
 * Written after SMS failed silently for three weeks. The failure this file
 * exists to prevent is a monitor that reports healthy while the thing it
 * watches is dead, so the assertions lean hard on the "must fail" cases.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { evaluate, median, worstVerdict, alertSignature } from "../lib/health/checks-core";

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

// ── Shopping out, 2026-08-06 → 2026-08-11 ──────────────────────────────────
// Physically dead for five days while every monitor read green, because not one
// check watched the lender side. The numbers below are the REAL production
// counts measured on 2026-08-11 during the audit, so these assertions record an
// outage that happened rather than one that seemed plausible.
{
  // Six lender packages queued at 14:38Z, the dispatch failed, and the rows sat
  // at pending with last_error NULL. Measured: 6.
  const r = evaluate("shopout.threads_stuck_pending", { kind: "must_be_zero" }, 6, []);
  assert.equal(r.verdict, "failing", "six deals stuck unsent MUST page");
}
{
  // The same check on a healthy system: a queue that drains is not an alert.
  const r = evaluate("shopout.threads_stuck_pending", { kind: "must_be_zero" }, 0, []);
  assert.equal(r.verdict, "ok", "an empty pending queue must not alert");
}
{
  // The reply side. Note what is NOT asserted here: "threads at 'sent' with no
  // movement for 3 days". That was the first draft and it was wrong — a lender
  // that has not replied leaves its thread at 'sent' by design, and 898 rows
  // sit at 'no_response' because that is the normal end state. A 3-day window
  // pages on every quiet lender. The invariant that cannot be produced by
  // lender behaviour is the 10-day SLA sweep failing to retire a thread.
  // Measured on 2026-08-11: 0, i.e. green, no false alarm on arrival.
  const r = evaluate("shopout.sla_sweep_stalled", { kind: "must_be_zero" }, 0, []);
  assert.equal(r.verdict, "ok", "quiet lenders must not page");
}
{
  // And it fires when the sweep genuinely stalls.
  const r = evaluate("shopout.sla_sweep_stalled", { kind: "must_be_zero" }, 12, []);
  assert.equal(r.verdict, "failing", "a stalled SLA sweep MUST page");
}
{
  // sent_without_proof must be GREEN on the current fleet. This is the
  // false-alarm guard: the first draft keyed on gmail_thread_id, which the SMTP
  // sender never populates (null on 55 of 55 sent threads), so it would have
  // gone red on 100% of history the moment it deployed. The receipt that IS
  // written is send_interaction_id (55 of 55). A monitor whose first act is a
  // false alarm is one people learn to ignore.
  const r = evaluate("shopout.sent_without_proof", { kind: "must_be_zero" }, 0, []);
  assert.equal(r.verdict, "ok", "the receipt check must be green on today's data");
}
{
  // And it must still fire when a status is moved with no send behind it.
  const r = evaluate("shopout.sent_without_proof", { kind: "must_be_zero" }, 3, []);
  assert.equal(r.verdict, "failing");
}
{
  // The checks must be registered, or they cannot run. Guards a merge that
  // keeps these tests and drops the checks.
  const src = readFileSync("lib/health/drip-checks.ts", "utf8");
  for (const id of [
    "shopout.threads_stuck_pending",
    "shopout.sent_without_proof",
    "shopout.sla_sweep_stalled",
  ]) {
    assert.ok(src.includes(`id: "${id}"`), `${id} must be registered in DRIP_CHECKS`);
  }
  // Three column choices are load-bearing, and all three are exactly the kind a
  // later pass "corrects" back to the obvious-looking wrong one.
  assert.ok(
    !/is\("gmail_thread_id", null\)/.test(src),
    "sent_without_proof must not key on gmail_thread_id — the SMTP path never sets it",
  );
  assert.ok(
    !/eq\("status", "pending"\)\s*\n?\s*\.lt\("created_at"/.test(src),
    "stuck_pending must measure from updated_at — retry resets status but not created_at",
  );
  assert.ok(
    /\.lt\("sent_at", iso\(endMs - 14 \* DAY\)\)/.test(src),
    "the reply-side check must key on the SLA sweep invariant (sent_at past the 14-day grace), " +
      "not on how long a lender has been quiet",
  );
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

// ── Alert decay is NOT reimplemented here ──────────────────────────────────
// It lives in lib/notify/alert-decay.ts. Two decay implementations that must
// agree is the exact drift this codebase was bitten by twice this week. This
// file only supplies the SIGNATURE, which must describe the condition rather
// than the rendered message — embedding a changing number defeats suppression.
assert.equal(alertSignature("sms.delivered_24h", "failing"), "health:sms.delivered_24h:failing");
assert.equal(
  alertSignature("sms.delivered_24h", "failing"),
  alertSignature("sms.delivered_24h", "failing"),
  "the same condition must produce a stable signature across runs",
);
assert.notEqual(
  alertSignature("sms.delivered_24h", "failing"),
  alertSignature("sms.delivered_24h", "degraded"),
  "a change in severity is news, not a repeat",
);
{
  const core = readFileSync("lib/health/checks-core.ts", "utf8");
  assert.ok(!/export function shouldAlert/.test(core),
    "checks-core must NOT define its own shouldAlert — alert-decay owns the ladder");
}

console.log("health-checks.test.ts — all assertions passed ✓");
