/**
 * /api/leads/[id]/documents — operator-facing document management for
 * a lead. Lets the drawer's Documents tab upload + list files without
 * leaving the side panel.
 *
 *   GET  — list documents (mirrors LeadDocumentsPanel's server fetch,
 *           but consumable from a client island).
 *   POST — multipart upload. Field name `file` (required) and `doc_type`
 *           (optional, defaults to classifier 'unclassified'). Uploads
 *           to the `lead-documents` storage bucket using the same path
 *           shape the public form submit uses, then inserts a
 *           lead_documents row, then auto-progresses lead.stage from
 *           missing_info → hot_lead when all required SunBiz docs are
 *           present.
 *
 * Auth: session-cookie → tenant via resolveSessionContext.
 *
 * Storage path: tenant_id/lead_id/<epoch>_<sanitized-filename>.
 * Bucket: lead-documents (created by migration 055).
 */

import { NextResponse, type NextRequest } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { resolveSessionContext } from "@/lib/api-auth";
import { sanitizeStorageFilename } from "@/lib/storage-helpers";
import { getRecord, updateRecord } from "@/lib/manifest/data";
import { publishAgentEvent } from "@/lib/manifest/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const ALLOWED_MIME = new Set<string>([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/heic",
  "image/heif",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
  "text/csv",
]);

// SunBiz-canonical required docs. Matches the SUNBIZ_DOC_PRESETS list
// in components/forms/VisualFieldsEditor.tsx. When all three land, the
// lead is "complete" and we bump the stage forward.
const REQUIRED_DOC_TYPES = ["bank_statements_3mo", "drivers_license", "void_cheque"];

export async function GET(
  _req: NextRequest,
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
  const db = getServiceSupabase();
  const r = await db
    .from("lead_documents")
    .select("id, filename, mime_type, size_bytes, doc_type, uploaded_by, uploaded_at")
    .eq("tenant_id", sess.tenantId)
    .eq("lead_id", id)
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
  const { id: leadId } = await ctx.params;
  if (!UUID_RE.test(leadId)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }
  const sess = await resolveSessionContext();
  if (!sess.ok) {
    return NextResponse.json({ ok: false, error: sess.reason }, { status: 401 });
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
  if (fileObj.size > MAX_FILE_BYTES) {
    return NextResponse.json(
      { ok: false, error: "file_too_large", max_bytes: MAX_FILE_BYTES },
      { status: 413 },
    );
  }
  const mime = (fileObj.type || "application/octet-stream").toLowerCase();
  if (!ALLOWED_MIME.has(mime)) {
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

  const db = getServiceSupabase();
  const cleanName = sanitizeStorageFilename(fileObj.name);
  const storagePath = `${sess.tenantId}/${leadId}/${Date.now()}_${cleanName}`;

  const buffer = Buffer.from(await fileObj.arrayBuffer());
  const upload = await db.storage
    .from("lead-documents")
    .upload(storagePath, buffer, { contentType: mime, upsert: false });
  if (upload.error) {
    return NextResponse.json(
      { ok: false, error: `upload_failed: ${upload.error.message}` },
      { status: 500 },
    );
  }

  const ins = await db
    .from("lead_documents")
    .insert({
      tenant_id: sess.tenantId,
      lead_id: leadId,
      filename: cleanName,
      storage_path: storagePath,
      mime_type: mime,
      size_bytes: fileObj.size,
      doc_type: docType,
      uploaded_by: sess.email || "operator",
      metadata: {
        source: "drawer_upload",
        profile_id: sess.profileId,
      },
    })
    .select("id, filename, mime_type, size_bytes, doc_type, uploaded_by, uploaded_at")
    .single();
  if (ins.error) {
    // Best-effort cleanup of the orphaned blob.
    await db.storage.from("lead-documents").remove([storagePath]);
    return NextResponse.json(
      { ok: false, error: `metadata_insert_failed: ${ins.error.message}` },
      { status: 500 },
    );
  }

  // Auto stage progression. When all three required SunBiz docs are
  // present and the lead is currently in {imported, missing_info,
  // follow_up}, bump it to hot_lead. Skips when the operator has
  // already moved the lead past hot_lead manually.
  const stageBumped = await maybeBumpStageOnDocs({
    tenantId: sess.tenantId,
    leadId,
  });

  return NextResponse.json({
    ok: true,
    document: ins.data,
    stage_bumped: stageBumped,
  });
}

async function maybeBumpStageOnDocs(input: {
  tenantId: string;
  leadId: string;
}): Promise<string | null> {
  const db = getServiceSupabase();

  // Tally distinct doc_types this lead has on file.
  const tally = await db
    .from("lead_documents")
    .select("doc_type")
    .eq("tenant_id", input.tenantId)
    .eq("lead_id", input.leadId);
  if (tally.error || !tally.data) return null;
  const present = new Set(tally.data.map((r) => (r as { doc_type: string }).doc_type));
  const allRequired = REQUIRED_DOC_TYPES.every((t) => present.has(t));
  if (!allRequired) return null;

  const lead = await getRecord({
    tenant_id: input.tenantId,
    entity: "lead",
    id: input.leadId,
  }).catch(() => null);
  if (!lead) return null;

  const currentStage = String((lead.data as Record<string, unknown>).stage || "");
  const BUMP_FROM = new Set(["", "imported", "missing_info", "follow_up"]);
  if (!BUMP_FROM.has(currentStage)) return null;

  await updateRecord({
    tenant_id: input.tenantId,
    entity: "lead",
    id: input.leadId,
    patch: { stage: "hot_lead" },
  }).catch(() => null);

  // updateRecord emits BRAVO_RECORD_STATUS_CHANGED automatically via
  // detectStatusTransitions. Also emit an operator-visible event so
  // the timeline shows WHY the stage changed.
  await publishAgentEvent({
    eventType: "BRAVO_LEAD_AUTO_BUMPED",
    tenantId: input.tenantId,
    publisher: "dashboard",
    payload: {
      lead_id: input.leadId,
      from: currentStage || null,
      to: "hot_lead",
      reason: "all_required_docs_received",
    },
  });

  return "hot_lead";
}
