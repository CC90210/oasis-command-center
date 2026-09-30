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
 * short in USD while clearing holds the same money in CAD. What converts is
 * exactly what the payout pays out: Stripe lists it (GET
 * /v1/balance_transactions?payout=, stripe-payouts-io.ts payoutContents), and
 * each charge and refund in it is matched to the row that booked it. The
 * conversion is its own entry, dated the payout's arrival day, at that day's
 * Bank of Canada rate, through 1060 Currency exchange clearing (which nets to
 * exactly zero):
 *
 *   Dr 1050 Stripe clearing  USD  what Stripe settled those charges at
 *   Cr 1060 FX clearing      USD
 *   Dr 1060 FX clearing      CAD  its Bank of Canada value
 *   Cr 1050 Stripe clearing  CAD  what the books booked those charges at
 *   the difference to FX gain/loss, whichever way it falls
 *
 * So the CAD those charges were booked at leaves clearing whole (nothing of a
 * paid-out charge stays behind to read as cash), and Stripe's conversion
 * against the Bank of Canada's rate is a realised loss or gain, both
 * directions. A gap beyond FX_DRIFT_TOLERANCE_PCT is not exchange rates (a
 * charge booked at a wrong amount), and is held. A payout that pays out a
 * charge or refund the books do not hold, or anything else the books do not
 * record (a dispute, an adjustment), is HELD with that reason; so is one
 * whose contents Stripe cannot list (no key, a manual payout), and a CAD
 * payout short of CAD. Stripe's own fees it deducts (billing fees) are booked
 * with it. What clearing holds is read as of the arrival day, so a charge
 * booked after a payout never funds it. After a payout, USD clearing holds
 * minus the fees of charges still in Stripe's balance (booked when each
 * settled, paid out later), which is why a payout whose contents Stripe
 * listed is not also checked against the USD clearing balance.
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

/** How far Stripe's conversion may fall from the Bank of Canada rate, either way, and still be read as exchange rates. */
export const FX_DRIFT_TOLERANCE_PCT = 5;

/** How many days either side of a payout's arrival the bank line that records it may be dated. */
export const PAYOUT_MATCH_WINDOW_DAYS = 3;

/**
 * What a payout pays out, as Stripe lists it, matched to the books
 * (stripe-payouts-io.ts payoutContents). ok: every charge and refund in it is
 * booked, nothing in it is of a kind the books do not record, and it adds up
 * to what the payout took from the Stripe balance.
 */
export type PayoutContents =
  | {
      ok: true;
      /** Its charges less its refunds, in the settlement currency: what Stripe settled them at. */
      settledCents: number;
      /** What the books booked those charges less refunds at, in CAD, in Stripe clearing. */
      cadBookedCents: number;
      /** Stripe's own fees it deducted (billing fees and the like), in the settlement currency; booked with the payout. */
      stripeFeeCents: number;
    }
  | { ok: false; reason: string };

export type PayoutConversion = {
  currency: string;
  /** What converted, in `currency`: the charges less refunds the payout pays out. */
  cents: number;
  /** Its CAD value at the Bank of Canada rate of the arrival day. */
  cadCents: number;
  /** The CAD taken out of Stripe clearing for it: what the books booked those charges at. */
  cadTakenCents: number;
  /** cadCents - cadTakenCents: > 0 a realised FX gain, < 0 a loss. */
  fxCents: number;
  lines: JournalLineInput[];
};

export type PayoutPlan =
  | { kind: "book"; lines: JournalLineInput[]; conversion: PayoutConversion | null; fxCents: number }
  | { kind: "held"; reason: string }
  | { kind: "unmapped"; reason: string };

export const UNMAPPED_REASON = "no bank account is chosen for Stripe payouts (Finances › Settings › Stripe)";

/**
 * Whether booking the payout needs its contents from Stripe: it settled in a
 * currency other than CAD, and Stripe clearing does not hold what it took in
 * that currency (so charges booked in CAD have to convert).
 */
export function payoutNeedsContents(p: Pick<PayoutFacts, "settlementCents" | "settlementCurrency" | "feeCents">, clearing: Readonly<Record<string, number>>): boolean {
  if (p.settlementCents === null || !p.settlementCurrency || p.settlementCurrency === "CAD") return false;
  return (clearing[p.settlementCurrency] ?? 0) < p.settlementCents + p.feeCents;
}

export function planStripePayout(input: {
  payout: PayoutFacts;
  /** fin_settings.stripe_payout_account_id, already checked to be one of this book's bank accounts; null = not chosen. */
  bankAccountId: string | null;
  accounts: PayoutAccounts;
  /** What 1050 Stripe clearing holds on the books ON THE ARRIVAL DAY, per currency, in that currency's cents (every line, reversals included). */
  clearing: Readonly<Record<string, number>>;
  /** What the payout pays out, when payoutNeedsContents; null = not read. */
  contents: PayoutContents | null;
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
  let stripeFeeCents = 0;
  if (inSettle < needed) {
    if (settleCur === "CAD") {
      return held(
        `payout ${p.payoutId} took ${centsToDecimal(needed)} CAD from the Stripe balance, but Stripe clearing holds ${centsToDecimal(inSettle)} CAD on the books on ${date}, so the charges it pays out are not recorded yet`,
      );
    }
    const c = input.contents;
    if (!c) return held(`Stripe was not asked which charges payout ${p.payoutId} pays out`);
    if (!c.ok) return held(c.reason);
    if (c.settledCents <= 0 || c.cadBookedCents <= 0) {
      return held(
        `payout ${p.payoutId} pays out no charge the books hold in CAD, and Stripe clearing holds ${centsToDecimal(inSettle)} ${settleCur} on the books on ${date}, less than the ${centsToDecimal(needed)} ${settleCur} it took`,
      );
    }
    const cadCents = input.cadOf(c.settledCents, settleCur, date);
    if (cadCents === null) return held(`no Bank of Canada ${settleCur} rate is stored for ${date} yet`);
    const inCad = input.clearing.CAD ?? 0;
    if (inCad < c.cadBookedCents) {
      return held(
        `the charges payout ${p.payoutId} pays out were booked at ${centsToDecimal(c.cadBookedCents)} CAD, but Stripe clearing holds ${centsToDecimal(inCad)} CAD on the books on ${date}`,
      );
    }
    const fx = cadCents - c.cadBookedCents;
    if (Math.abs(fx) * 100 > c.cadBookedCents * FX_DRIFT_TOLERANCE_PCT) {
      return held(
        `the charges payout ${p.payoutId} pays out were booked at ${centsToDecimal(c.cadBookedCents)} CAD, and Stripe settled them at ${centsToDecimal(c.settledCents)} ${settleCur}, worth ${centsToDecimal(cadCents)} CAD at the Bank of Canada rate of ${date}: a gap that size is not exchange rates`,
      );
    }
    const memo = `Stripe payout ${p.payoutId}: the charges it pays out, booked in CAD, settled in ${settleCur}; Bank of Canada rate of ${date}`;
    conversion = {
      currency: settleCur,
      cents: c.settledCents,
      cadCents,
      cadTakenCents: c.cadBookedCents,
      fxCents: fx,
      lines: [
        { accountId: input.accounts.stripeClearing, currency: settleCur, debitCents: c.settledCents, memo },
        { accountId: input.accounts.fxClearing, currency: settleCur, creditCents: c.settledCents, memo },
        { accountId: input.accounts.fxClearing, currency: "CAD", debitCents: cadCents, memo },
        { accountId: input.accounts.stripeClearing, currency: "CAD", creditCents: c.cadBookedCents, memo },
        ...(fx > 0 ? [{ accountId: input.accounts.fxGainLoss, currency: "CAD", creditCents: fx, memo: "Realised FX gain: Stripe's conversion against the Bank of Canada rate" }] : []),
        ...(fx < 0 ? [{ accountId: input.accounts.fxGainLoss, currency: "CAD", debitCents: -fx, memo: "Realised FX loss: Stripe's conversion against the Bank of Canada rate" }] : []),
      ],
    };
    stripeFeeCents = c.stripeFeeCents;
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
      // Contents Stripe listed and the books matched are the check (see above); otherwise what clearing holds is.
      conversion ? undefined : inSettle,
    );
    if (!built.ok) return held(built.reason);
    const memo = `Stripe payout ${p.payoutId}: Stripe's own fees it deducted`;
    const fees: JournalLineInput[] =
      stripeFeeCents > 0
        ? [
            { accountId: input.accounts.stripeFees, currency: settleCur, debitCents: stripeFeeCents, memo },
            { accountId: input.accounts.stripeClearing, currency: settleCur, creditCents: stripeFeeCents, memo },
          ]
        : stripeFeeCents < 0
          ? [
              { accountId: input.accounts.stripeClearing, currency: settleCur, debitCents: -stripeFeeCents, memo: `${memo} (a credit)` },
              { accountId: input.accounts.stripeFees, currency: settleCur, creditCents: -stripeFeeCents, memo: `${memo} (a credit)` },
            ]
          : [];
    return { kind: "book", lines: [...built.lines, ...fees], conversion, fxCents: built.fxCents };
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
