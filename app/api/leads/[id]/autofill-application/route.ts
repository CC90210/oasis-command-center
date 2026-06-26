/**
 * POST /api/leads/[id]/autofill-application — drop an application document onto
 * an EXISTING lead. We file the original as the `application` doc and QUEUE an
 * extraction job — we do NOT call the Anthropic vision API here. A VPS daemon
 * (extraction_consumer.py) reads the doc with the Claude Code CLI on CC's
 * subscription, then POSTs the fields + signature back to
 * /api/internal/apply-extraction, which fills the application + regenerates the
 * PDF. The dropzone polls /api/extraction-jobs/[job_id] for the result.
 * (Cost: extraction moved off the metered API onto the flat-rate subscription.)
 *
 * Auth: owner-or-admin OR the owning agent (getAccessibleLead); read-only denied;
 * fail closed. Multipart: { file }.
 */

import { NextResponse, type NextRequest } from "next/server";
import { resolveSessionContext } from "@/lib/api-auth";
import { getAccessibleLead } from "@/lib/lead-access";
import { isReadOnlyRole } from "@/lib/role-gates";
import { MAX_LEAD_DOC_BYTES, uploadLeadDocument } from "@/lib/lead-documents";
import { getServiceSupabase } from "@/lib/supabase-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOWED = new Set(["application/pdf", "image/png", "image/jpeg", "image/webp", "image/gif"]);

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }
  const sess = await resolveSessionContext();
  if (!sess.ok) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (isReadOnlyRole(sess.teamRole)) {
    return NextResponse.json({ ok: false, error: "forbidden_role" }, { status: 403 });
  }
  const lead = await getAccessibleLead(
    { isAdmin: sess.isAdmin, userId: sess.userId },
    { tenantId: sess.tenantId, entity: "lead", id },
  );
  if (!lead) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });

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
  const f = file as File;
  if (f.size === 0) return NextResponse.json({ ok: false, error: "empty_file" }, { status: 400 });
  if (f.size > MAX_LEAD_DOC_BYTES) {
    return NextResponse.json({ ok: false, error: "file_too_large", max_bytes: MAX_LEAD_DOC_BYTES }, { status: 413 });
  }
  const mime = (f.type || "application/octet-stream").toLowerCase().split(";")[0].trim();
  if (!ALLOWED.has(mime)) {
    return NextResponse.json({ ok: false, error: "unsupported_type", mime }, { status: 415 });
  }
  const bytes = Buffer.from(await f.arrayBuffer());

  // 1) File the original as the `application` doc (the real, possibly-signed app).
  //    The daemon downloads it from storage to extract; it's also kept as the doc.
  const up = await uploadLeadDocument({
    tenantId: sess.tenantId,
    leadId: id,
    filename: f.name,
    mimeType: mime,
    bytes,
    sizeBytes: bytes.length,
    docType: "application",
    uploadedBy: sess.email || "operator",
    source: "dropped_application_autofill",
    extraMetadata: { autofill: true },
  });
  if (!up.ok) {
    return NextResponse.json({ ok: false, error: "upload_failed", detail: up.error }, { status: 502 });
  }

  // 2) Queue the extraction job. The VPS daemon picks it up (subscription CLI).
  const db = getServiceSupabase();
  const ins = await db
    .from("document_extraction_jobs")
    .insert({
      tenant_id: sess.tenantId,
      lead_id: id,
      lead_document_id: up.document.id,
      storage_path: up.document.storage_path,
      mime_type: mime,
      source: "autofill",
      assigned_to: typeof lead.data.assigned_to === "string" ? lead.data.assigned_to : null,
      uploaded_by: sess.email || "operator",
      status: "queued",
    })
    .select("id")
    .single();
  if (ins.error) {
    return NextResponse.json({ ok: false, error: "queue_failed", detail: ins.error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, queued: true, job_id: ins.data.id });
}
