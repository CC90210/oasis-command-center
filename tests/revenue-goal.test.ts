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
import { computeGoalProgress, nextDay, type RevenueGoal } from "../lib/goals/goal-math";

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

assert.equal(nextDay("2026-10-24"), "2026-10-25", "the inclusive end becomes an exclusive [from, to) bound");
assert.equal(nextDay("2026-12-31"), "2027-01-01");

// Wiring: the goal is a row, not profile columns, and the seed matches CC's numbers.
{
  const migration = readFileSync("database/turso/182_revenue_goals.turso.sql", "utf8");
  assert.match(migration, /600000, 'USD', '2026-09-24', '2026-10-24'/);
  assert.match(migration, /WHERE status = 'active'/, "one active goal per workspace");
}

console.log("revenue-goal: all assertions passed");
