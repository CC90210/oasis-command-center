/**
 * /api/sign/[token] — the public, unauthenticated signing surface.
 *
 * NO session cookie — the 32-byte token IS the auth boundary (mirrors the
 * /f/ public-form model, lib/forms/public-resolver.ts). Fail-closed on
 * every non-happy-path: a bad, expired, already-consumed, or otherwise
 * unusable token collapses to ONE generic response so a prober can never
 * learn WHICH condition failed (no enumeration oracle) — token guessing is
 * already infeasible at 32 bytes of entropy, but this keeps the response
 * surface uniform regardless.
 *
 *   GET  — validate token, log 'viewed', return envelope + source PDF.
 *   POST — validate consent + token, record the signature, and — if every
 *          signer on the envelope is now signed — assemble the final
 *          signed PDF (lib/esign/pdf.ts) and complete the envelope.
 */

import { NextResponse, type NextRequest } from "next/server";
import { getClientIp } from "@/lib/api-helpers";
import { rateLimit } from "@/lib/rate-limit";
import { hashIncomingToken } from "@/lib/esign/tokens";
import {
  getSignerByTokenHash,
  markSignerSigned,
  markSignerDeclined,
  updateEnvelopeStatus,
  getAllSignersForEnvelope,
  saveSignatureField,
  getSignatureFieldsForEnvelope,
  logEvent,
} from "@/lib/esign/db";
import { downloadEsignPdf, uploadEsignSignedPdf } from "@/lib/esign/storage";
import { appendSignaturePages, sha256OfBytes } from "@/lib/esign/pdf";
import { sendEnvelopeCompletedWithPdf } from "@/lib/esign/email";
import { resolveSigningSession } from "@/lib/esign/resolve-signing-session";
import type { EsignSignerRow, EsignEnvelopeRow } from "@/lib/esign/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// One shape for every failure — status + body never vary by reason.
function genericError() {
  return NextResponse.json({ ok: false, error: "link_unavailable" }, { status: 404 });
}

/** A token is "usable" only when it resolves to a signer that hasn't
 *  signed/declined yet, hasn't expired, and belongs to an envelope that's
 *  still open for signing. Every other combination fails closed. */
function isUsable(signer: EsignSignerRow, envelope: EsignEnvelopeRow): boolean {
  if (signer.status === "signed" || signer.status === "declined") return false;
  if (new Date(signer.expires_at).getTime() < Date.now()) return false;
  if (!["sent", "viewed", "partially_signed"].includes(envelope.status)) return false;
  return true;
}

/** A drawn signature must decode to a REAL PNG (magic bytes), not just carry a
 *  "data:image" prefix — otherwise a garbage payload like "data:image,x" would
 *  mark the signer signed+consented while the certificate renders a blank
 *  signature box, gutting the record's evidentiary value. */
function isValidPngDataUri(uri: string): boolean {
  if (!uri.startsWith("data:image")) return false;
  const b64 = uri.split(",")[1] || "";
  if (!b64) return false;
  let buf: Buffer;
  try {
    buf = Buffer.from(b64, "base64");
  } catch {
    return false;
  }
  // PNG signature: 89 50 4E 47 0D 0A 1A 0A
  return buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const ip = getClientIp(req);

  // Pre-lookup throttle keyed by IP — blunts scanning /api/sign/<guess>
  // before we ever touch the DB. Generous (legit page loads are 1 hit).
  const ipLimit = rateLimit({ key: `esign-view-ip:${ip}`, capacity: 30, refillPerSec: 0.5 });
  if (!ipLimit.allowed) return genericError();

  const resolved = await resolveSigningSession(token, { ip, userAgent: req.headers.get("user-agent") || "unknown" });
  if (!resolved.ok) return genericError();

  return NextResponse.json({ ok: true, ...resolved.session });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const ip = getClientIp(req);
  const userAgent = req.headers.get("user-agent") || "unknown";

  const ipLimit = rateLimit({ key: `esign-sign-ip:${ip}`, capacity: 20, refillPerSec: 0.2 });
  if (!ipLimit.allowed) return genericError();

  let body: { signatureDataUri?: unknown; typedName?: unknown; consented?: unknown; decline?: unknown; declineReason?: unknown };
  try {
    body = await req.json();
  } catch {
    return genericError();
  }

  const tokenHash = hashIncomingToken(token);
  const lookup = await getSignerByTokenHash(tokenHash);
  if (!lookup.ok) return genericError();
  const { signer, envelope } = lookup;
  if (!isUsable(signer, envelope)) return genericError();

  // Per-signer throttle (lib/rate-limit.ts) — bounds repeated submit
  // attempts against one signer's link specifically, on top of the IP gate.
  const signerLimit = rateLimit({ key: `esign-sign:${signer.id}`, capacity: 8, refillPerSec: 0.05 });
  if (!signerLimit.allowed) return genericError();

  // Decline path — no consent required to decline.
  if (body.decline === true) {
    const reason = typeof body.declineReason === "string" ? body.declineReason.slice(0, 500) : "declined by signer";
    const decl = await markSignerDeclined(signer.id, reason);
    if (!decl.ok) return genericError();
    await updateEnvelopeStatus(envelope.tenant_id, envelope.id, "declined");
    await logEvent({
      envelopeId: envelope.id,
      signerId: signer.id,
      tenantId: envelope.tenant_id,
      event: "declined",
      actor: `signer:${signer.id}`,
      ip,
      userAgent,
      meta: {}, // reason intentionally omitted from the audit meta blob (redact-PII default) — stored on the row instead
    });
    return NextResponse.json({ ok: true, status: "declined" });
  }

  // Consent REQUIRED before signing — reject with NO side effects.
  if (body.consented !== true) {
    return genericError();
  }
  const signatureDataUri = typeof body.signatureDataUri === "string" ? body.signatureDataUri : "";
  const typedName = typeof body.typedName === "string" ? body.typedName.trim().slice(0, 200) : "";
  const hasSignatureImage = isValidPngDataUri(signatureDataUri);
  if (!hasSignatureImage && !typedName) {
    return genericError();
  }

  const signResult = await markSignerSigned(signer.id, { ip, userAgent, consented: true });
  if (!signResult.ok) return genericError();
  if (!signResult.changed) {
    // A concurrent/replayed POST already flipped this signer to 'signed' — the
    // CAS returned 0 rows. Benign success, no duplicated side effects.
    return NextResponse.json({ ok: true, status: "signed", envelope_complete: envelope.status === "completed" });
  }
  // Persist THIS signer's captured signature (esign_fields — see
  // saveSignatureField's doc comment) so a later signer's completion can
  // build every signer's certificate page, not just their own.
  const fieldSave = await saveSignatureField({
    envelopeId: envelope.id,
    signerId: signer.id,
    tenantId: envelope.tenant_id,
    signatureDataUri: hasSignatureImage ? signatureDataUri : null,
    typedName: !hasSignatureImage ? typedName : null,
  });
  if (!fieldSave.ok) return genericError();
  await logEvent({
    envelopeId: envelope.id,
    signerId: signer.id,
    tenantId: envelope.tenant_id,
    event: "signed",
    actor: `signer:${signer.id}`,
    ip,
    userAgent,
    meta: { method: hasSignatureImage ? "drawn" : "typed" },
  });

  // Re-check whether EVERY signer on the envelope is now signed. Any
  // signer still pending/viewed keeps the envelope partially_signed;
  // failures below (PDF assembly, upload, DB writes) must not silently
  // report success — fail closed with a generic error so the operator sees
  // the envelope stuck (not falsely completed) and can retry.
  const allSignersRes = await getAllSignersForEnvelope(envelope.id);
  if (!allSignersRes.ok) return genericError();
  const allSigned = allSignersRes.signers.every((s) => s.status === "signed");
  const anyDeclined = allSignersRes.signers.some((s) => s.status === "declined");

  if (!allSigned) {
    await updateEnvelopeStatus(envelope.tenant_id, envelope.id, anyDeclined ? "declined" : "partially_signed");
    return NextResponse.json({ ok: true, status: "signed", envelope_complete: false });
  }

  // Every signer is done — assemble the final signed PDF.
  const source = await downloadEsignPdf(envelope.source_storage_key);
  if (!source.ok) return genericError();

  const fieldsRes = await getSignatureFieldsForEnvelope(envelope.id);
  if (!fieldsRes.ok) return genericError();
  const certInfo = allSignersRes.signers.map((s) => {
    const captured = fieldsRes.bySignerId.get(s.id);
    return {
      name: s.name,
      email: s.email,
      signedAt: s.signed_at || new Date().toISOString(),
      ip: s.signed_ip || "unknown",
      userAgent: s.signed_user_agent || "unknown",
      signatureDataUri: captured?.signatureDataUri ?? null,
      typedName: captured?.typedName ?? null,
      consentDisclosureVersion: envelope.consent_disclosure_version,
    };
  });
  // One certificate page per signer, assembled once here (on the LAST
  // signer's completion) from every signer's persisted esign_fields row —
  // not incrementally, and not just from this request's in-memory payload.
  const appended = await appendSignaturePages(source.bytes, certInfo, {
    sourceSha256: envelope.source_pdf_sha256,
    envelopeTitle: envelope.title,
  });
  if (!appended.ok) return genericError();

  const signedSha256 = sha256OfBytes(appended.bytes);
  const upload = await uploadEsignSignedPdf({
    tenantId: envelope.tenant_id,
    envelopeId: envelope.id,
    leadId: envelope.lead_id,
    filename: `${envelope.title || "document"}_signed.pdf`,
    bytes: Buffer.from(appended.bytes),
    mimeType: "application/pdf",
    uploadedBy: envelope.created_by,
  });
  if (!upload.ok) return genericError();

  const completed = await updateEnvelopeStatus(envelope.tenant_id, envelope.id, "completed", {
    signed_storage_key: upload.storagePath,
    signed_document_id: upload.documentId,
    signed_pdf_sha256: signedSha256,
    completed_at: new Date().toISOString(),
  });
  if (!completed.ok) return genericError();

  // Only the write that actually flipped the envelope to 'completed' fires the
  // one-time side effects — a racing second completion (changed:false) skips
  // the audit row + creator email so neither is duplicated.
  if (completed.changed) {
    await logEvent({
      envelopeId: envelope.id,
      tenantId: envelope.tenant_id,
      event: "completed",
      actor: "system",
      meta: { signed_pdf_sha256: signedSha256 },
    });

    // Email EVERY signer a completion confirmation with the fully-signed PDF
    // ATTACHED (from the configured e-sign sender, e.g. adonyess@gmail.com).
    // Best-effort — never blocks the signer's success response; a failed
    // notification is not a signing failure.
    try {
      await sendEnvelopeCompletedWithPdf({
        tenantId: envelope.tenant_id,
        to: allSignersRes.signers.map((s) => s.email),
        envelopeTitle: envelope.title,
        pdfBytes: Buffer.from(appended.bytes),
      });
    } catch {
      /* best-effort */
    }
  }

  return NextResponse.json({ ok: true, status: "signed", envelope_complete: true });
}
