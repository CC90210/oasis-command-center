/**
 * GET  /api/manifest/<slug>/cold-lists — list all cold lists for the tenant.
 * POST /api/manifest/<slug>/cold-lists — create a new cold list.
 *
 * Cold lists are intentionally separate from the warm pipeline (tenant_records).
 * These routes scope exclusively to cold_lead_lists; warm leads live in
 * tenant_records with entity_type='lead'. The two stores never overlap.
 *
 * Auth: session required + caller must own this slug (resolveDataTenant).
 * Preview-mode callers (wrong slug ownership) receive 403.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSessionUser, getServiceSupabase } from "@/lib/supabase-server";
import { resolveDataTenant } from "@/lib/manifest/tenant-scope";
import { manifestExists } from "@/lib/manifest/loader";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{1,62}$/;

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
    return { ok: false, status: 403, error: "preview_mode_no_writes" };
  }
  return { ok: true, tenantId: dataTenantId };
}

/**
 * GET /api/manifest/<slug>/cold-lists
 *
 * Returns { lists: ColdList[] } sorted newest first.
 * Only non-archived lists are returned.
 */
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ slug: string }> },
) {
  const { slug } = await ctx.params;
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const context = await resolveContext(user.id, slug);
  if (!context.ok) {
    return NextResponse.json({ ok: false, error: context.error }, { status: context.status });
  }

  const db = getServiceSupabase();
  const { data, error } = await db
    .from("cold_lead_lists")
    .select("id, name, source, row_count, promoted_count, created_at")
    .eq("tenant_id", context.tenantId)
    .is("archived_at", null)
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json({ ok: false, error: "db_error", detail: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, lists: data ?? [] });
}

/**
 * POST /api/manifest/<slug>/cold-lists
 *
 * Body: { name: string, source?: string }
 * Returns: { ok: true, list_id: string, row_count: 0 }
 */
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ slug: string }> },
) {
  const { slug } = await ctx.params;
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const context = await resolveContext(user.id, slug);
  if (!context.ok) {
    return NextResponse.json({ ok: false, error: context.error }, { status: context.status });
  }

  let body: { name?: unknown; source?: unknown };
  try {
    body = (await req.json()) as { name?: unknown; source?: unknown };
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
    return NextResponse.json({ ok: false, error: "name_required" }, { status: 400 });
  }

  const source = typeof body.source === "string" && body.source.trim()
    ? body.source.trim()
    : "csv_upload";

  const db = getServiceSupabase();
  const { data, error } = await db
    .from("cold_lead_lists")
    .insert({
      tenant_id: context.tenantId,
      name,
      source,
      row_count: 0,
      promoted_count: 0,
      created_by_user_id: user.id,
    })
    .select("id")
    .single();

  if (error || !data) {
    return NextResponse.json(
      { ok: false, error: "db_error", detail: error?.message },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true, list_id: data.id, row_count: 0 });
}
