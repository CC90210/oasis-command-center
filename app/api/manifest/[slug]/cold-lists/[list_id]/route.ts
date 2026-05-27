/**
 * DELETE /api/manifest/<slug>/cold-lists/<list_id>
 *
 * Soft-archives a cold list by stamping archived_at. The list and its
 * underlying cold_leads rows are preserved — the GET in
 * cold-lists/route.ts filters out archived lists via `archived_at IS NULL`,
 * so this hides the list from the picker without losing history.
 *
 * Auth: session required + caller must own this slug (resolveDataTenant).
 * Preview-mode callers receive 403 (consistent with sibling routes).
 */

import { NextRequest, NextResponse } from "next/server";
import { getSessionUser, getServiceSupabase } from "@/lib/supabase-server";
import { resolveDataTenant } from "@/lib/manifest/tenant-scope";
import { manifestExists } from "@/lib/manifest/loader";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{1,62}$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ slug: string; list_id: string }> },
) {
  const { slug, list_id } = await ctx.params;

  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  if (!SLUG_RE.test(slug)) {
    return NextResponse.json({ ok: false, error: "invalid_slug" }, { status: 400 });
  }
  if (!UUID_RE.test(list_id)) {
    return NextResponse.json({ ok: false, error: "invalid_list_id" }, { status: 400 });
  }
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

  const dataTenantId = await resolveDataTenant(slug, userTenantId);
  if (!dataTenantId) {
    return NextResponse.json(
      { ok: false, error: "preview_mode_no_writes" },
      { status: 403 },
    );
  }

  const { data, error } = await db
    .from("cold_lead_lists")
    .update({ archived_at: new Date().toISOString() })
    .eq("id", list_id)
    .eq("tenant_id", dataTenantId)
    .is("archived_at", null)
    .select("id")
    .maybeSingle();

  if (error) {
    return NextResponse.json(
      { ok: false, error: "db_error", detail: error.message },
      { status: 500 },
    );
  }
  if (!data) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true, list_id });
}
