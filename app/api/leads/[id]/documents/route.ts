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
import {
  uploadLeadDocument,
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
): Promise<DocumentTarget | null> {
  const entity = entityParam === "application" ? "application" : "lead";
  if (entity === "lead") {
    const lead = await getRecord({ tenant_id: tenantId, entity: "lead", id }).catch(() => null);
    if (!lead) return null;
    return { documentLeadId: id, stageLeadId: id, entity };
  }

  const application = await getRecord({
    tenant_id: tenantId,
    entity: "application",
    id,
  }).catch(() => null);
  if (!application) return null;

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
