/**
 * lib/lead-documents.ts — canonical lead-document upload helper.
 *
 * Three surfaces upload to lead_documents today:
 *   1. /api/forms/submit (public form intake; HMAC-authed)
 *   2. /api/leads/[id]/documents (operator-side drawer; session-authed)
 *   3. ManifestRecordForm's full-record create/edit upload queue
 *
 * All surfaces share the same storage bucket, same path shape, same
 * metadata-row schema, and the same downstream stage-engine call.
 * This helper centralises that pipeline so adding a future upload
 * surface (mobile app, Telegram-attached doc forwarder, etc.) is a
 * one-line call instead of re-deriving the storage path + insert
 * shape + cleanup-on-failure semantics.
 */

import { getServiceSupabase } from "./supabase-server";
import { sanitizeStorageFilename } from "./storage-helpers";

export const LEAD_DOC_BUCKET = "lead-documents";

export type LeadDocumentUploadResult = {
  ok: true;
  document: {
    id: string;
    filename: string;
    mime_type: string;
    size_bytes: number;
    doc_type: string;
    uploaded_by: string | null;
    uploaded_at: string;
    storage_path: string;
  };
};

export type LeadDocumentUploadFailure = {
  ok: false;
  error: string;
};

export type UploadLeadDocumentInput = {
  tenantId: string;
  leadId: string;
  filename: string;
  mimeType: string;
  bytes: Buffer | Uint8Array;
  sizeBytes: number;
  /** Canonical doc_type (bank_statements_3mo, drivers_license, …) or "unclassified". */
  docType: string;
  uploadedBy: string;
  /** Audit context — "drawer_upload", "form_intake", "telegram_forward", … */
  source: string;
  /** Free-form extras stored on lead_documents.metadata. */
  extraMetadata?: Record<string, unknown>;
};

/**
 * Upload a single lead-document. Writes to Supabase Storage first, then
 * inserts the metadata row; if the metadata insert fails the blob is
 * cleaned up so we don't leak orphaned objects. Returns a structured
 * result the caller maps to its own HTTP shape.
 */
export async function uploadLeadDocument(
  input: UploadLeadDocumentInput,
): Promise<LeadDocumentUploadResult | LeadDocumentUploadFailure> {
  const db = getServiceSupabase();
  const cleanName = sanitizeStorageFilename(input.filename);
  const storagePath = `${input.tenantId}/${input.leadId}/${Date.now()}_${cleanName}`;

  const upload = await db.storage
    .from(LEAD_DOC_BUCKET)
    .upload(storagePath, input.bytes, {
      contentType: input.mimeType,
      upsert: false,
    });
  if (upload.error) {
    return { ok: false, error: `upload_failed: ${upload.error.message}` };
  }

  const ins = await db
    .from("lead_documents")
    .insert({
      tenant_id: input.tenantId,
      lead_id: input.leadId,
      filename: cleanName,
      storage_path: storagePath,
      mime_type: input.mimeType,
      size_bytes: input.sizeBytes,
      doc_type: input.docType,
      uploaded_by: input.uploadedBy,
      metadata: {
        source: input.source,
        ...(input.extraMetadata || {}),
      },
    })
    .select("id, filename, mime_type, size_bytes, doc_type, uploaded_by, uploaded_at, storage_path")
    .single();

  if (ins.error) {
    // Cleanup the orphaned blob so storage doesn't accumulate dangling
    // objects when the metadata row insert fails.
    await db.storage.from(LEAD_DOC_BUCKET).remove([storagePath]);
    return { ok: false, error: `metadata_insert_failed: ${ins.error.message}` };
  }

  return { ok: true, document: ins.data as LeadDocumentUploadResult["document"] };
}

/**
 * Allowed MIME types for operator uploads. Form intake is more
 * permissive (handles whatever the prospect sends) but the
 * dashboard-side upload narrows the set so an operator can't drop a
 * .exe into a lead's document store.
 */
export const OPERATOR_ALLOWED_DOC_MIME = new Set<string>([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/heic",
  "image/heif",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
  "text/csv",
]);

export const MAX_LEAD_DOC_BYTES = 25 * 1024 * 1024;
