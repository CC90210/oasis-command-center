/**
 * Financial statements from journal lines. PURE.
 *
 * Every figure is in CAD (the functional currency): lines carry their CAD
 * equivalent from the day they were posted (ledger.ts), so a statement is a
 * sum, never a re-conversion at today's rate.
 *
 * Date ranges are [from, to) on entry_date, like the rest of the suite.
 */

import { naturalBalance, type AccountType } from "./ledger";
import { CASH_SUBTYPES } from "./chart";

export type ReportAccount = { id: string; code: string; name: string; type: AccountType; subtype: string };

export type ReportLine = {
  entryId: string;
  entryDate: string;
  accountId: string;
  cadDebitCents: number;
  cadCreditCents: number;
  memo: string;
  entryMemo: string;
  source: string;
};

export type AccountRow = { accountId: string; code: string; name: string; type: AccountType; subtype: string; amountCents: number };

function sumByAccount(lines: readonly ReportLine[], pred: (l: ReportLine) => boolean) {
  const m = new Map<string, { d: number; c: number }>();
  for (const l of lines) {
    if (!pred(l)) continue;
    const cur = m.get(l.accountId) || { d: 0, c: 0 };
    cur.d += l.cadDebitCents;
    cur.c += l.cadCreditCents;
    m.set(l.accountId, cur);
  }
  return m;
}

function sortRows(rows: AccountRow[]): AccountRow[] {
  return rows.sort((a, b) => a.code.localeCompare(b.code));
}

export type TrialBalance = {
  rows: Array<{ accountId: string; code: string; name: string; type: AccountType; debitCents: number; creditCents: number }>;
  totalDebitCents: number;
  totalCreditCents: number;
  balanced: boolean;
};

export function trialBalance(accounts: readonly ReportAccount[], lines: readonly ReportLine[], asOf: string): TrialBalance {
  const sums = sumByAccount(lines, (l) => l.entryDate < asOf);
  const rows = accounts
    .map((a) => {
      const s = sums.get(a.id) || { d: 0, c: 0 };
      const net = s.d - s.c;
      return {
        accountId: a.id,
        code: a.code,
        name: a.name,
        type: a.type,
        debitCents: net > 0 ? net : 0,
        creditCents: net < 0 ? -net : 0,
      };
    })
    .filter((r) => r.debitCents !== 0 || r.creditCents !== 0)
    .sort((a, b) => a.code.localeCompare(b.code));
  const totalDebitCents = rows.reduce((a, r) => a + r.debitCents, 0);
  const totalCreditCents = rows.reduce((a, r) => a + r.creditCents, 0);
  return { rows, totalDebitCents, totalCreditCents, balanced: totalDebitCents === totalCreditCents };
}

export type ProfitAndLoss = {
  revenue: AccountRow[];
  expenses: AccountRow[];
  totalRevenueCents: number;
  totalExpenseCents: number;
  netIncomeCents: number;
};

export function profitAndLoss(
  accounts: readonly ReportAccount[],
  lines: readonly ReportLine[],
  from: string,
  to: string,
): ProfitAndLoss {
  const sums = sumByAccount(lines, (l) => l.entryDate >= from && l.entryDate < to);
  const revenue: AccountRow[] = [];
  const expenses: AccountRow[] = [];
  for (const a of accounts) {
    const s = sums.get(a.id);
    if (!s) continue;
    if (a.type !== "revenue" && a.type !== "expense") continue;
    const amountCents = naturalBalance(a.type, s.d, s.c);
    if (amountCents === 0) continue;
    const row = { accountId: a.id, code: a.code, name: a.name, type: a.type, subtype: a.subtype, amountCents };
    (a.type === "revenue" ? revenue : expenses).push(row);
  }
  const totalRevenueCents = revenue.reduce((a, r) => a + r.amountCents, 0);
  const totalExpenseCents = expenses.reduce((a, r) => a + r.amountCents, 0);
  return {
    revenue: sortRows(revenue),
    expenses: sortRows(expenses),
    totalRevenueCents,
    totalExpenseCents,
    netIncomeCents: totalRevenueCents - totalExpenseCents,
  };
}

export type BalanceSheet = {
  assets: AccountRow[];
  liabilities: AccountRow[];
  equity: AccountRow[];
  currentEarningsCents: number;
  totalAssetsCents: number;
  totalLiabilitiesCents: number;
  totalEquityCents: number;
  balanced: boolean;
};

/**
 * As of `asOf` (exclusive). Revenue and expense balances roll into a single
 * "current earnings" equity line so the sheet balances without a year-end
 * closing entry — assets = liabilities + equity + current earnings.
 */
export function balanceSheet(accounts: readonly ReportAccount[], lines: readonly ReportLine[], asOf: string): BalanceSheet {
  const sums = sumByAccount(lines, (l) => l.entryDate < asOf);
  const assets: AccountRow[] = [];
  const liabilities: AccountRow[] = [];
  const equity: AccountRow[] = [];
  let currentEarningsCents = 0;
  for (const a of accounts) {
    const s = sums.get(a.id);
    if (!s) continue;
    const amountCents = naturalBalance(a.type, s.d, s.c);
    if (a.type === "revenue") {
      currentEarningsCents += amountCents;
      continue;
    }
    if (a.type === "expense") {
      currentEarningsCents -= amountCents;
      continue;
    }
    if (amountCents === 0) continue;
    const row = { accountId: a.id, code: a.code, name: a.name, type: a.type, subtype: a.subtype, amountCents };
    if (a.type === "asset") assets.push(row);
    else if (a.type === "liability") liabilities.push(row);
    else equity.push(row);
  }
  const totalAssetsCents = assets.reduce((a, r) => a + r.amountCents, 0);
  const totalLiabilitiesCents = liabilities.reduce((a, r) => a + r.amountCents, 0);
  const totalEquityCents = equity.reduce((a, r) => a + r.amountCents, 0) + currentEarningsCents;
  return {
    assets: sortRows(assets),
    liabilities: sortRows(liabilities),
    equity: sortRows(equity),
    currentEarningsCents,
    totalAssetsCents,
    totalLiabilitiesCents,
    totalEquityCents,
    balanced: totalAssetsCents === totalLiabilitiesCents + totalEquityCents,
  };
}

export type CashFlow = {
  openingCashCents: number;
  closingCashCents: number;
  operating: AccountRow[];
  investing: AccountRow[];
  financing: AccountRow[];
  netOperatingCents: number;
  netInvestingCents: number;
  netFinancingCents: number;
  netChangeCents: number;
};

function cashFlowSection(a: ReportAccount): "operating" | "investing" | "financing" {
  if (a.type === "equity" || a.subtype === "loan") return "financing";
  if (a.subtype === "fixed_asset" || a.subtype === "investment") return "investing";
  return "operating";
}

/**
 * Direct method. For every entry that moves a cash-like account (bank, cash,
 * Stripe clearing), the cash movement is attributed to the entry's NON-cash
 * lines, and those are grouped by section. Transfers between two cash
 * accounts net to zero and do not appear.
 */
export function cashFlow(
  accounts: readonly ReportAccount[],
  lines: readonly ReportLine[],
  from: string,
  to: string,
): CashFlow {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const isCash = (id: string) => CASH_SUBTYPES.has(byId.get(id)?.subtype || "");
  let openingCashCents = 0;
  for (const l of lines) {
    if (l.entryDate < from && isCash(l.accountId)) openingCashCents += l.cadDebitCents - l.cadCreditCents;
  }
  const entries = new Map<string, ReportLine[]>();
  for (const l of lines) {
    if (l.entryDate < from || l.entryDate >= to) continue;
    const list = entries.get(l.entryId) || [];
    list.push(l);
    entries.set(l.entryId, list);
  }
  const flows = new Map<string, number>();
  for (const list of entries.values()) {
    const cashDelta = list.filter((l) => isCash(l.accountId)).reduce((a, l) => a + l.cadDebitCents - l.cadCreditCents, 0);
    if (cashDelta === 0) continue;
    // The entry balances in CAD, so the non-cash lines' (credit - debit)
    // sum to exactly the cash movement: each line's own net IS its share.
    for (const l of list) {
      if (isCash(l.accountId)) continue;
      const net = l.cadCreditCents - l.cadDebitCents;
      if (net !== 0) flows.set(l.accountId, (flows.get(l.accountId) || 0) + net);
    }
  }
  const operating: AccountRow[] = [];
  const investing: AccountRow[] = [];
  const financing: AccountRow[] = [];
  for (const [id, amountCents] of flows) {
    if (amountCents === 0) continue;
    const a = byId.get(id);
    if (!a) continue;
    const row = { accountId: id, code: a.code, name: a.name, type: a.type, subtype: a.subtype, amountCents };
    const section = cashFlowSection(a);
    (section === "operating" ? operating : section === "investing" ? investing : financing).push(row);
  }
  const sum = (rows: AccountRow[]) => rows.reduce((a, r) => a + r.amountCents, 0);
  const netOperatingCents = sum(operating);
  const netInvestingCents = sum(investing);
  const netFinancingCents = sum(financing);
  const netChangeCents = netOperatingCents + netInvestingCents + netFinancingCents;
  return {
    openingCashCents,
    closingCashCents: openingCashCents + netChangeCents,
    operating: sortRows(operating),
    investing: sortRows(investing),
    financing: sortRows(financing),
    netOperatingCents,
    netInvestingCents,
    netFinancingCents,
    netChangeCents,
  };
}

/**
 * Money in / money out through cash-like accounts, per entry: an entry that
 * raises cash is "in", one that lowers it is "out", and a transfer between two
 * cash accounts (e.g. a Stripe payout to the bank) moves nothing and is
 * neither — otherwise every payout would read as revenue a second time.
 */
export function cashInOut(
  accounts: readonly ReportAccount[],
  lines: readonly ReportLine[],
  from: string,
  to: string,
): { inCents: number; outCents: number } {
  const cash = new Set(accounts.filter((a) => CASH_SUBTYPES.has(a.subtype)).map((a) => a.id));
  const delta = new Map<string, number>();
  for (const l of lines) {
    if (l.entryDate < from || l.entryDate >= to || !cash.has(l.accountId)) continue;
    delta.set(l.entryId, (delta.get(l.entryId) || 0) + l.cadDebitCents - l.cadCreditCents);
  }
  let inCents = 0;
  let outCents = 0;
  for (const d of delta.values()) {
    if (d > 0) inCents += d;
    else outCents += -d;
  }
  return { inCents, outCents };
}

export type LedgerAccountSection = {
  account: ReportAccount;
  openingCents: number;
  rows: Array<{ entryId: string; date: string; memo: string; source: string; debitCents: number; creditCents: number; balanceCents: number }>;
  closingCents: number;
};

export function generalLedger(
  accounts: readonly ReportAccount[],
  lines: readonly ReportLine[],
  from: string,
  to: string,
  onlyAccountId?: string | null,
): LedgerAccountSection[] {
  const out: LedgerAccountSection[] = [];
  const sorted = [...lines].sort((a, b) => a.entryDate.localeCompare(b.entryDate) || a.entryId.localeCompare(b.entryId));
  for (const account of [...accounts].sort((a, b) => a.code.localeCompare(b.code))) {
    if (onlyAccountId && account.id !== onlyAccountId) continue;
    const mine = sorted.filter((l) => l.accountId === account.id);
    if (mine.length === 0) continue;
    let balance = 0;
    for (const l of mine) if (l.entryDate < from) balance += naturalBalance(account.type, l.cadDebitCents, l.cadCreditCents);
    const openingCents = balance;
    const rows = mine
      .filter((l) => l.entryDate >= from && l.entryDate < to)
      .map((l) => {
        balance += naturalBalance(account.type, l.cadDebitCents, l.cadCreditCents);
        return {
          entryId: l.entryId,
          date: l.entryDate,
          memo: l.memo || l.entryMemo,
          source: l.source,
          debitCents: l.cadDebitCents,
          creditCents: l.cadCreditCents,
          balanceCents: balance,
        };
      });
    if (rows.length === 0 && openingCents === 0) continue;
    out.push({ account, openingCents, rows, closingCents: balance });
  }
  return out;
}

export type AgingInvoice = { id: string; number: string | null; contactName: string; dueDate: string; balanceCents: number; currency: string };
export const AGING_BUCKETS = ["current", "1-30", "31-60", "61-90", "90+"] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];

export function agingBucket(dueDate: string, asOf: string): AgingBucket {
  const days = Math.floor((Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${dueDate}T00:00:00Z`)) / 86_400_000);
  if (days <= 0) return "current";
  if (days <= 30) return "1-30";
  if (days <= 60) return "31-60";
  if (days <= 90) return "61-90";
  return "90+";
}

export function arAging(invoices: readonly AgingInvoice[], asOf: string) {
  const rows = invoices
    .filter((i) => i.balanceCents > 0)
    .map((i) => ({ ...i, bucket: agingBucket(i.dueDate, asOf) }))
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const totals: Record<string, Record<AgingBucket, number>> = {};
  for (const r of rows) {
    totals[r.currency] ||= { current: 0, "1-30": 0, "31-60": 0, "61-90": 0, "90+": 0 };
    totals[r.currency][r.bucket] += r.balanceCents;
  }
  return { rows, totals };
}

/**
 * RFC 4180 CSV. Text cells that a spreadsheet would execute as a formula
 * (=, +, -, @, tab, CR at the start) are prefixed with an apostrophe —
 * customer names and bank descriptions are third-party text.
 */
export function toCsv(rows: ReadonlyArray<ReadonlyArray<string | number | null | undefined>>): string {
  return rows
    .map((r) =>
      r
        .map((cell) => {
          if (cell === null || cell === undefined) return "";
          if (typeof cell === "number") return String(cell);
          let s = String(cell);
          if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
          return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        })
        .join(","),
    )
    .join("\r\n");
}
