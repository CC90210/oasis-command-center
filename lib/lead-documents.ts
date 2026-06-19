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
 * Infer a canonical doc_type from the filename when the caller didn't supply
 * one ("unclassified"/empty). Bank statements uploaded via import or a form
 * file-field often arrive untyped — without this they never count toward the
 * lead's required-docs tracker, and the underwriting orchestrator has to fall
 * back to its own filename heuristic. Classifying at write time keeps doc_type
 * correct for every consumer (tracker, underwriting, shop-out attachments).
 * Mirrors the VPS orchestrator's _looks_like_bank_statement heuristic.
 */
export function classifyDocTypeByFilename(filename: string): string {
  const n = (filename || "").toLowerCase();
  // More-specific KYC docs first so a void cheque / driver's license never
  // falls through to bank_statements.
  if (/(driver|licen[sc]e|(^|[_\-\s])dl([_\-\s]|$)|id[_\-]?card|passport)/.test(n)) {
    return "drivers_license";
  }
  if (/(void|cheque)/.test(n)) {
    return "void_cheque";
  }
  if (/(statement|stmt|checking|savings|\bbank\b)/.test(n)) {
    return "bank_statements_3mo";
  }
  return "unclassified";
}

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

  // Auto-classify untyped uploads by filename so they count toward the lead's
  // required-docs tracker AND underwriting picks them up with the right
  // doc_type (no more "STILL NEEDS: BANK STATEMENTS" when statements are on file).
  const docType =
    !input.docType || input.docType === "unclassified"
      ? classifyDocTypeByFilename(cleanName)
      : input.docType;

  const ins = await db
    .from("lead_documents")
    .insert({
      tenant_id: input.tenantId,
      lead_id: input.leadId,
      filename: cleanName,
      storage_path: storagePath,
      mime_type: input.mimeType,
      size_bytes: input.sizeBytes,
      doc_type: docType,
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
 * Register a lead-document whose bytes are ALREADY in Storage — used by the
 * direct-to-Storage form upload path (browser PUTs to a server-minted signed
 * upload URL, then the submit route registers the object here). This is the
 * trusted-registration counterpart to uploadLeadDocument: the caller never
 * supplies bytes, so we must (1) confirm the path is inside the caller's
 * tenant+lead prefix — the signed URL is only ever minted for that prefix, so
 * anything else is a forged/misrouted descriptor — and (2) confirm the object
 * actually exists and read its REAL size from Storage (never trust a
 * client-claimed size_bytes). Idempotent on storage_path so a re-submitted
 * step can't stack duplicate rows.
 */
export async function registerLeadDocument(input: {
  tenantId: string;
  leadId: string;
  storagePath: string;
  filename: string;
  mimeType: string;
  docType: string;
  uploadedBy: string;
  source: string;
  extraMetadata?: Record<string, unknown>;
}): Promise<LeadDocumentUploadResult | LeadDocumentUploadFailure> {
  const db = getServiceSupabase();

  // SECURITY: the path MUST be inside this tenant+lead's prefix. The signed
  // upload URL (/api/forms/upload-url) is minted ONLY for `${tenant}/${lead}/`,
  // so a path outside that — or any traversal — means a forged descriptor.
  const expectedPrefix = `${input.tenantId}/${input.leadId}/`;
  if (!input.storagePath.startsWith(expectedPrefix) || input.storagePath.includes("..")) {
    return { ok: false, error: "storage_path_outside_scope" };
  }

  const selectCols =
    "id, filename, mime_type, size_bytes, doc_type, uploaded_by, uploaded_at, storage_path";

  // Idempotency: the descriptor's path is unique per upload (Date.now() prefix),
  // so a row already carrying it means a duplicate submit — return the existing.
  const dup = await db
    .from("lead_documents")
    .select(selectCols)
    .eq("tenant_id", input.tenantId)
    .eq("storage_path", input.storagePath)
    .maybeSingle();
  if (dup.data) {
    return { ok: true, document: dup.data as LeadDocumentUploadResult["document"] };
  }

  // Confirm the object exists + read its real size (anti-spoof).
  const slash = input.storagePath.lastIndexOf("/");
  const dir = input.storagePath.slice(0, slash);
  const base = input.storagePath.slice(slash + 1);
  const listed = await db.storage.from(LEAD_DOC_BUCKET).list(dir, { search: base, limit: 100 });
  if (listed.error) {
    return { ok: false, error: `storage_list_failed: ${listed.error.message}` };
  }
  const obj = (listed.data || []).find((o) => o.name === base);
  if (!obj) {
    return { ok: false, error: "uploaded_object_not_found" };
  }
  const md = obj.metadata as { size?: number } | null;
  const realSize = typeof md?.size === "number" ? md.size : 0;

  const docType =
    !input.docType || input.docType === "unclassified"
      ? classifyDocTypeByFilename(input.filename)
      : input.docType;

  const ins = await db
    .from("lead_documents")
    .insert({
      tenant_id: input.tenantId,
      lead_id: input.leadId,
      filename: sanitizeStorageFilename(input.filename),
      storage_path: input.storagePath,
      mime_type: input.mimeType,
      size_bytes: realSize,
      doc_type: docType,
      uploaded_by: input.uploadedBy,
      metadata: { source: input.source, ...(input.extraMetadata || {}) },
    })
    .select(selectCols)
    .single();
  if (ins.error) {
    // Remove the orphaned blob so a failed metadata insert doesn't leak it.
    await db.storage.from(LEAD_DOC_BUCKET).remove([input.storagePath]);
    return { ok: false, error: `metadata_insert_failed: ${ins.error.message}` };
  }
  return { ok: true, document: ins.data as LeadDocumentUploadResult["document"] };
}

/**
 * Soft-delete a lead document (Batch 5). Marks `metadata.deleted_at` so the doc
 * is excluded from every read path (drawer, timeline, shop-out attachments, the
 * required-doc/stage engine, AI tools, downloads) while staying recoverable +
 * audit-traceable. Storage bytes are kept (a delayed purge can reap them later).
 * Every lead_documents read MUST filter `.is("metadata->>deleted_at", null)`.
 */
export async function softDeleteLeadDocument(input: {
  tenantId: string;
  docId: string;
  deletedBy: string;
  /**
   * The authorized parent lead id (Codex 2026-06-19 HIGH). The caller has
   * already gated access to THIS lead/application; binding the delete to its
   * lead_id closes the confused-deputy hole where an agent who owns lead A
   * passes lead A's id + another lead's document UUID to hide a file they can't
   * see. When provided, both the read AND the update require lead_id match, so a
   * doc that isn't attached to the authorized parent surfaces as not_found.
   */
  expectedLeadId?: string;
}): Promise<
  | { ok: true; lead_id: string; doc_type: string; filename: string }
  | { ok: false; error: string }
> {
  const db = getServiceSupabase();
  let readQ = db
    .from("lead_documents")
    .select("id, lead_id, doc_type, filename, metadata")
    .eq("tenant_id", input.tenantId)
    .eq("id", input.docId);
  if (input.expectedLeadId) readQ = readQ.eq("lead_id", input.expectedLeadId);
  const row = await readQ.maybeSingle();
  if (row.error) return { ok: false, error: row.error.message };
  if (!row.data) return { ok: false, error: "not_found" };
  const r = row.data as {
    lead_id: string;
    doc_type: string;
    filename: string;
    metadata: Record<string, unknown> | null;
  };
  if (r.metadata?.deleted_at) {
    return { ok: true, lead_id: r.lead_id, doc_type: r.doc_type, filename: r.filename }; // already deleted (idempotent)
  }
  const metadata = {
    ...(r.metadata || {}),
    deleted_at: new Date().toISOString(),
    deleted_by: input.deletedBy,
  };
  let updQ = db
    .from("lead_documents")
    .update({ metadata })
    .eq("tenant_id", input.tenantId)
    .eq("id", input.docId);
  if (input.expectedLeadId) updQ = updQ.eq("lead_id", input.expectedLeadId);
  const upd = await updQ;
  if (upd.error) return { ok: false, error: upd.error.message };
  return { ok: true, lead_id: r.lead_id, doc_type: r.doc_type, filename: r.filename };
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
