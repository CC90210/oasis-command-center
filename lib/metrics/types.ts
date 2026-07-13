/**
 * lib/metrics/types.ts — the one canonical email-metric block the Metrics tab
 * renders for every source. Fields + rate definitions mirror what Constant
 * Contact reports so a number here means the same thing CC would show.
 *
 * Rate denominators follow CC's convention:
 *   delivered   = sent − bounces
 *   deliveryRate= delivered / sent
 *   openRate    = uniqueOpens / delivered
 *   clickRate   = uniqueClicks / delivered
 *   ctor        = uniqueClicks / uniqueOpens        (click-to-open)
 *   bounceRate  = bounces / sent
 *   unsubRate   = unsubscribes / delivered
 *   complaintRate = complaints / delivered
 *
 * A new source plugs into the tab by producing an EmailMetrics (via computeRates)
 * — that is the extensibility seam.
 */

export type MetricSource = "drips" | "cold" | "submissions" | "constant_contact";

/** Raw counts a source collects; rates are derived by computeRates(). */
export type EmailCounts = {
  sent: number;
  bounces: number;
  opens: number;
  uniqueOpens: number;
  clicks: number;
  uniqueClicks: number;
  unsubscribes: number;
  complaints: number;
  /** true when bounces/complaints are a proxy from email_suppressions rather
   *  than real DSN/feedback-loop counts (drip + submissions until the Ship-2
   *  bounce reader lands; CC + SmartLead report real numbers). */
  isProxy?: boolean;
};

export type EmailMetrics = EmailCounts & {
  delivered: number;
  deliveryRate: number;
  bounceRate: number;
  openRate: number;
  didNotOpen: number;
  clickRate: number;
  ctor: number;
  unsubRate: number;
  complaintRate: number;
};

export function rate(numerator: number, denominator: number): number {
  if (!denominator || denominator <= 0) return 0;
  const r = numerator / denominator;
  return isFinite(r) ? r : 0;
}

export function emptyCounts(): EmailCounts {
  return { sent: 0, bounces: 0, opens: 0, uniqueOpens: 0, clicks: 0, uniqueClicks: 0, unsubscribes: 0, complaints: 0 };
}

/** Derive the CC-parity rates from raw counts. */
export function computeRates(c: EmailCounts): EmailMetrics {
  const delivered = Math.max(0, c.sent - c.bounces);
  return {
    ...c,
    delivered,
    deliveryRate: rate(delivered, c.sent),
    bounceRate: rate(c.bounces, c.sent),
    openRate: rate(c.uniqueOpens, delivered),
    didNotOpen: Math.max(0, delivered - c.uniqueOpens),
    clickRate: rate(c.uniqueClicks, delivered),
    ctor: rate(c.uniqueClicks, c.uniqueOpens),
    unsubRate: rate(c.unsubscribes, delivered),
    complaintRate: rate(c.complaints, delivered),
  };
}

/** Sum raw counts across sources for the combined "All" view, then re-derive rates. */
export function sumMetrics(blocks: EmailCounts[]): EmailMetrics {
  const total = emptyCounts();
  let anyProxy = false;
  for (const b of blocks) {
    total.sent += b.sent;
    total.bounces += b.bounces;
    total.opens += b.opens;
    total.uniqueOpens += b.uniqueOpens;
    total.clicks += b.clicks;
    total.uniqueClicks += b.uniqueClicks;
    total.unsubscribes += b.unsubscribes;
    total.complaints += b.complaints;
    if (b.isProxy) anyProxy = true;
  }
  total.isProxy = anyProxy;
  return computeRates(total);
}
