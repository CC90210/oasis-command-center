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

// Bump when the watermark RENDERING changes so older-version stored statements
// get re-watermarked (the shop-out guard + backfill re-do anything not on this
// version). v2 (2026-06-28): SunBiz LOGO tiled over the white areas + a real
// registered font (v1 drew invisible text — canvas had no fonts on Vercel).
export const WATERMARK_VERSION = 2;

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

  // Auto-classify untyped uploads by filename so they count toward the lead's
  // required-docs tracker AND underwriting picks them up with the right
  // doc_type (no more "STILL NEEDS: BANK STATEMENTS" when statements are on file).
  // Classify BEFORE the store so we can brand bank statements before they land.
  const docType =
    !input.docType || input.docType === "unclassified"
      ? classifyDocTypeByFilename(cleanName)
      : input.docType;

  // Bank statements get the unremovable SunBiz watermark baked in at ingestion
  // (CC 2026-06-28). Bytes are already in hand here, so brand them inline before
  // the store — no re-download. Best-effort: a branding failure NEVER blocks the
  // upload; we store the original, flag metadata.watermark_error, and the
  // shop-out guard heals it before anything leaves to a lender.
  let storeBytes: Buffer | Uint8Array = input.bytes;
  let storeMime = input.mimeType;
  let storeSize = input.sizeBytes;
  const wmMeta: Record<string, unknown> = {};
  if (docType === "bank_statements_3mo") {
    try {
      const { watermarkBankStatement } = await import("./forms/watermark");
      const srcBuf = Buffer.isBuffer(input.bytes) ? input.bytes : Buffer.from(input.bytes);
      const wm = await watermarkBankStatement({
        bytes: srcBuf,
        mimeType: input.mimeType,
        provenance: await resolveProvenance(db, input.tenantId, input.leadId),
      });
      if (wm.ok) {
        storeBytes = wm.bytes;
        storeMime = wm.mimeType;
        storeSize = wm.bytes.length;
        wmMeta.watermarked_at = new Date().toISOString();
        wmMeta.watermark_version = WATERMARK_VERSION;
      } else {
        wmMeta.watermark_error = wm.error;
      }
    } catch (e) {
      wmMeta.watermark_error = e instanceof Error ? e.message : "watermark_threw";
    }
  }

  const upload = await db.storage
    .from(LEAD_DOC_BUCKET)
    .upload(storagePath, storeBytes, {
      contentType: storeMime,
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
      mime_type: storeMime,
      size_bytes: storeSize,
      doc_type: docType,
      uploaded_by: input.uploadedBy,
      metadata: {
        source: input.source,
        ...(input.extraMetadata || {}),
        ...wmMeta,
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
  const doc = ins.data as LeadDocumentUploadResult["document"];
  // Direct-to-storage uploads (public form) never passed bytes through the
  // server, so brand bank statements now: download → watermark → overwrite in
  // place (CC 2026-06-28). Best-effort and awaited so the stored object is
  // branded by the time submit returns; a failure is non-fatal (the shop-out
  // guard + backfill are the backstop).
  if (docType === "bank_statements_3mo") {
    try {
      const wm = await watermarkStoredBankStatement(input.storagePath);
      if (wm.ok && !wm.skipped && typeof wm.sizeBytes === "number") {
        doc.size_bytes = wm.sizeBytes;
        if (wm.mimeType) doc.mime_type = wm.mimeType;
      }
    } catch {
      /* best-effort */
    }
  }
  return { ok: true, document: doc };
}

/**
 * Best-effort provenance for the watermark footer: the lead's business name
 * (from its tenant_records row) + the short lead id + today's date. A missing
 * business name falls back to a generic label inside the watermark renderer.
 */
async function resolveProvenance(
  db: ReturnType<typeof getServiceSupabase>,
  tenantId: string,
  leadId: string,
): Promise<{ businessName: string | null; leadId: string; date: string }> {
  const date = new Date().toISOString().slice(0, 10);
  try {
    const r = await db
      .from("tenant_records")
      .select("data")
      .eq("tenant_id", tenantId)
      .eq("id", leadId)
      .maybeSingle();
    const data = (r.data as { data?: Record<string, unknown> } | null)?.data || {};
    const biz =
      typeof data.business_name === "string" && data.business_name.trim()
        ? data.business_name.trim()
        : typeof data.merchant_name === "string" && data.merchant_name.trim()
          ? data.merchant_name.trim()
          : null;
    return { businessName: biz, leadId, date };
  } catch {
    return { businessName: null, leadId, date };
  }
}

export type WatermarkStoredResult = {
  ok: boolean;
  skipped?: boolean;
  sizeBytes?: number;
  mimeType?: string;
  error?: string;
};

/**
 * Brand a bank-statement object that is ALREADY in Storage: download → SunBiz
 * watermark → overwrite the same path → update the row's size/mime + stamp
 * metadata.watermarked_at. The single source of truth for "make the stored
 * statement watermarked", used by the public-form path, the shop-out door
 * guard, and the one-time backfill.
 *
 * Idempotent: a doc already carrying metadata.watermarked_at is skipped (no
 * double-stamp) unless `force` is set. Never destructive: a watermark failure
 * leaves the original bytes untouched and records metadata.watermark_error.
 * Only ever touches doc_type === "bank_statements_3mo".
 */
export async function watermarkStoredBankStatement(
  storagePath: string,
  opts?: { force?: boolean },
): Promise<WatermarkStoredResult> {
  const db = getServiceSupabase();
  const rowRes = await db
    .from("lead_documents")
    .select("id, tenant_id, lead_id, doc_type, mime_type, metadata")
    .eq("storage_path", storagePath)
    .maybeSingle();
  if (rowRes.error) return { ok: false, error: `row_lookup_failed: ${rowRes.error.message}` };
  if (!rowRes.data) return { ok: false, error: "row_not_found" };
  const row = rowRes.data as {
    id: string;
    tenant_id: string;
    lead_id: string;
    doc_type: string;
    mime_type: string | null;
    metadata: Record<string, unknown> | null;
  };
  if (row.doc_type !== "bank_statements_3mo") return { ok: false, error: "not_a_bank_statement" };
  // Skip only if it's already watermarked AT THE CURRENT VERSION (and not
  // force). A stale-version stored statement (e.g. the v1 invisible-text mark)
  // falls through and gets re-watermarked with the current renderer.
  if (
    row.metadata?.watermarked_at &&
    row.metadata?.watermark_version === WATERMARK_VERSION &&
    !opts?.force
  ) {
    return { ok: true, skipped: true };
  }

  const dl = await db.storage.from(LEAD_DOC_BUCKET).download(storagePath);
  if (dl.error || !dl.data) {
    return { ok: false, error: `download_failed: ${dl.error?.message || "no_data"}` };
  }
  const buf = Buffer.from(await dl.data.arrayBuffer());

  const { watermarkBankStatement } = await import("./forms/watermark");
  const wm = await watermarkBankStatement({
    bytes: buf,
    mimeType: row.mime_type || "application/pdf",
    provenance: await resolveProvenance(db, row.tenant_id, row.lead_id),
  });
  if (!wm.ok) {
    await db
      .from("lead_documents")
      .update({ metadata: { ...(row.metadata || {}), watermark_error: wm.error } })
      .eq("id", row.id);
    return { ok: false, error: wm.error };
  }

  // Overwrite the SAME path so every downstream reader (UI, underwriting,
  // shop-out attachment download) gets the branded bytes with zero path churn.
  const up = await db.storage
    .from(LEAD_DOC_BUCKET)
    .upload(storagePath, wm.bytes, { contentType: wm.mimeType, upsert: true });
  if (up.error) return { ok: false, error: `overwrite_failed: ${up.error.message}` };

  await db
    .from("lead_documents")
    .update({
      mime_type: wm.mimeType,
      size_bytes: wm.bytes.length,
      metadata: {
        ...(row.metadata || {}),
        watermarked_at: new Date().toISOString(),
        watermark_version: WATERMARK_VERSION,
        watermark_error: null,
      },
    })
    .eq("id", row.id);

  return { ok: true, sizeBytes: wm.bytes.length, mimeType: wm.mimeType };
}

/**
 * Shop-out door guard: before a deal's documents leave to lenders, make sure
 * every bank-statement attachment carries the SunBiz watermark. Heals any that
 * ingestion missed or failed (idempotent — already-branded docs are skipped
 * cheaply, before any download). Returns the statements that could NOT be
 * branded so the caller refuses the send rather than ship one un-watermarked.
 * Non-bank attachments (void cheque, ID, etc.) pass through untouched.
 */
export async function ensureBankStatementsWatermarked(
  tenantId: string,
  attachments: Array<{ filename: string; storage_path: string }>,
): Promise<{
  ok: boolean;
  branded: number;
  failures: Array<{ filename: string; storage_path: string; reason: string }>;
}> {
  const db = getServiceSupabase();
  const failures: Array<{ filename: string; storage_path: string; reason: string }> = [];
  let branded = 0;
  const paths = attachments.map((a) => a.storage_path).filter(Boolean);
  if (paths.length === 0) return { ok: true, branded, failures };

  const rows = await db
    .from("lead_documents")
    .select("storage_path, doc_type, metadata")
    .eq("tenant_id", tenantId)
    .in("storage_path", paths);
  const byPath = new Map<
    string,
    { doc_type?: string; metadata?: Record<string, unknown> | null }
  >();
  for (const r of (rows.data || []) as Array<{
    storage_path: string;
    doc_type?: string;
    metadata?: Record<string, unknown> | null;
  }>) {
    byPath.set(r.storage_path, r);
  }

  for (const att of attachments) {
    const row = byPath.get(att.storage_path);
    if (!row) {
      // FAIL CLOSED: an attachment we can't resolve to a tenant lead_documents
      // row could be an un-branded bank statement we have no way to verify.
      // Never ship what we can't identify — surface it so the caller refuses
      // the send. (Normal flow always resolves: attachments are picked from the
      // operator's own lead_documents list; an unresolved path means a
      // hand-crafted request or a doc removed mid-flight.)
      failures.push({
        filename: att.filename,
        storage_path: att.storage_path,
        reason: "unresolved_attachment_no_lead_document",
      });
      continue;
    }
    if (row.doc_type !== "bank_statements_3mo") continue; // non-statement (ID, void cheque) — out of scope
    if (row.metadata?.watermarked_at && row.metadata?.watermark_version === WATERMARK_VERSION) {
      continue; // already branded at the current version
    }
    const wm = await watermarkStoredBankStatement(att.storage_path);
    if (wm.ok || wm.skipped) {
      if (wm.ok && !wm.skipped) branded += 1;
    } else {
      failures.push({
        filename: att.filename,
        storage_path: att.storage_path,
        reason: wm.error || "watermark_failed",
      });
    }
  }
  return { ok: failures.length === 0, branded, failures };
}

/**
 * Retry-path door guard: the lender-thread retry endpoints re-fire
 * shop_out_send_batch, which sends EVERY non-terminal thread on the application
 * from its persisted attachments (application_lender_threads.attachments,
 * migration 065). Before a retry can re-send, brand any un-watermarked bank
 * statement across those threads — this is the only path that can ship a
 * PRE-FEATURE or previously-failed thread whose attachments never passed the
 * upload or shop-out guards. Same fail-closed contract as
 * ensureBankStatementsWatermarked (an unresolved path is a failure).
 */
export async function ensureApplicationThreadsWatermarked(
  tenantId: string,
  applicationId: string,
): Promise<{
  ok: boolean;
  branded: number;
  failures: Array<{ filename: string; storage_path: string; reason: string }>;
}> {
  const db = getServiceSupabase();
  const res = await db
    .from("application_lender_threads")
    .select("attachments")
    .eq("tenant_id", tenantId)
    .eq("application_id", applicationId)
    // Everything the batch could send once a retry flips error/sending → pending.
    .in("status", ["pending", "error", "sending"]);
  if (res.error) {
    return {
      ok: false,
      branded: 0,
      failures: [{ filename: "(threads)", storage_path: "", reason: `thread_query_failed: ${res.error.message}` }],
    };
  }
  const seen = new Set<string>();
  const attachments: Array<{ filename: string; storage_path: string }> = [];
  for (const row of (res.data || []) as Array<{ attachments?: unknown }>) {
    const arr = Array.isArray(row.attachments) ? row.attachments : [];
    for (const a of arr as Array<Record<string, unknown>>) {
      const sp = typeof a?.storage_path === "string" ? a.storage_path : "";
      if (!sp || seen.has(sp)) continue;
      seen.add(sp);
      attachments.push({
        filename: typeof a?.filename === "string" ? a.filename : "attachment",
        storage_path: sp,
      });
    }
  }
  return ensureBankStatementsWatermarked(tenantId, attachments);
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
