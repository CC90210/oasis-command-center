/**
 * Shared server-side preamble and data loaders for every Finances page.
 *
 * BUSINESS ONLY (CC, 2026-09-24: "this is just finances, it's for the
 * business"). Every page shows the OASIS AI Solutions book; ?entity= is
 * ignored. The personal books and their data are untouched — they are simply
 * not surfaced here. The gate is unchanged: resolveFinanceViewer() (CC and
 * Adon only), then requireBusinessEntity(), which still runs canAccessEntity.
 *
 * LOADERS. Each page's reads live in one function here so the independent
 * ones run together (Promise.all) and tests/finances-roundtrips.test.ts can pin an
 * upper bound on each page's database round trips. No loader makes a network
 * call: FX conversions use stored Bank of Canada rates only (metrics
 * storedRatesOnly), and the Stripe account check streams in behind Suspense
 * on the Settings page rather than blocking it.
 */
import "server-only";

import { notFound } from "next/navigation";
import {
  FinanceNotFound,
  entityAccounts,
  entityCategories,
  requireBusinessEntity,
  resolveFinanceViewer,
  type EntityRow,
  type FounderViewer,
} from "./access-io";
import type { FinanceViewer } from "./access";
import { equitySummary, listBills, listRecurring } from "./bills-io";
import { FX_PAIR_USDCAD, addDays, parseRateMicro, torontoToday, usdToCadCents } from "./fx";
import { getInvoiceDetail, listContacts, listInvoices } from "./invoices-io";
import { revenueCollected, stripeMrr } from "./metrics";
import { monthlyCentsForItem, type RecurringInterval } from "./mrr";
import { REPORT_KINDS, listPayments, loadLedger, overview, runReport, taxOverview, type ReportKind } from "./reports-io";
import { loadSettings } from "./settings-io";
import { importHistory, listRules, listTransactions } from "./transactions-io";
import { query, queryOne } from "./db";

export type SearchParams = Promise<Record<string, string | string[] | undefined>>;
type Sp = Record<string, string | string[] | undefined>;

export function param(sp: Sp, key: string): string {
  const v = sp[key];
  return typeof v === "string" ? v : Array.isArray(v) ? v[0] || "" : "";
}

/** The book a Finances page shows for this viewer: always the business. */
export async function financeBook(viewer: FinanceViewer): Promise<EntityRow> {
  return requireBusinessEntity(viewer);
}

export async function financePage(searchParams: SearchParams): Promise<{ viewer: FounderViewer; entity: EntityRow; sp: Sp }> {
  const [viewer, sp] = await Promise.all([resolveFinanceViewer(), searchParams]);
  if (!viewer) notFound();
  let entity: EntityRow;
  try {
    entity = await financeBook(viewer);
  } catch (e) {
    if (e instanceof FinanceNotFound) notFound();
    throw e;
  }
  return { viewer, entity, sp };
}

// ── recurring expenses, monthly ──────────────────────────────────────────

const CADENCE: Record<string, { interval: RecurringInterval; intervalCount: number }> = {
  weekly: { interval: "week", intervalCount: 1 },
  monthly: { interval: "month", intervalCount: 1 },
  quarterly: { interval: "month", intervalCount: 3 },
  yearly: { interval: "year", intervalCount: 1 },
};

export type RecurringMonthly = {
  items: Array<{ id: string; name: string; cadence: string; currency: string; amountCents: number; monthlyCents: number; monthlyCadCents: number | null }>;
  totalCadCents: number;
  /** Items in a currency with no stored rate, left out of the total. */
  unconverted: number;
  /** The stored USD/CAD rate used, when any USD item was converted. */
  rate: { date: string; rate: string } | null;
};

/**
 * Active recurring items as a monthly CAD figure. PURE. Yearly / 12,
 * quarterly / 3, weekly x 52 / 12 (the MRR normalisation in mrr.ts); USD at
 * the one rate passed in, so the total is an estimate and labelled as one.
 */
export function recurringMonthly(
  rows: ReadonlyArray<{ id: string; name: string; amount_cents: number; currency: string; cadence: string; active: number }>,
  usdCad: { date: string; rate: string } | null,
): RecurringMonthly {
  const micro = usdCad ? parseRateMicro(usdCad.rate) : null;
  let usdUsed = false;
  let unconverted = 0;
  const items = rows
    .filter((r) => Number(r.active) === 1)
    .map((r) => {
      const c = CADENCE[r.cadence] || CADENCE.monthly;
      const monthlyCents = monthlyCentsForItem({ unitAmountCents: Number(r.amount_cents), quantity: 1, interval: c.interval, intervalCount: c.intervalCount });
      let monthlyCadCents: number | null = null;
      if (r.currency === "CAD") monthlyCadCents = monthlyCents;
      else if (r.currency === "USD" && micro) {
        monthlyCadCents = usdToCadCents(monthlyCents, micro);
        usdUsed = true;
      } else unconverted += 1;
      return { id: r.id, name: r.name, cadence: r.cadence, currency: r.currency, amountCents: Number(r.amount_cents), monthlyCents, monthlyCadCents };
    })
    .sort((a, b) => (b.monthlyCadCents ?? -1) - (a.monthlyCadCents ?? -1));
  return {
    items,
    totalCadCents: items.reduce((s, i) => s + (i.monthlyCadCents ?? 0), 0),
    unconverted,
    rate: usdUsed ? usdCad : null,
  };
}

async function latestStoredUsdCad(): Promise<{ date: string; rate: string } | null> {
  const row = await queryOne<{ rate_date: string; rate: string }>(
    `SELECT rate_date, rate FROM fin_fx_rates WHERE pair = ? ORDER BY rate_date DESC LIMIT 1`,
    [FX_PAIR_USDCAD],
  );
  return row ? { date: row.rate_date, rate: String(row.rate) } : null;
}

// ── per-page loaders ─────────────────────────────────────────────────────

/**
 * Overview. The overdue sweep is deferred: the page runs it after the
 * response (next/server after()), and nothing shown depends on it because
 * overdue is recomputed from the due date.
 */
export async function loadOverviewPage(viewer: FinanceViewer, entity: EntityRow) {
  const today = torontoToday();
  const [ov, collected, mrr, recent, recurringRows, usdCad, settings] = await Promise.all([
    overview(viewer, entity.id, { sweep: "deferred" }),
    revenueCollected({ from: `${today.slice(0, 7)}-01`, to: addDays(today, 1) }, { storedRatesOnly: true }),
    stripeMrr({ storedRatesOnly: true }),
    listTransactions(viewer, entity.id, { limit: 8 }),
    listRecurring(viewer, entity.id),
    latestStoredUsdCad(),
    loadSettings(entity.id),
  ]);
  return { ov, collected, mrr, recent, recurring: recurringMonthly(recurringRows, usdCad), stripePinned: Boolean(settings.stripe_account_id) };
}

export async function loadTransactionsPage(viewer: FinanceViewer, entity: EntityRow, sp: Sp) {
  const filters = {
    accountId: param(sp, "account") || undefined,
    categoryId: param(sp, "category") || undefined,
    status: param(sp, "status") || undefined,
    from: param(sp, "from") || undefined,
    to: param(sp, "to") || undefined,
    q: param(sp, "q") || undefined,
  };
  const [rows, accounts, categories, imports, payments] = await Promise.all([
    listTransactions(viewer, entity.id, filters),
    entityAccounts(entity.id),
    entityCategories(entity.id),
    importHistory(viewer, entity.id),
    listPayments(viewer, entity.id, 25),
  ]);
  return { filters, rows, accounts, categories, imports, payments };
}

/** Invoices. Like the Overview, the page runs the overdue sweep after the response. */
export async function loadInvoicesPage(viewer: FinanceViewer, entity: EntityRow, sp: Sp) {
  const status = param(sp, "status");
  const [invoices, contacts, settings, revenueAccounts] = await Promise.all([
    listInvoices(viewer, entity.id, status || undefined),
    listContacts(viewer, entity.id, "customer"),
    loadSettings(entity.id),
    query<{ id: string; name: string }>(
      `SELECT id, name FROM fin_accounts WHERE entity_id = ? AND type = 'revenue' AND subtype = 'revenue' AND archived = 0 ORDER BY code`,
      [entity.id],
    ),
  ]);
  return { status, invoices, contacts, settings, revenueAccounts };
}

/**
 * Invoice detail. Invoices exist only in the business book, so the accounts
 * and customers are read alongside the invoice instead of after it (one
 * sequential step fewer); an invoice from any other book is a 404, as before.
 * The customer list is only used by the draft editor.
 */
export async function loadInvoiceDetailPage(viewer: FinanceViewer, invoiceId: string) {
  const book = await financeBook(viewer); // entity table is cached per process: no round trip once warm
  const [d, accounts, contacts] = await Promise.all([
    getInvoiceDetail(viewer, invoiceId),
    entityAccounts(book.id),
    listContacts(viewer, book.id, "customer"),
  ]);
  if (d.invoice.entity_id !== book.id) throw new FinanceNotFound();
  return { ...d, accounts, contacts: d.invoice.status === "draft" ? contacts : [] };
}

export async function loadBillsPage(viewer: FinanceViewer, entity: EntityRow) {
  const [bills, accounts, categories, settings, recurring, attachments] = await Promise.all([
    listBills(viewer, entity.id),
    entityAccounts(entity.id),
    entityCategories(entity.id),
    loadSettings(entity.id),
    listRecurring(viewer, entity.id),
    query<{ id: string; owner_id: string; filename: string }>(
      `SELECT id, owner_id, filename FROM fin_attachments WHERE entity_id = ? AND owner_type = 'bill' ORDER BY created_at`,
      [entity.id],
    ),
  ]);
  return { bills, accounts, categories, settings, recurring, attachments };
}

export async function loadAccountsPage(viewer: FinanceViewer, entity: EntityRow) {
  const today = torontoToday();
  const [{ accounts, lines }, equity] = await Promise.all([loadLedger(entity.id, addDays(today, 1)), equitySummary(viewer, entity.id)]);
  return { today, accounts, lines, equity };
}

export async function loadReportsPage(viewer: FinanceViewer, entity: EntityRow, sp: Sp) {
  const kindRaw = param(sp, "kind") as ReportKind;
  const kind: ReportKind = REPORT_KINDS.includes(kindRaw) ? kindRaw : "pnl";
  const account = param(sp, "account") || null;
  const [report, accounts] = await Promise.all([
    runReport(viewer, entity.id, kind, { from: param(sp, "from") || undefined, to: param(sp, "to") || undefined, accountId: account }),
    kind === "ledger" ? entityAccounts(entity.id) : Promise.resolve([]),
  ]);
  return { kind, account, report, accounts };
}

export async function loadTaxesPage(viewer: FinanceViewer, sp: Sp) {
  return taxOverview(viewer, { from: param(sp, "from") || undefined, to: param(sp, "to") || undefined });
}

/** Settings, minus the Stripe account check (a network call) which the page streams separately. */
export async function loadSettingsPage(viewer: FinanceViewer, entity: EntityRow) {
  const [settings, rules, categories, lastFx, lastEvent] = await Promise.all([
    loadSettings(entity.id),
    listRules(viewer, entity.id),
    entityCategories(entity.id),
    queryOne<{ d: string | null }>(`SELECT MAX(rate_date) AS d FROM fin_fx_rates`),
    queryOne<{ at: string | null; n: number }>(`SELECT MAX(received_at) AS at, COUNT(*) AS n FROM fin_stripe_events`),
  ]);
  return { settings, rules, categories, lastFx, lastEvent };
}
