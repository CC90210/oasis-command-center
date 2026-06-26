/**
 * POST /api/internal/apply-extraction — VPS-only callback that lands the result
 * of an async document extraction onto the application.
 *
 * The flow (see database/104_document_extraction_jobs.sql): the dashboard queues
 * a document_extraction_jobs row instead of calling the Anthropic vision API; the
 * VPS daemon (extraction_consumer.py) runs the Claude Code CLI on CC's
 * subscription to extract {fields, signature_box}, then POSTs the result here.
 * This route runs the EXISTING apply pipeline — applyExtractedApplication (which
 * regenerates the branded PDF) + the server-side signature crop — so all the
 * apply/PDF logic lives in ONE place (TS) and the daemon stays a thin CLI wrapper.
 *
 * Trust boundary: there is NO Supabase session here. Auth is an HMAC-SHA256 over
 * the raw body with OASIS_OUTBOUND_HMAC_SECRET (the same shared secret the VPS
 * send_gateway uses for /api/outbound/log). A browser can never call this — only
 * a holder of the server-only secret. Idempotent on job_id.
 *
 * Body: { job_id: uuid, fields: object, signature_box?: {x,y,width,height,page} | null,
 *         used_fallback?: boolean }
 * Header: x-oasis-signature: hex(HMAC_SHA256(secret, rawBody))
 */

import { NextResponse, type NextRequest } from "next/server";
import { createHmac, timingSafeEqual } from "crypto";
import { getServiceSupabase } from "@/lib/supabase-server";
import { applyExtractedApplication } from "@/lib/applications/apply-extracted";
import { cropSignatureFromDocument, toPngDataUri } from "@/lib/forms/signature-crop";
import { LEAD_DOC_BUCKET } from "@/lib/lead-documents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = 512_000; // fields JSON is small; generous ceiling

function verifyHmac(rawBody: string, header: string | null): boolean {
  const secret = (process.env.OASIS_OUTBOUND_HMAC_SECRET || "").trim();
  if (!secret || !header) return false;
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(header.trim(), "utf8");
  // timingSafeEqual throws on length mismatch — guard so a wrong-length sig is a
  // clean false, not a 500.
  return a.length === b.length && timingSafeEqual(a, b);
}

type Job = {
  id: string;
  tenant_id: string;
  lead_id: string | null;
  application_id: string | null;
  storage_path: string;
  mime_type: string;
  source: string;
  assigned_to: string | null;
  uploaded_by: string | null;
  status: string;
};

export async function POST(req: NextRequest) {
  // 1) Read the raw body for HMAC (must hash the exact bytes the daemon signed).
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) {
    return NextResponse.json({ ok: false, error: "payload_too_large" }, { status: 413 });
  }
  if (!verifyHmac(raw, req.headers.get("x-oasis-signature"))) {
    return NextResponse.json({ ok: false, error: "bad_signature" }, { status: 401 });
  }

  let body: {
    job_id?: unknown;
    fields?: unknown;
    signature_box?: unknown;
    used_fallback?: unknown;
  };
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  const jobId = typeof body.job_id === "string" ? body.job_id.trim() : "";
  if (!UUID_RE.test(jobId)) {
    return NextResponse.json({ ok: false, error: "invalid_job_id" }, { status: 400 });
  }
  const fields =
    body.fields && typeof body.fields === "object" && !Array.isArray(body.fields)
      ? (body.fields as Record<string, unknown>)
      : null;
  if (!fields) {
    return NextResponse.json({ ok: false, error: "fields_required" }, { status: 400 });
  }

  const db = getServiceSupabase();

  // 2) Load the job (service-role). The job carries the trusted scope
  //    (tenant_id, lead_id, storage_path) — we DON'T take those from the body.
  const jobRes = await db
    .from("document_extraction_jobs")
    .select(
      "id, tenant_id, lead_id, application_id, storage_path, mime_type, source, assigned_to, uploaded_by, status",
    )
    .eq("id", jobId)
    .maybeSingle();
  const job = jobRes.data as Job | null;
  if (!job) {
    return NextResponse.json({ ok: false, error: "job_not_found" }, { status: 404 });
  }
  // Idempotency: a retried callback (network blip) must not double-apply.
  if (job.status === "applied") {
    return NextResponse.json({ ok: true, already_applied: true, job_id: jobId });
  }

  // 3) Apply the extracted fields onto the application (creates the lead for the
  //    new_from_document path) + regenerate the branded PDF. The original doc was
  //    already filed at queue time, so no originalFile here.
  const applied = await applyExtractedApplication({
    tenantId: job.tenant_id,
    leadId: job.lead_id,
    rawFields: fields,
    assignedTo: job.assigned_to,
    uploadedBy: job.uploaded_by || "extraction_daemon",
  });
  if (!applied.ok) {
    await db
      .from("document_extraction_jobs")
      .update({ status: "failed", error: `apply_failed: ${applied.error}`, updated_at: new Date().toISOString() })
      .eq("id", jobId);
    return NextResponse.json({ ok: false, error: "apply_failed", detail: applied.error }, { status: 500 });
  }

  // 4) Signature (CC-approved visual reproduction + MANDATORY operator confirm):
  //    crop it server-side from the stored doc, but do NOT land it on the PDF
  //    yet. Stash the preview in the job result so the dropzone surfaces the
  //    confirm UI when the operator returns — the existing application-signature
  //    route lands it only after they tap "Use it".
  let signaturePreview: string | null = null;
  let signatureBox: { x: number; y: number; width: number; height: number; page: number } | null = null;
  const sb = body.signature_box;
  if (sb && typeof sb === "object" && !Array.isArray(sb)) {
    const s = sb as Record<string, unknown>;
    const nums = ["x", "y", "width", "height"].map((k) => s[k]);
    if (nums.every((n) => typeof n === "number" && Number.isFinite(n))) {
      const bbox = { x: nums[0] as number, y: nums[1] as number, width: nums[2] as number, height: nums[3] as number };
      const page = typeof s.page === "number" && s.page > 0 ? s.page : 1;
      const dl = await db.storage.from(LEAD_DOC_BUCKET).download(job.storage_path);
      if (!dl.error && dl.data) {
        const bytes = Buffer.from(await dl.data.arrayBuffer());
        const crop = await cropSignatureFromDocument({ bytes, mimeType: job.mime_type, bbox, page });
        if (crop.ok) {
          signaturePreview = toPngDataUri(crop.pngBase64);
          signatureBox = { ...bbox, page };
        }
      }
    }
  }

  // 5) Mark the job applied with the result the poll route returns to the UI.
  const usedFallback = body.used_fallback === true;
  await db
    .from("document_extraction_jobs")
    .update({
      status: "applied",
      application_id: applied.applicationId,
      lead_id: applied.leadId,
      used_fallback: usedFallback,
      result_json: {
        applied_keys: applied.appliedKeys,
        application_id: applied.applicationId,
        lead_id: applied.leadId,
        created_lead: applied.createdLead,
        signature_preview: signaturePreview,
        signature_box: signatureBox,
        used_fallback: usedFallback,
      },
      error: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", jobId);

  return NextResponse.json({
    ok: true,
    job_id: jobId,
    lead_id: applied.leadId,
    application_id: applied.applicationId,
    applied_keys: applied.appliedKeys,
    signature_found: !!signaturePreview,
  });
}
