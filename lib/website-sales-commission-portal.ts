/**
 * website-sales-commission-portal - everything the Commissions page shows, in
 * one server call.
 *
 * WHY THIS FILE (2026-10-02, LOAD-02). The page used to paint a "loading"
 * card, then fetch /api/website-sales/commissions from the browser after
 * hydration: three screens per click, a second Worker request that resolved
 * the session again, and up to ten database reads one after another. The page
 * now calls loadCommissionPortal() itself with the session its gate already
 * resolved, so the numbers are in the first paint. The GET route is a thin
 * wrapper around the same function, for the portal's Refresh and for the
 * re-read after a payout change.
 *
 * READS, in waves (everything in a wave runs at once; the depth is pinned by
 * tests/commissions-portal.test.ts):
 *   0. a manager only: their direct-report roster (who is in scope)
 *   1. the recent rows, the first page of outstanding rows, and the complete
 *      ledger the totals are built from
 *   2. website_deals, ONCE, for every deal either list names: the totals'
 *      currencies and each row's client, package and receipt (it used to be
 *      read twice, once by the summary and once by the route)
 *   3. leads, receipts and profiles
 *
 * Every failure is logged here with its detail and returned as a code; the
 * screen turns the code into a sentence (lib/ui/error-copy.ts).
 */
import "server-only";

import type { SessionContext } from "@/lib/api-auth";
import {
  SURFACE_CAPABILITIES,
  maySeeCommissionSurface,
  type Persona,
} from "@/lib/role-surfaces";
import { getServiceSupabase } from "@/lib/supabase-server";
import { getOasisSalesRepRoster } from "@/lib/team";
import {
  loadWebsiteSalesCommissionListing,
  loadWebsiteSalesCommissionSummaryRows,
  summarizeWebsiteSalesCommissions,
  type CommissionLedgerStatus,
  type WebsiteSalesCommissionSummary,
} from "@/lib/website-sales-commission-summary";

const RECENT_LEDGER_LIMIT = 500;
const COMMISSION_SELECT =
  "id,deal_id,rep_user_id,payment_reference,entry_type,party_role,basis_amount_cents,rate_bps,amount_cents,collected_setup_amount,rate,amount,status,approved_by,approved_at,paid_by,paid_at,payout_reference,voided_by,voided_at,void_reason,created_at";
const LOOKUP_CHUNK_SIZE = 200;

export type CommissionLedgerScope = "tenant" | "manager_team" | "self";

export type CommissionPortalViewer = {
  userId: string;
  isAdmin: boolean;
  canManagePayouts: boolean;
  ledgerScope: CommissionLedgerScope;
};

export type CommissionPortalRow = {
  id: string;
  dealId: string;
  leadId: string | null;
  clientName: string;
  packageId: string | null;
  currency: "CAD" | "USD";
  repUserId: string;
  repName: string;
  repEmail: string | null;
  partyRole: string;
  paymentReference: string;
  paymentProvider: "stripe" | "manual" | null;
  paymentStatus: string;
  paymentVerified: boolean;
  paymentVerifiedAt: string | null;
  quotedAmountCents: number;
  collectedAmountCents: number;
  rateBps: number;
  amountCents: number;
  status: CommissionLedgerStatus;
  entryType: "accrual" | "refund_offset" | "manual_adjustment";
  approvedBy: string | null;
  approvedByName: string | null;
  approvedAt: string | null;
  paidBy: string | null;
  paidAt: string | null;
  payoutReference: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  createdAt: string;
  effectiveAt: string;
};

export type CommissionPortalPage = {
  returned: number;
  recentLimit: number;
  recentReturned: number;
  outstandingCount: number;
  completeOutstanding: boolean;
  hasMore: boolean;
};

export type CommissionPortalErrorCode =
  | "forbidden_commission_role"
  | "commission_scope_unavailable"
  | "commission_listing_unavailable"
  | "commission_summary_unavailable"
  | "commission_deals_unavailable"
  | "commission_leads_unavailable"
  | "commission_receipts_unavailable"
  | "commission_profiles_unavailable"
  | "commission_portal_unavailable";

/** The GET route's JSON body, and the page's first paint. */
export type CommissionPortalPayload =
  | {
      ok: true;
      viewer: CommissionPortalViewer;
      data: CommissionPortalRow[];
      summary: WebsiteSalesCommissionSummary;
      page: CommissionPortalPage;
    }
  | { ok: false; error: string };

export type CommissionPortalResult = { status: number; body: CommissionPortalPayload };

/** The parts of a resolved session the portal reads. */
export type CommissionPortalSession = Pick<
  Extract<SessionContext, { ok: true }>,
  "userId" | "tenantId" | "isAdmin" | "isTrueAdmin"
>;

type CommissionRow = {
  id: string;
  deal_id: string;
  rep_user_id: string;
  payment_reference: string;
  entry_type: string;
  party_role: string | null;
  basis_amount_cents: number | null;
  rate_bps: number | null;
  amount_cents: number | null;
  collected_setup_amount: number;
  rate: number;
  amount: number;
  status: string;
  approved_by: string | null;
  approved_at: string | null;
  paid_by: string | null;
  paid_at: string | null;
  payout_reference: string | null;
  voided_by: string | null;
  voided_at: string | null;
  void_reason: string | null;
  created_at: string;
};

type DealRow = {
  id: string;
  lead_id: string;
  package_id: string;
  currency: "CAD" | "USD";
  setup_amount: number;
  monthly_amount: number;
  payment_provider: "stripe" | "manual" | null;
  verified_payment_id: string | null;
  closed_at: string | null;
};

type ReceiptRow = {
  id: string;
  provider: "stripe" | "manual";
  provider_reference: string;
  status: string;
  amount_cents: number;
  currency: "CAD" | "USD";
  verified_at: string;
};

type ProfileRow = {
  auth_user_id: string | null;
  email: string | null;
  full_name: string | null;
  display_name: string | null;
  team_role: string | null;
};

type LeadRow = { id: string; data: unknown };

async function loadRowsInChunks<T>(
  ids: string[],
  label: string,
  read: (chunk: string[]) => PromiseLike<{
    data: unknown;
    error: { message: string } | null;
  }>,
): Promise<T[]> {
  const rows: T[] = [];
  for (let offset = 0; offset < ids.length; offset += LOOKUP_CHUNK_SIZE) {
    const result = await read(ids.slice(offset, offset + LOOKUP_CHUNK_SIZE));
    if (result.error) throw new Error(`${label}:${result.error.message}`);
    rows.push(...((result.data ?? []) as T[]));
  }
  return rows;
}

function profileName(profile: ProfileRow | undefined, fallback: string): string {
  return profile?.display_name?.trim() || profile?.full_name?.trim() || profile?.email?.trim() || fallback;
}

function leadName(raw: unknown, fallback: string): string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fallback;
  const data = raw as Record<string, unknown>;
  for (const key of ["business_name", "company", "name", "contact_name"]) {
    const value = typeof data[key] === "string" ? data[key].trim() : "";
    if (value) return value;
  }
  return fallback;
}

function cents(primary: unknown, legacy: unknown): number {
  const authoritative = Number(primary);
  if (primary !== null && primary !== undefined && primary !== "" && Number.isSafeInteger(authoritative)) {
    return authoritative;
  }
  const fallback = Math.round(Number(legacy) * 100);
  return Number.isSafeInteger(fallback) ? fallback : 0;
}

function fail(status: number, error: CommissionPortalErrorCode): CommissionPortalResult {
  return { status, body: { ok: false, error } };
}

type WaveStep = {
  result: PromiseSettledResult<unknown>;
  /** The log tag the route has always used for this read. */
  tag: string;
  code: CommissionPortalErrorCode;
};

/**
 * Called when a read in a wave failed: logs every failed read with its detail
 * and returns the code of the first one in the order listed, so the code does
 * not depend on which read lost a race.
 */
function firstFailure(steps: readonly WaveStep[]): CommissionPortalErrorCode {
  const failed = steps.filter((step) => step.result.status === "rejected");
  for (const step of failed) {
    console.error(`[website-sales.commissions.${step.tag}]`, (step.result as PromiseRejectedResult).reason);
  }
  return (failed[0] ?? steps[0]).code;
}

/**
 * The Commissions portal for a signed-in session: its viewer, the visible
 * rows, the complete totals and the paging facts, or a status and an error
 * code. The persona gate is checked here, so the page and the route share it.
 * Never throws.
 */
export async function loadCommissionPortal(
  session: CommissionPortalSession,
  persona: Persona,
): Promise<CommissionPortalResult> {
  try {
    return await readCommissionPortal(session, persona);
  } catch (error) {
    // Each read below has its own code. This catches what none of them
    // expected (a row that breaks the mapping, a persona missing from the
    // capability map): the page reads on the server now, so a throw here
    // would replace the whole page with the error screen instead of putting
    // one plain sentence on it.
    console.error("[website-sales.commissions.portal]", error);
    return fail(500, "commission_portal_unavailable");
  }
}

async function readCommissionPortal(
  session: CommissionPortalSession,
  persona: Persona,
): Promise<CommissionPortalResult> {
  if (!maySeeCommissionSurface(SURFACE_CAPABILITIES[persona])) {
    return fail(403, "forbidden_commission_role");
  }

  const db = getServiceSupabase();
  let ledgerScope: CommissionLedgerScope = "tenant";
  let repScope: { repUserId?: string; repUserIds?: string[] } = {};
  if (!session.isAdmin && persona === "manager") {
    try {
      // A ledger is history: a deactivated report's rows must stay in their
      // former manager's list and totals, so inactive reports are included.
      const directReports = await getOasisSalesRepRoster(session.tenantId, session.userId, { includeInactive: true });
      ledgerScope = "manager_team";
      repScope = {
        // The manager sees their own sales/override entries plus only the reps
        // whose canonical tenant roster row points to this manager.
        repUserIds: Array.from(new Set([
          session.userId,
          ...directReports.map((rep) => rep.auth_user_id).filter((id): id is string => Boolean(id)),
        ])),
      };
    } catch (error) {
      console.error("[website-sales.commissions.manager-scope]", error);
      return fail(500, "commission_scope_unavailable");
    }
  } else if (!session.isAdmin) {
    ledgerScope = "self";
    repScope = { repUserId: session.userId };
  }

  // Wave 1: the visible rows and the complete ledger behind the totals, with
  // the same rep boundary on both.
  const [listingRead, summaryRowsRead] = await Promise.allSettled([
    loadWebsiteSalesCommissionListing<CommissionRow>(db, {
      tenantId: session.tenantId,
      ...repScope,
      columns: COMMISSION_SELECT,
      recentLimit: RECENT_LEDGER_LIMIT,
    }),
    loadWebsiteSalesCommissionSummaryRows(db, {
      tenantId: session.tenantId,
      ...repScope,
    }),
  ]);
  if (listingRead.status === "rejected" || summaryRowsRead.status === "rejected") {
    return fail(500, firstFailure([
      { result: listingRead, tag: "listing", code: "commission_listing_unavailable" },
      { result: summaryRowsRead, tag: "summary", code: "commission_summary_unavailable" },
    ]));
  }
  const listing = listingRead.value;
  const commissions = listing.rows;
  const summaryRows = summaryRowsRead.value;

  // Wave 2: every deal either list names, read once.
  const dealIds = [...new Set([...summaryRows, ...commissions].map((row) => row.deal_id).filter(Boolean))];
  let deals: DealRow[];
  try {
    deals = await loadRowsInChunks<DealRow>(dealIds, "commission_deals_failed", (chunk) =>
      db
        .from("website_deals")
        .select("id,lead_id,package_id,currency,setup_amount,monthly_amount,payment_provider,verified_payment_id,closed_at")
        .eq("tenant_id", session.tenantId)
        .in("id", chunk)
        .order("id", { ascending: true }),
    );
  } catch (error) {
    console.error("[website-sales.commissions.deals]", error);
    return fail(500, "commission_deals_unavailable");
  }
  let summary: WebsiteSalesCommissionSummary;
  try {
    summary = summarizeWebsiteSalesCommissions(summaryRows, deals);
  } catch (error) {
    console.error("[website-sales.commissions.summary]", error);
    return fail(500, "commission_summary_unavailable");
  }
  const dealsById = new Map(deals.map((deal) => [deal.id, deal]));

  // Wave 3: the names, receipts and people behind the visible rows.
  const listedDeals = [...new Set(commissions.map((row) => row.deal_id))]
    .map((id) => dealsById.get(id))
    .filter((deal): deal is DealRow => Boolean(deal));
  const leadIds = [...new Set(listedDeals.map((deal) => deal.lead_id).filter(Boolean))];
  const receiptIds = [...new Set(listedDeals.map((deal) => deal.verified_payment_id).filter((id): id is string => !!id))];
  const profileIds = [
    ...new Set(
      commissions
        .flatMap((row) => [row.rep_user_id, row.approved_by, row.paid_by, row.voided_by])
        .filter((id): id is string => !!id),
    ),
  ];
  const [leadsRead, receiptsRead, profilesRead] = await Promise.allSettled([
    loadRowsInChunks<LeadRow>(leadIds, "commission_leads_failed", (chunk) =>
      db
        .from("tenant_records")
        .select("id,data")
        .eq("tenant_id", session.tenantId)
        .eq("entity_type", "lead")
        .in("id", chunk)
        .order("id", { ascending: true }),
    ),
    loadRowsInChunks<ReceiptRow>(receiptIds, "commission_receipts_failed", (chunk) =>
      db
        .from("website_sales_payment_receipts")
        .select("id,provider,provider_reference,status,amount_cents,currency,verified_at")
        .eq("tenant_id", session.tenantId)
        .in("id", chunk)
        .order("id", { ascending: true }),
    ),
    loadRowsInChunks<ProfileRow>(profileIds, "commission_profiles_failed", (chunk) =>
      db
        .from("user_profiles")
        .select("auth_user_id,email,full_name,display_name,team_role")
        .eq("tenant_id", session.tenantId)
        .in("auth_user_id", chunk)
        .order("auth_user_id", { ascending: true }),
    ),
  ]);
  if (leadsRead.status === "rejected" || receiptsRead.status === "rejected" || profilesRead.status === "rejected") {
    return fail(500, firstFailure([
      { result: leadsRead, tag: "leads", code: "commission_leads_unavailable" },
      { result: receiptsRead, tag: "receipts", code: "commission_receipts_unavailable" },
      { result: profilesRead, tag: "profiles", code: "commission_profiles_unavailable" },
    ]));
  }
  const leadsById = new Map(leadsRead.value.map((lead) => [lead.id, lead.data]));
  const receiptsById = new Map(receiptsRead.value.map((receipt) => [receipt.id, receipt]));
  const profilesById = new Map(
    profilesRead.value
      .filter((profile): profile is ProfileRow & { auth_user_id: string } => !!profile.auth_user_id)
      .map((profile) => [profile.auth_user_id, profile]),
  );

  const data = commissions.map((commission): CommissionPortalRow => {
    const deal = dealsById.get(commission.deal_id);
    const receipt = deal?.verified_payment_id ? receiptsById.get(deal.verified_payment_id) : undefined;
    const rep = profilesById.get(commission.rep_user_id);
    const paymentVerified = receipt?.status === "verified";
    const amountCents = cents(commission.amount_cents, commission.amount);
    // The deal's verified_payment_id is the latest receipt, not the full
    // payment-plan total. The commission ledger freezes the aggregate cash
    // collected when the deal closes, so it remains authoritative for split
    // deposit + balance plans (and is negative on refund-offset entries).
    const collectedAmountCents = cents(null, commission.collected_setup_amount);
    const rateBps = commission.rate_bps !== null && commission.rate_bps !== undefined && Number.isInteger(Number(commission.rate_bps))
      ? Number(commission.rate_bps)
      : Math.round(Number(commission.rate) * 10_000);
    const effectiveAt =
      commission.paid_at || commission.voided_at || commission.approved_at || commission.created_at;
    return {
      id: commission.id,
      dealId: commission.deal_id,
      leadId: deal?.lead_id ?? null,
      clientName: deal ? leadName(leadsById.get(deal.lead_id), `Lead ${deal.lead_id.slice(0, 8)}`) : "Unknown client",
      packageId: deal?.package_id ?? null,
      currency: receipt?.currency ?? deal?.currency ?? "CAD",
      repUserId: commission.rep_user_id,
      repName: profileName(rep, `Rep ${commission.rep_user_id.slice(0, 8)}`),
      repEmail: rep?.email ?? null,
      partyRole: commission.party_role || "full_stack",
      paymentReference: receipt?.provider_reference ?? commission.payment_reference,
      paymentProvider: receipt?.provider ?? deal?.payment_provider ?? null,
      paymentStatus: receipt?.status ?? "missing",
      paymentVerified,
      paymentVerifiedAt: receipt?.verified_at ?? null,
      quotedAmountCents: Math.round(Number(deal?.setup_amount ?? 0) * 100),
      collectedAmountCents,
      rateBps,
      amountCents,
      status: commission.status as CommissionPortalRow["status"],
      entryType: commission.entry_type as CommissionPortalRow["entryType"],
      approvedBy: commission.approved_by,
      approvedByName: commission.approved_by
        ? profileName(profilesById.get(commission.approved_by), commission.approved_by)
        : null,
      approvedAt: commission.approved_at,
      paidBy: commission.paid_by,
      paidAt: commission.paid_at,
      payoutReference: commission.payout_reference,
      voidedAt: commission.voided_at,
      voidReason: commission.void_reason,
      createdAt: commission.created_at,
      effectiveAt,
    };
  });

  return {
    status: 200,
    body: {
      ok: true,
      viewer: {
        userId: session.userId,
        isAdmin: session.isAdmin,
        canManagePayouts: session.isTrueAdmin,
        ledgerScope,
      },
      data,
      summary,
      page: {
        returned: data.length,
        recentLimit: RECENT_LEDGER_LIMIT,
        recentReturned: listing.recentCount,
        outstandingCount: listing.outstandingCount,
        completeOutstanding: true,
        hasMore: summary.entryCount > data.length,
      },
    },
  };
}
