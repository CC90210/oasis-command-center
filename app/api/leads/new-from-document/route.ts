/**
 * POST /api/leads/new-from-document — "new deal from a dropped application".
 * We upload the doc to a tenant-scoped PENDING storage path and QUEUE an
 * extraction job with lead_id=null — we do NOT create a lead or call the
 * Anthropic API here. The VPS daemon reads the doc with the Claude Code CLI on
 * CC's subscription; the apply callback (/api/internal/apply-extraction) then
 * CREATES the lead + application from the extracted fields and files the doc to
 * the new lead. So a lead exists ONLY after extraction succeeds — no orphan
 * "reading" stub, no merchant drip on a blank-identity lead (Codex 2026-06-26).
 *
 * The dropzone polls /api/extraction-jobs/[job_id] and redirects to the created
 * application when it lands.
 *
 * Static segment — Next resolves this before the sibling [id] dynamic route.
 * Auth: session + member+ (read-only denied); fail closed. Multipart: { file }.
 */

import { NextResponse, type NextRequest } from "next/server";
import { resolveSessionContext } from "@/lib/api-auth";
import { isReadOnlyRole } from "@/lib/role-gates";
import { MAX_LEAD_DOC_BYTES, LEAD_DOC_BUCKET } from "@/lib/lead-documents";
import { sanitizeStorageFilename } from "@/lib/storage-helpers";
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

  const db = getServiceSupabase();

  // 1) Upload to a PENDING tenant path (no lead, no lead_documents row yet). The
  //    callback files the real doc to the created lead, then deletes this object.
  const cleanName = sanitizeStorageFilename(f.name);
  const pendingPath = `${sess.tenantId}/_extraction_pending/${Date.now()}_${cleanName}`;
  const upload = await db.storage
    .from(LEAD_DOC_BUCKET)
    .upload(pendingPath, bytes, { contentType: mime, upsert: false });
  if (upload.error) {
    return NextResponse.json({ ok: false, error: "upload_failed", detail: upload.error.message }, { status: 502 });
  }

  // 2) Queue the extraction job (lead_id null — created on apply).
  const ins = await db
    .from("document_extraction_jobs")
    .insert({
      tenant_id: sess.tenantId,
      lead_id: null,
      storage_path: pendingPath,
      mime_type: mime,
      source: "new_from_document",
      assigned_to: sess.userId,
      uploaded_by: sess.email || "operator",
      status: "queued",
    })
    .select("id")
    .single();
  if (ins.error) {
    // Clean up the orphaned blob so a failed queue doesn't leak storage.
    await db.storage.from(LEAD_DOC_BUCKET).remove([pendingPath]).catch(() => {});
    return NextResponse.json({ ok: false, error: "queue_failed", detail: ins.error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, queued: true, job_id: ins.data.id });
}
