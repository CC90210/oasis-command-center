/**
 * "Money collected" arithmetic shared by revenueCollected,
 * revenueCollectedByDay and revenueByCustomer. PURE.
 *
 * ONE definition, three views. All three take the same rows (fin_payments,
 * business entity, live mode) and the same per-row conversion, and all three
 * bucket by `occurred_on` — the America/Toronto calendar date stamped when
 * the payment was recorded (fx.ts torontoDateOf). So for any range,
 * sum(byDay) === total and sum(byCustomer) === total, by construction; the
 * tests assert both.
 *
 * Per-row conversion, each at the row's OWN day's Bank of Canada rate:
 *   CAD value: Stripe's CAD settlement amount when known, else the amount
 *              itself for CAD, else USD x rate(day).
 *   USD value: the amount itself for USD, else CAD / rate(day).
 * A value that needs a rate with none within the lookback counts as 0 and the
 * day is reported in fx_missing_days — never converted at a guessed rate.
 *
 * Refunds are rows of kind 'refund' on the day they happened and subtract.
 * An invoice paid through Stripe is ONE fin_payments row (the Stripe charge,
 * linked to the invoice), so it cannot be counted twice here.
 */

import { cadToUsdCents, isoDateRange, usdToCadCents } from "./fx";

export type CollectedRow = {
  kind: "payment" | "refund";
  occurredOn: string;
  amountCents: number;
  currency: string;
  settlementCadCents: number | null;
  customerKey: string;
  customerLabel: string;
  livemode: boolean;
};

export type RateLookup = (date: string) => bigint | null;

export type RowValue = { cadCents: number; usdCents: number; missingDay: string | null };

export function rowValue(row: CollectedRow, rateFor: RateLookup): RowValue {
  const sign = row.kind === "refund" ? -1 : 1;
  let cad: number | null = null;
  let usd: number | null = null;
  let missing = false;
  const cur = row.currency.toUpperCase();
  if (row.settlementCadCents !== null) cad = row.settlementCadCents;
  else if (cur === "CAD") cad = row.amountCents;
  if (cur === "USD") usd = row.amountCents;

  if (cad === null || usd === null) {
    const rate = rateFor(row.occurredOn);
    if (rate === null) missing = true;
    else {
      if (cad === null && cur === "USD") cad = usdToCadCents(row.amountCents, rate);
      if (usd === null && cad !== null) usd = cadToUsdCents(cad, rate);
    }
  }
  // An unsupported currency with no settlement amount cannot be valued.
  if (cad === null && usd === null) missing = true;
  return {
    cadCents: sign * (cad ?? 0),
    usdCents: sign * (usd ?? 0),
    missingDay: missing ? row.occurredOn : null,
  };
}

function inRange(row: CollectedRow, from: string, to: string): boolean {
  return row.livemode && row.occurredOn >= from && row.occurredOn < to;
}

export type CollectedTotal = { cad_cents: number; usd_cents: number; payments: number; fx_missing_days: string[] };

export function summarizeCollected(
  rows: readonly CollectedRow[],
  from: string,
  to: string,
  rateFor: RateLookup,
): CollectedTotal {
  let cad = 0;
  let usd = 0;
  let payments = 0;
  const missing = new Set<string>();
  for (const r of rows) {
    if (!inRange(r, from, to)) continue;
    const v = rowValue(r, rateFor);
    cad += v.cadCents;
    usd += v.usdCents;
    if (v.missingDay) missing.add(v.missingDay);
    if (r.kind === "payment") payments += 1;
  }
  return { cad_cents: cad, usd_cents: usd, payments, fx_missing_days: [...missing].sort() };
}

export function collectedByDay(
  rows: readonly CollectedRow[],
  from: string,
  to: string,
  rateFor: RateLookup,
): Array<{ date: string; cad_cents: number; usd_cents: number }> {
  const days = isoDateRange(from, to);
  const map = new Map(days.map((d) => [d, { date: d, cad_cents: 0, usd_cents: 0 }]));
  for (const r of rows) {
    if (!inRange(r, from, to)) continue;
    const bucket = map.get(r.occurredOn);
    if (!bucket) continue;
    const v = rowValue(r, rateFor);
    bucket.cad_cents += v.cadCents;
    bucket.usd_cents += v.usdCents;
  }
  return days.map((d) => map.get(d)!);
}

export function collectedByCustomer(
  rows: readonly CollectedRow[],
  from: string,
  to: string,
  rateFor: RateLookup,
): Array<{ customer: string; usd_cents: number; cad_cents: number }> {
  const map = new Map<string, { customer: string; usd_cents: number; cad_cents: number }>();
  for (const r of rows) {
    if (!inRange(r, from, to)) continue;
    const v = rowValue(r, rateFor);
    const key = r.customerKey || "unknown";
    const label = r.customerLabel.trim() || "Unknown customer";
    const cur = map.get(key) || { customer: label, usd_cents: 0, cad_cents: 0 };
    if (cur.customer === "Unknown customer" && label !== "Unknown customer") cur.customer = label;
    cur.usd_cents += v.usdCents;
    cur.cad_cents += v.cadCents;
    map.set(key, cur);
  }
  return [...map.values()].sort((a, b) => b.usd_cents - a.usd_cents || a.customer.localeCompare(b.customer));
}
