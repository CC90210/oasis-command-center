/**
 * lib/founders-finances/cash-coverage.ts — the old name of the cash half of
 * books-coverage.ts, kept as an alias.
 *
 * "May the ledger's cash figure be called cash on hand?" (#482) became one of
 * the questions books-coverage.ts answers for the whole book (2026-09-30):
 * expenses from, revenue sources, opening balances and payouts. Today, the
 * /money cash tile, Atlas's summary and the tests import these names from
 * here; they are the same functions, re-exported unchanged.
 */

export {
  cashCoverage,
  incompleteBooksNote,
  unbookedPayoutsGap,
  type BookKind,
  type CashCoverage,
  type CoverageAccount,
  type UnbookedPayout,
} from "./books-coverage";
