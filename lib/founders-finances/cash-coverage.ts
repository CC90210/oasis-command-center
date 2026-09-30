/**
 * lib/founders-finances/cash-coverage.ts — may the ledger's cash figure be
 * called "cash on hand"?
 *
 * overview() sums debit minus credit over the bank, cash and clearing accounts
 * (reports-io.ts). That is the right arithmetic and the wrong claim whenever
 * the book does not hold the whole story of those accounts. On 2026-09-29 the
 * owner's Today showed "Cash on hand −CA$1,788.23" because:
 *
 *   - 1000 Business chequing held six September expenses and nothing else: no
 *     opening balance, no deposits, no bank import. Its −CA$3,427.44 is "what
 *     was spent from it since the book started", not a balance.
 *   - 1050 Stripe clearing held every card charge less fees and refunds, and
 *     no payout: Stripe's own balance was $0, the book's was +CA$1,639.21, and
 *     it only grows, because nothing books a payout.
 *
 * This file does not change that arithmetic or any account (Atlas owns the
 * definitions). It answers one question the tile has to ask before printing
 * the figure as a balance, and says in plain words what each account covers,
 * so the raw figure can still be shown as what it is.
 *
 * INCOMPLETE when either holds:
 *   - a bank or cash account that is in use (it has ledger lines or imported
 *     bank lines) has no opening-balance entry IN FORCE (isOpeningBalance,
 *     below: status "posted", so a reversed one no longer records a starting
 *     point);
 *   - Stripe clearing has card money in it and no payout has ever moved money
 *     out of it into a bank or cash account.
 * A payout is recognised by its SHAPE, not a source name: one entry that
 * credits Stripe clearing and debits a bank or cash account. That is how a
 * payout lands today (a bank line categorised by the seeded "Stripe payouts
 * are transfers" rule) and how a future payout.paid handler would post it.
 * An opening balance is recognised the same way, whatever wrote it: the Wise
 * card's (source "opening_balance", wise-feed.ts OPENING_BALANCE_SOURCE), or
 * any posted entry that sets bank or cash accounts against the book's
 * opening-balance equity account and nothing else.
 *
 * PURE: overview() hands it the ledger it already loaded; tests run it bare.
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

export function cashCoverage(input: {
  accounts: readonly ReportAccount[];
  lines: readonly ReportLine[];
  /** fin_bank_transactions counts by account id. */
  bankLinesByAccount: Readonly<Record<string, number>>;
  /** The book these accounts belong to: its opening-balance account and who can post one differ. */
  book: BookKind;
  /** Whether the Wise card can post an opening balance right now (wise-feed.ts WISE_FEED_WRITES_ENABLED). */
  wiseWritesEnabled: boolean;
}): CashCoverage {
  const cashAccounts = input.accounts.filter((a) => BALANCE_SUBTYPES.has(a.subtype) || a.subtype === "clearing");
  const kindOf = new Map(input.accounts.map((a) => [a.id, a.subtype]));
  const byAccount = new Map<string, ReportLine[]>();
  const byEntry = new Map<string, ReportLine[]>();
  for (const l of input.lines) {
    byAccount.set(l.accountId, [...(byAccount.get(l.accountId) || []), l]);
    byEntry.set(l.entryId, [...(byEntry.get(l.entryId) || []), l]);
  }
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
    if (l.status !== "posted" || l.source === REVERSAL_SOURCE) return false;
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
      // A payout: an entry that takes money OUT of clearing and puts it INTO a bank or cash account.
      const payoutRecorded = lines.some(
        (l) =>
          l.cadCreditCents > 0 &&
          (byEntry.get(l.entryId) || []).some(
            (o) => o.accountId !== a.id && BALANCE_SUBTYPES.has(kindOf.get(o.accountId) || "") && o.cadDebitCents > 0,
          ),
      );
      covers = `Card charges less Stripe fees and refunds${span(firstDate, lastDate)}; ${
        payoutRecorded ? "payouts to the bank are recorded" : "no payout to the bank is recorded, so this is not Stripe's balance"
      }`;
      if (cardMoneyIn && !payoutRecorded) gaps.push("Stripe payouts to the bank are not recorded");
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

  return {
    complete: gaps.length === 0,
    gaps,
    accounts,
    bankLines: Object.values(input.bankLinesByAccount).reduce((s, n) => s + Number(n || 0), 0),
  };
}
