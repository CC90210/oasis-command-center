/**
 * tests/email-drip-health.test.ts — the drip monitor must not grade on a curve.
 *
 * Adon, 2026-08-14: "the second that it is either not functional or sending out
 * the volume that we want, I should be alerted."
 *
 * THE BUG THIS EXISTS TO PREVENT is subtle and had already happened. The
 * pre-existing email.sent_24h check uses `baseline_drop`, comparing today
 * against a rolling median of recent days. That bar FOLLOWS THE FAILURE DOWN:
 * send 10/day for a week and the baseline becomes 10, the check turns green,
 * and the monitor certifies the broken state as normal. On 2026-08-13 it read
 * "19 vs a normal 51.5" — degraded, not failing — while the true figure against
 * what had been agreed was about a fifth of target.
 *
 * A relative check cannot answer "are we sending the volume we want", because
 * it does not know what we want. So these assertions pin the absolute rules.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { evaluate, median } from "../lib/health/checks-core";
import { isBenignSendFailure } from "../lib/health/email-drip-checks";

// ── must_be_below: the ceiling rule the silence check needs ───────────────
// Added for this monitor. Hours-of-silence is an observation where BIGGER IS
// WORSE, and expressing that as a floor on some inverted quantity reads
// backwards at 3am.
{
  const rule = { kind: "must_be_below", ceiling: 6 } as const;
  assert.equal(evaluate("silence", rule, 2, []).verdict, "ok");
  assert.equal(evaluate("silence", rule, 6, []).verdict, "ok", "at the limit is still within it");
  assert.equal(evaluate("silence", rule, 6.5, []).verdict, "failing");
  assert.equal(evaluate("silence", rule, 999, []).verdict, "failing", "never sent at all is maximal silence");

  // A check that could not run is NEVER a pass — the single rule the whole
  // monitoring layer rests on.
  assert.equal(evaluate("silence", rule, null, []).verdict, "check_broken");
}

// ── A rolling baseline normalises to the failure; an absolute floor does not ──
// Both are given the SAME history: a week of 10/day against a target of 40.
{
  const weekOfTen = [10, 10, 10, 10, 10, 10, 10];

  const relative = evaluate(
    "email.sent_24h",
    { kind: "baseline_drop", failingBelowPct: 0.25, degradedBelowPct: 0.6 },
    10,
    weekOfTen,
  );
  assert.equal(relative.verdict, "ok", "this is the trap: 10 looks fine once 10 is normal");

  const absolute = evaluate("drips.email_volume_vs_target", { kind: "must_be_above", floor: 13 }, 10, weekOfTen);
  assert.equal(absolute.verdict, "failing", "against the agreed number, 10 is a failure whatever the history");
  assert.match(absolute.reason, /at or below the floor/);
}

// ── The floor is a third of target, so a ramp behind schedule is not an outage ──
{
  const target = 40;
  const floor = Math.max(1, Math.floor(target / 3)); // 13
  assert.equal(evaluate("v", { kind: "must_be_above", floor }, 30, []).verdict, "ok", "behind target but clearly working");
  assert.equal(evaluate("v", { kind: "must_be_above", floor }, 10, []).verdict, "failing", "a fifth of target is a fault");
  assert.equal(evaluate("v", { kind: "must_be_above", floor }, 0, []).verdict, "failing", "zero is always a fault");
}

// ── Starvation is its own signal ──────────────────────────────────────────
// August's outage was not a broken sender — it was an empty queue. Every
// send-side check was green because sending was fine; there was nothing to
// send. So enrolment is checked directly rather than inferred from output.
{
  assert.equal(evaluate("enrol", { kind: "must_be_above", floor: 1 }, 0, []).verdict, "failing",
    "zero enrolments in 24h means the funnel stopped feeding the engine");
  assert.equal(evaluate("enrol", { kind: "must_be_above", floor: 1 }, 20, []).verdict, "ok");
}

// ── An overdue queue means the dispatcher is dead ─────────────────────────
{
  const rule = { kind: "must_be_zero" } as const;
  assert.equal(evaluate("due", rule, 0, []).verdict, "ok");
  assert.equal(evaluate("due", rule, 275, []).verdict, "failing",
    "rows overdue by more than an hour is the 2026-08-06 cron outage signature");
}

// ── Bluerise silence is invisible to an all-brand total ───────────────────
// The brand had a warm domain, working credentials and 512 leads pointed at it,
// and had sent zero emails in its lifetime — hidden because every aggregate
// check summed both brands.
{
  assert.equal(evaluate("bluerise", { kind: "must_be_above", floor: 0 }, 0, []).verdict, "failing",
    "a floor of 0 still fails at 0 — must_be_above is strict");
  assert.equal(evaluate("bluerise", { kind: "must_be_above", floor: 0 }, 1, []).verdict, "ok");
}

// ── A failure that is the system working must not page ────────────────────
// Production carries `suppressed (unsubscribed)` rows: compliance correctly
// declining to email an opt-out. Paging on correct behaviour is how a channel
// gets muted, and a muted channel is why the August outage ran for four days.
{
  for (const benign of [
    "suppressed (unsubscribed)",
    "SUPPRESSED (unsubscribed)",
    "lead has unsubscribed",
    "recipient opted out",
  ]) {
    assert.equal(isBenignSendFailure(benign), true, `should not page: ${benign}`);
  }
  for (const real of [
    "Invalid login: 535-5.7.8 Username and Password not accepted",
    "lead_not_found",
    "ETIMEDOUT",
    null,
    undefined,
    "",
  ]) {
    assert.equal(isBenignSendFailure(real), false, `must page: ${String(real)}`);
  }
}

// ── The bug this file exists to keep dead ─────────────────────────────────
// The first draft of the failure check filtered on sent_at. In production
// sent_at is stamped on SUCCESS only — all 36 failed rows have it null — so the
// check counted zero forever and would have read green straight through an
// outage. A decorative check is worse than no check because it occupies the
// slot. Asserted at the source level: there is no way to observe this from a
// pure unit test, and "we fixed it once" is not a guarantee.
{
  const src = readFileSync(new URL("../lib/health/email-drip-checks.ts", import.meta.url), "utf8");
  const failureFn = src.slice(src.indexOf("async function countRealFailures"), src.indexOf("const CHECKS"));
  assert.ok(failureFn.length > 100, "countRealFailures must exist — the failure check cannot be inlined back");
  assert.ok(failureFn.includes('.eq("status", "failed")'), "still scoped to failed rows");

  // Two sequence engines write to this database. Every check in this file must
  // read the OASIS drip engine (drip_runs / lead_interactions), never the
  // legacy Python daemon's sequence_state — a green number from the wrong
  // engine is the "verify contribution, not presence" failure in its purest
  // form, and the first draft of the enrolment check did exactly that.
  assert.ok(
    !src.includes('from("sequence_state")'),
    "sequence_state belongs to the legacy Python daemon — these checks watch the oasis drip engine",
  );
  assert.ok(failureFn.includes('.gte("claimed_at"'), "failed rows are windowed by claimed_at");
  // The explanatory comment names sent_at on purpose, so match the QUERY form
  // rather than the bare word.
  assert.ok(
    !/\.(gte|lte|lt|gt|eq)\(\s*"sent_at"/.test(failureFn),
    "sent_at is null on every failed row — windowing a failure query on it can never match",
  );
}

// ── median ignores one bad day rather than being dragged by it ────────────
assert.equal(median([10, 50, 52, 48, 51]), 50); // sorted [10,48,50,51,52] — the 10 does not pull it
assert.equal(median([]), null);

console.log("email-drip-health.test.ts — all assertions passed");
