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
// v3 (2026-06-29): NON-DESTRUCTIVE pdf-lib overlay (no longer rasterized) — bump
// regenerates any v2 raster `_shopout_wm` copies as the high-quality overlay.
export const WATERMARK_VERSION = 3;

export type LeadDocumentUploadResult = {
  ok: true;
  /** True only when this call inserted the metadata row. */
  created?: boolean;
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

  // Bank statements are stored CLEAN (2026-06-29). The SunBiz watermark is applied
  // ONLY at shop-out, to a SEPARATE derived copy (watermarkAttachmentsForShopOut),
  // so lead storage + FundMate/paper-lender submissions stay watermark-free while
  // lenders still receive a branded copy.
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

  return { ok: true, created: true, document: ins.data as LeadDocumentUploadResult["document"] };
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
    return { ok: true, created: false, document: dup.data as LeadDocumentUploadResult["document"] };
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
  // Stored CLEAN (2026-06-29) — bank statements are watermarked only at shop-out
  // (a derived copy), so direct-to-storage uploads land clean like every surface.
  return { ok: true, created: true, document: doc };
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

  // Stamp the row LAST, and FAIL if it doesn't persist. The version stamp is the
  // ONLY skip signal — if the bytes are overwritten but the stamp write fails,
  // returning ok would leave the row "stale" forever, so every future guard +
  // backfill would re-rasterize the already-watermarked object (progressive
  // quality loss + doubled overlays). Returning a failure instead means the
  // guard blocks the send (safe) and the NEXT attempt re-does it once — bounded.
  const upd = await db
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
  if (upd.error) return { ok: false, error: `stamp_failed: ${upd.error.message}` };

  return { ok: true, sizeBytes: wm.bytes.length, mimeType: wm.mimeType };
}

/**
 * Extension for a watermarked derived copy, keyed off the mime the watermarker
 * ACTUALLY produced (which can differ from the source — HEIC/GIF flatten to
 * JPEG). Before 2026-08-03 every copy was written as `.pdf`, so an image
 * statement was stored under a `.pdf` key holding JPEG bytes and the lender
 * received a "PDF" their reader refused to open.
 */
export function wmCopyExtension(mimeType: string): string {
  switch ((mimeType || "").toLowerCase().split(";")[0].trim()) {
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "image/jpeg":
    case "image/jpg":
      return "jpg";
    default:
      return "pdf";
  }
}

/** Swap an attachment filename's extension to match the branded copy's mime. */
export function retargetFilename(filename: string, ext: string): string {
  const base = (filename || "statement").replace(/\.[A-Za-z0-9]{1,8}$/, "");
  return `${base}.${ext}`;
}

/**
 * The mime lib/forms/watermark.ts WILL emit for a given source mime. Mirrors
 * watermarkImage's format policy: PNG and WebP are preserved, everything else
 * raster (JPEG/GIF/HEIC/HEIF) flattens to JPEG, and PDFs stay PDFs.
 *
 * Used to judge copies branded BEFORE shopout_wm_mime was recorded. Assuming
 * "no recorded mime" meant PDF would let a legacy image copy — a `.pdf` key
 * holding JPEG bytes, the exact artifact this change exists to repair — pass the
 * reuse check and be re-sent broken forever. Inferring from the source instead
 * heals precisely the wrong ones without re-branding every healthy PDF.
 */
export function expectedWmMimeForSource(sourceMime: string | null): string {
  const mt = (sourceMime || "application/pdf").toLowerCase().split(";")[0].trim();
  if (mt === "application/pdf") return "application/pdf";
  if (mt === "image/png") return "image/png";
  if (mt === "image/webp") return "image/webp";
  if (IMAGE_MIME_TYPES.has(mt)) return "image/jpeg";
  return "application/pdf";
}

// Mirrors IMAGE_MIME in lib/forms/watermark.ts.
const IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif",
]);

/**
 * Get (or create) the watermarked DERIVED copy of a stored bank statement, for
 * the lender-facing send. Downloads the CLEAN original → SunBiz-watermarks →
 * uploads to a separate `_shopout_wm/{docId}_v{version}.{ext}` path. NEVER
 * touches the original (lead storage + FundMate keep reading it clean).
 * Idempotent: a copy already recorded at the current version is reused.
 *
 * The extension/mime are derived from the watermarker's OUTPUT, and both are
 * returned so callers can retarget the outbound attachment. A statement whose
 * copy still sits at a stale-extension path simply misses the reuse check and
 * gets rebuilt at the correct path (the orphan cleanup below removes the old).
 */
async function getOrCreateWatermarkedCopy(
  db: ReturnType<typeof getServiceSupabase>,
  row: {
    id: string;
    tenant_id: string;
    lead_id: string;
    storage_path: string;
    mime_type: string | null;
    metadata: Record<string, unknown> | null;
  },
): Promise<
  | { ok: true; wmPath: string; raster: boolean; mimeType: string }
  | { ok: false; error: string }
> {
  const wmDir = `${row.tenant_id}/${row.lead_id}/_shopout_wm/${row.id}_v${WATERMARK_VERSION}`;
  const recordedPath =
    typeof row.metadata?.shopout_wm_path === "string" ? (row.metadata.shopout_wm_path as string) : null;
  // Copies branded before 2026-08-03 have no recorded mime; infer what the
  // watermarker would have produced from the SOURCE mime rather than assuming
  // PDF, so legacy `.pdf`-keyed image copies fail the check below and get
  // rebuilt instead of being re-sent broken.
  const recordedMime =
    typeof row.metadata?.shopout_wm_mime === "string"
      ? (row.metadata.shopout_wm_mime as string)
      : expectedWmMimeForSource(row.mime_type);
  // Reuse when the recorded copy is at the current version AND its path matches
  // the extension its mime implies.
  if (
    recordedPath &&
    recordedPath === `${wmDir}.${wmCopyExtension(recordedMime)}` &&
    row.metadata?.shopout_wm_version === WATERMARK_VERSION
  ) {
    return {
      ok: true,
      wmPath: recordedPath,
      raster: row.metadata?.shopout_wm_raster === true,
      mimeType: recordedMime,
    };
  }
  const dl = await db.storage.from(LEAD_DOC_BUCKET).download(row.storage_path);
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
  if (!wm.ok) return { ok: false, error: wm.error };
  const wmPath = `${wmDir}.${wmCopyExtension(wm.mimeType)}`;
  const up = await db.storage
    .from(LEAD_DOC_BUCKET)
    .upload(wmPath, wm.bytes, { contentType: wm.mimeType, upsert: true });
  if (up.error) return { ok: false, error: `wm_copy_upload_failed: ${up.error.message}` };
  // Orphan cleanup: a version bump (e.g. v2→v3) or an extension correction
  // writes a NEW path; best-effort delete the prior copy so stale ones don't
  // pile up.
  if (recordedPath && recordedPath !== wmPath && recordedPath.startsWith(`${row.tenant_id}/`)) {
    try { await db.storage.from(LEAD_DOC_BUCKET).remove([recordedPath]); } catch { /* best-effort */ }
  }
  // Pointer on the ORIGINAL row so we reuse the copy + can re-resolve on retry.
  // shopout_wm_raster flags a LOSSY (flattened) copy — set when the overlay had
  // to fall back to raster (e.g. an encrypted source) so it's never silent.
  const stamp = await db
    .from("lead_documents")
    .update({
      metadata: {
        ...(row.metadata || {}),
        shopout_wm_path: wmPath,
        shopout_wm_version: WATERMARK_VERSION,
        shopout_wm_at: new Date().toISOString(),
        shopout_wm_raster: wm.raster === true,
        shopout_wm_mime: wm.mimeType,
      },
    })
    .eq("id", row.id);
  if (stamp.error) {
    // NOT fatal to the send: the branded bytes are uploaded and `wmPath` is
    // correct, so the lender still receives a watermarked statement. The only
    // casualty is the reuse cache — this doc gets re-branded on every future
    // shop-out. Loud, because a persistent failure here is invisible work.
    // (Contrast watermarkStoredBankStatement, which DOES fail closed: there the
    // stamp is what stops an endless re-rasterize of the stored object.)
    console.error(
      `[watermark] shopout_wm stamp write failed for doc ${row.id}: ${stamp.error.message} — copy is valid, reuse cache not persisted`,
    );
  }
  return { ok: true, wmPath, raster: wm.raster === true, mimeType: wm.mimeType };
}

export type ShopOutAttachmentBase = {
  filename: string;
  storage_path: string;
  original_path?: string;
};

/** Preserve the clean source and annotate why branding degraded. */
export function shopOutCleanFallback<T extends ShopOutAttachmentBase>(
  attachment: T,
  originalPath: string,
  reason: string,
): T {
  return {
    ...attachment,
    storage_path: originalPath,
    original_path: originalPath,
    watermark_status: "fallback_clean",
    watermark_error: reason,
  } as T;
}

type WmDocRow = {
  id: string;
  tenant_id: string;
  lead_id: string;
  storage_path: string;
  doc_type?: string;
  mime_type: string | null;
  metadata: Record<string, unknown> | null;
};

/**
 * Shop-out door guard (2026-06-29 model): for the lender-facing send, REWRITE
 * each bank-statement attachment to point at its watermarked DERIVED copy,
 * leaving the clean original untouched (lead storage + FundMate stay clean). The
 * returned attachments carry storage_path = the watermarked copy + original_path
 * = the clean source (so retries re-resolve from the original). Non-statement
 * attachments (the app form, ID, void cheque) pass through clean. Branding is
 * best-effort: an unbrandable statement stays attached as the verified clean
 * original and the caller receives a detailed degradation warning.
 */
export async function watermarkAttachmentsForShopOut<T extends ShopOutAttachmentBase>(
  tenantId: string,
  attachments: T[],
): Promise<{
  ok: boolean;
  attachments: T[];
  failures: Array<{ filename: string; storage_path: string; reason: string }>;
}> {
  const db = getServiceSupabase();
  const out: T[] = [];
  const failures: Array<{ filename: string; storage_path: string; reason: string }> = [];
  const origOf = (a: T) =>
    typeof a.original_path === "string" && a.original_path ? a.original_path : a.storage_path;
  const paths = attachments.map(origOf).filter(Boolean);
  if (paths.length === 0) return { ok: true, attachments, failures };

  const rows = await db
    .from("lead_documents")
    .select("id, tenant_id, lead_id, storage_path, doc_type, mime_type, metadata")
    .eq("tenant_id", tenantId)
    .in("storage_path", paths);
  if (rows.error) {
    // Still fail closed — but say WHAT failed. Until 2026-08-03 this error was
    // unchecked, so a transient DB fault left `byPath` empty and EVERY
    // attachment was reported as "unresolved_attachment_no_lead_document".
    // That sent the operator hunting a document problem that did not exist,
    // and it looked identical to a genuinely un-uploadable statement.
    return {
      ok: false,
      attachments: attachments.map((a) =>
        shopOutCleanFallback(a, origOf(a), `lead_document_lookup_failed: ${rows.error.message}`),
      ),
      failures: attachments.map((a) => ({
        filename: a.filename,
        storage_path: a.storage_path,
        reason: `lead_document_lookup_failed: ${rows.error.message}`,
      })),
    };
  }
  const byPath = new Map<string, WmDocRow>();
  for (const r of (rows.data || []) as WmDocRow[]) byPath.set(r.storage_path, r);

  for (const att of attachments) {
    const op = origOf(att);
    const row = byPath.get(op);
    if (!row) {
      // FAIL CLOSED: an attachment we can't resolve to a tenant lead_documents
      // row could be an un-branded statement we can't verify. Never ship it.
      failures.push({ filename: att.filename, storage_path: att.storage_path, reason: "unresolved_attachment_no_lead_document" });
      out.push(shopOutCleanFallback(att, op, "unresolved_attachment_no_lead_document"));
      continue;
    }
    if (row.doc_type !== "bank_statements_3mo") {
      out.push({ ...att, storage_path: op, original_path: op } as T); // non-statement — clean original
      continue;
    }
    const cp = await getOrCreateWatermarkedCopy(db, row);
    if (!cp.ok) {
      failures.push({ filename: att.filename, storage_path: att.storage_path, reason: cp.error });
      out.push(shopOutCleanFallback(att, op, cp.error));
      continue;
    }
    // Retarget filename + mime to the branded copy. The watermarker can change
    // the container (HEIC/GIF flatten to JPEG), and the attachment previously
    // kept the SOURCE mime/extension while storage_path pointed at the derived
    // copy — so a lender could receive `statement.heic` holding JPEG bytes.
    const ext = wmCopyExtension(cp.mimeType);
    out.push({
      ...att,
      storage_path: cp.wmPath,
      original_path: op,
      filename: retargetFilename(att.filename, ext),
      ...(typeof (att as { mime_type?: unknown }).mime_type === "string"
        ? { mime_type: cp.mimeType }
        : {}),
      watermark_status: "applied",
      watermark_error: null,
    } as T);
  }
  return { ok: failures.length === 0, attachments: out, failures };
}

/**
 * Retry-path door guard: the lender-thread retry endpoints re-fire
 * shop_out_send_batch over each thread's persisted attachments
 * (application_lender_threads.attachments, migration 065). Re-resolve each
 * thread's bank-statement attachments to their CURRENT watermarked copy and
 * write the rewritten attachments back, so a retry re-sends the branded copy
 * (and heals a PRE-FEATURE thread whose attachment is still a clean original).
 * Same best-effort contract: persist branded paths when available, otherwise
 * persist the clean fallback and let the retry continue.
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
    .select("id, attachments")
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
  const failures: Array<{ filename: string; storage_path: string; reason: string }> = [];
  let branded = 0;
  for (const thread of (res.data || []) as Array<{ id: string; attachments?: unknown }>) {
    const arr = (Array.isArray(thread.attachments) ? thread.attachments : []) as ShopOutAttachmentBase[];
    if (arr.length === 0) continue;
    const r = await watermarkAttachmentsForShopOut(tenantId, arr);
    if (!r.ok) failures.push(...r.failures);
    const upd = await db
      .from("application_lender_threads")
      .update({ attachments: r.attachments })
      .eq("id", thread.id)
      .eq("tenant_id", tenantId);
    if (upd.error) failures.push({ filename: "(thread)", storage_path: "", reason: `thread_update_failed: ${upd.error.message}` });
    else branded += 1;
  }
  return { ok: failures.length === 0, branded, failures };
}

/**
 * Pick which physical object to serve for the OPERATOR view/download, based on
 * the duplicate-file model (2026-06-29): every clean statement keeps both a clean
 * original (`storage_path`) and a watermarked copy (`metadata.shopout_wm_path`).
 * `metadata.active_variant` ("clean" | "watermarked", default clean) chooses.
 * Safe degradation: watermarked-requested-but-no-copy → serve clean. Legacy baked
 * rows (`watermarked_at`) have no clean original — their `storage_path` IS the
 * watermarked file. NOTE: lenders (shop-out) + FundMate do NOT use this — they
 * always send the watermarked copy / always read the clean original respectively.
 */
export function resolveActiveStoragePath(row: {
  storage_path: string;
  metadata: Record<string, unknown> | null;
}): { path: string; variant: "clean" | "watermarked"; is_watermarked: boolean; raster: boolean } {
  const meta = (row.metadata || {}) as Record<string, unknown>;
  if (meta.watermarked_at) {
    return { path: row.storage_path, variant: "watermarked", is_watermarked: true, raster: true };
  }
  const wmPath = typeof meta.shopout_wm_path === "string" ? (meta.shopout_wm_path as string) : null;
  if (meta.active_variant === "watermarked" && wmPath) {
    return { path: wmPath, variant: "watermarked", is_watermarked: true, raster: meta.shopout_wm_raster === true };
  }
  return { path: row.storage_path, variant: "clean", is_watermarked: false, raster: false };
}

export type SetVariantResult =
  | { ok: true; active: "clean" | "watermarked"; is_watermarked: boolean; raster?: boolean }
  | { ok: true; state: "legacy_baked"; clean_available: false; message: string }
  | { ok: false; error: string };

/**
 * Toggle which variant of a stored statement is "active" for the operator
 * (2026-06-29, Adon ask: "watermark it or unwatermark it … keeping duplicate
 * files"). KEEPS BOTH copies — flipping is instant + infinitely reversible.
 *  - target "watermarked": ensure the watermarked duplicate exists, flip active.
 *  - target "clean": flip active to the clean original (the wm copy stays).
 *  - LEGACY baked + target "clean": no clean original exists → return
 *    `legacy_baked` so the UI shows a re-upload prompt (no lossy guessing).
 * Fail-closed: any storage/db error returns { ok:false }.
 */
export async function setLeadDocumentVariant(
  db: ReturnType<typeof getServiceSupabase>,
  row: {
    id: string;
    tenant_id: string;
    lead_id: string;
    storage_path: string;
    mime_type: string | null;
    metadata: Record<string, unknown> | null;
  },
  target: "clean" | "watermarked",
  toggledBy?: string | null,
): Promise<SetVariantResult> {
  const meta = (row.metadata || {}) as Record<string, unknown>;

  if (meta.watermarked_at) {
    if (target === "clean") {
      return {
        ok: true,
        state: "legacy_baked",
        clean_available: false,
        message:
          "This statement was watermarked before the clean-storage fix, so the clean original is gone. Re-upload it to get a clean version.",
      };
    }
    return { ok: true, active: "watermarked", is_watermarked: true, raster: true };
  }

  if (target === "watermarked") {
    const cp = await getOrCreateWatermarkedCopy(db, {
      id: row.id, tenant_id: row.tenant_id, lead_id: row.lead_id,
      storage_path: row.storage_path, mime_type: row.mime_type, metadata: meta,
    });
    if (!cp.ok) return { ok: false, error: cp.error };
    // Re-read metadata so we don't clobber the shopout_wm_* stamps the copy just wrote.
    const fresh = await db.from("lead_documents").select("metadata").eq("id", row.id).maybeSingle();
    const freshMeta = ((fresh.data as { metadata?: Record<string, unknown> } | null)?.metadata) || meta;
    const upd = await db
      .from("lead_documents")
      .update({
        metadata: { ...freshMeta, active_variant: "watermarked", variant_toggled_at: new Date().toISOString(), variant_toggled_by: toggledBy || null },
      })
      .eq("id", row.id);
    if (upd.error) return { ok: false, error: `variant_set_failed: ${upd.error.message}` };
    return { ok: true, active: "watermarked", is_watermarked: true, raster: cp.raster };
  }

  // target "clean" — keep the watermarked copy, just flip the active pointer.
  const upd = await db
    .from("lead_documents")
    .update({
      metadata: { ...meta, active_variant: "clean", variant_toggled_at: new Date().toISOString(), variant_toggled_by: toggledBy || null },
    })
    .eq("id", row.id);
  if (upd.error) return { ok: false, error: `variant_set_failed: ${upd.error.message}` };
  return { ok: true, active: "clean", is_watermarked: false };
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
