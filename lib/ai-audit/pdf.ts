/**
 * lib/ai-audit/pdf.ts — the PDF, printed on CC's Mac from the same page the
 * client sees.
 *
 * WHY THE MAC. The Worker has no browser. CC chose "private web page + PDF,
 * both from the same data": the page IS the template, and the Mac runner
 * (CEO-Agent scripts/ai_audit/runner.py, a system runner tool) opens a signed,
 * fifteen-minute render address of the exact version (link.ts
 * signRenderPath), prints it with Playwright and posts the bytes back. The PDF
 * is stored privately (R2 prefix ai-audits/, never a public bucket) and its
 * sha256 recorded on the version; CC's final approval binds to that hash.
 *
 * THE JOB carries only ids and the content hash. The render address is signed
 * at claim time (runner-handlers), so a job row never holds a usable URL.
 */
import "server-only";
import type { Client } from "@libsql/client";
import { inputHashOf } from "@/lib/tools/store";
import { r2Configured, r2StorageSurface } from "@/lib/r2-storage";
import { newId, sha256Hex } from "@/lib/ai-audit/hash";
import { getAuditVersion } from "@/lib/ai-audit/versions";
import { requireTenant } from "@/lib/ai-audit/store";

export const PDF_TOOL_KEY = "ai_audit_pdf" as const;
export const PDF_BUCKET = "ai-audits";
/** A whole audit prints to well under this; a bigger file is a runner bug. */
export const PDF_MAX_BYTES = 1_500_000;

export function pdfStoragePath(tenantId: string, engagementId: string, versionId: string): string {
  return `${tenantId}/${engagementId}/${versionId}.pdf`;
}

/** The private R2 prefix the PDFs live under, or null when R2 is not configured. */
export function r2PdfStorage(): PdfStorage | null {
  if (!r2Configured()) return null;
  const bucket = r2StorageSurface().from(PDF_BUCKET);
  return {
    async upload(path, bytes) {
      const r = await bucket.upload(path, bytes, { contentType: "application/pdf", upsert: true });
      return r.error ? { ok: false, error: r.error.message } : { ok: true };
    },
    async download(path) {
      const r = await bucket.download(path);
      if (r.error || !r.data) return null;
      return new Uint8Array(await r.data.arrayBuffer());
    },
  };
}

/** Queue the print of one awaiting-approval version, once (the dedupe key holds while it is in flight). */
export async function queuePdfJob(
  db: Client,
  input: { tenantId: string; engagementId: string; auditVersionId: string; contentSha256: string; now: Date },
): Promise<boolean> {
  const t = requireTenant(input.tenantId);
  const at = input.now.toISOString();
  const jobInput = { engagement_id: input.engagementId, audit_version_id: input.auditVersionId, content_sha256: input.contentSha256 };
  const dedupe = `${PDF_TOOL_KEY}:${input.auditVersionId}`;
  const r = await db.execute({
    sql: `INSERT INTO tool_jobs (id, tenant_id, tool_key, runs_on, status, input_json, input_hash, idempotency_key, dedupe_key, created_by, created_by_email, created_at, updated_at)
          SELECT ?, ?, ?, 'runner', 'queued', ?, ?, NULL, ?, NULL, NULL, ?, ?
          WHERE NOT EXISTS (SELECT 1 FROM tool_jobs WHERE tenant_id = ? AND dedupe_key = ? AND status IN ('queued', 'claimed', 'running'))
            AND EXISTS (SELECT 1 FROM ai_audit_versions WHERE tenant_id = ? AND id = ? AND status = 'awaiting_approval' AND pdf_sha256 IS NULL)`,
    args: [newId(), t, PDF_TOOL_KEY, JSON.stringify(jobInput), inputHashOf(PDF_TOOL_KEY, jobInput), dedupe, at, at, t, dedupe, t, input.auditVersionId],
  });
  return r.rowsAffected === 1;
}

export type PdfReport = { pdfBase64: string; sha256: string; bytes: number; pages: number };

/** The runner's report, checked field by field. */
export function parsePdfReport(b: Record<string, unknown>): { ok: true; value: PdfReport } | { ok: false; field: string } {
  if (typeof b.pdf_base64 !== "string" || b.pdf_base64.length < 100 || b.pdf_base64.length > Math.ceil((PDF_MAX_BYTES * 4) / 3) + 8) return { ok: false, field: "pdf_base64" };
  if (typeof b.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(b.sha256)) return { ok: false, field: "sha256" };
  if (typeof b.bytes !== "number" || !Number.isInteger(b.bytes) || b.bytes < 100 || b.bytes > PDF_MAX_BYTES) return { ok: false, field: "bytes" };
  if (typeof b.pages !== "number" || !Number.isInteger(b.pages) || b.pages < 1 || b.pages > 200) return { ok: false, field: "pages" };
  return { ok: true, value: { pdfBase64: b.pdf_base64, sha256: b.sha256, bytes: b.bytes, pages: b.pages } };
}

export type PdfStorage = {
  /** Overwrites: a retried print replaces an earlier attempt's bytes, so the stored file always matches the recorded hash. */
  upload(path: string, bytes: Uint8Array): Promise<{ ok: true } | { ok: false; error: string }>;
  download(path: string): Promise<Uint8Array | null>;
};

/**
 * Store the printed PDF and stamp the version, only if it is still the version
 * the job printed (awaiting approval, same content hash, no PDF yet). Bytes are
 * checked against the reported hash and must be a PDF.
 */
export async function storePdf(
  db: Client,
  storage: PdfStorage | null,
  input: { tenantId: string; jobInput: Record<string, unknown>; report: PdfReport; now: Date },
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const t = requireTenant(input.tenantId);
  const versionId = typeof input.jobInput.audit_version_id === "string" ? input.jobInput.audit_version_id : "";
  const expectedSha = typeof input.jobInput.content_sha256 === "string" ? input.jobInput.content_sha256 : "";
  const version = versionId ? await getAuditVersion(db, t, versionId) : null;
  if (!version || version.status !== "awaiting_approval" || version.content_sha256 !== expectedSha) return { ok: false, error: "version_moved_on" };
  if (version.pdf_sha256) return version.pdf_sha256 === input.report.sha256 ? { ok: true, path: version.pdf_path ?? "" } : { ok: false, error: "pdf_already_stored" };
  const bytes = Uint8Array.from(Buffer.from(input.report.pdfBase64, "base64"));
  if (bytes.byteLength !== input.report.bytes) return { ok: false, error: "pdf_size_mismatch" };
  if (sha256Hex(bytes) !== input.report.sha256) return { ok: false, error: "pdf_hash_mismatch" };
  if (Buffer.from(bytes.subarray(0, 5)).toString("latin1") !== "%PDF-") return { ok: false, error: "not_a_pdf" };
  if (!storage) return { ok: false, error: "storage_not_configured" };
  const path = pdfStoragePath(t, version.engagement_id, version.id);
  const up = await storage.upload(path, bytes);
  if (!up.ok) return { ok: false, error: `storage: ${up.error.slice(0, 120)}` };
  const at = input.now.toISOString();
  const r = await db.execute({
    sql: `UPDATE ai_audit_versions SET pdf_path = ?, pdf_sha256 = ?, pdf_bytes = ?, pdf_pages = ?, pdf_rendered_at = ?, updated_at = ?
          WHERE tenant_id = ? AND id = ? AND status = 'awaiting_approval' AND content_sha256 = ? AND pdf_sha256 IS NULL`,
    args: [path, input.report.sha256, input.report.bytes, input.report.pages, at, at, t, version.id, expectedSha],
  });
  return r.rowsAffected === 1 ? { ok: true, path } : { ok: false, error: "version_moved_on" };
}
