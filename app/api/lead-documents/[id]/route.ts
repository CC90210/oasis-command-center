/**
 * GET /api/lead-documents/[id]
 *
 * Mints a short-lived signed URL for a lead_documents row so the operator
 * UI can render the file inline (or download it) without exposing the
 * bucket publicly. Tenant scope is verified BEFORE the signed URL is
 * generated — guessing a UUID never produces a working link.
 *
 * Response: { ok: true, url, filename, mime_type } or { ok: false, error }.
 */
import { NextResponse, type NextRequest } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { resolveSessionContext } from "@/lib/api-auth";
import { canViewLead, leadScopingEnabled } from "@/lib/lead-scope";
import { resolveActiveStoragePath } from "@/lib/lead-documents";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const SIGN_TTL_SECONDS = 60 * 10; // 10 minutes

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const sess = await resolveSessionContext();
  if (!sess.ok) {
    return NextResponse.json(
      { ok: false, error: "unauthorized" },
      { status: 401 },
    );
  }
  const { id } = await context.params;
  const db = getServiceSupabase();
  const tenantId = sess.tenantId;

  const docRow = await db
    .from("lead_documents")
    .select("id, tenant_id, lead_id, filename, storage_path, mime_type, metadata")
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .is("metadata->>deleted_at", null) // Batch 5: a soft-deleted doc isn't downloadable
    .maybeSingle();
  const doc = docRow.data as
    | {
        id: string;
        tenant_id: string;
        lead_id: string | null;
        filename: string;
        storage_path: string;
        mime_type: string | null;
        metadata: Record<string, unknown> | null;
      }
    | null;
  if (!doc) {
    return NextResponse.json(
      { ok: false, error: "not_found" },
      { status: 404 },
    );
  }

  // Per-agent scope (Codex 2026-06-19 HIGH). The tenant match above is NOT
  // enough once LEAD_SCOPING_ENABLED is on: any tenant member with a document
  // UUID could otherwise mint a signed URL for ANOTHER agent's bank statements.
  // Authorize the document's parent record (lead OR application — both carry
  // assigned_to) before signing; deny with the same 404 so a foreign UUID can't
  // even confirm the file exists.
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
    // Only lead/application records are per-agent scoped. If the parent is one of
    // those and the viewer can't see it, deny. (A missing parent or a non-scoped
    // entity falls through — scoping governs lead/application only.)
    if (
      prow &&
      (prow.entity_type === "lead" || prow.entity_type === "application") &&
      !canViewLead({ isAdmin: sess.isAdmin, userId: sess.userId }, prow.data || {}, true)
    ) {
      return NextResponse.json(
        { ok: false, error: "not_found" },
        { status: 404 },
      );
    }
  }

  // Confused-deputy guard. lead_documents.tenant_id matched the caller
  // — but `storage_path` is operator-writable through RLS (the
  // lead_documents_member_all policy lets authenticated tenant members
  // INSERT rows for their own tenant). A malicious employee could
  // craft a row pointing at another tenant's storage path and then
  // this service-role mint would sign it. Refuse to sign unless the
  // storage path is anchored under THIS tenant's folder.
  const expectedPrefix = `${doc.tenant_id}/`;
  if (!doc.storage_path.startsWith(expectedPrefix)) {
    return NextResponse.json(
      { ok: false, error: "storage_path_mismatch" },
      { status: 403 },
    );
  }

  // Duplicate-file model (2026-06-29): serve the ACTIVE variant — clean original
  // or the watermarked duplicate — per metadata.active_variant. The resolved path
  // is re-checked against the tenant prefix (it could be the _shopout_wm copy).
  const active = resolveActiveStoragePath({ storage_path: doc.storage_path, metadata: doc.metadata });
  if (!active.path.startsWith(expectedPrefix)) {
    return NextResponse.json({ ok: false, error: "storage_path_mismatch" }, { status: 403 });
  }
  const cleanAvailable = !(doc.metadata || {}).watermarked_at; // legacy baked → no clean

  const signed = await db.storage
    .from("lead-documents")
    .createSignedUrl(active.path, SIGN_TTL_SECONDS);
  if (signed.error || !signed.data?.signedUrl) {
    return NextResponse.json(
      { ok: false, error: signed.error?.message || "sign_failed" },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    url: signed.data.signedUrl,
    filename: doc.filename,
    mime_type: doc.mime_type,
    active_variant: active.variant,
    is_watermarked: active.is_watermarked,
    clean_available: cleanAvailable,
    raster: active.raster,
  });
}
