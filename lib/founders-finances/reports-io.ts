/**
 * Statement data loading + the Overview / Taxes read models. The arithmetic
 * lives in reports.ts / tax.ts; this file only fetches rows, gated by entity.
 */
import "server-only";

import {
  arAging,
  balanceSheet,
  cashFlow,
  cashInOut,
  generalLedger,
  profitAndLoss,
  trialBalance,
  type ReportAccount,
  type ReportLine,
} from "./reports";
import { gstQstPeriodReport, quarterOf, smallSupplierStatus, trailingFourQuarters, type ThresholdStatus } from "./tax";
import { addDays, isIsoDate, torontoToday } from "./fx";
import { accountId, BUSINESS_ENTITY_ID, CASH_SUBTYPES, SYS } from "./chart";
import { balanceDueCents, effectiveInvoiceStatus } from "./invoice";
import type { FinanceViewer } from "./access";
import { query, queryOne } from "./db";
import { requireEntity, type EntityRow } from "./access-io";
import { loadSettings } from "./settings-io";
import { sweepOverdue } from "./invoices-io";

export const REPORT_KINDS = ["pnl", "balance", "trial", "cashflow", "ledger", "aging"] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

export async function loadLedger(entityId: string, before: string): Promise<{ accounts: ReportAccount[]; lines: ReportLine[] }> {
  // The two reads are independent: one round trip of latency, not two.
  const [accounts, lines] = await Promise.all([
    query<ReportAccount>(`SELECT id, code, name, type, subtype FROM fin_accounts WHERE entity_id = ? ORDER BY code`, [entityId]),
    query<{
      entry_id: string;
      entry_date: string;
      account_id: string;
      cad_debit_cents: number;
      cad_credit_cents: number;
      memo: string;
      entry_memo: string;
      source: string;
    }>(
      `SELECT l.entry_id, e.entry_date, l.account_id, l.cad_debit_cents, l.cad_credit_cents, l.memo, e.memo AS entry_memo, e.source
         FROM fin_journal_lines l JOIN fin_journal_entries e ON e.id = l.entry_id
        WHERE l.entity_id = ? AND e.entry_date < ?`,
      [entityId, before],
    ),
  ]);
  return {
    accounts,
    lines: lines.map((l) => ({
      entryId: l.entry_id,
      entryDate: l.entry_date,
      accountId: l.account_id,
      cadDebitCents: Number(l.cad_debit_cents),
      cadCreditCents: Number(l.cad_credit_cents),
      memo: l.memo || "",
      entryMemo: l.entry_memo || "",
      source: l.source,
    })),
  };
}

export function defaultRange(today = torontoToday()): { from: string; to: string } {
  return { from: `${today.slice(0, 4)}-01-01`, to: addDays(today, 1) };
}

export async function arAgingFor(entityId: string, asOf: string) {
  const rows = await query<{ id: string; number: string | null; contact_name: string; due_date: string; total_cents: number; amount_paid_cents: number; currency: string; status: string }>(
    `SELECT i.id, i.number, c.name AS contact_name, i.due_date, i.total_cents, i.amount_paid_cents, i.currency, i.status
       FROM fin_invoices i JOIN fin_contacts c ON c.id = i.contact_id
      WHERE i.entity_id = ? AND i.status IN ('sent', 'overdue')`,
    [entityId],
  );
  return arAging(
    rows.map((r) => ({
      id: r.id,
      number: r.number,
      contactName: r.contact_name,
      dueDate: r.due_date,
      balanceCents: balanceDueCents({ totalCents: r.total_cents, amountPaidCents: r.amount_paid_cents }),
      currency: r.currency,
    })),
    asOf,
  );
}

export async function runReport(
  viewer: FinanceViewer,
  entityRef: string,
  kind: ReportKind,
  range: { from?: string; to?: string; accountId?: string | null },
) {
  const entity = await requireEntity(viewer, entityRef);
  const d = defaultRange();
  const from = range.from && isIsoDate(range.from) ? range.from : d.from;
  const to = range.to && isIsoDate(range.to) ? range.to : d.to;
  // AR aging reads open invoices only; loading the whole ledger for it was waste.
  if (kind === "aging") return { kind, entity, from, to, data: await arAgingFor(entity.id, addDays(to, -1)) };
  const { accounts, lines } = await loadLedger(entity.id, to);
  switch (kind) {
    case "pnl":
      return { kind, entity, from, to, data: profitAndLoss(accounts, lines, from, to) };
    case "balance":
      return { kind, entity, from, to, data: balanceSheet(accounts, lines, to) };
    case "trial":
      return { kind, entity, from, to, data: trialBalance(accounts, lines, to) };
    case "cashflow":
      return { kind, entity, from, to, data: cashFlow(accounts, lines, from, to) };
    case "ledger":
      return { kind, entity, from, to, data: generalLedger(accounts, lines, from, to, range.accountId || null) };
  }
}

// ── threshold + taxes ────────────────────────────────────────────────────

/** Revenue (CAD, net of refunds) per calendar quarter for the business book. */
export async function quarterlyRevenue(entityId: string, quarters: ReadonlyArray<{ label: string; from: string; to: string }>) {
  // One query per quarter, all in flight at once (they were awaited in turn:
  // four round trips of latency on the Overview and Taxes pages). Order kept.
  return Promise.all(
    quarters.map(async (q) => {
      const row = await queryOne<{ net: number | null }>(
        `SELECT COALESCE(SUM(l.cad_credit_cents - l.cad_debit_cents), 0) AS net
           FROM fin_journal_lines l JOIN fin_journal_entries e ON e.id = l.entry_id JOIN fin_accounts a ON a.id = l.account_id
          WHERE l.entity_id = ? AND a.type = 'revenue' AND e.entry_date >= ? AND e.entry_date < ?`,
        [entityId, q.from, q.to],
      );
      return { label: q.label, revenueCents: Number(row?.net || 0) };
    }),
  );
}

export async function thresholdStatus(today = torontoToday()): Promise<ThresholdStatus> {
  const quarters = trailingFourQuarters(today);
  return smallSupplierStatus(await quarterlyRevenue(BUSINESS_ENTITY_ID, quarters));
}

export async function taxOverview(viewer: FinanceViewer, range: { from?: string; to?: string }) {
  const entity = await requireEntity(viewer, BUSINESS_ENTITY_ID);
  const q = quarterOf(torontoToday());
  const from = range.from && isIsoDate(range.from) ? range.from : q.from;
  const to = range.to && isIsoDate(range.to) ? range.to : q.to;
  // Settings, the period sums and the threshold are independent reads.
  const [settings, sums, threshold] = await Promise.all([
    loadSettings(entity.id),
    query<{ account_id: string; d: number; c: number }>(
      `SELECT l.account_id, COALESCE(SUM(l.cad_debit_cents), 0) AS d, COALESCE(SUM(l.cad_credit_cents), 0) AS c
         FROM fin_journal_lines l JOIN fin_journal_entries e ON e.id = l.entry_id
        WHERE l.entity_id = ? AND e.entry_date >= ? AND e.entry_date < ? AND l.account_id IN (?, ?, ?, ?)
        GROUP BY l.account_id`,
      [entity.id, from, to, accountId(entity.id, SYS.gstPayable), accountId(entity.id, SYS.qstPayable), accountId(entity.id, SYS.gstReceivable), accountId(entity.id, SYS.qstReceivable)],
    ),
    thresholdStatus(),
  ]);
  const get =(code: string) => sums.find((s) => s.account_id === accountId(entity.id, code)) || { d: 0, c: 0 };
  const period = gstQstPeriodReport({
    registered: settings.gst_qst_registered === 1,
    gstCollectedCents: Number(get(SYS.gstPayable).c) - Number(get(SYS.gstPayable).d),
    qstCollectedCents: Number(get(SYS.qstPayable).c) - Number(get(SYS.qstPayable).d),
    gstItcCents: Number(get(SYS.gstReceivable).d) - Number(get(SYS.gstReceivable).c),
    qstItrCents: Number(get(SYS.qstReceivable).d) - Number(get(SYS.qstReceivable).c),
  });
  return { entity, settings, threshold, period, from, to };
}

/** Recent money received/refunded (Stripe + manual), business book. */
export async function listPayments(viewer: FinanceViewer, entityRef: string, limit = 50) {
  const entity = await requireEntity(viewer, entityRef);
  return query<{
    id: string;
    kind: string;
    source: string;
    occurred_on: string;
    amount_cents: number;
    currency: string;
    settlement_cad_cents: number | null;
    fee_cad_cents: number | null;
    fee_status: string;
    customer_name: string;
    customer_email: string;
    invoice_number: string | null;
    description: string;
    entry_id: string | null;
  }>(
    `SELECT p.id, p.kind, p.source, p.occurred_on, p.amount_cents, p.currency, p.settlement_cad_cents, p.fee_cad_cents, p.fee_status,
            p.customer_name, p.customer_email, i.number AS invoice_number, p.description, p.entry_id
       FROM fin_payments p LEFT JOIN fin_invoices i ON i.id = p.invoice_id
      WHERE p.entity_id = ? ORDER BY p.occurred_at DESC LIMIT ${Math.max(1, Math.min(200, Math.trunc(limit)))}`,
    [entity.id],
  );
}

// ── overview ─────────────────────────────────────────────────────────────

function monthStart(date: string, back = 0): string {
  const d = new Date(`${date.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - back);
  return d.toISOString().slice(0, 10);
}

/**
 * `sweep: "deferred"` skips the inline overdue sweep. ONLY for a caller that
 * runs sweepOverdue itself after the response (the Overview page, via
 * next/server after()); nothing here depends on the sweep, because overdue is
 * recomputed from the due date below. Atlas's /summary keeps the default.
 */
export async function overview(viewer: FinanceViewer, entityRef: string, opts: { sweep?: "inline" | "deferred" } = {}) {
  const entity: EntityRow = await requireEntity(viewer, entityRef);
  const today = torontoToday();
  const tomorrow = addDays(today, 1);
  const business = entity.kind === "business";
  // Independent reads run together. The open-invoice read stays BEHIND the
  // sweep (the only write here), so it never runs ahead of it.
  const openInvoices = async () => {
    if (!business) return [];
    if (opts.sweep !== "deferred") await sweepOverdue(entity.id);
    return query<{ status: string; due_date: string; total_cents: number; amount_paid_cents: number; currency: string }>(
      `SELECT status, due_date, total_cents, amount_paid_cents, currency FROM fin_invoices WHERE entity_id = ? AND status IN ('sent', 'overdue')`,
      [entity.id],
    );
  };
  const [{ accounts, lines }, invoices, unreviewed, threshold] = await Promise.all([
    loadLedger(entity.id, tomorrow),
    openInvoices(),
    queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM fin_bank_transactions WHERE entity_id = ? AND status IN ('unreviewed', 'draft')`, [entity.id]),
    business ? thresholdStatus(today) : Promise.resolve(null),
  ]);
  const balances = new Map<string, number>();
  for (const l of lines) balances.set(l.accountId, (balances.get(l.accountId) || 0) + l.cadDebitCents - l.cadCreditCents);
  const cashAccounts = accounts
    .filter((a) => CASH_SUBTYPES.has(a.subtype) || a.subtype === "credit_card")
    .map((a) => ({ id: a.id, code: a.code, name: a.name, subtype: a.subtype, balanceCents: a.type === "asset" ? balances.get(a.id) || 0 : -(balances.get(a.id) || 0) }))
    .filter((a) => a.balanceCents !== 0 || a.subtype === "bank" || a.subtype === "clearing");
  const cashTotal = cashAccounts.filter((a) => a.subtype !== "credit_card").reduce((s, a) => s + a.balanceCents, 0);
  const series: Array<{ month: string; inCents: number; outCents: number }> = [];
  for (let i = 5; i >= 0; i--) {
    const from = monthStart(today, i);
    const to = i === 0 ? tomorrow : monthStart(today, i - 1);
    const io = cashInOut(accounts, lines, from, to);
    series.push({ month: from.slice(0, 7), ...io });
  }
  const pnlMonth = profitAndLoss(accounts, lines, monthStart(today), tomorrow);
  const openAr: Record<string, number> = {};
  const overdueAr: Record<string, number> = {};
  let overdueCount = 0;
  for (const inv of invoices) {
    const bal = balanceDueCents({ totalCents: inv.total_cents, amountPaidCents: inv.amount_paid_cents });
    openAr[inv.currency] = (openAr[inv.currency] || 0) + bal;
    if (effectiveInvoiceStatus({ status: inv.status as "sent", dueDate: inv.due_date, totalCents: inv.total_cents, amountPaidCents: inv.amount_paid_cents }, today) === "overdue") {
      overdueAr[inv.currency] = (overdueAr[inv.currency] || 0) + bal;
      overdueCount += 1;
    }
  }
  return {
    entity,
    today,
    cashAccounts,
    cashTotal,
    series,
    month: { ...series[series.length - 1], revenueCents: pnlMonth.totalRevenueCents, expenseCents: pnlMonth.totalExpenseCents, netCents: pnlMonth.netIncomeCents },
    openAr,
    overdueAr,
    overdueCount,
    unreviewed: Number(unreviewed?.n || 0),
    threshold,
  };
}
