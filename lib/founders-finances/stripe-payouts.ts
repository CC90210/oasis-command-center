/**
 * A Stripe payout -> the entries that book it. PURE.
 *
 * A payout is a transfer, never revenue: the revenue was booked when each
 * charge settled into 1050 Stripe clearing. Booking it moves the money OUT of
 * Stripe clearing and INTO the bank account it landed in, so the clearing
 * balance stops growing forever (2026-09-29: the books held +CA$1,639.21 in
 * clearing while Stripe's own balance was $0, and Today printed "Cash on hand
 * -CA$1,788.23").
 *
 * THE BANK ACCOUNT IS A SETTING, NEVER A GUESS. fin_settings.
 * stripe_payout_account_id names the bank account payouts land in. Unset, a
 * payout is recorded "unmapped" and the cash tile lists it as a gap; it is
 * booked by the next reconcile after a founder chooses the account.
 *
 * THE PAYOUT ENTRY is the Wise feed's own (wise-feed.ts stripePayoutLines),
 * so a payout booked from Stripe and one booked from its bank line are the
 * same lines: Dr bank / Cr Stripe clearing in the currency Stripe settled in,
 * through 1060 with the difference to FX gain/loss when it arrived in another
 * currency, an instant payout's fee to Stripe fees.
 *
 * WHEN CLEARING DOES NOT HOLD IT IN THAT CURRENCY. OASIS's Stripe balance is
 * USD, but a CA$ charge is booked into Stripe clearing in CAD (stripe-ingest.ts
 * posts the charge's own amount; the balance transaction is USD), and only
 * the fees land in USD. So USD clearing is negative and every USD payout is
 * short in USD while clearing holds the same money in CAD. The shortfall is
 * the conversion Stripe made when those charges settled; it is booked here as
 * its own entry, dated the payout's arrival day, at that day's Bank of Canada
 * rate, through 1060 Currency exchange clearing (which nets to exactly zero):
 *
 *   Dr 1050 Stripe clearing  USD  shortfall  / Cr 1060 FX clearing USD
 *   Dr 1060 FX clearing      CAD  CAD value  / Cr 1050 Stripe clearing CAD
 *
 * The shortfall is exactly what brings USD clearing to the payout (settled +
 * fee), so after the payout USD clearing is back at zero, and what is left in
 * CAD clearing is charges not yet paid out. Stripe converted at its own rate,
 * not the Bank of Canada's, so the CAD those charges were booked at can fall a
 * little short of the shortfall's CAD value: when CAD clearing holds less, but
 * within FX_DRIFT_TOLERANCE_PCT, the conversion takes what it holds and books
 * the difference to FX gain/loss (a realised gain: the USD was worth more than
 * the CAD given for it). A bigger gap is not exchange rates, it is charges the
 * books do not hold yet, and the payout is HELD with that reason, as is a CAD
 * payout short of CAD. Never booked into a negative balance.
 */

import type { JournalLineInput } from "./ledger";
import type { PayoutFacts } from "./stripe-map";
import { centsToDecimal, stripePayoutLines, type FeedAccounts, type WiseFeedRow } from "./wise-feed";

/** Currencies the books hold (the chart's accounts carry CAD and USD lines). */
const BOOKABLE: ReadonlySet<string> = new Set(["CAD", "USD"]);

/** The journal source of a booked payout and of its conversion; source_ref is the payout id (unique per entity). */
export const PAYOUT_SOURCE = "stripe_payout";
export const PAYOUT_FX_SOURCE = "stripe_payout_fx";

/**
 * The description a Wise bank line carries once the feed recognised it as
 * this payout (wise-feed.ts tagStripePayouts; the import stores NAME, then
 * " — " and the memo when there is one). The payout path looks for it so a
 * payout the bank feed already booked is adopted, not booked twice.
 */
export function payoutBankLineName(payoutId: string): string {
  return `Stripe payout ${payoutId}`;
}

export type PayoutAccounts = Omit<FeedAccounts, "chequing">;

/** How far short of the shortfall's Bank of Canada value CAD clearing may be and still be read as Stripe's conversion rate. */
export const FX_DRIFT_TOLERANCE_PCT = 5;

export type PayoutConversion = {
  currency: string;
  /** The shortfall, in `currency`. */
  cents: number;
  /** Its CAD value at the Bank of Canada rate of the arrival day. */
  cadCents: number;
  /** The CAD taken out of Stripe clearing for it (cadCents, or all CAD clearing held when that was a little less). */
  cadTakenCents: number;
  lines: JournalLineInput[];
};

export type PayoutPlan =
  | { kind: "book"; lines: JournalLineInput[]; conversion: PayoutConversion | null; fxCents: number }
  | { kind: "held"; reason: string }
  | { kind: "unmapped"; reason: string };

export const UNMAPPED_REASON = "no bank account is chosen for Stripe payouts (Finances › Settings › Stripe)";

export function planStripePayout(input: {
  payout: PayoutFacts;
  /** fin_settings.stripe_payout_account_id, already checked to be one of this book's bank accounts; null = not chosen. */
  bankAccountId: string | null;
  accounts: PayoutAccounts;
  /** What 1050 Stripe clearing holds on the books, per currency, in that currency's cents (every line, reversals included). */
  clearing: Readonly<Record<string, number>>;
  /** CAD value of `cents` of `currency` on `date` at the Bank of Canada rate the entry will use; null = no rate stored for that day yet. */
  cadOf: (cents: number, currency: string, date: string) => number | null;
}): PayoutPlan {
  const p = input.payout;
  const held = (reason: string): PayoutPlan => ({ kind: "held", reason });
  if (!input.bankAccountId) return { kind: "unmapped", reason: UNMAPPED_REASON };
  if (p.amountCents <= 0) return held(`payout ${p.payoutId} moves money from the bank back to Stripe, which is not booked automatically`);
  if (p.settlementCents === null || !p.settlementCurrency) return held(`Stripe did not say what payout ${p.payoutId} took from the Stripe balance`);
  if (p.settlementCents <= 0) return held(`Stripe's figures for payout ${p.payoutId} point in different directions`);
  const settleCur = p.settlementCurrency;
  for (const cur of [p.currency, settleCur]) {
    if (!BOOKABLE.has(cur)) return held(`payout ${p.payoutId} is in ${cur}, which the books do not hold`);
  }
  const date = p.arrivalDate;
  const needed = p.settlementCents + p.feeCents;
  const inSettle = input.clearing[settleCur] ?? 0;

  let conversion: PayoutConversion | null = null;
  if (inSettle < needed) {
    const shortfall = needed - inSettle;
    if (settleCur === "CAD") {
      return held(
        `payout ${p.payoutId} took ${centsToDecimal(needed)} CAD from the Stripe balance, but Stripe clearing holds ${centsToDecimal(inSettle)} CAD on the books, so the charges it pays out are not recorded yet`,
      );
    }
    const cadCents = input.cadOf(shortfall, settleCur, date);
    if (cadCents === null) return held(`no Bank of Canada ${settleCur} rate is stored for ${date} yet`);
    const inCad = input.clearing.CAD ?? 0;
    const taken = Math.min(inCad, cadCents);
    const gain = cadCents - taken;
    if (taken <= 0 || gain * 100 > cadCents * FX_DRIFT_TOLERANCE_PCT) {
      return held(
        `payout ${p.payoutId} needs ${centsToDecimal(shortfall)} ${settleCur} (${centsToDecimal(cadCents)} CAD) more than Stripe clearing holds in ${settleCur}, and it holds ${centsToDecimal(inCad)} CAD, so the charges it pays out are not recorded yet`,
      );
    }
    const memo = `Stripe payout ${p.payoutId}: ${settleCur} it paid out from charges booked in CAD, at the Bank of Canada rate of ${date}`;
    conversion = {
      currency: settleCur,
      cents: shortfall,
      cadCents,
      cadTakenCents: taken,
      lines: [
        { accountId: input.accounts.stripeClearing, currency: settleCur, debitCents: shortfall, memo },
        { accountId: input.accounts.fxClearing, currency: settleCur, creditCents: shortfall, memo },
        { accountId: input.accounts.fxClearing, currency: "CAD", debitCents: cadCents, memo },
        { accountId: input.accounts.stripeClearing, currency: "CAD", creditCents: taken, memo },
        ...(gain > 0
          ? [{ accountId: input.accounts.fxGainLoss, currency: "CAD", creditCents: gain, memo: "Realised FX gain: Stripe's conversion against the Bank of Canada rate" }]
          : []),
      ],
    };
  }

  // Both currencies' rates are needed only when the payout arrived in a
  // currency other than the one it settled in (stripePayoutLines' FX path).
  const cadStrict = (cents: number, currency: string, day: string): number => {
    const v = input.cadOf(cents, currency, day);
    if (v === null) throw new MissingRate(currency, day);
    return v;
  };
  const row: WiseFeedRow = {
    fitid: `STRIPE-${p.payoutId}`,
    postedDate: date,
    occurredAt: `${date}T00:00:00.000Z`,
    amountCents: p.amountCents,
    feeCents: 0,
    currency: p.currency,
    kind: "DEPOSIT",
    ref: p.payoutId,
    name: payoutBankLineName(p.payoutId),
    memo: "",
  };
  try {
    const built = stripePayoutLines(
      row,
      { id: p.payoutId, amountCents: p.amountCents, currency: p.currency, arrivalDate: date, settlementCents: p.settlementCents, settlementCurrency: settleCur, feeCents: p.feeCents },
      { ...input.accounts, chequing: input.bankAccountId },
      cadStrict,
      inSettle + (conversion?.cents ?? 0),
    );
    if (!built.ok) return held(built.reason);
    return { kind: "book", lines: built.lines, conversion, fxCents: built.fxCents };
  } catch (e) {
    if (e instanceof MissingRate) return held(`no Bank of Canada ${e.currency} rate is stored for ${e.day} yet`);
    throw e;
  }
}

class MissingRate extends Error {
  readonly currency: string;
  readonly day: string;
  constructor(currency: string, day: string) {
    super(`no ${currency} rate for ${day}`);
    this.currency = currency;
    this.day = day;
  }
}
