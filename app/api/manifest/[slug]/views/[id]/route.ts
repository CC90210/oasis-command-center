/**
 * GET    /api/manifest/<slug>/views/<id> — read one view + children.
 * DELETE /api/manifest/<slug>/views/<id> — soft-delete (sets is_active=false).
 *
 * PUT is intentionally omitted: client-side updates rewrite children
 * (fields/filters/sorts) wholesale. Implement as DELETE + POST. This keeps
 * the dispatcher simple and avoids merge-conflict semantics on JSONB diffs.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSessionUser, getServiceSupabase } from "@/lib/supabase-server";
import { resolveDataTenant } from "@/lib/manifest/tenant-scope";
import { manifestExists } from "@/lib/manifest/loader";
import { loadView } from "@/lib/views/loader";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{1,62}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function resolveContext(userId: string, slug: string) {
  if (!SLUG_RE.test(slug)) return { ok: false as const, status: 400, error: "invalid_slug" };
  if (!(await manifestExists(slug))) return { ok: false as const, status: 404, error: "unknown_tenant" };
  const db = getServiceSupabase();
  const profileRes = await db
    .from("user_profiles")
    .select("tenant_id")
    .eq("auth_user_id", userId)
    .maybeSingle();
  const userTenantId =
    (profileRes.data as { tenant_id: string | null } | null)?.tenant_id ?? null;
  const dataTenantId = await resolveDataTenant(slug, userTenantId);
  if (!dataTenantId) return { ok: false as const, status: 403, error: "preview_mode_no_writes" };
  return { ok: true as const, tenantId: dataTenantId };
}

/**
 * Private-view gate (V6.9.5 hotfix): a view with `owner_user_id !== null` is
 * private to that user. Tenant-scoped RLS alone is not enough — every
 * tenant member would otherwise be able to read/delete each other's private
 * views just by knowing the UUID. The route enforces the per-user gate
 * AFTER the tenant gate.
 */
function isViewAccessible(view: { tenant_id: string; owner_user_id: string | null }, tenantId: string, userId: string): boolean {
  if (view.tenant_id !== tenantId) return false;
  if (view.owner_user_id === null) return true; // workspace-shared
  return view.owner_user_id === userId;
}

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ slug: string; id: string }> },
) {
  const { slug, id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const context = await resolveContext(user.id, slug);
  if (!context.ok) return NextResponse.json({ ok: false, error: context.error }, { status: context.status });

  const view = await loadView(id);
  if (!view || !isViewAccessible(view, context.tenantId, user.id)) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, view });
}

export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ slug: string; id: string }> },
) {
  const { slug, id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const context = await resolveContext(user.id, slug);
  if (!context.ok) return NextResponse.json({ ok: false, error: context.error }, { status: context.status });

  // Load first to enforce private-view gate before mutating.
  const view = await loadView(id);
  if (!view || !isViewAccessible(view, context.tenantId, user.id)) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }

  const db = getServiceSupabase();
  const result = await db
    .from("views")
    .update({ is_active: false })
    .eq("id", id)
    .eq("tenant_id", context.tenantId)
    .select("id")
    .maybeSingle();
  if (result.error) {
    return NextResponse.json({ ok: false, error: "db_error", detail: result.error.message }, { status: 500 });
  }
  if (!result.data) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
