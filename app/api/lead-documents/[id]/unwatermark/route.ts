/**
 * POST /api/lead-documents/[id]/unwatermark
 *
 * Operator action (2026-06-29, Adon ask): get the CLEAN version of a stored bank
 * statement. Since b4d9039 the stored `storage_path` IS the clean original (the
 * SunBiz mark only ever lands on a derived `_shopout_wm` copy at shop-out), so
 * "unwatermark" = guarantee clean: purge the derived copy + clear its stamps.
 *
 * For the legacy files that were rasterized in place BEFORE that fix, the clean
 * original is gone and flattened pixels can't be losslessly recovered — the route
 * returns { state:"legacy_baked", clean_available:false } (HTTP 200, a known
 * state, not an error) so the UI shows a re-upload prompt.
 *
 * Auth/scoping mirrors the GET signed-URL route in this folder: session → tenant
 * gate → per-agent confused-deputy guard → tenant-prefix storage guard.
 *
 * Response: { ok:true, state:"clean"|"legacy_baked", ... } or { ok:false, error }.
 */
import { NextResponse, type NextRequest } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { resolveSessionContext } from "@/lib/api-auth";
import { canViewLead, leadScopingEnabled } from "@/lib/lead-scope";
import { unwatermarkLeadDocument } from "@/lib/lead-documents";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const sess = await resolveSessionContext();
  if (!sess.ok) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const { id } = await context.params;
  const db = getServiceSupabase();
  const tenantId = sess.tenantId;

  const docRow = await db
    .from("lead_documents")
    .select("id, tenant_id, lead_id, storage_path, doc_type, metadata")
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .is("metadata->>deleted_at", null)
    .maybeSingle();
  const doc = docRow.data as
    | {
        id: string;
        tenant_id: string;
        lead_id: string | null;
        storage_path: string;
        doc_type: string | null;
        metadata: Record<string, unknown> | null;
      }
    | null;
  if (!doc) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }

  // Per-agent scope (confused-deputy): authorize the parent lead/application
  // before mutating, same as the GET route. Deny with 404 so a foreign UUID
  // can't even confirm the file exists.
  if (leadScopingEnabled() && doc.lead_id) {
    const parent = await db
      .from("tenant_records")
      .select("data, entity_type")
      .eq("tenant_id", tenantId)
      .eq("id", doc.lead_id)
      .maybeSingle();
    const prow = parent.data as
      | { data?: Record<string, unknown> | null; entity_type?: string | null }
      | null;
    if (
      prow &&
      (prow.entity_type === "lead" || prow.entity_type === "application") &&
      !canViewLead({ isAdmin: sess.isAdmin, userId: sess.userId }, prow.data || {}, true)
    ) {
      return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
    }
  }

  // Tenant-prefix storage guard (matches the GET route): never act on a row whose
  // storage path isn't anchored under this tenant's folder.
  if (!doc.storage_path.startsWith(`${doc.tenant_id}/`)) {
    return NextResponse.json({ ok: false, error: "storage_path_mismatch" }, { status: 403 });
  }

  const result = await unwatermarkLeadDocument(db, {
    id: doc.id,
    tenant_id: doc.tenant_id,
    storage_path: doc.storage_path,
    metadata: doc.metadata,
  });
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: 500 });
  }
  return NextResponse.json(result);
}
