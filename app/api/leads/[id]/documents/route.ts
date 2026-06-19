/**
 * /api/leads/[id]/documents — operator-facing document management.
 *
 *   GET  — list documents for the drawer's Documents tab and full-record pages.
 *   POST — multipart upload via uploadLeadDocument (shared with the
 *          public form intake and full-record forms). After insert, the engine evaluates
 *          whether to auto-progress lead.stage.
 *
 * Auth: session-cookie → tenant via resolveSessionContext.
 * Bucket: lead-documents (migration 055).
 */

import { NextResponse, type NextRequest } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { resolveSessionContext } from "@/lib/api-auth";
import { getRecord } from "@/lib/manifest/data";
import { canViewLead, leadScopingEnabled, type LeadViewer } from "@/lib/lead-scope";
import {
  uploadLeadDocument,
  softDeleteLeadDocument,
  OPERATOR_ALLOWED_DOC_MIME,
  MAX_LEAD_DOC_BYTES,
} from "@/lib/lead-documents";
import { dispatchLeadStageEvent } from "@/lib/lead-stage-dispatcher";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type DocumentTarget = {
  documentLeadId: string;
  stageLeadId: string | null;
  entity: "lead" | "application";
};

async function resolveDocumentTarget(
  tenantId: string,
  id: string,
  entityParam: string | null,
  viewer: LeadViewer,
): Promise<DocumentTarget | null> {
  const entity = entityParam === "application" ? "application" : "lead";
  if (entity === "lead") {
    const lead = await getRecord({ tenant_id: tenantId, entity: "lead", id }).catch(() => null);
    // Per-agent lock: an agent must not read/upload another agent's lead docs by
    // guessing the id. Returning null surfaces as record_not_found (same as a
    // missing record — doesn't confirm existence).
    if (!lead || !canViewLead(viewer, lead.data as Record<string, unknown>, leadScopingEnabled())) return null;
    return { documentLeadId: id, stageLeadId: id, entity };
  }

  const application = await getRecord({
    tenant_id: tenantId,
    entity: "application",
    id,
  }).catch(() => null);
  if (!application || !canViewLead(viewer, application.data as Record<string, unknown>, leadScopingEnabled())) return null;

  const linkedLeadId = (application.data as Record<string, unknown>).lead_id;
  const stageLeadId =
    typeof linkedLeadId === "string" && UUID_RE.test(linkedLeadId) ? linkedLeadId : null;

  return {
    documentLeadId: stageLeadId || id,
    stageLeadId,
    entity,
  };
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }
  const sess = await resolveSessionContext();
  if (!sess.ok) {
    return NextResponse.json({ ok: false, error: sess.reason }, { status: 401 });
  }
  const target = await resolveDocumentTarget(
    sess.tenantId,
    id,
    req.nextUrl.searchParams.get("entity"),
    { isAdmin: sess.isAdmin, userId: sess.userId },
  );
  if (!target) {
    return NextResponse.json({ ok: false, error: "record_not_found" }, { status: 404 });
  }
  const db = getServiceSupabase();
  const r = await db
    .from("lead_documents")
    // storage_path exposed so the Shopping Out workflow can pass it into
    // POST /api/applications/[id]/shop-out's `attachments` array
    // (the shop-out route validates each path starts with `<tenant_id>/`
    // before forwarding to send_gateway). Tenant-scoped read is already
    // enforced by the .eq("tenant_id") + RLS combo.
    .select("id, filename, mime_type, size_bytes, doc_type, storage_path, uploaded_by, uploaded_at")
    .eq("tenant_id", sess.tenantId)
    .eq("lead_id", target.documentLeadId)
    .is("metadata->>deleted_at", null) // Batch 5: exclude soft-deleted (also keeps them out of shop-out)
    .order("uploaded_at", { ascending: false });
  if (r.error) {
    return NextResponse.json({ ok: false, error: r.error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, documents: r.data || [] });
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }
  const sess = await resolveSessionContext();
  if (!sess.ok) {
    return NextResponse.json({ ok: false, error: sess.reason }, { status: 401 });
  }
  const target = await resolveDocumentTarget(
    sess.tenantId,
    id,
    req.nextUrl.searchParams.get("entity"),
    { isAdmin: sess.isAdmin, userId: sess.userId },
  );
  if (!target) {
    return NextResponse.json({ ok: false, error: "record_not_found" }, { status: 404 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ ok: false, error: "expected_multipart" }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof Blob) || !("name" in file)) {
    return NextResponse.json({ ok: false, error: "file_required" }, { status: 400 });
  }
  const fileObj = file as File;
  if (fileObj.size === 0) {
    return NextResponse.json({ ok: false, error: "empty_file" }, { status: 400 });
  }
  if (fileObj.size > MAX_LEAD_DOC_BYTES) {
    return NextResponse.json(
      { ok: false, error: "file_too_large", max_bytes: MAX_LEAD_DOC_BYTES },
      { status: 413 },
    );
  }
  const mime = (fileObj.type || "application/octet-stream").toLowerCase();
  if (!OPERATOR_ALLOWED_DOC_MIME.has(mime)) {
    return NextResponse.json(
      { ok: false, error: "unsupported_mime_type", mime },
      { status: 415 },
    );
  }

  const rawDocType = form.get("doc_type");
  const docType =
    typeof rawDocType === "string" && rawDocType
      ? rawDocType.replace(/[^a-z0-9_]/gi, "_").toLowerCase()
      : "unclassified";
  const rawSource = form.get("source");
  const source =
    typeof rawSource === "string" && /^[a-z0-9_:-]{1,40}$/i.test(rawSource)
      ? rawSource
      : "drawer_upload";

  const buffer = Buffer.from(await fileObj.arrayBuffer());

  const result = await uploadLeadDocument({
    tenantId: sess.tenantId,
    leadId: target.documentLeadId,
    filename: fileObj.name,
    mimeType: mime,
    bytes: buffer,
    sizeBytes: fileObj.size,
    docType,
    uploadedBy: sess.email || "operator",
    source,
    extraMetadata: {
      profile_id: sess.profileId,
      entity: target.entity,
      record_id: id,
    },
  });
  if (!result.ok) {
    const status = result.error.startsWith("upload_failed") ? 500 : 500;
    return NextResponse.json({ ok: false, error: result.error }, { status });
  }

  // Engine evaluates whether this upload completes the required-doc
  // set and bumps the lead's stage if so. Best-effort: a failure
  // here doesn't reject the document insert.
  const stageEvent = target.stageLeadId
    ? await dispatchLeadStageEvent({
        type: "doc_uploaded",
        tenantId: sess.tenantId,
        leadId: target.stageLeadId,
        docType,
      })
    : null;

  return NextResponse.json({
    ok: true,
    document: result.document,
    stage_bumped: stageEvent?.fired ? stageEvent.to : null,
  });
}

/**
 * DELETE /api/leads/[id]/documents?doc=<docId> — soft-delete one document
 * (Batch 5). Gate: owner-agent or admin on the parent lead (reuses
 * resolveDocumentTarget, which runs canViewLead). Soft-delete keeps the bytes
 * but excludes the doc from every read path + shop-out. Audited to the timeline.
 */
export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }
  const docId = req.nextUrl.searchParams.get("doc");
  if (!docId || !UUID_RE.test(docId)) {
    return NextResponse.json({ ok: false, error: "invalid_doc_id" }, { status: 400 });
  }
  const sess = await resolveSessionContext();
  if (!sess.ok) {
    return NextResponse.json({ ok: false, error: sess.reason }, { status: 401 });
  }
  // Owner-or-admin gate on the parent lead/application (same gate as GET/POST).
  const target = await resolveDocumentTarget(
    sess.tenantId,
    id,
    req.nextUrl.searchParams.get("entity"),
    { isAdmin: sess.isAdmin, userId: sess.userId },
  );
  if (!target) {
    return NextResponse.json({ ok: false, error: "record_not_found" }, { status: 404 });
  }

  const result = await softDeleteLeadDocument({
    tenantId: sess.tenantId,
    docId,
    deletedBy: sess.email || sess.userId || "operator",
  });
  if (!result.ok) {
    const status = result.error === "not_found" ? 404 : 500;
    return NextResponse.json({ ok: false, error: result.error }, { status });
  }

  // Audit + re-evaluate required-doc/stage state (a removed bank statement may
  // drop the lead back below the doc threshold). Both best-effort.
  try {
    const db = getServiceSupabase();
    const note = `Document removed: ${result.filename}`;
    await db.from("lead_interactions").insert({
      tenant_id: sess.tenantId,
      lead_id: result.lead_id,
      type: "document_deleted",
      channel: "system",
      direction: "outbound",
      agent_source: "dashboard_doc_delete",
      subject: "Document removed",
      content: note,
      content_preview: note,
      metadata: { document_id: docId, doc_type: result.doc_type, deleted_by: sess.userId },
    });
  } catch {
    /* best-effort audit */
  }
  if (target.stageLeadId) {
    await dispatchLeadStageEvent({
      type: "doc_uploaded",
      tenantId: sess.tenantId,
      leadId: target.stageLeadId,
      docType: result.doc_type,
    }).catch(() => {});
  }

  return NextResponse.json({ ok: true, deleted: docId });
}
