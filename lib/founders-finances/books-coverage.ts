/**
 * lib/founders-finances/books-coverage.ts — what the books hold, and so what
 * every Money figure built on them may claim. PURE.
 *
 * TWO QUESTIONS, ONE FILE.
 *
 * 1. CASH (cashCoverage, from #482): may the ledger's cash figure be called
 *    "cash on hand"? overview() sums debit minus credit over the bank, cash
 *    and clearing accounts (reports-io.ts). That is the right arithmetic and
 *    the wrong claim whenever the book does not hold the whole story of those
 *    accounts. On 2026-09-29 the owner's Today showed "Cash on hand
 *    −CA$1,788.23" because:
 *
 *      - 1000 Business chequing held six September expenses and nothing else:
 *        no opening balance, no deposits, no bank import. Its −CA$3,427.44 is
 *        "what was spent from it since the book started", not a balance.
 *      - 1050 Stripe clearing held every card charge less fees and refunds,
 *        and no payout: Stripe's own balance was $0, the book's was
 *        +CA$1,639.21, and it only grew, because nothing booked a payout.
 *
 * 2. THE WHOLE BOOK (booksCoverage, 2026-09-30 audit): the P&L, the Balance
 *    Sheet, the Accounts page, the month tiles, the CSV export and the
 *    GST/QST threshold all read the same ledger, and on 2026-09-30 it held
 *    revenue from 2026-01-20 (Stripe only) but operating expenses from
 *    2026-09-01 only, no bank line, no opening balance and no payout. Each of
 *    those surfaces printed its figure as final. booksCoverage says what the
 *    book covers (expenses from, revenue sources, opening balances, payouts)
 *    and lists every gap in plain words, so one banner can say it everywhere
 *    (components/founders/finances/BooksCoverageBanner.tsx).
 *
 * Neither changes any arithmetic or account (Atlas owns the definitions).
 * lib/founders-finances/cash-coverage.ts re-exports the cash half under its
 * old name, so every existing caller keeps working.
 *
 * CASH is INCOMPLETE when either holds:
 *   - a bank or cash account that is in use (it has ledger lines or imported
 *     bank lines) has no opening-balance entry IN FORCE (isOpeningBalance,
 *     below: status "posted", so a reversed one no longer records a starting
 *     point);
 *   - Stripe clearing has card money in it and no payout has ever moved money
 *     out of it into a bank or cash account.
 * A payout is recognised by its SHAPE, not a source name: one entry that
 * credits Stripe clearing and debits a bank or cash account. That is how a
 * payout lands from a bank line (categorised by the seeded "Stripe payouts
 * are transfers" rule, or booked by the Wise feed) and how the payout.paid
 * handler posts it (stripe-payouts-io.ts). Every payout Stripe reported paid
 * that the books did NOT book (no bank account chosen for payouts, Stripe
 * clearing short, no rate yet) is its own gap, named with its reason: one
 * booked payout does not make the other eleven complete.
 * An opening balance is recognised the same way, whatever wrote it: the Wise
 * card's (source "opening_balance", wise-feed.ts OPENING_BALANCE_SOURCE), or
 * any posted entry that sets bank or cash accounts against the book's
 * opening-balance equity account and nothing else.
 *
 * THE BOOK is INCOMPLETE when the cash is, and also when:
 *   - operating expenses start later than revenue (or are absent while
 *     revenue exists): the months before have revenue and no costs;
 *   - after expenses start, a month has revenue and no operating expense at
 *     all: that month's rent and software are not recorded;
 *   - no bank deposit is recorded from before the first revenue: revenue that
 *     did not come through Stripe (a Wise or e-Transfer payment, a client
 *     paying by wire) cannot be in the books, so every revenue total is a
 *     floor. This is also what makes the GST/QST threshold "unconfirmed"
 *     (tax.ts smallSupplierStatus);
 *   - the imported bank lines do not CONTINUE: a bank account's imports skip
 *     a calendar month, or stop before the current one. One old statement
 *     import is a start date, not a bank feed, and the months after it hold
 *     no deposit the books can know about. Coverage is by calendar month
 *     (a month with no imported line at all), so a quiet week is not a gap,
 *     and a new month reads incomplete until its first line is imported.
 *
 * PURE: the loaders hand it the ledger they already loaded; tests run it bare.
 */

import type { ReportAccount, ReportLine } from "./reports";
import { SYS } from "./chart";
import { OPENING_BALANCE_SOURCE } from "./wise-feed";

/** Accounts whose balance is money in a bank or a till: they need an opening balance. */
const BALANCE_SUBTYPES: ReadonlySet<string> = new Set(["bank", "cash"]);

export type CoverageAccount = {
  code: string;
  name: string;
  subtype: string;
  balanceCents: number;
  /** Distinct journal entries on this account (voids and their reversals included). */
  entries: number;
  firstDate: string | null;
  lastDate: string | null;
  hasOpeningBalance: boolean;
  /** fin_bank_transactions rows imported against this account, ever. */
  bankLines: number;
  /** One plain sentence: what the figure on this account is made of. */
  covers: string;
};

export type CashCoverage = {
  /** Every account in the cash total holds its whole story. */
  complete: boolean;
  /** Plain sentences naming what is missing, in account order. Empty when complete. */
  gaps: string[];
  /** The cash accounts that are in use, in chart order. */
  accounts: CoverageAccount[];
  /** Bank lines imported for this book, ever (every account). 0 = no bank feed or import. */
  bankLines: number;
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-09-05" → "Sep 5". A value that is not a date passes through. */
function shortDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${MONTHS[Number(m[2]) - 1] ?? m[2]} ${Number(m[3])}`;
}

/** "2026-09-05" → "Sep 5, 2026". */
function longDate(iso: string): string {
  return /^\d{4}-\d{2}-\d{2}/.test(iso) ? `${shortDate(iso)}, ${iso.slice(0, 4)}` : iso;
}

function span(first: string | null, last: string | null): string {
  if (!first || !last) return "";
  if (first === last) return ` on ${shortDate(first)}`;
  const sameYear = first.slice(0, 4) === last.slice(0, 4);
  return sameYear
    ? ` from ${shortDate(first)} to ${shortDate(last)}`
    : ` from ${shortDate(first)}, ${first.slice(0, 4)} to ${shortDate(last)}, ${last.slice(0, 4)}`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Which book the accounts belong to (fin_entities.kind): the charts differ (chart.ts). */
export type BookKind = "business" | "personal";

/**
 * The equity account a book's opening balances post against: the business
 * book's Retained earnings (what the Wise card posts to, wise-feed-io.ts), the
 * personal book's "Net worth (opening balance)" (chart.ts PERSONAL_CHART).
 */
const OPENING_EQUITY_CODE: Record<BookKind, string> = { business: SYS.retained, personal: "3000" };

/** ledger-io.ts buildReversal's source: a reversal has an opening balance's shape and undoes it. */
const REVERSAL_SOURCE = "reversal";

/** In force: posted, and not itself a reversal. A reversed entry records nothing. */
function inForce(l: ReportLine): boolean {
  return l.status === "posted" && l.source !== REVERSAL_SOURCE;
}

/**
 * How an account's missing opening balance gets fixed, said with the gap so it
 * is not a dead end, and never pointing at a control that does not work.
 *
 * The one place in the app that records an opening balance is the Wise card
 * (Finances › Settings; wise-feed-io.ts postWiseOpeningBalance), and only for
 * the BUSINESS book's chequing: it posts to the business entity whatever book
 * is open. Its Post button is disabled while bank feed writes are off
 * (wise-feed.ts WISE_FEED_WRITES_ENABLED), so the gap says it cannot be done
 * yet rather than naming a greyed-out button. No journal-entry screen exists,
 * so every other bank or cash account, and every personal book, is told the
 * same plainly.
 */
function openingBalanceFix(book: BookKind, code: string, wiseWritesEnabled: boolean): string {
  if (book === "business" && code === SYS.chequing) {
    return wiseWritesEnabled
      ? "(post it from the Wise card in Finances › Settings)"
      : "(recording one is not yet possible from the app while bank feed writes are off)";
  }
  return "(recording one for this account is not yet possible from the app)";
}

/**
 * What a cash surface prints in place of "Cash on hand" when the books are
 * incomplete, or null when the ledger total may be called a balance. The
 * Finances Overview prints it; Today's Cash glance prints the same sentence
 * and the /money tile the same gaps, from the same coverage.
 */
export function incompleteBooksNote(coverage: Pick<CashCoverage, "complete" | "gaps">): string | null {
  return coverage.complete ? null : `Not a cash balance yet: ${coverage.gaps.join("; ")}.`;
}

/** A payout Stripe reported paid that the books have not booked (stripe-payouts-io.ts unbookedPayouts). */
export type UnbookedPayout = { id: string; arrivalDate: string; booking: "held" | "unmapped"; reason: string };

/** One gap for every payout the books did not book: how many, and why the oldest was not. */
export function unbookedPayoutsGap(unbooked: readonly UnbookedPayout[]): string | null {
  if (unbooked.length === 0) return null;
  const count = `${plural(unbooked.length, "Stripe payout")} to the bank ${unbooked.length === 1 ? "is" : "are"} not booked`;
  const reasons = new Set(unbooked.map((p) => p.reason));
  if (reasons.size === 1) return `${count}: ${unbooked[0].reason}`;
  const oldest = unbooked[0];
  return `${count} (the oldest, ${shortDate(oldest.arrivalDate)}: ${oldest.reason})`;
}

type CashInput = {
  accounts: readonly ReportAccount[];
  lines: readonly ReportLine[];
  /** fin_bank_transactions counts by account id. */
  bankLinesByAccount: Readonly<Record<string, number>>;
  /** The book these accounts belong to: its opening-balance account and who can post one differ. */
  book: BookKind;
  /** Whether the Wise card can post an opening balance right now (wise-feed.ts WISE_FEED_WRITES_ENABLED). */
  wiseWritesEnabled: boolean;
  /** Paid payouts not booked, oldest first. Only the business book has Stripe payouts; omitted = none. */
  unbookedPayouts?: readonly UnbookedPayout[];
};

/** Lines grouped by account and by entry, with each account's subtype: what both coverages walk. */
function indexLines(accounts: readonly ReportAccount[], lines: readonly ReportLine[]) {
  const kindOf = new Map(accounts.map((a) => [a.id, a.subtype]));
  const byAccount = new Map<string, ReportLine[]>();
  const byEntry = new Map<string, ReportLine[]>();
  for (const l of lines) {
    let onAccount = byAccount.get(l.accountId);
    if (!onAccount) byAccount.set(l.accountId, (onAccount = []));
    onAccount.push(l);
    let legs = byEntry.get(l.entryId);
    if (!legs) byEntry.set(l.entryId, (legs = []));
    legs.push(l);
  }
  return { kindOf, byAccount, byEntry };
}

export function cashCoverage(input: CashInput): CashCoverage {
  const unbooked = input.unbookedPayouts ?? [];
  let payoutGapSaid = false;
  const cashAccounts = input.accounts.filter((a) => BALANCE_SUBTYPES.has(a.subtype) || a.subtype === "clearing");
  const { kindOf, byAccount, byEntry } = indexLines(input.accounts, input.lines);
  const openingEquity = new Set(
    input.accounts.filter((a) => a.type === "equity" && a.code === OPENING_EQUITY_CODE[input.book]).map((a) => a.id),
  );
  /**
   * An opening balance IN FORCE, whatever posted it: a posted entry (a
   * reversed one records no starting point) that is not itself a reversal,
   * and is either the Wise card's (its source) or sets bank and cash accounts
   * against the book's opening-balance equity account and nothing else. A
   * transfer between two bank accounts touches no equity; an expense, an
   * owner contribution or a payout touches other accounts; neither counts.
   */
  const isOpeningBalance = (l: ReportLine): boolean => {
    if (!inForce(l)) return false;
    if (l.source === OPENING_BALANCE_SOURCE) return true;
    const legs = byEntry.get(l.entryId) || [];
    return (
      legs.some((o) => openingEquity.has(o.accountId)) &&
      legs.every((o) => openingEquity.has(o.accountId) || BALANCE_SUBTYPES.has(kindOf.get(o.accountId) || ""))
    );
  };

  const gaps: string[] = [];
  const accounts: CoverageAccount[] = [];
  for (const a of cashAccounts) {
    const lines = byAccount.get(a.id) || [];
    const bankLines = Number(input.bankLinesByAccount[a.id] || 0);
    if (lines.length === 0 && bankLines === 0) continue;
    const dates = lines.map((l) => l.entryDate).sort();
    const firstDate = dates[0] ?? null;
    const lastDate = dates[dates.length - 1] ?? null;
    const entries = new Set(lines.map((l) => l.entryId)).size;
    const balanceCents = lines.reduce((s, l) => s + l.cadDebitCents - l.cadCreditCents, 0);
    // In force only: a reversed opening balance (replaced or removed from the
    // Wise card; ledger-io buildReversal) records no starting point at all.
    const hasOpeningBalance = lines.some(isOpeningBalance);
    let covers: string;

    if (a.code === SYS.stripeClearing) {
      const cardMoneyIn = lines.some((l) => l.cadDebitCents > 0);
      // A payout IN FORCE: an entry that takes money OUT of clearing and puts it
      // INTO a bank or cash account. A voided payout records none.
      const payoutRecorded = lines.some(
        (l) =>
          inForce(l) &&
          l.cadCreditCents > 0 &&
          (byEntry.get(l.entryId) || []).some(
            (o) => o.accountId !== a.id && BALANCE_SUBTYPES.has(kindOf.get(o.accountId) || "") && o.cadDebitCents > 0,
          ),
      );
      covers = `Card charges less Stripe fees and refunds${span(firstDate, lastDate)}; ${
        unbooked.length > 0
          ? `${plural(unbooked.length, "payout")} to the bank not booked, so this is not Stripe's balance`
          : payoutRecorded
            ? "payouts to the bank are recorded"
            : "no payout to the bank is recorded, so this is not Stripe's balance"
      }`;
      const payoutGap = unbookedPayoutsGap(unbooked);
      if (payoutGap) {
        gaps.push(payoutGap);
        payoutGapSaid = true;
      } else if (cardMoneyIn && !payoutRecorded) gaps.push("Stripe payouts to the bank are not recorded");
    } else if (BALANCE_SUBTYPES.has(a.subtype)) {
      covers = `${plural(entries, "entry", "entries")}${span(firstDate, lastDate)}; ${
        hasOpeningBalance ? "opening balance recorded" : "no opening balance"
      }; ${bankLines > 0 ? `${plural(bankLines, "bank line")} imported` : "no bank import"}`;
      if (!hasOpeningBalance) gaps.push(`${a.name} has no opening balance ${openingBalanceFix(input.book, a.code, input.wiseWritesEnabled)}`);
    } else {
      covers = `${plural(entries, "entry", "entries")}${span(firstDate, lastDate)}`;
    }

    accounts.push({
      code: a.code,
      name: a.name,
      subtype: a.subtype,
      balanceCents,
      entries,
      firstDate,
      lastDate,
      hasOpeningBalance,
      bankLines,
      covers,
    });
  }
  // Stripe clearing held nothing to list (its charges are not in the books),
  // yet Stripe reported payouts: still a gap, never silence.
  const payoutGap = unbookedPayoutsGap(unbooked);
  if (payoutGap && !payoutGapSaid) gaps.push(payoutGap);

  return {
    complete: gaps.length === 0,
    gaps,
    accounts,
    bankLines: Object.values(input.bankLinesByAccount).reduce((s, n) => s + Number(n || 0), 0),
  };
}

// ── the whole book ───────────────────────────────────────────────────────

/**
 * Expense accounts the books fill on their own from Stripe and the bank feed
 * (Stripe fees on every charge, FX gain/loss on every conversion). They say
 * nothing about whether rent, software or contractors were recorded, so they
 * never count as "operating expenses recorded from".
 */
const AUTOMATIC_EXPENSE_CODES: ReadonlySet<string> = new Set([SYS.stripeFees, SYS.fxGainLoss]);

/** What the books' revenue figures count, and whether they can count all of it. */
export type RevenueSources = {
  /** Revenue from Stripe (charges and refunds) is in the books. */
  stripe: boolean;
  /** Revenue from anywhere else (an invoice marked paid, a categorised deposit) is in the books. */
  other: boolean;
  /** The earliest bank line imported for the book (a bank feed or a statement import, never one typed by hand); null = none. */
  bankFrom: string | null;
  /**
   * Every rail revenue can arrive by is recorded: bank deposits are in the
   * books from on or before the first revenue, and every bank account's
   * imports run without a missing month through the current one. False =
   * every revenue total is a floor (off-Stripe revenue may be missing).
   */
  complete: boolean;
  /** In words, for the threshold and the banner: e.g. "Counts Stripe only; bank deposits and off-Stripe revenue are not recorded". */
  note: string | null;
};

export type BooksCoverage = {
  /** The first operating expense in force (Stripe fees and FX excluded); null = none recorded. */
  expensesFrom: string | null;
  /** The first revenue in force; null = none recorded. */
  revenueFrom: string | null;
  revenueSources: RevenueSources;
  /** Bank and cash accounts in use, by name: those with an opening balance in force, and those without. */
  openingBalances: { recorded: string[]; missing: string[] };
  /** Stripe clearing has seen a payout to the bank and none Stripe reported paid is left unbooked (true when no card money ever came in). */
  payoutsRecorded: boolean;
  complete: boolean;
  /** Plain sentences, cash first, then expenses, then revenue. Empty when complete. */
  gaps: string[];
  /** The cash half, unchanged (the cash tile, Today and Atlas's summary read it). */
  cash: CashCoverage;
};

export type BooksCoverageInput = CashInput & {
  /** The earliest IMPORTED fin_bank_transactions.posted_date per account id (source 'import'); an account with none is absent or null. */
  bankLinesFromByAccount?: Readonly<Record<string, string | null | undefined>>;
  /** The latest IMPORTED posted_date per account id; absent or null = not known. */
  bankLinesToByAccount?: Readonly<Record<string, string | null | undefined>>;
  /** The calendar months ("YYYY-MM") holding at least one IMPORTED line, per account id; absent = none known. */
  bankLineMonthsByAccount?: Readonly<Record<string, readonly string[] | null | undefined>>;
  /** Today (Toronto, YYYY-MM-DD): imported bank lines must reach this month for deposits to be on the books through now. */
  today: string;
};

/** "2026-02" -> "Feb 2026". */
function monthLabel(ym: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(ym);
  return m ? `${MONTHS[Number(m[2]) - 1] ?? m[2]} ${m[1]}` : ym;
}

/** The month after "YYYY-MM". */
function nextMonth(ym: string): string {
  const y = Number(ym.slice(0, 4));
  const m = Number(ym.slice(5, 7));
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}

/** Every month from `from` to `to` ("YYYY-MM"), both included; empty when `from` is later. */
function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let m = from; m <= to && out.length < 1200; m = nextMonth(m)) out.push(m);
  return out;
}

/** Sorted months as words, runs merged: "Feb 2026", "Feb to Aug 2026", "Dec 2026 to Jan 2027", joined with "and". */
function monthsLabel(months: readonly string[]): string {
  const sorted = [...new Set(months)].sort();
  const runs: Array<[string, string]> = [];
  for (const m of sorted) {
    const last = runs[runs.length - 1];
    if (last && nextMonth(last[1]) === m) last[1] = m;
    else runs.push([m, m]);
  }
  const words = runs.map(([a, b]) => {
    if (a === b) return monthLabel(a);
    return a.slice(0, 4) === b.slice(0, 4) ? `${monthLabel(a).slice(0, 3)} to ${monthLabel(b)}` : `${monthLabel(a)} to ${monthLabel(b)}`;
  });
  return words.length <= 1 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/** "Stripe", "invoices and deposits recorded by hand", or both: what the revenue in the books came from. */
function countedSources(stripe: boolean, other: boolean): string {
  if (stripe && other) return "Stripe and revenue recorded by hand";
  if (other) return "revenue recorded by hand";
  return "Stripe";
}

export function booksCoverage(input: BooksCoverageInput): BooksCoverage {
  const cash = cashCoverage(input);
  const typeOf = new Map(input.accounts.map((a) => [a.id, a]));
  let expensesFrom: string | null = null;
  let revenueFrom: string | null = null;
  let stripe = false;
  let other = false;
  /** Months ("YYYY-MM") with revenue in force, and with an operating expense in force. */
  const revenueMonths = new Set<string>();
  const expenseMonths = new Set<string>();
  for (const l of input.lines) {
    if (!inForce(l)) continue;
    const a = typeOf.get(l.accountId);
    if (!a) continue;
    if (a.type === "expense" && l.cadDebitCents > 0 && !AUTOMATIC_EXPENSE_CODES.has(a.code)) {
      if (expensesFrom === null || l.entryDate < expensesFrom) expensesFrom = l.entryDate;
      expenseMonths.add(l.entryDate.slice(0, 7));
    } else if (a.type === "revenue" && (l.cadCreditCents > 0 || l.cadDebitCents > 0)) {
      if (l.cadCreditCents > 0 && (revenueFrom === null || l.entryDate < revenueFrom)) revenueFrom = l.entryDate;
      if (l.cadCreditCents > 0) revenueMonths.add(l.entryDate.slice(0, 7));
      if (l.source.startsWith("stripe")) stripe = true;
      else other = true;
    }
  }

  // Bank lines exist only for bank, cash and card accounts; the earliest one
  // on a BANK account is where deposits start to be on the books. They are on
  // the books only while the imports CONTINUE: an account whose imported lines
  // stop short of this month, or skip a month, says nothing about the deposits
  // after it or in it (one old statement import is not a bank feed).
  let bankFrom: string | null = null;
  const thisMonth = input.today.slice(0, 7);
  const continuityNotes: string[] = [];
  const sources = countedSources(stripe, other);
  for (const [accountId, from] of Object.entries(input.bankLinesFromByAccount ?? {})) {
    if (!from || Number(input.bankLinesByAccount[accountId] || 0) === 0) continue;
    const account = typeOf.get(accountId);
    if (!account || !BALANCE_SUBTYPES.has(account.subtype)) continue;
    if (bankFrom === null || from < bankFrom) bankFrom = from;
    const to = input.bankLinesToByAccount?.[accountId] ?? null;
    const held = new Set(input.bankLineMonthsByAccount?.[accountId] ?? []);
    const missing = monthsBetween(from.slice(0, 7), thisMonth).filter((m) => !held.has(m));
    if (missing.length === 0) continue;
    const toMonth = to ? to.slice(0, 7) : null;
    continuityNotes.push(
      toMonth && missing.every((m) => m > toMonth)
        ? `Bank deposits into ${account.name} are recorded from ${longDate(from)} to ${longDate(to as string)} only; revenue after that counts ${sources} only`
        : `No bank line is imported into ${account.name} for ${monthsLabel(missing)}; revenue in ${missing.length === 1 ? "that month" : "those months"} counts ${sources} only`,
    );
  }

  const revenueNotes: string[] = [];
  if (bankFrom === null) {
    revenueNotes.push(
      stripe || other
        ? `Counts ${sources} only; bank deposits and off-Stripe revenue are not recorded`
        : "No revenue and no bank deposit is recorded, so revenue is unknown, not zero",
    );
  } else {
    if (revenueFrom !== null && bankFrom > revenueFrom) {
      revenueNotes.push(`Bank deposits are recorded from ${longDate(bankFrom)} only; revenue before then counts ${sources} only`);
    }
    revenueNotes.push(...continuityNotes);
  }
  const revenueComplete = revenueNotes.length === 0;
  const revenueNote = revenueComplete ? null : revenueNotes.join(". ");

  const expenseGap =
    revenueFrom === null
      ? null
      : expensesFrom === null
        ? `No operating expenses are recorded (rent, software, contractors); revenue is recorded from ${longDate(revenueFrom)}`
        : expensesFrom > revenueFrom
          ? `Operating expenses are recorded from ${longDate(expensesFrom)} only; revenue from ${longDate(revenueFrom)}, so earlier costs are missing`
          : null;
  // After expenses start, a month with revenue and no operating expense at all
  // is a month whose costs are not recorded (rent and software recur monthly).
  const bareMonths = expensesFrom === null ? [] : [...revenueMonths].filter((m) => m >= (expensesFrom as string).slice(0, 7) && !expenseMonths.has(m));
  const bareMonthsGap =
    bareMonths.length === 0
      ? null
      : `No operating expense is recorded for ${monthsLabel(bareMonths)}, ${bareMonths.length === 1 ? "a month" : "months"} with revenue, so ${bareMonths.length === 1 ? "its" : "their"} costs are missing`;

  const gaps = [...cash.gaps, ...(expenseGap ? [expenseGap] : []), ...(bareMonthsGap ? [bareMonthsGap] : []), ...revenueNotes];
  const inUse = cash.accounts.filter((a) => BALANCE_SUBTYPES.has(a.subtype));
  // Payouts: none Stripe reported paid is left unbooked, and card money that
  // came into Stripe clearing has left it into a bank at least once (the same
  // shape cashCoverage reads). No card money ever in: nothing to pay out.
  const { kindOf, byAccount, byEntry } = indexLines(input.accounts, input.lines);
  const clearingId = input.accounts.find((a) => a.code === SYS.stripeClearing)?.id;
  const clearingLines = clearingId ? byAccount.get(clearingId) || [] : [];
  const cardMoneyIn = clearingLines.some((l) => l.cadDebitCents > 0);
  const payoutInForce = clearingLines.some(
    (l) =>
      inForce(l) &&
      l.cadCreditCents > 0 &&
      (byEntry.get(l.entryId) || []).some((o) => o.accountId !== clearingId && BALANCE_SUBTYPES.has(kindOf.get(o.accountId) || "") && o.cadDebitCents > 0),
  );
  const payoutsRecorded = (input.unbookedPayouts ?? []).length === 0 && (!cardMoneyIn || payoutInForce);
  return {
    expensesFrom,
    revenueFrom,
    revenueSources: { stripe, other, bankFrom, complete: revenueComplete, note: revenueNote },
    openingBalances: {
      recorded: inUse.filter((a) => a.hasOpeningBalance).map((a) => a.name),
      missing: inUse.filter((a) => !a.hasOpeningBalance).map((a) => a.name),
    },
    payoutsRecorded,
    complete: gaps.length === 0,
    gaps,
    cash,
  };
}

/** The Accounts page's caveat under a bank balance that is negative only because nothing records its deposits. */
export const BANK_NOT_CONNECTED = "Bank not connected: balances exclude deposits";

/**
 * True when a bank account's balance is below zero and can only be: the
 * books record money leaving it (paid bills, expenses) and never money
 * arriving (no deposit in force, no bank line imported). That figure is not
 * an overdraft; it is what was spent from the account since the book began.
 */
export function bankBalanceExcludesDeposits(input: {
  account: Pick<ReportAccount, "id" | "subtype">;
  /** The account's natural balance (debit minus credit for an asset), in CAD cents. */
  balanceCents: number;
  lines: readonly ReportLine[];
  bankLines: number;
}): boolean {
  if (!BALANCE_SUBTYPES.has(input.account.subtype) || input.balanceCents >= 0 || input.bankLines > 0) return false;
  return !input.lines.some((l) => l.accountId === input.account.id && inForce(l) && l.cadDebitCents > 0);
}
