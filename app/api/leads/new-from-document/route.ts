/**
 * POST /api/leads/new-from-document — "new deal from a dropped application".
 * We create a stub lead, file the original as the `application` doc, and QUEUE an
 * extraction job — we do NOT call the Anthropic vision API here. The VPS daemon
 * (extraction_consumer.py) reads the doc with the Claude Code CLI on CC's
 * subscription, POSTs the fields back to /api/internal/apply-extraction, which
 * backfills the stub lead's identity + creates the application + PDF. The dropzone
 * polls /api/extraction-jobs/[job_id].
 *
 * The stub lead is created with EMPTY identity fields so applyExtractedApplication
 * backfills them (its existing-lead branch only fills gaps, never clobbers). It
 * carries data.extraction_status="reading" so the board/drawer can show progress.
 *
 * Static segment — Next resolves this before the sibling [id] dynamic route.
 * Auth: session + member+ (read-only denied); fail closed. Multipart: { file }.
 */

import { NextResponse, type NextRequest } from "next/server";
import { resolveSessionContext } from "@/lib/api-auth";
import { isReadOnlyRole } from "@/lib/role-gates";
import { MAX_LEAD_DOC_BYTES, uploadLeadDocument } from "@/lib/lead-documents";
import { createRecord } from "@/lib/manifest/data";
import { getServiceSupabase } from "@/lib/supabase-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED = new Set(["application/pdf", "image/png", "image/jpeg", "image/webp", "image/gif"]);

export async function POST(req: NextRequest) {
  const sess = await resolveSessionContext();
  if (!sess.ok) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (isReadOnlyRole(sess.teamRole)) {
    return NextResponse.json({ ok: false, error: "forbidden_role" }, { status: 403 });
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

  // 1) Stub lead (empty identity → apply backfills it; reading flag for the UI).
  const stub = await createRecord({
    tenant_id: sess.tenantId,
    entity: "lead",
    data: {
      source: "dropped_application",
      stage: "signed_application",
      assigned_to: sess.userId,
      business_name: "",
      extraction_status: "reading",
    },
  });

  // 2) File the original as the application doc on the stub lead.
  const up = await uploadLeadDocument({
    tenantId: sess.tenantId,
    leadId: stub.id,
    filename: f.name,
    mimeType: mime,
    bytes,
    sizeBytes: bytes.length,
    docType: "application",
    uploadedBy: sess.email || "operator",
    source: "dropped_application_new_deal",
    extraMetadata: { autofill: true },
  });
  if (!up.ok) {
    return NextResponse.json({ ok: false, error: "upload_failed", detail: up.error }, { status: 502 });
  }

  // 3) Queue the extraction job.
  const db = getServiceSupabase();
  const ins = await db
    .from("document_extraction_jobs")
    .insert({
      tenant_id: sess.tenantId,
      lead_id: stub.id,
      lead_document_id: up.document.id,
      storage_path: up.document.storage_path,
      mime_type: mime,
      source: "new_from_document",
      assigned_to: sess.userId,
      uploaded_by: sess.email || "operator",
      status: "queued",
    })
    .select("id")
    .single();
  if (ins.error) {
    return NextResponse.json({ ok: false, error: "queue_failed", detail: ins.error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, queued: true, job_id: ins.data.id, lead_id: stub.id });
}
