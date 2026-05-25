/**
 * GET /api/manifest/[slug]/daily-plan?date=YYYY-MM-DD
 *
 * Returns today's (or the requested date's) daily plan for the tenant
 * identified by `slug`. Consumed by DailyPlanClient.tsx (the "Daily Plan"
 * tab added in the 2026-05-25 second SunBiz product meeting).
 *
 * Backing tables (migration 069): daily_plan_items, tenant_records.
 * Preview mode: tenantId === null from the layout → client never calls this
 * route; client short-circuits to an empty plan. Auth gate here mirrors
 * /api/manifest/[slug]/offer/[id]/accept — 403 on no ownership, 401 on no
 * session. No empty-data preview path server-side; the client owns that.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSessionUser, getServiceSupabase } from "@/lib/supabase-server";
import { resolveDataTenant } from "@/lib/manifest/tenant-scope";
import { manifestExists } from "@/lib/manifest/loader";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ItemCategory =
  | "priority_call"
  | "missing_info"
  | "stuck"
  | "new_offer"
  | "shop_today"
  | "renewal_eligible";

type DailyPlanItemRow = {
  id: string;
  category: ItemCategory;
  priority: number;
  reason: string;
  lead_id: string | null;
  application_id: string | null;
  metadata: Record<string, unknown>;
  status: "open" | "done" | "dismissed";
};

/** America/Toronto "today" in YYYY-MM-DD, matching the generator's tz. */
function torontoDateIso(override?: string | null): string {
  if (override && /^\d{4}-\d{2}-\d{2}$/.test(override)) return override;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ slug: string }> },
) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const { slug } = await ctx.params;
  if (!(await manifestExists(slug))) {
    return NextResponse.json({ ok: false, error: "unknown_tenant" }, { status: 404 });
  }

  const db = getServiceSupabase();
  const profileRes = await db
    .from("user_profiles")
    .select("tenant_id")
    .eq("auth_user_id", user.id)
    .maybeSingle();
  const userTenantId =
    (profileRes.data as { tenant_id: string | null } | null)?.tenant_id ?? null;
  if (!userTenantId) {
    return NextResponse.json({ ok: false, error: "no_tenant" }, { status: 401 });
  }

  const dataTenantId = await resolveDataTenant(slug, userTenantId);
  if (!dataTenantId) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  const date = torontoDateIso(req.nextUrl.searchParams.get("date"));

  // Fetch open/done items for this date (dismissed excluded — client handles
  // optimistic removal; server-dismissed rows never travel to the client).
  const itemsRes = await db
    .from("daily_plan_items")
    .select("id, category, priority, reason, lead_id, application_id, metadata, status")
    .eq("tenant_id", dataTenantId)
    .eq("plan_date", date)
    .in("status", ["open", "done"])
    .order("priority", { ascending: false })
    .order("category")
    .order("created_at");

  if (itemsRes.error) {
    return NextResponse.json(
      { ok: false, error: "db_error", message: itemsRes.error.message },
      { status: 500 },
    );
  }

  const rows = (itemsRes.data ?? []) as DailyPlanItemRow[];

  // Batch-fetch linked tenant_records for leads and applications in two
  // IN-list queries rather than N+1 per row.
  const leadIds = [...new Set(rows.map((r) => r.lead_id).filter(Boolean) as string[])];
  const appIds = [...new Set(rows.map((r) => r.application_id).filter(Boolean) as string[])];

  type RecordRow = { id: string; data: Record<string, unknown> };
  const leadMap = new Map<string, RecordRow>();
  const appMap = new Map<string, RecordRow>();

  if (leadIds.length > 0) {
    const { data } = await db
      .from("tenant_records")
      .select("id, data")
      .eq("tenant_id", dataTenantId)
      .in("id", leadIds);
    for (const r of (data ?? []) as RecordRow[]) leadMap.set(r.id, r);
  }
  if (appIds.length > 0) {
    const { data } = await db
      .from("tenant_records")
      .select("id, data")
      .eq("tenant_id", dataTenantId)
      .in("id", appIds);
    for (const r of (data ?? []) as RecordRow[]) appMap.set(r.id, r);
  }

  // Build response items with resolved display names.
  const items = rows.map((row) => {
    const leadData = row.lead_id ? (leadMap.get(row.lead_id)?.data ?? {}) : {};
    const appData = row.application_id ? (appMap.get(row.application_id)?.data ?? {}) : {};
    // Application name takes precedence; fall back to lead fields.
    const business_name =
      (appData.business_name as string | undefined) ??
      (leadData.business_name as string | undefined) ??
      null;
    const contact_name =
      (appData.contact_name as string | undefined) ??
      (leadData.contact_name as string | undefined) ??
      null;
    return {
      id: row.id,
      category: row.category,
      priority: row.priority,
      reason: row.reason,
      lead_id: row.lead_id,
      application_id: row.application_id,
      business_name,
      contact_name,
      metadata: row.metadata ?? {},
      status: row.status,
    };
  });

  // Compute summary counts per category.
  let priority_calls = 0, missing_info = 0, stuck = 0, new_offers = 0, shop_today = 0, renewals_eligible = 0;
  for (const item of items) {
    if (item.category === "priority_call") priority_calls++;
    else if (item.category === "missing_info") missing_info++;
    else if (item.category === "stuck") stuck++;
    else if (item.category === "new_offer") new_offers++;
    else if (item.category === "shop_today") shop_today++;
    else if (item.category === "renewal_eligible") renewals_eligible++;
  }

  return NextResponse.json({
    date,
    summary: {
      total: items.length,
      priority_calls,
      missing_info,
      stuck,
      new_offers,
      shop_today,
      renewals_eligible,
    },
    items,
  });
}
