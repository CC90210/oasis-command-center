/**
 * The OASIS money block — read ONCE, the same way, for every surface that shows
 * it (Today, Analytics). Two screens that each assembled "Net MRR" and "collected
 * vs goal" from their own queries is how Today read $6,263 while Stripe read
 * CA$100 (2026-09-24).
 *
 * Every figure is the Finances ledger or live Stripe (lib/founders-finances/
 * metrics.ts): the business entity's books, which carry no tenant key. So the
 * caller MUST gate on `capabilities.canSeeCompanyFinancials` (an OASIS-owned
 * workspace) before calling — this module assumes that check already passed.
 */
import "server-only";

import { safe } from "@/lib/api-helpers";
import { operatorDateKey } from "@/lib/dates";
import { getActiveRevenueGoal } from "@/lib/goals/revenue-goal";
import {
  buildPaceSeries,
  computeGoalProgress,
  nextDay,
  type GoalProgress,
  type RevenueGoal,
} from "@/lib/goals/goal-math";
import {
  revenueByCustomer,
  revenueCollected,
  revenueCollectedByDay,
  stripeMrr,
  usdPerCad,
} from "@/lib/founders-finances/metrics";
import { pinnedStripeAccount } from "@/lib/founders-finances/stripe-io";
import type { GoalPacePoint } from "@/components/charts/GoalPaceChart";

export type OasisMoney = {
  goal: RevenueGoal | null;
  collected: Awaited<ReturnType<typeof revenueCollected>> | null;
  last7: Awaited<ReturnType<typeof revenueCollected>> | null;
  mrr: Awaited<ReturnType<typeof stripeMrr>> | null;
  /**
   * False until a founder pins OASIS's Stripe account in Finances > Settings.
   * Until then nothing syncs from Stripe, so MRR is unknown (not zero) and
   * "collected" holds only manually recorded payments. Null = the check failed.
   */
  stripeConnected: boolean | null;
  /** Live Stripe MRR in USD cents at today's rate; null when it cannot be converted. */
  mrrUsdCents: number | null;
  topCustomer: { customer: string; share_pct: number } | null;
  progress: GoalProgress | null;
  paceSeries: GoalPacePoint[];
};

export async function loadOasisMoney(tenantId: string, label: string): Promise<OasisMoney> {
  const todayKey = operatorDateKey();
  const goal = await safe(`${label}.revenue_goal`, getActiveRevenueGoal(tenantId), null);
  const range = goal ? { from: goal.period_start, to: nextDay(goal.period_end) } : null;
  const [collected, byDay, last7, mrr, rate, customers, pinned] = await Promise.all([
    range ? safe(`${label}.revenue_collected`, revenueCollected(range), null) : Promise.resolve(null),
    range ? safe(`${label}.revenue_by_day`, revenueCollectedByDay(range), []) : Promise.resolve([]),
    safe(
      `${label}.collected_7d`,
      revenueCollected({ from: operatorDateKey(new Date(), -6), to: operatorDateKey(new Date(), 1) }),
      null,
    ),
    safe(`${label}.stripe_mrr`, stripeMrr(), null),
    safe(`${label}.fx`, usdPerCad(todayKey), null),
    range ? safe(`${label}.revenue_by_customer`, revenueByCustomer(range), []) : Promise.resolve([]),
    safe(`${label}.stripe_pin`, pinnedStripeAccount().then((id) => id !== null), null),
  ]);
  const total = customers.reduce((sum, c) => sum + c.usd_cents, 0);
  const currency = mrr?.currency.toUpperCase();
  return {
    goal,
    collected,
    last7,
    // An unconnected account has no subscription rows, which would read as a
    // confident CA$0. Unknown is not zero.
    mrr: pinned === true ? mrr : null,
    stripeConnected: pinned,
    mrrUsdCents:
      pinned !== true || !mrr
        ? null
        : currency === "USD"
          ? mrr.mrr_cents
          : currency === "CAD" && rate
            ? Math.round(mrr.mrr_cents * rate)
            : null,
    topCustomer:
      customers.length > 0 && total > 0
        ? { customer: customers[0].customer, share_pct: Math.round((customers[0].usd_cents / total) * 1000) / 10 }
        : null,
    progress: goal && collected ? computeGoalProgress(goal, collected.usd_cents, todayKey) : null,
    paceSeries: goal ? buildPaceSeries(goal, byDay, todayKey) : [],
  };
}
