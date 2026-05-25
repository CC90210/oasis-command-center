/**
 * GET /api/manifest/<slug>/cold-lists/<list_id>/leads
 *
 * Returns paginated cold leads for the given list, optionally filtered by
 * stage and max attempt_count. Used by the compose UI's recipient filter
 * chip preview ("47 in this list") and the "Preview first 3 messages" flow.
 *
 * Query params:
 *   stage        (optional) — filter to this stage value
 *   max_attempts (optional) — include only rows where attempt_count <= n
 *   limit        (default 500, max 500; pass 0 for count-only)
 *
 * Returns: { ok: true, leads: ColdLead[], total: number }
 *
 * `total` always reflects the unfiltered-by-limit count matching the filter
 * so the chip can display "47 recipients match" without a separate request.
 *
 * Auth: session required + caller must own this slug (resolveDataTenant).
 */

import { NextRequest, NextResponse } from "next/server";
import { getSessionUser, getServiceSupabase } from "@/lib/supabase-server";
import { resolveDataTenant } from "@/lib/manifest/tenant-scope";
import { manifestExists } from "@/lib/manifest/loader";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{1,62}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CAP = 500;

type ColdLead = {
  id: string;
  business_name: string;
  contact_name: string | null;
  phone: string | null;
  email: string | null;
  stage: string;
  attempt_count: number;
  last_contacted_at: string | null;
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
  req: NextRequest,
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

  const sp = req.nextUrl.searchParams;
  const stageFilter = sp.get("stage") ?? null;
  const maxAttemptsRaw = sp.get("max_attempts");
  const maxAttempts =
    maxAttemptsRaw !== null && !Number.isNaN(Number(maxAttemptsRaw))
      ? Number(maxAttemptsRaw)
      : null;
  const limitRaw = sp.get("limit");
  const limit =
    limitRaw !== null && !Number.isNaN(Number(limitRaw))
      ? Math.min(Number(limitRaw), CAP)
      : CAP;

  const db = getServiceSupabase();

  // Verify the list belongs to this tenant.
  const { data: listRow, error: listErr } = await db
    .from("cold_lead_lists")
    .select("id")
    .eq("id", list_id)
    .eq("tenant_id", context.tenantId)
    .is("archived_at", null)
    .maybeSingle();

  if (listErr || !listRow) {
    return NextResponse.json({ ok: false, error: "list_not_found" }, { status: 404 });
  }

  // Build the filtered query (shared between count and data fetch).
  let baseQuery = db
    .from("cold_leads")
    .select(
      "id, business_name, contact_name, phone, email, stage, attempt_count, last_contacted_at",
    )
    .eq("tenant_id", context.tenantId)
    .eq("list_id", list_id);

  if (stageFilter) {
    baseQuery = baseQuery.eq("stage", stageFilter);
  }
  if (maxAttempts !== null) {
    baseQuery = baseQuery.lte("attempt_count", maxAttempts);
  }

  // Count query — always returns the full filtered count regardless of limit.
  const countQuery = db
    .from("cold_leads")
    .select("*", { count: "exact", head: true })
    .eq("tenant_id", context.tenantId)
    .eq("list_id", list_id);

  let filteredCountQuery = db
    .from("cold_leads")
    .select("*", { count: "exact", head: true })
    .eq("tenant_id", context.tenantId)
    .eq("list_id", list_id);

  if (stageFilter) filteredCountQuery = filteredCountQuery.eq("stage", stageFilter);
  if (maxAttempts !== null) filteredCountQuery = filteredCountQuery.lte("attempt_count", maxAttempts);

  const [countRes, dataRes] = await Promise.all([
    filteredCountQuery,
    limit === 0
      ? Promise.resolve({ data: [], error: null })
      : baseQuery.order("created_at", { ascending: false }).limit(limit),
  ]);

  if (dataRes.error) {
    return NextResponse.json(
      { ok: false, error: "db_error", detail: dataRes.error.message },
      { status: 500 },
    );
  }

  const leads = (dataRes.data ?? []) as ColdLead[];
  const total = countRes.count ?? leads.length;

  return NextResponse.json({ ok: true, leads, total });
}
