/**
 * Report objects -> CSV rows. PURE. Amounts are exported as decimal CAD
 * ("1234.56"), the form a spreadsheet or an accountant's import expects.
 */

import { centsToDecimalString } from "./money";
import type { AgingBucket, BalanceSheet, CashFlow, LedgerAccountSection, ProfitAndLoss, TrialBalance, AccountRow } from "./reports";
import { AGING_BUCKETS } from "./reports";

type Cell = string | number;
const d = centsToDecimalString;

/**
 * The CSV's first line when the book is incomplete, naming every gap, so an
 * exported statement never travels without what it leaves out
 * (books-coverage.ts). A real comment line: "#" is its first character, and
 * it is written raw, before the RFC 4180 rows (toCsv), never as a quoted
 * cell, which would start the line with a quote that no "#"-skipping importer
 * recognises. So it can need no quoting at all: no comma (a date reads
 * "Sep 1 2026"), no double quote and no line break. An importer that skips
 * comment lines skips it whole; one that does not reads it as one cell.
 * Complete books: "" (no line).
 */
export function coverageCsvComment(coverage: { complete: boolean; gaps: readonly string[] }): string {
  if (coverage.complete || coverage.gaps.length === 0) return "";
  const gaps = coverage.gaps.map((g) => (/[.!?]$/.test(g.trim()) ? g.trim() : `${g.trim()}.`)).join(" ");
  const line = `# Books incomplete: these figures are only what the books record so far. ${gaps}`
    .replace(/[\r\n]+/g, " ")
    .replace(/"/g, "'")
    .replace(/,/g, "");
  return `${line}\r\n`;
}

function section(title: string, rows: AccountRow[], total: number): Cell[][] {
  return [[title], ...rows.map((r) => [r.code, r.name, d(r.amountCents)]), [`Total ${title.toLowerCase()}`, "", d(total)], []];
}

export function pnlRows(p: ProfitAndLoss): Cell[][] {
  return [
    ["Code", "Account", "Amount (CAD)"],
    ...section("Revenue", p.revenue, p.totalRevenueCents),
    ...section("Expenses", p.expenses, p.totalExpenseCents),
    ["Net income", "", d(p.netIncomeCents)],
  ];
}

export function balanceRows(b: BalanceSheet): Cell[][] {
  return [
    ["Code", "Account", "Amount (CAD)"],
    ...section("Assets", b.assets, b.totalAssetsCents),
    ...section("Liabilities", b.liabilities, b.totalLiabilitiesCents),
    ...b.equity.map((r) => [r.code, r.name, d(r.amountCents)]),
    ["", "Current earnings", d(b.currentEarningsCents)],
    ["Total equity", "", d(b.totalEquityCents)],
  ];
}

export function trialRows(t: TrialBalance): Cell[][] {
  return [
    ["Code", "Account", "Debit (CAD)", "Credit (CAD)"],
    ...t.rows.map((r) => [r.code, r.name, r.debitCents ? d(r.debitCents) : "", r.creditCents ? d(r.creditCents) : ""]),
    ["Total", "", d(t.totalDebitCents), d(t.totalCreditCents)],
  ];
}

export function cashFlowRows(c: CashFlow): Cell[][] {
  return [
    ["Code", "Account", "Amount (CAD)"],
    ["Opening cash", "", d(c.openingCashCents)],
    [],
    ...section("Operating", c.operating, c.netOperatingCents),
    ...section("Investing", c.investing, c.netInvestingCents),
    ...section("Financing", c.financing, c.netFinancingCents),
    ["Net change", "", d(c.netChangeCents)],
    ["Closing cash", "", d(c.closingCashCents)],
  ];
}

export function ledgerRows(sections: LedgerAccountSection[]): Cell[][] {
  const out: Cell[][] = [["Account", "Date", "Memo", "Source", "Debit (CAD)", "Credit (CAD)", "Balance (CAD)"]];
  for (const s of sections) {
    out.push([`${s.account.code} ${s.account.name}`, "", "Opening balance", "", "", "", d(s.openingCents)]);
    for (const r of s.rows) out.push(["", r.date, r.memo, r.source, r.debitCents ? d(r.debitCents) : "", r.creditCents ? d(r.creditCents) : "", d(r.balanceCents)]);
    out.push([`${s.account.code} ${s.account.name}`, "", "Closing balance", "", "", "", d(s.closingCents)], []);
  }
  return out;
}

export function agingRows(a: {
  rows: Array<{ number: string | null; contactName: string; dueDate: string; balanceCents: number; currency: string; bucket: AgingBucket }>;
}): Cell[][] {
  return [
    ["Invoice", "Customer", "Due", "Currency", ...AGING_BUCKETS],
    ...a.rows.map((r) => [r.number || "", r.contactName, r.dueDate, r.currency, ...AGING_BUCKETS.map((b) => (b === r.bucket ? d(r.balanceCents) : ""))]),
  ];
}
