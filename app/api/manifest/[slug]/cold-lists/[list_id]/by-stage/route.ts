/**
 * GET /api/manifest/<slug>/cold-lists/<list_id>/by-stage
 *
 * Returns the cold list partitioned by stage for the Arcadian chevron rail.
 *
 * Response:
 *   {
 *     ok: true,
 *     list: { id, name, row_count, promoted_count },
 *     stages: {
 *       imported:  { count: number; recent: ColdLead[] },
 *       contacted: { count: number; recent: ColdLead[] },
 *       replied:   { count: number; recent: ColdLead[] },
 *       qualified: { count: number; recent: ColdLead[] },
 *       promoted:  { count: number; recent: ColdLead[] },
 *       dead:      { count: number; recent: ColdLead[] },
 *     }
 *   }
 *
 * `recent` is the latest 10 rows per stage (by created_at DESC).
 * The chevron rail shows these inline; the operator opens a drawer for detail.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSessionUser, getServiceSupabase } from "@/lib/supabase-server";
import { resolveDataTenant } from "@/lib/manifest/tenant-scope";
import { manifestExists } from "@/lib/manifest/loader";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{1,62}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const COLD_STAGES = [
  "imported",
  "contacted",
  "replied",
  "qualified",
  "promoted",
  "dead",
] as const;

type ColdStage = typeof COLD_STAGES[number];

type ColdLeadRow = {
  id: string;
  business_name: string | null;
  contact_name: string | null;
  phone: string | null;
  email: string | null;
  stage: string;
  attempt_count: number;
  created_at: string;
};

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

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ slug: string; list_id: string }> },
) {
  const { slug, list_id } = await ctx.params;
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  if (!UUID_RE.test(list_id)) {
    return NextResponse.json({ ok: false, error: "invalid_list_id" }, { status: 400 });
  }

  const context = await resolveContext(user.id, slug);
  if (!context.ok) {
    return NextResponse.json({ ok: false, error: context.error }, { status: context.status });
  }

  const db = getServiceSupabase();

  // Verify the list belongs to this tenant.
  const { data: listRow, error: listErr } = await db
    .from("cold_lead_lists")
    .select("id, name, row_count, promoted_count")
    .eq("id", list_id)
    .eq("tenant_id", context.tenantId)
    .maybeSingle();

  if (listErr || !listRow) {
    return NextResponse.json({ ok: false, error: "list_not_found" }, { status: 404 });
  }

  // Fetch all cold leads for this list ordered newest first.
  // We fetch all rows so we can count per stage accurately and pick the
  // most recent 10 per stage without N+1 round-trips.
  const { data: allRows, error: rowsErr } = await db
    .from("cold_leads")
    .select("id, business_name, contact_name, phone, email, stage, attempt_count, created_at")
    .eq("tenant_id", context.tenantId)
    .eq("list_id", list_id)
    .order("created_at", { ascending: false });

  if (rowsErr) {
    return NextResponse.json({ ok: false, error: "db_error", detail: rowsErr.message }, { status: 500 });
  }

  const rows = (allRows ?? []) as ColdLeadRow[];

  // Partition into per-stage buckets. Rows with unrecognized stages land
  // in 'imported' so the UI doesn't silently drop them.
  const buckets: Record<ColdStage, ColdLeadRow[]> = {
    imported: [],
    contacted: [],
    replied: [],
    qualified: [],
    promoted: [],
    dead: [],
  };

  for (const row of rows) {
    const stage = (COLD_STAGES as readonly string[]).includes(row.stage)
      ? (row.stage as ColdStage)
      : "imported";
    buckets[stage].push(row);
  }

  const stages = Object.fromEntries(
    COLD_STAGES.map((s) => [
      s,
      {
        count: buckets[s].length,
        // Already sorted newest-first from Supabase; take first 10.
        recent: buckets[s].slice(0, 10),
      },
    ]),
  );

  return NextResponse.json({
    ok: true,
    list: listRow,
    stages,
  });
}
