/**
 * Revenue-goal arithmetic — pure, so tests/revenue-goal.test.ts executes it.
 *
 * Dates are calendar days in the operator's zone (America/Toronto) as ISO
 * `YYYY-MM-DD`; the goal's `period_end` is INCLUSIVE — "by October 24" means
 * money collected on the 24th still counts. All money is integer cents.
 */

export type RevenueGoal = {
  id: string;
  label: string;
  target_cents: number;
  currency: "USD" | "CAD";
  period_start: string;
  period_end: string;
};

export type GoalProgress = {
  collected_cents: number;
  remaining_cents: number;
  pct: number;
  /** Calendar days left INCLUDING today, 0 once the period is over. */
  days_left: number;
  /** Cents per remaining day to land the target on time; 0 once met or over. */
  daily_need_cents: number;
  status: "upcoming" | "on_track" | "behind" | "met" | "missed";
};

const DAY_MS = 86_400_000;

function dayNumber(isoDate: string): number {
  const ms = Date.parse(`${isoDate}T00:00:00Z`);
  if (!Number.isFinite(ms)) throw new Error(`invalid date: ${isoDate}`);
  return Math.floor(ms / DAY_MS);
}

/** The day after `isoDate` — for [from, to) range queries over an inclusive end. */
export function nextDay(isoDate: string): string {
  return new Date((dayNumber(isoDate) + 1) * DAY_MS).toISOString().slice(0, 10);
}

export function computeGoalProgress(goal: RevenueGoal, collectedCents: number, today: string): GoalProgress {
  const collected = Math.max(0, Math.round(collectedCents));
  const remaining = Math.max(0, goal.target_cents - collected);
  const pct = goal.target_cents > 0 ? Math.round((collected / goal.target_cents) * 1000) / 10 : 0;

  const start = dayNumber(goal.period_start);
  const end = dayNumber(goal.period_end);
  const now = dayNumber(today);
  const totalDays = end - start + 1;
  const daysLeft = now > end ? 0 : Math.min(totalDays, end - Math.max(now, start) + 1);
  const dailyNeed = remaining > 0 && daysLeft > 0 ? Math.ceil(remaining / daysLeft) : 0;

  let status: GoalProgress["status"];
  if (remaining === 0) status = "met";
  else if (now > end) status = "missed";
  else if (now < start) status = "upcoming";
  else {
    // Straight-line pace: by the end of today we should have collected this
    // share of the target. Behind means below that line.
    const elapsed = now - start + 1;
    const paceCents = Math.round((goal.target_cents * elapsed) / totalDays);
    status = collected >= paceCents ? "on_track" : "behind";
  }

  return {
    collected_cents: collected,
    remaining_cents: remaining,
    pct,
    days_left: daysLeft,
    daily_need_cents: dailyNeed,
    status,
  };
}
