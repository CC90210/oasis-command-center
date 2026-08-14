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

  const absolute = evaluate(
    "drips.email_volume_vs_target",
    { kind: "must_reach", target: 40, failingBelow: 13 },
    10,
    weekOfTen,
  );
  assert.equal(absolute.verdict, "failing", "against the agreed number, 10 is a failure whatever the history");
  assert.match(absolute.reason, /far below the target of 40/);
}

// ── must_reach: short of target and dead pipe are DIFFERENT events ────────
// The first draft used must_be_above with a floor of target/3. That rule has
// no degraded verdict, so 30 against a target of 40 read as plain ok and the
// monitor said nothing — while the literal ask was to be told when volume is
// below what was agreed. Codex caught it in review.
{
  const target = 40;
  const rule = { kind: "must_reach", target, failingBelow: Math.max(1, Math.floor(target / 3)) } as const;

  assert.equal(evaluate("v", rule, 40, []).verdict, "ok", "hitting the target is ok");
  assert.equal(evaluate("v", rule, 120, []).verdict, "ok", "over target is ok");

  // THE regression: this is the case the old rule got wrong.
  const behind = evaluate("v", rule, 30, []);
  assert.equal(behind.verdict, "degraded", "behind target must be reported, not swallowed");
  assert.match(behind.reason, /short of the target of 40/);

  assert.equal(evaluate("v", rule, 39, []).verdict, "degraded", "no silent grace band — that is grading on a curve again");
  assert.equal(evaluate("v", rule, 13, []).verdict, "degraded", "at the outage threshold is still merely behind");
  assert.equal(evaluate("v", rule, 12, []).verdict, "failing", "below it is an outage");
  assert.equal(evaluate("v", rule, 0, []).verdict, "failing", "zero is always an outage");
  assert.equal(evaluate("v", rule, null, []).verdict, "check_broken");
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

  // Dry runs must not count as sends ANYWHERE. With DRIPS_LIVE off the executor
  // still writes email_sent interactions stamped dry_run, so a check that reads
  // them as real stays green forever while nothing leaves the building. The
  // silence check originally took the newest row of any kind; both read paths
  // now filter, and both must keep filtering.
  const silenceFn = src.slice(src.indexOf("async function hoursSinceLastEmail"), src.indexOf("const CHECKS"));
  assert.ok(silenceFn.length > 100, "hoursSinceLastEmail must exist");
  assert.ok(silenceFn.includes("dry_run"), "the silence check must exclude dry runs, not just the volume check");
  // A single page lets a dry-run burst longer than the page hide the last real
  // send, and the old fallback then fabricated 999h — a false outage out of a
  // busy rehearsal. Paged scan, and the give-up value is a row we actually saw.
  assert.ok(silenceFn.includes(".range("), "the scan must paginate, not read one fixed page");
  assert.ok(silenceFn.includes("oldestSeen"), "on hitting the cap, report the provable lower bound");
  // 999 stays for the genuine never-sent-at-all case, which IS maximal silence.
  // What must not happen is reaching it while rows exist, so the lower-bound
  // assignment has to come first.
  const bound = silenceFn.indexOf("if (!last && oldestSeen) last = oldestSeen;");
  const giveUp = silenceFn.indexOf("if (!last) return 999;");
  assert.ok(bound > 0 && giveUp > 0, "both the lower bound and the never-sent fallback must be present");
  assert.ok(bound < giveUp, "999 is only reachable after the lower bound has been tried — never while rows exist");
  assert.equal(
    (src.match(/dry_run/g) || []).length >= 2,
    true,
    "both the volume count and the silence timestamp exclude dry runs",
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
