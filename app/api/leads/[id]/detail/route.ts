/**
 * GET /api/leads/[id]/detail
 *
 * Aggregated read for the SunBiz LeadDetailDrawer. Returns lead row +
 * documents + linked application (for the Lenders / Bank tabs) in one
 * round trip so the drawer can render all five tabs without firing
 * five separate fetches as the operator clicks between them.
 *
 * Auth: session → tenant via resolveTenantId. tenant_id constrains
 * every query so a session for tenant A cannot read tenant B's lead.
 */

import { NextResponse, type NextRequest } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { getRecord, listRecords } from "@/lib/manifest/data";
import { resolveTenantId } from "@/lib/api-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }

  const tenantId = await resolveTenantId();
  if (!tenantId) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  // `entity` query param lets the same endpoint serve the application
  // drawer (?entity=application) without a parallel route. Default is
  // "lead" so existing callers don't break.
  const url = new URL(req.url);
  const entity = url.searchParams.get("entity") === "application" ? "application" : "lead";

  const record = await getRecord({ tenant_id: tenantId, entity, id }).catch(() => null);
  if (!record) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }

  // Documents — `lead_documents` row store is keyed by lead_id even when
  // the drawer is opened against an application; the application's
  // data.lead_id resolves the link.
  const docLeadId =
    entity === "lead"
      ? id
      : typeof (record.data as Record<string, unknown>).lead_id === "string" &&
          UUID_RE.test((record.data as Record<string, unknown>).lead_id as string)
        ? ((record.data as Record<string, unknown>).lead_id as string)
        : id;

  const db = getServiceSupabase();
  const docsRes = docLeadId
    ? await db
        .from("lead_documents")
        .select("id, filename, mime_type, size_bytes, doc_type, uploaded_by, uploaded_at")
        .eq("tenant_id", tenantId)
        .eq("lead_id", docLeadId)
        .order("uploaded_at", { ascending: false })
    : { data: [] as unknown[], error: null };

  // Linked application for the Lenders tab — only when the drawer was
  // opened on a lead. When opened on an application, the record itself
  // is the application.
  let linkedApplication: { id: string; data: Record<string, unknown> } | null = null;
  if (entity === "lead") {
    const apps = await listRecords({
      tenant_id: tenantId,
      entity: "application",
      where: { lead_id: id },
      limit: 1,
    }).catch(() => ({ rows: [] }));
    if (apps.rows[0]) {
      linkedApplication = {
        id: apps.rows[0].id,
        data: apps.rows[0].data as Record<string, unknown>,
      };
    }
  } else {
    linkedApplication = { id: record.id, data: record.data as Record<string, unknown> };
  }

  return NextResponse.json({
    ok: true,
    record: {
      id: record.id,
      entity,
      data: record.data,
      created_at: record.created_at,
      updated_at: record.updated_at,
    },
    documents: docsRes.data || [],
    application: linkedApplication,
  });
}
