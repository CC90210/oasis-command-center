/**
 * /api/esign/envelopes — create + list e-signature envelopes.
 *
 *   POST — accepts a base64 PDF (new source document) OR a `sourceDocumentId`
 *          pointing at an existing lead_documents row (use-case B: sign an
 *          already-uploaded application/other PDF). Mints one signing token
 *          per signer, creates the envelope + signer rows in `draft` status
 *          (no email is sent here — POST .../send fires it).
 *   GET  — tenant-scoped list with per-signer status for the console table.
 *
 * Auth: session-cookie via resolveSessionContext (lib/api-auth.ts:71),
 * scoped by tenantId on every query — this is a MANAGEMENT route, not the
 * public signer-facing /api/sign/[token].
 */

import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { resolveSessionContext } from "@/lib/api-auth";
import { loadSourcePdf, sha256OfBytes } from "@/lib/esign/pdf";
import { uploadEsignSourcePdf, loadExistingLeadDocumentAsSource } from "@/lib/esign/storage";
import { createEnvelope, createSigners, listEnvelopes, logEvent } from "@/lib/esign/db";
import { mintSigningToken } from "@/lib/esign/tokens";
import { canAccessSharedTenantResource } from "@/lib/shared-tenant-resource-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_PDF_BYTES = 25 * 1024 * 1024;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DEFAULT_EXPIRY_DAYS = 30;

type SignerInput = { email: string; name: string; order?: number };

export async function GET() {
  const sess = await resolveSessionContext();
  if (!sess.ok) return NextResponse.json({ ok: false, error: sess.reason }, { status: 401 });
  if (!(await canAccessSharedTenantResource(sess))) return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });

  const res = await listEnvelopes(sess.tenantId);
  if (!res.ok) return NextResponse.json({ ok: false, error: res.error }, { status: 500 });
  return NextResponse.json({ ok: true, envelopes: res.envelopes });
}

export async function POST(req: NextRequest) {
  const sess = await resolveSessionContext();
  if (!sess.ok) return NextResponse.json({ ok: false, error: sess.reason }, { status: 401 });
  if (!(await canAccessSharedTenantResource(sess))) return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });

  let body: {
    title?: unknown;
    message?: unknown;
    leadId?: unknown;
    applicationId?: unknown;
    sourceDocumentId?: unknown;
    pdfBase64?: unknown;
    filename?: unknown;
    signers?: unknown;
    expiresInDays?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const title = typeof body.title === "string" ? body.title.trim().slice(0, 200) : "";
  if (!title) return NextResponse.json({ ok: false, error: "title_required" }, { status: 400 });

  const rawSigners = Array.isArray(body.signers) ? body.signers : [];
  const signers: SignerInput[] = [];
  for (const s of rawSigners as unknown[]) {
    if (!s || typeof s !== "object") continue;
    const email = typeof (s as Record<string, unknown>).email === "string" ? (s as Record<string, unknown>).email as string : "";
    const name = typeof (s as Record<string, unknown>).name === "string" ? (s as Record<string, unknown>).name as string : "";
    const order = typeof (s as Record<string, unknown>).order === "number" ? (s as Record<string, unknown>).order as number : signers.length + 1;
    const cleanEmail = email.trim().toLowerCase();
    if (!EMAIL_RE.test(cleanEmail) || !name.trim()) continue;
    signers.push({ email: cleanEmail, name: name.trim().slice(0, 200), order });
  }
  if (signers.length === 0) {
    return NextResponse.json({ ok: false, error: "at_least_one_valid_signer_required" }, { status: 400 });
  }

  const leadId = typeof body.leadId === "string" && body.leadId.trim() ? body.leadId.trim() : null;
  const applicationId = typeof body.applicationId === "string" && body.applicationId.trim() ? body.applicationId.trim() : null;
  const sourceDocumentId = typeof body.sourceDocumentId === "string" && body.sourceDocumentId.trim() ? body.sourceDocumentId.trim() : null;
  const message = typeof body.message === "string" && body.message.trim() ? body.message.trim().slice(0, 2000) : null;
  const expiresInDays =
    typeof body.expiresInDays === "number" && Number.isFinite(body.expiresInDays) && body.expiresInDays > 0
      ? Math.min(body.expiresInDays, 365)
      : DEFAULT_EXPIRY_DAYS;

  // Resolve the source PDF bytes — either an existing lead document or a
  // fresh base64 upload. Fail closed: exactly one must resolve to real bytes.
  let sourceBytes: Buffer;
  let sourceFilename: string;
  let existingDocumentId: string | null = null;

  if (sourceDocumentId) {
    const existing = await loadExistingLeadDocumentAsSource(sess.tenantId, sourceDocumentId);
    if (!existing.ok) {
      return NextResponse.json({ ok: false, error: "source_document_not_found" }, { status: 404 });
    }
    sourceBytes = existing.bytes;
    sourceFilename = existing.filename;
    existingDocumentId = sourceDocumentId;
  } else if (typeof body.pdfBase64 === "string" && body.pdfBase64.trim()) {
    const raw = body.pdfBase64.includes(",") ? body.pdfBase64.split(",").slice(1).join(",") : body.pdfBase64;
    try {
      sourceBytes = Buffer.from(raw, "base64");
    } catch {
      return NextResponse.json({ ok: false, error: "invalid_pdf_base64" }, { status: 400 });
    }
    if (sourceBytes.length === 0) {
      return NextResponse.json({ ok: false, error: "empty_pdf" }, { status: 400 });
    }
    if (sourceBytes.length > MAX_PDF_BYTES) {
      return NextResponse.json({ ok: false, error: "pdf_too_large" }, { status: 413 });
    }
    sourceFilename = typeof body.filename === "string" && body.filename.trim() ? body.filename.trim() : "document.pdf";
  } else {
    return NextResponse.json({ ok: false, error: "pdfBase64_or_sourceDocumentId_required" }, { status: 400 });
  }

  const loaded = await loadSourcePdf(sourceBytes);
  if (!loaded.ok) {
    return NextResponse.json({ ok: false, error: "invalid_pdf" }, { status: 400 });
  }

  const envelopeId = randomUUID();
  const sourceSha256 = sha256OfBytes(sourceBytes);

  const upload = await uploadEsignSourcePdf({
    tenantId: sess.tenantId,
    envelopeId,
    filename: sourceFilename,
    bytes: sourceBytes,
    mimeType: "application/pdf",
  });
  if (!upload.ok) {
    return NextResponse.json({ ok: false, error: "source_upload_failed" }, { status: 500 });
  }

  const envRes = await createEnvelope({
    id: envelopeId,
    tenantId: sess.tenantId,
    createdBy: sess.userId,
    title,
    sourceStorageKey: upload.storagePath,
    sourceDocumentId: existingDocumentId,
    sourcePdfSha256: sourceSha256,
    leadId,
    applicationId,
    message,
  });
  if (!envRes.ok) {
    return NextResponse.json({ ok: false, error: "envelope_create_failed" }, { status: 500 });
  }

  const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString();
  const signerRows = signers.map((s) => {
    const token = mintSigningToken();
    return { email: s.email, name: s.name, signOrder: s.order || 1, tokenSha256: token.sha256, expiresAt };
  });
  const signersRes = await createSigners(envelopeId, sess.tenantId, signerRows);
  if (!signersRes.ok) {
    return NextResponse.json({ ok: false, error: "signers_create_failed" }, { status: 500 });
  }

  await logEvent({
    envelopeId,
    tenantId: sess.tenantId,
    event: "created",
    actor: `operator:${sess.userId}`,
    meta: { signer_count: signers.length },
  });

  return NextResponse.json({
    ok: true,
    envelope: envRes.envelope,
    signers: signersRes.signers.map((s) => ({ id: s.id, email: s.email, name: s.name, status: s.status })),
  });
}
