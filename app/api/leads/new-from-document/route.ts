/**
 * POST /api/leads/new-from-document — "new deal from a dropped application".
 * Claude extracts the fields from the uploaded application document; a fresh lead
 * + application are created and populated. The original file is kept as the
 * `application` doc and the formatted PDF is generated. The new deal is assigned
 * to the creating operator.
 *
 * Static segment — Next resolves this before the sibling [id] dynamic route.
 * Auth: session + member+ (read-only denied); fail closed. Multipart: { file }.
 */

import { NextResponse, type NextRequest } from "next/server";
import { resolveSessionContext } from "@/lib/api-auth";
import { isReadOnlyRole } from "@/lib/role-gates";
import { extractApplicationFields } from "@/lib/ai-document-extractor";
import { applyExtractedApplication } from "@/lib/applications/apply-extracted";
import { MAX_LEAD_DOC_BYTES } from "@/lib/lead-documents";

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

  const ext = await extractApplicationFields(bytes, mime);
  if (!ext.ok) {
    return NextResponse.json({ ok: false, error: "extract_failed", detail: ext.error }, { status: 502 });
  }
  const applied = await applyExtractedApplication({
    tenantId: sess.tenantId,
    leadId: null,
    rawFields: ext.fields,
    assignedTo: sess.userId,
    originalFile: { bytes, filename: f.name, mimeType: mime },
    uploadedBy: sess.email || "operator",
  });
  if (!applied.ok) {
    return NextResponse.json({ ok: false, error: "apply_failed", detail: applied.error }, { status: 500 });
  }
  return NextResponse.json({
    ok: true,
    lead_id: applied.leadId,
    application_id: applied.applicationId,
    applied_keys: applied.appliedKeys,
  });
}
