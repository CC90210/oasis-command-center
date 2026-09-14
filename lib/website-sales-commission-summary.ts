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

type ListingOptions = {
  tenantId: string;
  repUserId?: string;
  repUserIds?: string[];
  columns: string;
  recentLimit?: number;
};

export type WebsiteSalesCommissionListing<T extends { id: string }> = {
  rows: T[];
  recentCount: number;
  outstandingCount: number;
};

type CommissionRow = {
  id: string;
  deal_id: string;
  rep_user_id: string;
  status: CommissionLedgerStatus;
  amount_cents: number | null;
  amount: number | null;
};

type DealCurrencyRow = {
  id: string;
  currency: string;
};

const COMMISSION_PAGE_SIZE = 500;
const DEAL_LOOKUP_CHUNK_SIZE = 200;
const CURRENCY_ORDER: CommissionCurrency[] = ["CAD", "USD"];

/**
 * Returns a bounded recent history plus every accrued/approved accrual. The
 * latter is deliberately unbounded and paged: an old commission must never
 * disappear from the only founder approve/pay surface merely because 500 newer
 * rows were written.
 */
export async function loadWebsiteSalesCommissionListing<T extends { id: string }>(
  db: SupabaseClient,
  options: ListingOptions,
): Promise<WebsiteSalesCommissionListing<T>> {
  const tenantId = options.tenantId.trim();
  const repUserId = options.repUserId?.trim();
  if (options.repUserId !== undefined && options.repUserIds !== undefined) {
    throw new Error("commission_listing_rep_scope_ambiguous");
  }
  const repUserIds = options.repUserIds === undefined
    ? undefined
    : Array.from(new Set(options.repUserIds.map((id) => id.trim())));
  const columns = options.columns.trim();
  const recentLimit = options.recentLimit ?? COMMISSION_PAGE_SIZE;
  if (!tenantId) throw new Error("commission_listing_tenant_required");
  if (options.repUserId !== undefined && !repUserId) throw new Error("commission_listing_rep_required");
  if (repUserIds?.some((id) => !id)) throw new Error("commission_listing_rep_required");
  if (!columns) throw new Error("commission_listing_columns_required");
  if (!Number.isSafeInteger(recentLimit) || recentLimit < 1 || recentLimit > 1_000) {
    throw new Error("commission_listing_recent_limit_invalid");
  }
  if (repUserIds?.length === 0) {
    return { rows: [], recentCount: 0, outstandingCount: 0 };
  }

  let recentQuery = db
    .from("website_sales_commissions")
    .select(columns)
    .eq("tenant_id", tenantId);
  if (repUserId) recentQuery = recentQuery.eq("rep_user_id", repUserId);
  if (repUserIds) recentQuery = recentQuery.in("rep_user_id", repUserIds);
  const recentResult = await recentQuery
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(recentLimit);
  if (recentResult.error) throw new Error(`commission_listing_recent_failed:${recentResult.error.message}`);
  const recentRows = (recentResult.data ?? []) as unknown as T[];

  const outstandingRows: T[] = [];
  for (let from = 0; ; from += COMMISSION_PAGE_SIZE) {
    let outstandingQuery = db
      .from("website_sales_commissions")
      .select(columns)
      .eq("tenant_id", tenantId)
      .eq("entry_type", "accrual")
      .in("status", ["accrued", "approved"]);
    if (repUserId) outstandingQuery = outstandingQuery.eq("rep_user_id", repUserId);
    if (repUserIds) outstandingQuery = outstandingQuery.in("rep_user_id", repUserIds);
    const result = await outstandingQuery
      .order("id", { ascending: true })
      .range(from, from + COMMISSION_PAGE_SIZE - 1);
    if (result.error) throw new Error(`commission_listing_outstanding_failed:${result.error.message}`);
    const page = (result.data ?? []) as unknown as T[];
    outstandingRows.push(...page);
    if (page.length < COMMISSION_PAGE_SIZE) break;
  }

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
 * Reads the complete, tenant-scoped ledger in stable pages and keeps currencies
 * separate. This is the authoritative source for totals; UI row lists may be
 * intentionally recent/bounded, but a partial page must never masquerade as a
 * complete payout balance.
 */
export async function loadWebsiteSalesCommissionSummary(
  db: SupabaseClient,
  options: SummaryOptions,
): Promise<WebsiteSalesCommissionSummary> {
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
  if (repUserIds?.length === 0) return emptySummary();

  const rows: CommissionRow[] = [];
  for (let from = 0; ; from += COMMISSION_PAGE_SIZE) {
    let query = db
      .from("website_sales_commissions")
      .select("id,deal_id,rep_user_id,status,amount_cents,amount")
      .eq("tenant_id", tenantId);
    if (repUserId) query = query.eq("rep_user_id", repUserId);
    if (repUserIds) query = query.in("rep_user_id", repUserIds);
    if (options.partyRole) query = query.eq("party_role", options.partyRole);
    if (options.excludePartyRole) query = query.neq("party_role", options.excludePartyRole);
    const result = await query
      .order("id", { ascending: true })
      .range(from, from + COMMISSION_PAGE_SIZE - 1);
    if (result.error) throw new Error(`commission_summary_rows_failed:${result.error.message}`);
    const page = (result.data ?? []) as CommissionRow[];
    rows.push(...page);
    if (page.length < COMMISSION_PAGE_SIZE) break;
  }

  if (rows.length === 0) return emptySummary();

  const dealIds = Array.from(new Set(rows.map((row) => row.deal_id)));
  const currencyByDealId = new Map<string, CommissionCurrency>();
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
    for (const deal of (result.data ?? []) as DealCurrencyRow[]) {
      currencyByDealId.set(deal.id, currencyFor(deal.currency, deal.id));
    }
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
