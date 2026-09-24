/**
 * Report objects -> CSV rows. PURE. Amounts are exported as decimal CAD
 * ("1234.56"), the form a spreadsheet or an accountant's import expects.
 */

import { centsToDecimalString } from "./money";
import type { AgingBucket, BalanceSheet, CashFlow, LedgerAccountSection, ProfitAndLoss, TrialBalance, AccountRow } from "./reports";
import { AGING_BUCKETS } from "./reports";

type Cell = string | number;
const d = centsToDecimalString;

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
