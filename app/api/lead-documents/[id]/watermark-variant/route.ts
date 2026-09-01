/**
 * POST /api/lead-documents/[id]/watermark-variant  { target: "clean" | "watermarked" }
 *
 * Toggle which variant of a stored bank statement is "active" for the operator
 * view/download (2026-06-29, Adon: "watermark it or unwatermark it … keeping
 * duplicate files"). Both copies are kept — the clean original AND the
 * watermarked duplicate — so toggling is instant + infinitely reversible.
 *
 * Legacy baked files (watermarked in place before the clean-storage fix) have no
 * clean original; target:"clean" on those returns { state:"legacy_baked" } so the
 * UI shows a re-upload prompt. Lenders (shop-out) always get the watermarked
 * copy regardless of this flag; FundMate always uses the clean original.
 *
 * Auth/scoping mirrors the sibling GET signed-URL route.
 */
import { NextResponse, type NextRequest } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { resolveSessionContext } from "@/lib/api-auth";
import { setLeadDocumentVariant } from "@/lib/lead-documents";
import { getWritableLead } from "@/lib/lead-access";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// This route RENDERS — toggling to "watermarked" runs the full watermark path,
// and for an encrypted source that means rasterizing every page at ~165ms/page.
// It was the only watermarking entry point with no declared budget, so it
// inherited the platform default while shop-out (120s), shop-out/run (300s) and
// the thread retries (120s) all declare one. Match the 120s floor the raster
// page cap is sized against (lib/forms/watermark.ts, MAX_PAGES_RASTER).
export const maxDuration = 120;

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const sess = await resolveSessionContext();
  if (!sess.ok) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const { id } = await context.params;

  let target: "clean" | "watermarked" = "clean";
  try {
    const body = (await req.json()) as { target?: unknown };
    if (body?.target === "watermarked") target = "watermarked";
    else if (body?.target === "clean") target = "clean";
    else return NextResponse.json({ ok: false, error: "invalid_target" }, { status: 400 });
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const db = getServiceSupabase();
  const tenantId = sess.tenantId;

  const docRow = await db
    .from("lead_documents")
    .select("id, tenant_id, lead_id, storage_path, mime_type, doc_type, metadata")
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
        mime_type: string | null;
        doc_type: string | null;
        metadata: Record<string, unknown> | null;
      }
    | null;
  if (!doc) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }

  // This is a WRITE even though the bytes are unchanged. OASIS managers may
  // preview another rep's document for coaching, but only the assigned/
  // collaborating rep (or admin) may switch the active clean/WM variant.
  if (!doc.lead_id && !sess.isAdmin) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  if (doc.lead_id) {
    const parent = await db
      .from("tenant_records")
      .select("entity_type")
      .eq("tenant_id", tenantId)
      .eq("id", doc.lead_id)
      .maybeSingle();
    const parentEntity = (parent.data as { entity_type?: unknown } | null)?.entity_type;
    if (parentEntity !== "lead" && parentEntity !== "application") {
      return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
    }
    const access = await getWritableLead(
      {
        teamRole: sess.teamRole,
        userId: sess.userId,
        isOwner: sess.isTrueAdmin,
        adminAccess: sess.adminAccess,
      },
      {
        tenantId,
        entity: parentEntity,
        id: doc.lead_id,
      },
    );
    if (!access.ok) {
      return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
    }
  }

  // Tenant-prefix storage guard.
  if (!doc.storage_path.startsWith(`${doc.tenant_id}/`)) {
    return NextResponse.json({ ok: false, error: "storage_path_mismatch" }, { status: 403 });
  }

  const result = await setLeadDocumentVariant(
    db,
    {
      id: doc.id,
      tenant_id: doc.tenant_id,
      lead_id: doc.lead_id || "",
      storage_path: doc.storage_path,
      mime_type: doc.mime_type,
      metadata: doc.metadata,
    },
    target,
    sess.email || sess.userId,
  );
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: 500 });
  }
  return NextResponse.json(result);
}
