/**
 * GET /api/manifest/<slug>/cold-outreach/campaigns/<campaign_id>/recipients
 *
 * Paginated recipient list for the campaign drill-down accordion in
 * CampaignRow. Joins cold_leads to surface business_name and contact_name
 * alongside delivery status.
 *
 * Query params:
 *   offset (default 0)  — pagination offset
 *   limit  (default 50) — page size, max 200
 *
 * Returns:
 *   {
 *     ok: true,
 *     recipients: Recipient[],
 *     total: number
 *   }
 *
 * Recipient shape:
 *   id, cold_lead_id, contact_address, status, sent_at,
 *   delivery_status_at, last_error, business_name, contact_name
 *
 * Auth: session required + caller must own this slug (resolveDataTenant).
 * The campaign_id is also verified to belong to the resolved tenant so a
 * caller cannot enumerate recipients of another tenant's campaign by
 * guessing a UUID.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSessionUser, getServiceSupabase } from "@/lib/supabase-server";
import { resolveDataTenant } from "@/lib/manifest/tenant-scope";
import { manifestExists } from "@/lib/manifest/loader";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{1,62}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE_MAX = 200;

async function resolveContext(
  userId: string,
  slug: string,
): Promise<
  | { ok: true; tenantId: string }
  | { ok: false; status: number; error: string }
> {
  if (!SLUG_RE.test(slug)) return { ok: false, status: 400, error: "invalid_slug" };
  if (!(await manifestExists(slug))) return { ok: false, status: 404, error: "unknown_tenant" };

  const db = getServiceSupabase();
  const profileRes = await db
    .from("user_profiles")
    .select("tenant_id")
    .eq("auth_user_id", userId)
    .maybeSingle();
  const userTenantId =
    (profileRes.data as { tenant_id: string | null } | null)?.tenant_id ?? null;

  const dataTenantId = await resolveDataTenant(slug, userTenantId);
  if (!dataTenantId) {
    return { ok: false, status: 403, error: "forbidden" };
  }
  return { ok: true, tenantId: dataTenantId };
}

type RecipientRow = {
  id: string;
  cold_lead_id: string;
  contact_address: string;
  status: string;
  sent_at: string | null;
  delivery_status_at: string | null;
  last_error: string | null;
  cold_leads: {
    business_name: string | null;
    contact_name: string | null;
  } | null;
};

type Recipient = {
  id: string;
  cold_lead_id: string;
  contact_address: string;
  status: string;
  sent_at: string | null;
  delivery_status_at: string | null;
  last_error: string | null;
  business_name: string | null;
  contact_name: string | null;
};

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ slug: string; campaign_id: string }> },
) {
  const { slug, campaign_id } = await ctx.params;
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  if (!UUID_RE.test(campaign_id)) {
    return NextResponse.json({ ok: false, error: "invalid_campaign_id" }, { status: 400 });
  }

  const context = await resolveContext(user.id, slug);
  if (!context.ok) {
    return NextResponse.json({ ok: false, error: context.error }, { status: context.status });
  }

  const sp = req.nextUrl.searchParams;
  const offsetRaw = sp.get("offset");
  const limitRaw = sp.get("limit");
  const offset =
    offsetRaw !== null && !Number.isNaN(Number(offsetRaw))
      ? Math.max(0, Number(offsetRaw))
      : 0;
  const limit =
    limitRaw !== null && !Number.isNaN(Number(limitRaw))
      ? Math.max(1, Math.min(Number(limitRaw), PAGE_MAX))
      : 50;

  const db = getServiceSupabase();

  // Verify the campaign exists and belongs to this tenant — prevents
  // cross-tenant enumeration by UUID-guessing.
  const { data: campaignRow, error: campaignErr } = await db
    .from("cold_outreach_campaigns")
    .select("id")
    .eq("id", campaign_id)
    .eq("tenant_id", context.tenantId)
    .maybeSingle();

  if (campaignErr || !campaignRow) {
    return NextResponse.json({ ok: false, error: "campaign_not_found" }, { status: 404 });
  }

  // Fetch total count and page data in parallel.
  const [countRes, dataRes] = await Promise.all([
    db
      .from("cold_outreach_recipients")
      .select("*", { count: "exact", head: true })
      .eq("campaign_id", campaign_id)
      .eq("tenant_id", context.tenantId),
    db
      .from("cold_outreach_recipients")
      .select(
        "id, cold_lead_id, contact_address, status, sent_at, delivery_status_at, last_error, " +
        "cold_leads(business_name, contact_name)",
      )
      .eq("campaign_id", campaign_id)
      .eq("tenant_id", context.tenantId)
      .order("created_at", { ascending: true })
      .range(offset, offset + limit - 1),
  ]);

  if (dataRes.error) {
    return NextResponse.json(
      { ok: false, error: "db_error", detail: dataRes.error.message },
      { status: 500 },
    );
  }

  // Flatten the joined cold_leads data into the top-level recipient shape.
  // Double-cast through unknown: Supabase's generic infers a union type that
  // doesn't overlap with RecipientRow without the intermediate cast.
  const recipients: Recipient[] = ((dataRes.data ?? []) as unknown as RecipientRow[]).map((r) => ({
    id: r.id,
    cold_lead_id: r.cold_lead_id,
    contact_address: r.contact_address,
    status: r.status,
    sent_at: r.sent_at,
    delivery_status_at: r.delivery_status_at,
    last_error: r.last_error,
    business_name: r.cold_leads?.business_name ?? null,
    contact_name: r.cold_leads?.contact_name ?? null,
  }));

  return NextResponse.json({
    ok: true,
    recipients,
    total: countRes.count ?? recipients.length,
  });
}
