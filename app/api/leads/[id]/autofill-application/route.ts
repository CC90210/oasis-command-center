/**
 * POST /api/leads/[id]/autofill-application — drop an application document onto
 * an EXISTING lead. Claude extracts the fields, they're whitelisted + normalized,
 * and the lead's application is created/filled. The original file is kept as the
 * `application` doc and the formatted PDF is regenerated.
 *
 * Auth: owner-or-admin OR the owning agent (getAccessibleLead); read-only denied;
 * fail closed. Multipart: { file }.
 */

import { NextResponse, type NextRequest } from "next/server";
import { resolveSessionContext } from "@/lib/api-auth";
import { getAccessibleLead } from "@/lib/lead-access";
import { isReadOnlyRole } from "@/lib/role-gates";
import { extractApplicationFields } from "@/lib/ai-document-extractor";
import { applyExtractedApplication } from "@/lib/applications/apply-extracted";
import { MAX_LEAD_DOC_BYTES } from "@/lib/lead-documents";
import { cropSignatureFromDocument, toPngDataUri } from "@/lib/forms/signature-crop";

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

  const ext = await extractApplicationFields(bytes, mime);
  if (!ext.ok) {
    return NextResponse.json({ ok: false, error: "extract_failed", detail: ext.error }, { status: 502 });
  }
  const applied = await applyExtractedApplication({
    tenantId: sess.tenantId,
    leadId: id,
    rawFields: ext.fields,
    assignedTo: typeof lead.data.assigned_to === "string" ? lead.data.assigned_to : null,
    originalFile: { bytes, filename: f.name, mimeType: mime },
    uploadedBy: sess.email || "operator",
  });
  if (!applied.ok) {
    return NextResponse.json({ ok: false, error: "apply_failed", detail: applied.error }, { status: 500 });
  }
  // Best-effort signature extraction (CC-approved visual reproduction): when
  // Claude located a signature, crop it server-side so the operator can CONFIRM
  // it before it lands on the legal PDF. Never fails the autofill — a bad crop
  // just yields no preview, and the operator falls back to the signature pad.
  // (_signature is a UI hint only; applyExtractedApplication whitelists fields,
  // so it's never written as an application field.)
  let signaturePreview: string | null = null;
  let signatureBox: { x: number; y: number; width: number; height: number; page: number } | null = null;
  const sig = ext.fields._signature;
  if (sig && typeof sig === "object" && (sig as Record<string, unknown>).present === true) {
    const s = sig as { page?: unknown; bbox?: unknown };
    const arr = Array.isArray(s.bbox) ? s.bbox : [];
    const bbox =
      arr.length === 4 && arr.every((n) => typeof n === "number" && Number.isFinite(n))
        ? { x: arr[0] as number, y: arr[1] as number, width: arr[2] as number, height: arr[3] as number }
        : null;
    if (bbox) {
      const page = typeof s.page === "number" && s.page > 0 ? s.page : 1;
      const crop = await cropSignatureFromDocument({ bytes, mimeType: mime, bbox, page });
      if (crop.ok) {
        signaturePreview = toPngDataUri(crop.pngBase64);
        signatureBox = { ...bbox, page };
      }
    }
  }

  return NextResponse.json({
    ok: true,
    application_id: applied.applicationId,
    applied_keys: applied.appliedKeys,
    // The cropped signature (PNG data-URI) for the operator to confirm, plus the
    // box it came from (so the UI can offer a re-crop). Null when none found.
    signature_preview: signaturePreview,
    signature_box: signatureBox,
  });
}
