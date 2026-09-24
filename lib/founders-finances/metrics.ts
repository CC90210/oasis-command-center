/**
 * Revenue metrics for Bravo's Today page and Atlas. BUSINESS ENTITY ONLY —
 * nothing here can read a personal book.
 *
 * "Collected" means money actually received: succeeded live Stripe payments
 * and manually recorded invoice payments (fin_payments), net of refunds, each
 * converted at ITS OWN day's Bank of Canada rate, bucketed by the
 * America/Toronto calendar date. An invoice paid through Stripe is one
 * fin_payments row, so it is never counted twice. revenueCollected,
 * revenueCollectedByDay and revenueByCustomer all run the same rows through
 * the same pure functions (metrics-core.ts), so for one range they agree.
 *
 * Ranges are [from, to) ISO dates.
 */
import "server-only";

import { BUSINESS_ENTITY_ID } from "./chart";
import { isIsoDate, RATE_SCALE } from "./fx";
import {
  collectedByCustomer,
  collectedByDay,
  summarizeCollected,
  type CollectedRow,
  type RateLookup,
} from "./metrics-core";
import { customerLabel } from "./stripe-map";
import { divRoundHalfAwayFromZero } from "./money";
import { summarizeMrr } from "./mrr";
import { query, queryOne } from "./db";
import { latestUsdCadMicro, rateLookupFor, usdCadRate } from "./fx-io";

function assertRange(args: { from: string; to: string }): void {
  if (!isIsoDate(args.from) || !isIsoDate(args.to)) throw new Error("from and to must be ISO dates (YYYY-MM-DD)");
  if (args.to <= args.from) throw new Error("to must be after from");
}

async function loadCollectedRows(from: string, to: string): Promise<CollectedRow[]> {
  const rows = await query<{
    kind: "payment" | "refund";
    occurred_on: string;
    amount_cents: number;
    currency: string;
    settlement_cad_cents: number | null;
    livemode: number;
    contact_id: string | null;
    contact_name: string | null;
    customer_name: string | null;
    customer_email: string | null;
    stripe_customer_id: string | null;
  }>(
    `SELECT p.kind, p.occurred_on, p.amount_cents, p.currency, p.settlement_cad_cents, p.livemode,
            COALESCE(i.contact_id, p.contact_id, pp.contact_id) AS contact_id,
            c.name AS contact_name,
            COALESCE(NULLIF(p.customer_name, ''), pp.customer_name) AS customer_name,
            COALESCE(NULLIF(p.customer_email, ''), pp.customer_email) AS customer_email,
            COALESCE(p.stripe_customer_id, pp.stripe_customer_id) AS stripe_customer_id
       FROM fin_payments p
       LEFT JOIN fin_payments pp ON pp.id = p.parent_payment_id
       LEFT JOIN fin_invoices i ON i.id = COALESCE(p.invoice_id, pp.invoice_id)
       LEFT JOIN fin_contacts c ON c.id = COALESCE(i.contact_id, p.contact_id, pp.contact_id)
      WHERE p.entity_id = ? AND p.occurred_on >= ? AND p.occurred_on < ?`,
    [BUSINESS_ENTITY_ID, from, to],
  );
  return rows.map((r) => {
    const label = customerLabel({ contactName: r.contact_name, name: r.customer_name, email: r.customer_email });
    const key = r.contact_id
      ? `contact:${r.contact_id}`
      : r.stripe_customer_id
        ? `stripe:${r.stripe_customer_id}`
        : r.customer_email
          ? `email:${r.customer_email.toLowerCase()}`
          : r.customer_name
            ? `name:${r.customer_name.toLowerCase()}`
            : "unknown";
    return {
      kind: r.kind,
      occurredOn: r.occurred_on,
      amountCents: Number(r.amount_cents),
      currency: r.currency,
      settlementCadCents: r.settlement_cad_cents === null ? null : Number(r.settlement_cad_cents),
      customerKey: key,
      customerLabel: label,
      livemode: Number(r.livemode) === 1,
    };
  });
}

async function lookupForRows(rows: readonly CollectedRow[], from: string, to: string): Promise<RateLookup> {
  const days = [...new Set(rows.map((r) => r.occurredOn))];
  return rateLookupFor(from, to, { ensureDays: days });
}

export async function revenueCollected(args: {
  from: string;
  to: string;
}): Promise<{ cad_cents: number; usd_cents: number; payments: number; fx_missing_days: string[] }> {
  assertRange(args);
  const rows = await loadCollectedRows(args.from, args.to);
  return summarizeCollected(rows, args.from, args.to, await lookupForRows(rows, args.from, args.to));
}

export async function revenueCollectedByDay(args: {
  from: string;
  to: string;
}): Promise<Array<{ date: string; cad_cents: number; usd_cents: number }>> {
  assertRange(args);
  const rows = await loadCollectedRows(args.from, args.to);
  return collectedByDay(rows, args.from, args.to, await lookupForRows(rows, args.from, args.to));
}

export async function revenueByCustomer(args: {
  from: string;
  to: string;
}): Promise<Array<{ customer: string; usd_cents: number; cad_cents: number }>> {
  assertRange(args);
  const rows = await loadCollectedRows(args.from, args.to);
  return collectedByCustomer(rows, args.from, args.to, await lookupForRows(rows, args.from, args.to));
}

export async function stripeMrr(): Promise<{ mrr_cents: number; currency: string; active_subscriptions: number; as_of: string | null }> {
  const subs = await query<{ status: string; currency: string; monthly_cents: number }>(
    `SELECT status, currency, monthly_cents FROM fin_subscriptions WHERE entity_id = ? AND livemode = 1`,
    [BUSINESS_ENTITY_ID],
  );
  const asOf = await queryOne<{ as_of: string | null }>(`SELECT MAX(updated_at) AS as_of FROM fin_subscriptions WHERE entity_id = ?`, [BUSINESS_ENTITY_ID]);
  const currencies = new Set(subs.map((s) => s.currency.toUpperCase()));
  const rate = currencies.size > 1 ? await latestUsdCadMicro() : null;
  const s = summarizeMrr(
    subs.map((x) => ({ status: x.status, currency: x.currency, monthlyCents: Number(x.monthly_cents) })),
    rate,
  );
  if (s.unconverted.length > 0) {
    console.error("[finances:mrr] subscriptions in currencies with no rate were left out", s.unconverted);
  }
  return { mrr_cents: s.mrr_cents, currency: s.currency, active_subscriptions: s.active_subscriptions, as_of: asOf?.as_of ?? null };
}

/** USD per 1 CAD on `date` (own day, else the latest prior business day). */
export async function usdPerCad(date: string): Promise<number | null> {
  if (!isIsoDate(date)) throw new Error("date must be YYYY-MM-DD");
  const hit = await usdCadRate(date);
  if (!hit) return null;
  const scaled = divRoundHalfAwayFromZero(RATE_SCALE * RATE_SCALE, hit.micro); // 1 / (CAD per USD), x 1e6, rounded
  return Number(scaled) / 1_000_000;
}
