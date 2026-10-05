/**
 * POST /api/internal/extraction-doc-url — hand the VPS extraction daemon a
 * short-lived, single-object URL for the document it is about to read.
 *
 * WHY THIS EXISTS (2026-08-26 outage). Dropping an application into the SunBiz
 * pipeline stopped working at the 2026-08-08/09 Turso/R2 cutover and nobody
 * noticed until a rep reported it three weeks later. The dashboard writes the
 * dropped PDF to Cloudflare R2 (it holds R2 credentials on Vercel); the VPS
 * extraction daemon then has to read those bytes back. Its half of the cutover
 * was never provisioned. Verified live on the box, all three missing:
 *   - no R2 credentials (turso_vps_bundle.py ships only the two Turso keys),
 *   - no boto3, which the daemon's r2_storage._s3() requires,
 *   - no scripts/etl_storage_to_r2.py, which r2_storage._creds() imports to
 *     resolve aliased key names. That file DOES exist on CEO-Agent origin/main
 *     (added 2026-08-11) — the VPS checkout simply froze before it landed.
 * Every drop failed with a bare "download_failed" and nothing alerted.
 *
 * The obvious repair — deploy the missing file and put R2 keys on the VPS —
 * hands a box running eighteen other processes a standing account-wide
 * credential for a bucket holding 4,088 merchant bank statements, to solve
 * "read one PDF you already queued". So instead the side that legitimately
 * holds the credential mints a URL scoped to ONE object that expires in five
 * minutes, and the daemon fetches it over plain HTTPS with no S3 client at all.
 *
 * SCOPE IS THE WHOLE POINT: `storage_path` is read from the JOB ROW, never from
 * the request body. A holder of the secret can therefore only read a document
 * that this app itself already queued for extraction — not an arbitrary object
 * key. That is strictly less authority than the R2 keys would have granted, and
 * it is the same trust model /api/internal/apply-extraction already uses (which
 * likewise takes tenant_id and storage_path from the row, never the caller).
 *
 * Body:   { job_id: uuid }
 * Header: x-oasis-signature: hex(HMAC_SHA256(OASIS_OUTBOUND_HMAC_SECRET, rawBody))
 * Returns { ok: true, url, expires_in } — the URL is a bearer credential for one
 * object; it is never logged, here or on the daemon.
 */

import { NextResponse, type NextRequest } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { verifyInternalHmac } from "@/lib/internal-hmac";
import { pathBelongsToTenant } from "@/lib/storage-helpers";
import { LEAD_DOC_BUCKET } from "@/lib/lead-documents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = 4_096; // one uuid; anything larger is not this caller
/** Long enough for a slow multi-megabyte read, short enough that a URL leaked
 *  into a log is not a standing grant. The daemon fetches within a second. */
const URL_TTL_SEC = 300;

export async function POST(req: NextRequest) {
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) {
    return NextResponse.json({ ok: false, error: "payload_too_large" }, { status: 413 });
  }
  if (!verifyInternalHmac(raw, req.headers.get("x-oasis-signature"))) {
    return NextResponse.json({ ok: false, error: "bad_signature" }, { status: 401 });
  }

  let body: { job_id?: unknown };
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  const jobId = typeof body.job_id === "string" ? body.job_id.trim() : "";
  if (!UUID_RE.test(jobId)) {
    return NextResponse.json({ ok: false, error: "invalid_job_id" }, { status: 400 });
  }

  const db = getServiceSupabase();
  const job = await db
    .from("document_extraction_jobs")
    .select("id, tenant_id, storage_path")
    .eq("id", jobId)
    .maybeSingle();
  if (job.error) {
    return NextResponse.json(
      { ok: false, error: "job_lookup_failed", detail: job.error.message },
      { status: 500 },
    );
  }
  if (!job.data) {
    return NextResponse.json({ ok: false, error: "job_not_found" }, { status: 404 });
  }

  const tenantId = String(job.data.tenant_id || "");
  const storagePath = String(job.data.storage_path || "");
  if (!tenantId || !storagePath) {
    return NextResponse.json({ ok: false, error: "job_missing_path" }, { status: 409 });
  }

  /**
   * Defense in depth. Every path this app writes is `<tenant_id>/...` (see
   * new-from-document and lead-documents). Re-asserting it here means a job row
   * that somehow carried a foreign path — a future bug, a bad migration, a
   * tampered write — cannot be turned into a signed URL for another tenant's
   * documents. The check costs nothing and closes the only way this endpoint
   * could ever cross a tenant boundary. Proven by tests/extraction-doc-url-guard.test.ts.
   */
  if (!pathBelongsToTenant(tenantId, storagePath)) {
    return NextResponse.json({ ok: false, error: "path_outside_tenant" }, { status: 409 });
  }

  const signed = await db.storage.from(LEAD_DOC_BUCKET).createSignedUrl(storagePath, URL_TTL_SEC);
  if (signed.error || !signed.data?.signedUrl) {
    // Fail closed and NAME the reason. A generic error here is what turned the
    // original outage into three weeks of silence.
    return NextResponse.json(
      { ok: false, error: "presign_failed", detail: signed.error?.message || "no_signed_url" },
      { status: 502 },
    );
  }

  return NextResponse.json({ ok: true, url: signed.data.signedUrl, expires_in: URL_TTL_SEC });
}
