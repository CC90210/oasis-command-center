import { NextResponse } from "next/server";
import { resolveSessionContext } from "@/lib/api-auth";
import { getServiceSupabase } from "@/lib/supabase-server";
import {
  SURFACE_CAPABILITIES,
  maySeeCommissionSurface,
  resolvePersona,
} from "@/lib/role-surfaces";
import {
  loadWebsiteSalesCommissionListing,
  loadWebsiteSalesCommissionSummary,
} from "@/lib/website-sales-commission-summary";
import { getOasisSalesRepRoster } from "@/lib/team";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const RECENT_LEDGER_LIMIT = 500;
const COMMISSION_SELECT =
  "id,deal_id,rep_user_id,payment_reference,entry_type,party_role,basis_amount_cents,rate_bps,amount_cents,collected_setup_amount,rate,amount,status,approved_by,approved_at,paid_by,paid_at,payout_reference,voided_by,voided_at,void_reason,created_at";
const LOOKUP_CHUNK_SIZE = 200;

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

export async function GET() {
  const session = await resolveSessionContext();
  if (!session.ok) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const persona = resolvePersona({
    teamRole: session.teamRole,
    isTrueAdmin: session.isTrueAdmin,
    adminAccess: session.adminAccess,
  });
  if (!maySeeCommissionSurface(SURFACE_CAPABILITIES[persona])) {
    return NextResponse.json({ ok: false, error: "forbidden_commission_role" }, { status: 403 });
  }

  const db = getServiceSupabase();
  let ledgerScope: "tenant" | "manager_team" | "self" = "tenant";
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
      return NextResponse.json({ ok: false, error: "commission_scope_unavailable" }, { status: 500 });
    }
  } else if (!session.isAdmin) {
    ledgerScope = "self";
    repScope = { repUserId: session.userId };
  }
  let listing;
  try {
    listing = await loadWebsiteSalesCommissionListing<CommissionRow>(db, {
      tenantId: session.tenantId,
      ...repScope,
      columns: COMMISSION_SELECT,
      recentLimit: RECENT_LEDGER_LIMIT,
    });
  } catch (error) {
    console.error("[website-sales.commissions.listing]", error);
    return NextResponse.json({ ok: false, error: "commission_listing_unavailable" }, { status: 500 });
  }
  const commissions = listing.rows;
  let summary;
  try {
    summary = await loadWebsiteSalesCommissionSummary(db, {
      tenantId: session.tenantId,
      ...repScope,
    });
  } catch (error) {
    console.error("[website-sales.commissions.summary]", error);
    return NextResponse.json({ ok: false, error: "commission_summary_unavailable" }, { status: 500 });
  }

  const dealIds = [...new Set(commissions.map((row) => row.deal_id).filter(Boolean))];
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
    return NextResponse.json({ ok: false, error: "commission_deals_unavailable" }, { status: 500 });
  }
  const dealsById = new Map(deals.map((deal) => [deal.id, deal]));

  const leadIds = [...new Set(deals.map((deal) => deal.lead_id).filter(Boolean))];
  let leads: Array<{ id: string; data: unknown }>;
  try {
    leads = await loadRowsInChunks<Array<{ id: string; data: unknown }>[number]>(
      leadIds,
      "commission_leads_failed",
      (chunk) => db
        .from("tenant_records")
        .select("id,data")
        .eq("tenant_id", session.tenantId)
        .eq("entity_type", "lead")
        .in("id", chunk)
        .order("id", { ascending: true }),
    );
  } catch (error) {
    console.error("[website-sales.commissions.leads]", error);
    return NextResponse.json({ ok: false, error: "commission_leads_unavailable" }, { status: 500 });
  }
  const leadsById = new Map(leads.map((lead) => [lead.id, lead.data]));

  const receiptIds = [...new Set(deals.map((deal) => deal.verified_payment_id).filter((id): id is string => !!id))];
  let receipts: ReceiptRow[];
  try {
    receipts = await loadRowsInChunks<ReceiptRow>(receiptIds, "commission_receipts_failed", (chunk) =>
      db
        .from("website_sales_payment_receipts")
        .select("id,provider,provider_reference,status,amount_cents,currency,verified_at")
        .eq("tenant_id", session.tenantId)
        .in("id", chunk)
        .order("id", { ascending: true }),
    );
  } catch (error) {
    console.error("[website-sales.commissions.receipts]", error);
    return NextResponse.json({ ok: false, error: "commission_receipts_unavailable" }, { status: 500 });
  }
  const receiptsById = new Map(receipts.map((receipt) => [receipt.id, receipt]));

  const profileIds = [
    ...new Set(
      commissions
        .flatMap((row) => [row.rep_user_id, row.approved_by, row.paid_by, row.voided_by])
        .filter((id): id is string => !!id),
    ),
  ];
  let profiles: ProfileRow[];
  try {
    profiles = await loadRowsInChunks<ProfileRow>(profileIds, "commission_profiles_failed", (chunk) =>
      db
        .from("user_profiles")
        .select("auth_user_id,email,full_name,display_name,team_role")
        .eq("tenant_id", session.tenantId)
        .in("auth_user_id", chunk)
        .order("auth_user_id", { ascending: true }),
    );
  } catch (error) {
    console.error("[website-sales.commissions.profiles]", error);
    return NextResponse.json({ ok: false, error: "commission_profiles_unavailable" }, { status: 500 });
  }
  const profilesById = new Map(
    profiles
      .filter((profile): profile is ProfileRow & { auth_user_id: string } => !!profile.auth_user_id)
      .map((profile) => [profile.auth_user_id, profile]),
  );

  const data = commissions.map((commission) => {
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
      status: commission.status,
      entryType: commission.entry_type,
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

  return NextResponse.json({
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
  });
}

type PatchBody = {
  id?: unknown;
  action?: unknown;
  requestId?: unknown;
  payoutReference?: unknown;
  voidReason?: unknown;
};

export async function PATCH(req: Request) {
  const session = await resolveSessionContext();
  if (!session.ok) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (!session.isTrueAdmin) {
    return NextResponse.json({ ok: false, error: "founder_only" }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as PatchBody | null;
  const id = typeof body?.id === "string" ? body.id.trim() : "";
  const action = typeof body?.action === "string" ? body.action.trim() : "";
  const requestId = typeof body?.requestId === "string" ? body.requestId.trim() : "";
  if (!id || id.length > 200 || !["approve", "mark_paid", "void"].includes(action)) {
    return NextResponse.json({ ok: false, error: "invalid_body" }, { status: 400 });
  }
  if (!requestId || requestId.length > 200) {
    return NextResponse.json({ ok: false, error: "request_id_required" }, { status: 400 });
  }
  const payoutReference = typeof body?.payoutReference === "string" ? body.payoutReference.trim() : "";
  const voidReason = typeof body?.voidReason === "string" ? body.voidReason.trim() : "";
  if (action === "mark_paid" && (payoutReference.length < 3 || payoutReference.length > 200)) {
    return NextResponse.json({ ok: false, error: "payout_reference_required" }, { status: 400 });
  }
  if (action === "void" && (voidReason.length < 8 || voidReason.length > 500)) {
    return NextResponse.json({ ok: false, error: "void_reason_required" }, { status: 400 });
  }

  const result = await getServiceSupabase().rpc("transition_commission_entry", {
    p_tenant_id: session.tenantId,
    p_commission_id: id,
    p_actor_user_id: session.userId,
    p_action: action,
    p_request_id: requestId,
    p_occurred_at: new Date().toISOString(),
    ...(action === "mark_paid" ? { p_payout_reference: payoutReference } : {}),
    ...(action === "void" ? { p_void_reason: voidReason } : {}),
  });
  if (result.error) {
    const message = result.error.message || "commission_transition_failed";
    const status = message.includes("not_found_or_wrong_tenant")
      ? 404
      : message.includes("self_approval_forbidden")
        ? 403
        : message.includes("immutable") || message.includes("required") || message.includes("invalid")
          ? 400
          : 500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
  const data = result.data as { ok?: boolean; error?: string } | null;
  if (!data?.ok) {
    return NextResponse.json({ ok: false, error: data?.error || "status_conflict", data }, { status: 409 });
  }
  return NextResponse.json({ ok: true, data });
}
