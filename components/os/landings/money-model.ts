/**
 * money-model — the Money overview's numbers, with "unknown is not zero" as a
 * rule the page cannot forget. PURE: tests/os-landings.test.ts feeds it the
 * empty, disconnected and failed cases directly.
 *
 * The finances loaders answer 0 for a book with nothing in it: Cash on hand is
 * the sum of zero balances, MRR is the sum of zero subscriptions. Printed as
 * "CA$0.00" that reads as "the business has no money and no revenue", which is
 * the exact misreading lib/goals and the Today money cards were rebuilt to
 * prevent. So each tile says where its number comes from and is only "live"
 * when that source has actually reported:
 *
 *   Cash, In/Out/Net   live once the books hold any bank data (a balance or a
 *                      recorded transaction); otherwise "Not connected" with
 *                      a link to import a statement.
 *   Collected          live once Stripe is pinned or any payment is recorded.
 *   MRR                live once a Stripe subscription sync has run (as_of).
 *   Owed / Overdue     live always: invoices are created in this app, so no
 *                      invoice really is nothing owed.
 *   A failed read      every tile "Couldn't load", never a number.
 */

import type { KpiTileProps } from "@/components/os/KpiTile";

/** The slice of loadOverviewPage's result this page reads. */
export type MoneyOverviewInput = {
  ov: {
    cashTotal: number;
    cashAccounts: ReadonlyArray<{ balanceCents: number }>;
    month: { inCents: number; outCents: number; netCents: number };
    openAr: Record<string, number>;
    overdueAr: Record<string, number>;
    overdueCount: number;
    unreviewed: number;
  };
  collected: { cad_cents: number; usd_cents: number; payments: number; fx_missing_days: readonly string[] };
  mrr: { mrr_cents: number; currency: string; active_subscriptions: number; as_of: string | null };
  recent: ReadonlyArray<unknown>;
  stripePinned: boolean;
};

export const MONEY_LINKS = {
  importStatement: "/founders/finances/transactions#import",
  stripeSettings: "/founders/finances/settings#stripe",
  exchangeRates: "/founders/finances/settings#exchange-rates",
} as const;

export type MoneyTile = KpiTileProps & { id: string };

type Fmt = (cents: number, currency: string) => string;

function perCurrency(map: Record<string, number>, fmt: Fmt): string {
  const entries = Object.entries(map).filter(([, v]) => v !== 0);
  return entries.length ? entries.map(([c, v]) => fmt(v, c)).join(" + ") : fmt(0, "CAD");
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Books hold bank data when any cash balance moved or any transaction exists. */
export function booksHaveBankData(input: Pick<MoneyOverviewInput, "ov" | "recent">): boolean {
  return input.recent.length > 0 || input.ov.cashAccounts.some((a) => a.balanceCents !== 0);
}

/** The headline tiles, or every tile as "Couldn't load" when the read failed (null). */
export function moneyTiles(input: MoneyOverviewInput | null, fmt: Fmt): { headline: MoneyTile[]; month: MoneyTile[] } {
  if (!input) {
    const failed = (id: string, label: string): MoneyTile => ({ id, label, value: null, status: "error" });
    return {
      headline: [
        failed("cash", "Cash on hand"),
        failed("collected", "Collected this month"),
        failed("mrr", "MRR"),
        failed("owed", "Owed to you"),
      ],
      month: [failed("in", "In this month"), failed("out", "Out this month"), failed("net", "Net this month")],
    };
  }
  const { ov, collected, mrr, stripePinned } = input;
  const bank = booksHaveBankData(input);
  const collectedLive = stripePinned || collected.payments > 0;
  const mrrLive = mrr.as_of !== null;
  const bankTile = (id: string, label: string, cents: number, hint: string): MoneyTile =>
    bank
      ? { id, label, value: fmt(cents, "CAD"), status: "live", hint }
      : { id, label, value: null, status: "not_connected", connectHref: MONEY_LINKS.importStatement, hint: "No bank data yet" };

  const collectedHint = [
    `${fmt(collected.usd_cents, "USD")} · ${plural(collected.payments, "payment")}`,
    collected.fx_missing_days.length > 0 ? `rate missing for ${plural(collected.fx_missing_days.length, "day")}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return {
    headline: [
      bankTile("cash", "Cash on hand", ov.cashTotal, "Bank and Stripe balances"),
      collectedLive
        ? { id: "collected", label: "Collected this month", value: fmt(collected.cad_cents, "CAD"), status: "live", hint: collectedHint }
        : { id: "collected", label: "Collected this month", value: null, status: "not_connected", connectHref: MONEY_LINKS.stripeSettings, hint: "Stripe" },
      mrrLive
        ? {
            id: "mrr",
            label: "MRR",
            value: fmt(mrr.mrr_cents, mrr.currency || "CAD"),
            status: "live",
            hint: `${plural(mrr.active_subscriptions, "active subscription")} in Stripe`,
          }
        : { id: "mrr", label: "MRR", value: null, status: "not_connected", connectHref: MONEY_LINKS.stripeSettings, hint: "Stripe subscriptions" },
      {
        id: "owed",
        label: "Owed to you",
        value: perCurrency(ov.openAr, fmt),
        status: "live",
        hint: ov.overdueCount > 0 ? `${perCurrency(ov.overdueAr, fmt)} overdue · ${plural(ov.overdueCount, "invoice")}` : "Nothing overdue",
      },
    ],
    month: [
      bankTile("in", "In this month", ov.month.inCents, "Transfers between your own accounts excluded"),
      bankTile("out", "Out this month", ov.month.outCents, "Spending, draws and fees"),
      bankTile("net", "Net this month", ov.month.netCents, "Revenue minus expenses"),
    ],
  };
}
