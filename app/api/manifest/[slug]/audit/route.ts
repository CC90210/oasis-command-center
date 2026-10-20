import { NextResponse, type NextRequest } from "next/server";
import { canPreviewTenantSlug, resolveCallerTenantAccess } from "@/lib/tenant-access";
import { manifestExists } from "@/lib/manifest/loader";
import { getManifestRow, listManifestAudit } from "@/lib/manifest/persistence";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/manifest/<slug>/audit
 *
 * Returns the audit history for a manifest, newest first. Required for the
 * editor's "What changed?" sidebar and the rollback flow.
 *
 * Same gate as GET /api/manifest/<slug>: a platform operator, or the slug's
 * own workspace. This route used to check only that a session existed and
 * relied on a row-level-security policy to narrow the rows, but Turso has no
 * RLS, so any signed-in user of any workspace could read another workspace's
 * change log (diffs, messages, actor ids) by its slug, and slugs are public in
 * /f/<slug>/ form links (2026-10-19 audit).
 */
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ slug: string }> }
) {
  const { slug } = await ctx.params;
  const normalised = slug.toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{1,62}$/.test(normalised)) {
    return NextResponse.json({ ok: false, error: "invalid slug" }, { status: 400 });
  }
  const access = await resolveCallerTenantAccess();
  if (!access) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (!canPreviewTenantSlug(access, normalised) || !(await manifestExists(normalised))) {
    // One 404 for "exists but not yours" and "does not exist", as the
    // manifest route does, so the answer cannot enumerate workspaces.
    return NextResponse.json({ ok: false, error: "unknown tenant" }, { status: 404 });
  }

  const row = await getManifestRow(normalised);
  if (!row) {
    return NextResponse.json({ ok: true, entries: [], manifest_id: null });
  }
  const entries = await listManifestAudit(row.id, 50);
  return NextResponse.json({ ok: true, entries, manifest_id: row.id });
}
