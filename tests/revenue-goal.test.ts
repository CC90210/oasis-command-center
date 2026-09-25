/**
 * tests/revenue-goal.test.ts — the Today countdown's arithmetic (2026-09-24).
 *
 * CC's October sprint: at least US$6,000 COLLECTED between 2026-09-24 and
 * 2026-10-24 (the deadline day counts). Replaces a hand-typed MRR target with a
 * silent $5,000 fallback.
 *
 * Run: node --conditions=react-server --import tsx tests/revenue-goal.test.ts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildPaceSeries, computeGoalProgress, nextDay, validateGoalInput, type RevenueGoal } from "../lib/goals/goal-math";

const goal: RevenueGoal = {
  id: "goal-oasis-2026-10",
  label: "October sprint — revenue collected",
  target_cents: 600_000,
  currency: "USD",
  period_start: "2026-09-24",
  period_end: "2026-10-24",
};

// Day one, nothing collected: 31 days including today and the deadline.
{
  const p = computeGoalProgress(goal, 0, "2026-09-24");
  assert.equal(p.days_left, 31);
  assert.equal(p.remaining_cents, 600_000);
  assert.equal(p.daily_need_cents, Math.ceil(600_000 / 31));
  assert.equal(p.status, "behind", "zero on day one is behind a straight-line pace");
}

// On the deadline day itself there is exactly one day left.
{
  const p = computeGoalProgress(goal, 590_000, "2026-10-24");
  assert.equal(p.days_left, 1);
  assert.equal(p.daily_need_cents, 10_000);
}

// Met early: no daily need, 100%+.
{
  const p = computeGoalProgress(goal, 612_345, "2026-10-10");
  assert.equal(p.status, "met");
  assert.equal(p.daily_need_cents, 0);
  assert.equal(p.remaining_cents, 0);
  assert.equal(p.pct, 102.1);
}

// After the deadline, short: missed with 0 days left.
{
  const p = computeGoalProgress(goal, 100_000, "2026-10-25");
  assert.equal(p.status, "missed");
  assert.equal(p.days_left, 0);
  assert.equal(p.daily_need_cents, 0);
}

// Pace is a straight line through the END of today. Oct 8 is day 15 of 31,
// so the line sits at 600000*15/31 = 290,323 cents; Oct 9 (day 16) at 309,678.
{
  assert.equal(computeGoalProgress(goal, 300_000, "2026-10-08").status, "on_track");
  assert.equal(computeGoalProgress(goal, 300_000, "2026-10-09").status, "behind");
}

// Pace series: one point per period day, cumulative collected, stops at today.
{
  const series = buildPaceSeries(
    goal,
    [
      { date: "2026-09-24", usd_cents: 10_000 },
      { date: "2026-09-26", usd_cents: 25_050 },
      { date: "2026-10-30", usd_cents: 99_999 }, // outside the period: ignored
    ],
    "2026-09-26",
  );
  assert.equal(series.length, 31);
  assert.deepEqual(series[0], { date: "09-24", collected: 100, pace: 193.55 });
  assert.equal(series[1].collected, 100, "a zero day carries the running total");
  assert.equal(series[2].collected, 350.5);
  assert.equal(series[3].collected, null, "no line drawn for days that have not happened");
  assert.equal(series[30].pace, 6000, "the pace line lands exactly on the target on the deadline");
}

// Founder-entered goals are validated before they can replace the active one.
{
  const ok = { label: "November", target_cents: 800_000, currency: "USD" as const, period_start: "2026-10-25", period_end: "2026-11-24" };
  assert.equal(validateGoalInput(ok), null);
  assert.match(validateGoalInput({ ...ok, label: " " }) ?? "", /label/);
  assert.match(validateGoalInput({ ...ok, target_cents: 0 }) ?? "", /positive/);
  assert.match(validateGoalInput({ ...ok, target_cents: 12.5 }) ?? "", /whole number/);
  assert.match(validateGoalInput({ ...ok, currency: "EUR" as never }) ?? "", /currency/);
  assert.match(validateGoalInput({ ...ok, period_end: "2026-10-01" }) ?? "", /end on or after/);
  assert.match(validateGoalInput({ ...ok, period_start: "2026-13-45" }) ?? "", /real calendar|YYYY/);
}

// No hand-typed MRR path survives anywhere the app edits a profile.
{
  const policy = readFileSync("lib/profile-edit-policy.ts", "utf8");
  const actions = readFileSync("lib/agent-actions.ts", "utf8");
  const editor = readFileSync("components/settings/ProfileEditor.tsx", "utf8");
  for (const [name, src] of [["profile-edit-policy", policy], ["agent-actions", actions], ["ProfileEditor", editor]] as const) {
    assert.equal(/"mrr_(target_usd|current_usd|target_date)"|mrr_current_usd:/.test(src), false, `${name} still lets someone type MRR`);
  }
  const route = readFileSync("app/api/goals/route.ts", "utf8");
  assert.match(route, /isTrueAdminRole/, "only true admins may replace the goal");
}

assert.equal(nextDay("2026-10-24"), "2026-10-25", "the inclusive end becomes an exclusive [from, to) bound");
assert.equal(nextDay("2026-12-31"), "2027-01-01");

// Wiring: the goal is a row, not profile columns, and the seed matches CC's numbers.
{
  const migration = readFileSync("database/turso/182_revenue_goals.turso.sql", "utf8");
  assert.match(migration, /600000, 'USD', '2026-09-24', '2026-10-24'/);
  assert.match(migration, /WHERE status = 'active'/, "one active goal per workspace");
}

console.log("revenue-goal: all assertions passed");
