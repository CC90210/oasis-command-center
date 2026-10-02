import type { SupabaseClient } from "@supabase/supabase-js";

export type CommissionCurrency = "CAD" | "USD";
export type CommissionLedgerStatus = "accrued" | "approved" | "paid" | "offset" | "voided";
export type CommissionAmountStatus = Exclude<CommissionLedgerStatus, "voided">;
export type CommissionPartyRole = "opener" | "closer" | "builder" | "manager" | "full_stack";

export type CommissionCurrencyTotals = {
  currency: CommissionCurrency;
  accruedCents: number;
  approvedCents: number;
  paidCents: number;
  offsetCents: number;
  netCents: number;
};

export type WebsiteSalesCommissionSummary = {
  entryCount: number;
  totals: CommissionCurrencyTotals[];
  byRep: Record<string, CommissionCurrencyTotals[]>;
};

type SummaryOptions = {
  tenantId: string;
  repUserId?: string;
  repUserIds?: string[];
  partyRole?: CommissionPartyRole;
  excludePartyRole?: CommissionPartyRole;
};

type LedgerOptions = SummaryOptions & {
  /**
   * What to select; must include SUMMARY_COLUMNS. The Commissions page reads
   * its whole row here, so its list and its totals come from one read.
   */
  columns?: string;
  /** Once aborted (the caller has answered), no further page is read. */
  signal?: AbortSignal;
};

/** What the Commissions list needs from a ledger row. */
export type WebsiteSalesCommissionListingRow = {
  id: string;
  created_at: string;
  entry_type: string;
  status: string;
};

export type WebsiteSalesCommissionListing<T extends { id: string }> = {
  rows: T[];
  recentCount: number;
  outstandingCount: number;
};

/** One complete-ledger row, as the summary reads it. */
export type WebsiteSalesCommissionSummaryRow = {
  id: string;
  deal_id: string;
  rep_user_id: string;
  status: CommissionLedgerStatus;
  amount_cents: number | null;
  amount: number | null;
};
type CommissionRow = WebsiteSalesCommissionSummaryRow;

type DealCurrencyRow = {
  id: string;
  currency: string;
};

const COMMISSION_PAGE_SIZE = 500;
const DEAL_LOOKUP_CHUNK_SIZE = 200;
const CURRENCY_ORDER: CommissionCurrency[] = ["CAD", "USD"];
/** The columns the totals are built from; every ledger read includes them. */
const SUMMARY_COLUMNS = ["id", "deal_id", "rep_user_id", "status", "amount_cents", "amount"] as const;

/**
 * The Commissions page's rows, taken from the complete ledger it read for its
 * totals: the newest `recentLimit` entries plus every accrued or approved
 * accrual. The latter is deliberately unbounded: an old commission must never
 * disappear from the only founder approve/pay surface merely because 500 newer
 * rows were written.
 *
 * WHY FROM THE SAME READ (2026-10-02). The rows and the totals were two reads.
 * Run together, a deal that closed between them could appear in the list and
 * not in the totals; run one after the other (the route before that), the
 * totals could count a row the list did not show. Taken from one read, every
 * row on screen is a row the totals counted, with the same status and amount.
 * The order is the SQL's it replaces: created_at, then id, newest first,
 * compared as plain text (as SQLite's default collation compares them).
 */
export function listWebsiteSalesCommissions<T extends WebsiteSalesCommissionListingRow>(
  ledger: readonly T[],
  recentLimit: number = COMMISSION_PAGE_SIZE,
): WebsiteSalesCommissionListing<T> {
  if (!Number.isSafeInteger(recentLimit) || recentLimit < 1 || recentLimit > 1_000) {
    throw new Error("commission_listing_recent_limit_invalid");
  }
  const text = (a: unknown, b: unknown) => {
    const left = String(a ?? "");
    const right = String(b ?? "");
    return left < right ? -1 : left > right ? 1 : 0;
  };
  const recentRows = [...ledger]
    .sort((a, b) => text(b.created_at, a.created_at) || text(b.id, a.id))
    .slice(0, recentLimit);
  const outstandingRows = ledger
    .filter((row) => row.entry_type === "accrual" && (row.status === "accrued" || row.status === "approved"))
    .sort((a, b) => text(a.id, b.id));

  const rowsById = new Map<string, T>();
  for (const row of recentRows) rowsById.set(row.id, row);
  for (const row of outstandingRows) {
    if (!rowsById.has(row.id)) rowsById.set(row.id, row);
  }
  return {
    rows: Array.from(rowsById.values()),
    recentCount: recentRows.length,
    outstandingCount: outstandingRows.length,
  };
}

function emptyTotals(currency: CommissionCurrency): CommissionCurrencyTotals {
  return {
    currency,
    accruedCents: 0,
    approvedCents: 0,
    paidCents: 0,
    offsetCents: 0,
    netCents: 0,
  };
}

function emptySummary(): WebsiteSalesCommissionSummary {
  return { entryCount: 0, totals: [], byRep: {} };
}

function safeCents(primary: unknown, legacy: unknown, rowId: string): number {
  if (primary !== null && primary !== undefined && primary !== "") {
    const authoritative = Number(primary);
    if (Number.isSafeInteger(authoritative)) return authoritative;
    throw new Error(`commission_summary_invalid_amount_cents:${rowId}`);
  }
  if (legacy === null || legacy === undefined || legacy === "") {
    throw new Error(`commission_summary_legacy_amount_missing:${rowId}`);
  }
  const legacyAmount = Number(legacy);
  const fallback = Math.round(legacyAmount * 100);
  if (!Number.isFinite(legacyAmount) || !Number.isSafeInteger(fallback)) {
    throw new Error(`commission_summary_invalid_legacy_amount:${rowId}`);
  }
  return fallback;
}

function safeAdd(left: number, right: number, rowId: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw new Error(`commission_summary_amount_overflow:${rowId}`);
  return result;
}

function currencyFor(raw: string, dealId: string): CommissionCurrency {
  const currency = raw.trim().toUpperCase();
  if (currency === "CAD" || currency === "USD") return currency;
  throw new Error(`commission_summary_unsupported_currency:${dealId}`);
}

function finalizedTotals(
  buckets: Map<CommissionCurrency, CommissionCurrencyTotals>,
): CommissionCurrencyTotals[] {
  return CURRENCY_ORDER.flatMap((currency) => {
    const totals = buckets.get(currency);
    return totals ? [{ ...totals }] : [];
  });
}

function addRow(
  buckets: Map<CommissionCurrency, CommissionCurrencyTotals>,
  currency: CommissionCurrency,
  row: CommissionRow,
): void {
  const amountCents = safeCents(row.amount_cents, row.amount, row.id);
  const totals = buckets.get(currency) ?? emptyTotals(currency);
  switch (row.status) {
    case "accrued":
      totals.accruedCents = safeAdd(totals.accruedCents, amountCents, row.id);
      break;
    case "approved":
      totals.approvedCents = safeAdd(totals.approvedCents, amountCents, row.id);
      break;
    case "paid":
      totals.paidCents = safeAdd(totals.paidCents, amountCents, row.id);
      break;
    case "offset":
      totals.offsetCents = safeAdd(totals.offsetCents, amountCents, row.id);
      break;
    case "voided":
      break;
    default:
      throw new Error(`commission_summary_unsupported_status:${row.id}`);
  }
  if (row.status !== "voided") {
    totals.netCents = safeAdd(totals.netCents, amountCents, row.id);
  }
  buckets.set(currency, totals);
}

/**
 * The complete, tenant-scoped ledger rows a summary is built from, read in
 * stable pages. Split out of loadWebsiteSalesCommissionSummary (2026-10-02) so
 * the Commissions page can take its row list and its totals from this one read
 * (lib/website-sales-commission-portal.ts); it passes `columns` for its whole
 * row.
 */
export async function loadWebsiteSalesCommissionSummaryRows<
  T extends WebsiteSalesCommissionSummaryRow = WebsiteSalesCommissionSummaryRow,
>(
  db: SupabaseClient,
  options: LedgerOptions,
): Promise<T[]> {
  const tenantId = options.tenantId.trim();
  if (!tenantId) throw new Error("commission_summary_tenant_required");
  if (options.repUserId !== undefined && options.repUserIds !== undefined) {
    throw new Error("commission_summary_rep_scope_ambiguous");
  }
  if (options.partyRole !== undefined && options.excludePartyRole !== undefined) {
    throw new Error("commission_summary_party_scope_ambiguous");
  }

  const repUserId = options.repUserId?.trim();
  if (options.repUserId !== undefined && !repUserId) {
    throw new Error("commission_summary_rep_required");
  }
  const repUserIds = options.repUserIds === undefined
    ? undefined
    : Array.from(new Set(options.repUserIds.map((id) => id.trim())));
  if (repUserIds?.some((id) => !id)) throw new Error("commission_summary_rep_required");
  const columns = options.columns?.trim() || SUMMARY_COLUMNS.join(",");
  const selected = new Set(columns.split(",").map((column) => column.trim()));
  const missing = SUMMARY_COLUMNS.filter((column) => !selected.has(column));
  if (missing.length > 0) throw new Error(`commission_summary_columns_missing:${missing.join(",")}`);
  if (repUserIds?.length === 0) return [];

  const rows: T[] = [];
  const seen = new Set<string>();
  for (let from = 0; ; from += COMMISSION_PAGE_SIZE) {
    options.signal?.throwIfAborted();
    let query = db
      .from("website_sales_commissions")
      .select(columns)
      .eq("tenant_id", tenantId);
    if (repUserId) query = query.eq("rep_user_id", repUserId);
    if (repUserIds) query = query.in("rep_user_id", repUserIds);
    if (options.partyRole) query = query.eq("party_role", options.partyRole);
    if (options.excludePartyRole) query = query.neq("party_role", options.excludePartyRole);
    const result = await query
      .order("id", { ascending: true })
      .range(from, from + COMMISSION_PAGE_SIZE - 1);
    if (result.error) throw new Error(`commission_summary_rows_failed:${result.error.message}`);
    const page = (result.data ?? []) as unknown as T[];
    // Pages are offsets in id order. A deal that closes while they are read
    // moves the rows after it down one place, so a row can come back on the
    // next page; the ledger never deletes, so none is skipped. Count each id
    // once, or a total could include one commission twice.
    for (const row of page) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      rows.push(row);
    }
    if (page.length < COMMISSION_PAGE_SIZE) break;
  }
  return rows;
}

/**
 * Totals for `rows`, each row in its deal's currency. `deals` must hold every
 * deal the rows name and may hold more (the Commissions page passes the deals
 * it read for its row list too); a row whose deal is missing fails closed.
 */
export function summarizeWebsiteSalesCommissions(
  rows: readonly WebsiteSalesCommissionSummaryRow[],
  deals: readonly DealCurrencyRow[],
): WebsiteSalesCommissionSummary {
  if (rows.length === 0) return emptySummary();

  const wanted = new Set(rows.map((row) => row.deal_id));
  const currencyByDealId = new Map<string, CommissionCurrency>();
  for (const deal of deals) {
    if (wanted.has(deal.id)) currencyByDealId.set(deal.id, currencyFor(deal.currency, deal.id));
  }

  const totalBuckets = new Map<CommissionCurrency, CommissionCurrencyTotals>();
  const repBuckets = new Map<string, Map<CommissionCurrency, CommissionCurrencyTotals>>();
  for (const row of rows) {
    const currency = currencyByDealId.get(row.deal_id);
    if (!currency) throw new Error(`commission_summary_deal_missing:${row.deal_id}`);
    addRow(totalBuckets, currency, row);
    const buckets = repBuckets.get(row.rep_user_id) ?? new Map<CommissionCurrency, CommissionCurrencyTotals>();
    addRow(buckets, currency, row);
    repBuckets.set(row.rep_user_id, buckets);
  }

  return {
    entryCount: rows.length,
    totals: finalizedTotals(totalBuckets),
    byRep: Object.fromEntries(
      Array.from(repBuckets.entries()).map(([userId, buckets]) => [userId, finalizedTotals(buckets)]),
    ),
  };
}

/**
 * Reads the complete, tenant-scoped ledger in stable pages and keeps currencies
 * separate. This is the authoritative source for totals; UI row lists may be
 * intentionally recent/bounded, but a partial page must never masquerade as a
 * complete payout balance.
 */
export async function loadWebsiteSalesCommissionSummary(
  db: SupabaseClient,
  options: SummaryOptions,
): Promise<WebsiteSalesCommissionSummary> {
  const rows = await loadWebsiteSalesCommissionSummaryRows(db, options);
  if (rows.length === 0) return emptySummary();

  const tenantId = options.tenantId.trim();
  const dealIds = Array.from(new Set(rows.map((row) => row.deal_id)));
  const deals: DealCurrencyRow[] = [];
  for (let offset = 0; offset < dealIds.length; offset += DEAL_LOOKUP_CHUNK_SIZE) {
    const chunk = dealIds.slice(offset, offset + DEAL_LOOKUP_CHUNK_SIZE);
    const result = await db
      .from("website_deals")
      .select("id,currency")
      .eq("tenant_id", tenantId)
      .in("id", chunk)
      .order("id", { ascending: true })
      .range(0, chunk.length - 1);
    if (result.error) throw new Error(`commission_summary_deals_failed:${result.error.message}`);
    deals.push(...((result.data ?? []) as DealCurrencyRow[]));
  }
  return summarizeWebsiteSalesCommissions(rows, deals);
}

const STATUS_FIELD: Record<CommissionAmountStatus, keyof CommissionCurrencyTotals> = {
  accrued: "accruedCents",
  approved: "approvedCents",
  paid: "paidCents",
  offset: "offsetCents",
};

export function formatCommissionAmounts(
  totals: CommissionCurrencyTotals[],
  statuses: CommissionAmountStatus[],
): string {
  const amounts = totals.flatMap((totalsForCurrency) => {
    const amountCents = statuses.reduce(
      (sum, status) => sum + Number(totalsForCurrency[STATUS_FIELD[status]]),
      0,
    );
    if (amountCents === 0) return [];
    const formatted = new Intl.NumberFormat("en-CA", {
      style: "currency",
      currency: totalsForCurrency.currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amountCents / 100);
    return [`${formatted} ${totalsForCurrency.currency}`];
  });
  return amounts.length > 0 ? amounts.join(" + ") : "$0.00 CAD";
}

/** Translate the legacy storage role into the work the rep actually did.
 * `full_stack` predates the v4 split and now stores both finder+closer (35%)
 * and finder+closer+builder (70%). Their modifier ranges do not overlap: the
 * former tops out at 40%, while the latter bottoms out at 60%. */
export function commissionPartyRoleLabel(role: string, rateBps: number): string {
  if (role === "full_stack") {
    return rateBps >= 5_000 ? "Finder + closer + builder" : "Finder + closer";
  }
  return role.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}
