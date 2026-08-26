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
import { getServiceSupabase } from "@/lib/supabase-server";
import { verifyInternalHmac } from "@/lib/internal-hmac";
import { pathBelongsToTenant } from "@/lib/storage-helpers";
import { applyExtractedApplication } from "@/lib/applications/apply-extracted";
import { cropSignatureFromDocument, toPngDataUri } from "@/lib/forms/signature-crop";
import { LEAD_DOC_BUCKET } from "@/lib/lead-documents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = 512_000; // fields JSON is small; generous ceiling

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
  if (!verifyInternalHmac(raw, req.headers.get("x-oasis-signature"))) {
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

  // 2) ATOMIC claim (Codex 2026-06-26): a single conditional UPDATE flips the job
  //    to `applying` and returns the row ONLY if it wasn't already applied/applying.
  //    This is a compare-and-swap — two concurrent signed callbacks can't both
  //    pass a check-then-act gate and double-apply. If no row comes back the job
  //    is already applied or in-flight, so we return idempotently. The job also
  //    carries the trusted scope (tenant_id, lead_id, storage_path) — we never
  //    take those from the body. (A crash between claim and the final mark leaves
  //    the row in `applying`, which the daemon's stale-recovery re-POSTs.)
  const claim = await db
    .from("document_extraction_jobs")
    .update({ status: "applying", updated_at: new Date().toISOString() })
    .eq("id", jobId)
    .not("status", "in", "(applied,applying)")
    .select(
      "id, tenant_id, lead_id, application_id, storage_path, mime_type, source, assigned_to, uploaded_by, status",
    );
  const claimed = (claim.data || []) as Job[];
  if (claim.error) {
    return NextResponse.json({ ok: false, error: "claim_failed", detail: claim.error.message }, { status: 500 });
  }
  if (claimed.length === 0) {
    // Either the job doesn't exist, or it's already applied / being applied by a
    // concurrent callback. Distinguish not-found (404) from already-applied (200).
    const exists = await db.from("document_extraction_jobs").select("id").eq("id", jobId).maybeSingle();
    if (!exists.data) {
      return NextResponse.json({ ok: false, error: "job_not_found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true, already_applied: true, job_id: jobId });
  }
  const job = claimed[0];
  const isNew = job.source === "new_from_document";

  // Download the doc once — needed to FILE it for the new-deal path (the lead
  // doesn't exist until apply) and/or to CROP the signature.
  //
  // The path is re-checked against the job's own tenant for the same reason the
  // sibling extraction-doc-url route does it: this reads an object key straight
  // out of a database row, and a row is not a promise. Nothing exploits this
  // today — the queue routes write `<tenant_id>/...` themselves — but a future
  // bug or bad migration that put a foreign path in the row would otherwise get
  // another tenant's merchant document filed onto this tenant's lead.
  if (!pathBelongsToTenant(job.tenant_id, job.storage_path)) {
    await db
      .from("document_extraction_jobs")
      .update({ status: "failed", error: "blocked:path_outside_tenant", updated_at: new Date().toISOString() })
      .eq("id", jobId);
    return NextResponse.json({ ok: false, error: "path_outside_tenant" }, { status: 409 });
  }
  let docBytes: Buffer | null = null;
  const dl = await db.storage.from(LEAD_DOC_BUCKET).download(job.storage_path);
  if (!dl.error && dl.data) docBytes = Buffer.from(await dl.data.arrayBuffer());
  if (isNew && !docBytes) {
    // Can't create the new deal without the doc to file. Fail the job (the row
    // is in `applying`; stale-recovery resets it to retry the download).
    await db
      .from("document_extraction_jobs")
      .update({ status: "extracted", error: "doc_download_failed", updated_at: new Date().toISOString() })
      .eq("id", jobId);
    return NextResponse.json({ ok: false, error: "doc_download_failed" }, { status: 502 });
  }

  // 3) Apply the extracted fields. For new_from_document the lead is CREATED here
  //    (at the terminal "dropped application in hand" stage, with identity filled)
  //    and the original doc is filed to it via originalFile — so no lead, no drip,
  //    no orphan ever exists before extraction succeeds. For autofill the doc was
  //    already filed, so no originalFile.
  const filename = job.storage_path.split("/").pop() || "dropped-application.pdf";
  const applied = await applyExtractedApplication({
    tenantId: job.tenant_id,
    leadId: job.lead_id,
    rawFields: fields,
    assignedTo: job.assigned_to,
    uploadedBy: job.uploaded_by || "extraction_daemon",
    originalFile: isNew && docBytes ? { bytes: docBytes, filename, mimeType: job.mime_type } : null,
  });
  if (!applied.ok) {
    await db
      .from("document_extraction_jobs")
      .update({ status: "failed", error: `apply_failed: ${applied.error}`, updated_at: new Date().toISOString() })
      .eq("id", jobId);
    return NextResponse.json({ ok: false, error: "apply_failed", detail: applied.error }, { status: 500 });
  }

  // 4) Signature (CC-approved visual reproduction + MANDATORY operator confirm):
  //    crop it server-side from the downloaded doc, but do NOT land it on the PDF
  //    yet. Stash the preview in the job result so the dropzone surfaces the
  //    confirm UI when the operator returns — the existing application-signature
  //    route lands it only after they tap "Use it".
  let signaturePreview: string | null = null;
  let signatureBox: { x: number; y: number; width: number; height: number; page: number } | null = null;
  const sb = body.signature_box;
  if (sb && typeof sb === "object" && !Array.isArray(sb) && docBytes) {
    const s = sb as Record<string, unknown>;
    const nums = ["x", "y", "width", "height"].map((k) => s[k]);
    if (nums.every((n) => typeof n === "number" && Number.isFinite(n))) {
      const bbox = { x: nums[0] as number, y: nums[1] as number, width: nums[2] as number, height: nums[3] as number };
      const page = typeof s.page === "number" && s.page > 0 ? s.page : 1;
      const crop = await cropSignatureFromDocument({ bytes: docBytes, mimeType: job.mime_type, bbox, page });
      if (crop.ok) {
        signaturePreview = toPngDataUri(crop.pngBase64);
        signatureBox = { ...bbox, page };
      }
    }
  }

  // 5) New-deal cleanup: the real doc is now filed to the created lead, so delete
  //    the pending upload (best-effort — a leaked blob is harmless, not fatal).
  if (isNew) {
    await db.storage.from(LEAD_DOC_BUCKET).remove([job.storage_path]).catch(() => {});
  }

  // 6) Mark the job applied with the result the poll route returns to the UI.
  //    Check the update result — if it errors the fields ARE applied but the row
  //    stays `applying`; return 502 so the daemon's stale-recovery re-POSTs (the
  //    apply is idempotent: createApplicationFromLead reuses, fields upsert).
  const usedFallback = body.used_fallback === true;
  const mark = await db
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
  if (mark.error) {
    return NextResponse.json(
      { ok: false, error: "mark_applied_failed", detail: mark.error.message, applied: true },
      { status: 502 },
    );
  }

  return NextResponse.json({
    ok: true,
    job_id: jobId,
    lead_id: applied.leadId,
    application_id: applied.applicationId,
    applied_keys: applied.appliedKeys,
    signature_found: !!signaturePreview,
  });
}
