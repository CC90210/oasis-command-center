/**
 * lib/esign/storage.ts — Supabase Storage helpers for e-signature PDFs.
 *
 * Reuses the SAME bucket as every other lead-facing document,
 * `lead-documents` (LEAD_DOC_BUCKET, lib/lead-documents.ts:20), and the
 * same filename sanitizer (sanitizeStorageFilename, lib/storage-helpers.ts:13)
 * every other uploader uses, so an esign object can never escape its
 * tenant folder via a crafted filename.
 *
 * Two path shapes:
 *   - Source PDFs (the document being sent for signature, or the existing
 *     unsigned application PDF being signed) live under
 *     `${tenantId}/esign/${envelopeId}/source_<name>` — they are NOT lead
 *     documents in their own right (an envelope may have no lead_id at
 *     all), so they don't go through uploadLeadDocument().
 *   - Signed PDFs tied to a lead reuse uploadLeadDocument() (lib/lead-
 *     documents.ts:96, path `${tenantId}/${leadId}/${Date.now()}_${name}`)
 *     with doc_type "esigned_document" so they show up in the lead's
 *     Documents tab like any other file. Signed PDFs on a lead-less
 *     envelope fall back to the same `${tenantId}/esign/${envelopeId}/`
 *     scheme as the source.
 */

import "server-only";
import { getServiceSupabase } from "@/lib/supabase-server";
import { sanitizeStorageFilename } from "@/lib/storage-helpers";
import { uploadLeadDocument, LEAD_DOC_BUCKET } from "@/lib/lead-documents";

export { LEAD_DOC_BUCKET };

export type StorageResult =
  | { ok: true; storagePath: string; documentId: string | null }
  | { ok: false; error: string };

/** Upload the SOURCE PDF for a new envelope. Always under the esign/
 *  envelope-scoped path — the source is provenance for the certificate
 *  page, not itself a lead document. */
export async function uploadEsignSourcePdf(input: {
  tenantId: string;
  envelopeId: string;
  filename: string;
  bytes: Buffer | Uint8Array;
  mimeType: string;
}): Promise<StorageResult> {
  const db = getServiceSupabase();
  const cleanName = sanitizeStorageFilename(input.filename) || "source.pdf";
  const storagePath = `${input.tenantId}/esign/${input.envelopeId}/source_${cleanName}`;
  const up = await db.storage.from(LEAD_DOC_BUCKET).upload(storagePath, input.bytes, {
    contentType: input.mimeType || "application/pdf",
    upsert: true,
  });
  if (up.error) return { ok: false, error: `upload_failed: ${up.error.message}` };
  return { ok: true, storagePath, documentId: null };
}

/** Upload the COMPLETED signed PDF. Tied to the lead (uploadLeadDocument,
 *  doc_type esigned_document) when the envelope has a lead_id; otherwise
 *  the same esign/envelope-scoped path as the source. */
export async function uploadEsignSignedPdf(input: {
  tenantId: string;
  envelopeId: string;
  leadId: string | null;
  filename: string;
  bytes: Buffer | Uint8Array;
  mimeType: string;
  uploadedBy: string;
}): Promise<StorageResult> {
  const cleanName = sanitizeStorageFilename(input.filename) || "signed.pdf";
  if (input.leadId) {
    const res = await uploadLeadDocument({
      tenantId: input.tenantId,
      leadId: input.leadId,
      filename: cleanName,
      mimeType: input.mimeType || "application/pdf",
      bytes: input.bytes,
      sizeBytes: input.bytes.length,
      docType: "esigned_document",
      uploadedBy: input.uploadedBy,
      source: "esign_completion",
      extraMetadata: { esign_envelope_id: input.envelopeId },
    });
    if (!res.ok) return { ok: false, error: res.error };
    return { ok: true, storagePath: res.document.storage_path, documentId: res.document.id };
  }
  const db = getServiceSupabase();
  const storagePath = `${input.tenantId}/esign/${input.envelopeId}/signed_${cleanName}`;
  const up = await db.storage.from(LEAD_DOC_BUCKET).upload(storagePath, input.bytes, {
    contentType: input.mimeType || "application/pdf",
    upsert: true,
  });
  if (up.error) return { ok: false, error: `upload_failed: ${up.error.message}` };
  return { ok: true, storagePath, documentId: null };
}

/** Download raw bytes for any storage_path this module wrote (or any
 *  lead_documents storage_path, for the "sign an existing unsigned PDF"
 *  flow — source_document_id resolves to a lead_documents row first). */
export async function downloadEsignPdf(
  storagePath: string,
): Promise<{ ok: true; bytes: Buffer; mimeType: string | null } | { ok: false; error: string }> {
  const db = getServiceSupabase();
  const dl = await db.storage.from(LEAD_DOC_BUCKET).download(storagePath);
  if (dl.error || !dl.data) return { ok: false, error: `download_failed: ${dl.error?.message || "no_data"}` };
  const buf = Buffer.from(await dl.data.arrayBuffer());
  return { ok: true, bytes: buf, mimeType: dl.data.type || null };
}

/** Resolve an EXISTING lead_documents row (use-case B: sign an already-
 *  uploaded application/other PDF) to its storage_path + bytes. Tenant-
 *  scoped lookup — a document_id outside the caller's tenant is
 *  indistinguishable from not_found (fail closed, no cross-tenant probe). */
export async function loadExistingLeadDocumentAsSource(
  tenantId: string,
  documentId: string,
): Promise<{ ok: true; storagePath: string; filename: string; mimeType: string | null; bytes: Buffer } | { ok: false; error: string }> {
  const db = getServiceSupabase();
  const row = await db
    .from("lead_documents")
    .select("id, storage_path, filename, mime_type")
    .eq("tenant_id", tenantId)
    .eq("id", documentId)
    .is("metadata->>deleted_at", null)
    .maybeSingle();
  if (row.error) return { ok: false, error: `lookup_failed: ${row.error.message}` };
  const doc = row.data as { id: string; storage_path: string; filename: string; mime_type: string | null } | null;
  if (!doc) return { ok: false, error: "not_found" };
  const dl = await downloadEsignPdf(doc.storage_path);
  if (!dl.ok) return { ok: false, error: dl.error };
  return { ok: true, storagePath: doc.storage_path, filename: doc.filename, mimeType: doc.mime_type, bytes: dl.bytes };
}
