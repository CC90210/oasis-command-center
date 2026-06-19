/**
 * POST /api/forms/upload-url
 *
 * Mint a short-lived Supabase signed UPLOAD url for a public-form file field,
 * scoped to the authenticated lead's storage prefix. Lets the browser PUT large
 * files (bank statements up to 25 MB, 6-12 of them) straight to Storage instead
 * of base64-inlining them through /api/forms/submit — which is capped by the
 * Vercel request-body limit and could never carry 12 × 25 MB.
 *
 * Security model (mirrors the submit route's trust boundary):
 *   - Auth is the same HMAC form token (verifyFormLink) the submit route uses.
 *   - The storage path is built SERVER-SIDE from the VERIFIED token's
 *     tenant_id + lead_id (never client input), so a client can only ever get a
 *     signed URL for its OWN lead's prefix `${tenant_id}/${lead_id}/...`.
 *   - The submit route re-validates that every registered descriptor's path is
 *     inside that prefix AND that the object actually exists (lib/lead-documents
 *     registerLeadDocument), so a forged descriptor is rejected there too.
 *
 * Body:  { token, filename, mime_type, size_bytes }
 * Reply: { ok, storage_path, signed_url }
 */

import { NextRequest, NextResponse } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { verifyFormLink } from "@/lib/form-links";
import { rateLimit } from "@/lib/rate-limit";
import { LEAD_DOC_BUCKET, MAX_LEAD_DOC_BYTES } from "@/lib/lead-documents";
import { sanitizeStorageFilename } from "@/lib/storage-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Coarse gate at the mint step; the submit route enforces the field's exact
// accept[] list when it registers the object. Keep in sync with the prospect-
// facing accept set on the bank-statement fields (PDF + phone-photo formats).
const ALLOWED_MIME = new Set<string>([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/heic",
  "image/heif",
]);

type Body = {
  token?: string;
  filename?: string;
  mime_type?: string;
  size_bytes?: number;
};

export async function POST(req: NextRequest) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  if (!body.token) {
    return NextResponse.json({ ok: false, error: "missing_token" }, { status: 400 });
  }
  const sig = verifyFormLink(body.token);
  if (!sig.ok) {
    return NextResponse.json(
      { ok: false, error: `token_${sig.reason}` },
      { status: sig.reason === "server_misconfigured" ? 503 : 400 },
    );
  }
  const link = sig.payload;

  // Per-lead rate limit. 6-12 statements + the odd retry → 40/min is generous
  // for a human but bounds a script minting unbounded signed URLs.
  const limit = rateLimit({
    key: `forms-upload-url:${link.lead_id}:${link.form_id}`,
    capacity: 40,
    refillPerSec: 40 / 60,
  });
  if (!limit.allowed) {
    return NextResponse.json(
      { ok: false, error: "rate_limited", retry_in_sec: limit.resetIn },
      { status: 429 },
    );
  }

  const filename = typeof body.filename === "string" ? body.filename.trim() : "";
  const mime = typeof body.mime_type === "string" ? body.mime_type : "";
  const size = typeof body.size_bytes === "number" ? body.size_bytes : 0;
  if (!filename) {
    return NextResponse.json({ ok: false, error: "missing_filename" }, { status: 400 });
  }
  if (!ALLOWED_MIME.has(mime)) {
    return NextResponse.json({ ok: false, error: "mime_not_allowed" }, { status: 400 });
  }
  if (size <= 0 || size > MAX_LEAD_DOC_BYTES) {
    return NextResponse.json(
      { ok: false, error: "file_too_large", max_bytes: MAX_LEAD_DOC_BYTES },
      { status: 400 },
    );
  }

  const db = getServiceSupabase();

  // Resolve the form's tenant_id (uuid) + confirm the token's tenant slug maps
  // to it — defeats tenant-id forgery via a leaked token (same check the submit
  // route runs).
  const formRow = await db
    .from("forms")
    .select("id, tenant_id, enabled, tenant:tenants!inner(slug)")
    .eq("id", link.form_id)
    .maybeSingle();
  if (formRow.error || !formRow.data) {
    return NextResponse.json({ ok: false, error: "form_not_found" }, { status: 404 });
  }
  const form = formRow.data as {
    id: string;
    tenant_id: string;
    enabled: boolean;
    tenant: { slug: string } | { slug: string }[] | null;
  };
  if (!form.enabled) {
    return NextResponse.json({ ok: false, error: "form_disabled" }, { status: 400 });
  }
  const tenantRow = Array.isArray(form.tenant) ? form.tenant[0] : form.tenant;
  if (!tenantRow || tenantRow.slug !== link.tenant) {
    return NextResponse.json({ ok: false, error: "tenant_mismatch" }, { status: 400 });
  }

  // Path is built from the VERIFIED token — same shape uploadLeadDocument uses
  // so direct-to-Storage and inline uploads land identically.
  const storagePath = `${form.tenant_id}/${link.lead_id}/${Date.now()}_${sanitizeStorageFilename(filename)}`;

  const signed = await db.storage.from(LEAD_DOC_BUCKET).createSignedUploadUrl(storagePath);
  if (signed.error || !signed.data) {
    return NextResponse.json(
      { ok: false, error: `sign_failed: ${signed.error?.message || "unknown"}` },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    storage_path: signed.data.path,
    signed_url: signed.data.signedUrl,
  });
}
