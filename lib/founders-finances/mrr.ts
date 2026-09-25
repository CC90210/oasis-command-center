/**
 * Monthly recurring revenue from Stripe subscription state. PURE.
 *
 * Counted statuses: active, trialing, past_due (a past_due customer is still a
 * customer until Stripe gives up). incomplete / incomplete_expired / unpaid /
 * canceled / paused are not revenue.
 *
 * Normalisation to one month, applied to unit amount x quantity:
 *   month  / interval_count
 *   year   / (12 x interval_count)
 *   week   x 52 / (12 x interval_count)
 *   day    x 365 / (12 x interval_count)
 * computed as an exact fraction and rounded once, half away from zero.
 *
 * Not modelled (documented in docs/FINANCES_SUITE.md): coupons/discounts and
 * metered usage prices, whose amount is not known until the period closes.
 */

import { divRoundHalfAwayFromZero } from "./money";
import { cadToUsdCents, usdToCadCents } from "./fx";

export const MRR_STATUSES: ReadonlySet<string> = new Set(["active", "trialing", "past_due"]);

export type RecurringInterval = "day" | "week" | "month" | "year";

export type SubscriptionItemFacts = {
  unitAmountCents: number;
  quantity: number;
  interval: RecurringInterval;
  intervalCount: number;
};

export function monthlyCentsForItem(item: SubscriptionItemFacts): number {
  const amount = BigInt(Math.max(0, Math.trunc(item.unitAmountCents))) * BigInt(Math.max(0, Math.trunc(item.quantity)));
  const count = BigInt(Math.max(1, Math.trunc(item.intervalCount || 1)));
  let num: bigint;
  let den: bigint;
  switch (item.interval) {
    case "year":
      num = amount;
      den = BigInt(12) * count;
      break;
    case "week":
      num = amount * BigInt(52);
      den = BigInt(12) * count;
      break;
    case "day":
      num = amount * BigInt(365);
      den = BigInt(12) * count;
      break;
    default:
      num = amount;
      den = count;
  }
  return Number(divRoundHalfAwayFromZero(num, den));
}

export function subscriptionMonthlyCents(items: readonly SubscriptionItemFacts[]): number {
  return items.reduce((a, it) => a + monthlyCentsForItem(it), 0);
}

export type MrrSummary = {
  mrr_cents: number;
  currency: string;
  active_subscriptions: number;
  unconverted: Array<{ currency: string; cents: number }>;
};

/**
 * Sum counted subscriptions. One currency in play: reported in that currency.
 * Mixed CAD and USD: reported in CAD, USD converted at `usdCadRateMicro` (the
 * latest Bank of Canada rate). Currencies with no conversion path are listed
 * in `unconverted` rather than silently dropped or summed at par.
 */
export function summarizeMrr(
  subs: ReadonlyArray<{ status: string; currency: string; monthlyCents: number }>,
  usdCadRateMicro: bigint | null,
): MrrSummary {
  const counted = subs.filter((s) => MRR_STATUSES.has(s.status));
  const byCurrency = new Map<string, number>();
  for (const s of counted) {
    const c = s.currency.toUpperCase();
    byCurrency.set(c, (byCurrency.get(c) || 0) + s.monthlyCents);
  }
  if (byCurrency.size === 0) {
    return { mrr_cents: 0, currency: "CAD", active_subscriptions: 0, unconverted: [] };
  }
  if (byCurrency.size === 1) {
    const [[currency, cents]] = [...byCurrency.entries()];
    return { mrr_cents: cents, currency, active_subscriptions: counted.length, unconverted: [] };
  }
  let cad = 0;
  const unconverted: Array<{ currency: string; cents: number }> = [];
  for (const [currency, cents] of byCurrency) {
    if (currency === "CAD") cad += cents;
    else if (currency === "USD" && usdCadRateMicro) cad += usdToCadCents(cents, usdCadRateMicro);
    else unconverted.push({ currency, cents });
  }
  return { mrr_cents: cad, currency: "CAD", active_subscriptions: counted.length, unconverted };
}

/** Convenience for callers that want both views. */
export function mrrInUsd(summary: MrrSummary, usdCadRateMicro: bigint | null): number | null {
  if (summary.currency === "USD") return summary.mrr_cents;
  if (summary.currency === "CAD" && usdCadRateMicro) return cadToUsdCents(summary.mrr_cents, usdCadRateMicro);
  return null;
}
