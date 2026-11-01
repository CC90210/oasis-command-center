import "server-only";
import { createHash } from "node:crypto";
import type { InStatement } from "@libsql/client";
import type { RunnerDeps } from "./runner-handlers";
import { toolsJson, toolsRefuse } from "./runner-auth";
import { jobInTenants, jobUnderLease, LEASE_GUARD, sqlPlaceholders, toolTablesInstalled } from "./store";
import { MARKETING_MEDIA_BUCKET, MAX_VIDEO_BYTES } from "./limits";
import { parseContentResult, remixManifest, contentUploadPaths, type ContentToolKey, type RemixUpload } from "./content-results";

type Ref = { jobId: string; leaseId: string; runnerKey: string; tenantIds: readonly string[] };
const invalid = (field: string) => toolsRefuse(422, "invalid_payload", { field });
const lost = () => toolsRefuse(409, "lease_lost");
const object = (v: unknown): Record<string, unknown> | null => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
const uuidFor = (job: string, i: number) => {
  const h = createHash("sha256").update(`content-remix:${job}:${i}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

async function repeat(ref: Ref, tool: ContentToolKey, deps: RunnerDeps) {
  const job = await jobInTenants(deps.db, ref.tenantIds, ref.jobId);
  return job?.status === "done" && job.toolKey === tool && job.claimedBy === ref.runnerKey && job.leaseId === ref.leaseId
    ? toolsJson(200, { ok: true, duplicate: true, result: job.result, asset_id: job.assetId }) : lost();
}

/** Reserve all three files together; each lease gets new paths so stale PUT URLs cannot corrupt its successor. */
export async function handleContentUpload(ref: Ref, body: Record<string, unknown>, deps: RunnerDeps): Promise<Response> {
  if (!(await toolTablesInstalled(deps.db))) return toolsRefuse(503, "not_installed", { detail: "tables_missing" });
  if (!deps.storage) return toolsRefuse(503, "not_installed", { detail: "storage_not_configured" });
  const job = await jobUnderLease(deps.db, ref);
  if (!job) return lost();
  if (job.toolKey !== "video_remix") return invalid("job_id");
  if (!Array.isArray(body.files) || body.files.length !== 3) return invalid("files");
  const files: RemixUpload[] = [];
  for (const [i, raw] of body.files.entries()) {
    const f = object(raw);
    if (!f || !Number.isInteger(f.size_bytes) || Number(f.size_bytes) < 1 || Number(f.size_bytes) > MAX_VIDEO_BYTES ||
        typeof f.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(f.sha256) || typeof f.md5 !== "string" || !/^[a-f0-9]{32}$/.test(f.md5)) return invalid("files");
    const assetId = uuidFor(job.id, i);
    files.push({ asset_id: assetId, storage_path: `${job.tenantId}/${assetId}/${ref.leaseId}/clip-${i + 1}.mp4`,
      size_bytes: Number(f.size_bytes), sha256: f.sha256, md5: f.md5, title: `Vertical cut ${i + 1}` });
  }
  const previous = remixManifest(job.result);
  if (previous?.lease_id === ref.leaseId && JSON.stringify(previous.pending_uploads) !== JSON.stringify(files)) return toolsRefuse(409, "upload_conflict");
  const retired = previous?.lease_id === ref.leaseId ? previous.retired_uploads ?? [] : contentUploadPaths(job.result);
  const manifest = JSON.stringify({ pending_uploads: files, lease_id: ref.leaseId, retired_uploads: [...new Set(retired)] });
  const rs = await deps.db.execute({
    sql: `UPDATE tool_jobs SET result_json = ?, upload_path = ?, updated_at = ?
          WHERE ${LEASE_GUARD} AND tenant_id IN (${sqlPlaceholders(ref.tenantIds.length)}) AND result_json IS ?`,
    args: [manifest, files[0].storage_path, deps.now.toISOString(), ref.jobId, ref.runnerKey, ref.leaseId, ...ref.tenantIds,
      job.result === null ? null : JSON.stringify(job.result)],
  });
  if (rs.rowsAffected !== 1) return lost();
  const uploads = [];
  try {
    for (const f of files) uploads.push({ ...f, upload: { url: (await deps.storage.createSignedUploadUrl(f.storage_path)).signedUrl,
      headers: { "content-type": "video/mp4" } } });
  } catch {
    // Keep the reserved manifest for retry; never log a possibly signed URL.
    console.error("[tools.content-upload] presign failed", { jobId: job.id });
    return toolsRefuse(500, "upload_url_failed");
  }
  return toolsJson(200, { ok: true, uploads });
}

export async function handleContentComplete(ref: Ref, tool: ContentToolKey, body: Record<string, unknown>, deps: RunnerDeps): Promise<Response> {
  if (!(await toolTablesInstalled(deps.db))) return toolsRefuse(503, "not_installed", { detail: "tables_missing" });
  const job = await jobUnderLease(deps.db, ref);
  if (!job) return repeat(ref, tool, deps);
  if (job.toolKey !== tool) return invalid("tool_key");
  const at = deps.now.toISOString();
  const guard = `${LEASE_GUARD} AND tenant_id IN (${sqlPlaceholders(ref.tenantIds.length)})`;
  const args = [ref.jobId, ref.runnerKey, ref.leaseId, ...ref.tenantIds];
  if (tool !== "video_remix") {
    const result = parseContentResult(tool, body.result);
    if (!result) return invalid("result");
    const rs = await deps.db.execute({ sql: `UPDATE tool_jobs SET status = 'done', stage = NULL, result_json = ?, finished_at = ?, updated_at = ?, error_code = NULL, error_message = NULL WHERE ${guard}`,
      args: [JSON.stringify(result), at, at, ...args] });
    return rs.rowsAffected === 1 ? toolsJson(200, { ok: true, duplicate: false }) : repeat(ref, tool, deps);
  }
  const manifest = remixManifest(job.result);
  if (!manifest || manifest.lease_id !== ref.leaseId || !Array.isArray(body.clips) || body.clips.length !== 3) return invalid("clips");
  if (!deps.storage) return toolsRefuse(503, "not_installed", { detail: "storage_not_configured" });
  const statements: InStatement[] = [];
  const result: Array<{ asset_id: string; title: string; duration_s: number }> = [];
  for (const [i, f] of manifest.pending_uploads.entries()) {
    const clip = object(body.clips[i]);
    if (!clip || clip.storage_path !== f.storage_path || !Number.isFinite(clip.duration_s) || Number(clip.duration_s) <= 0 || Number(clip.duration_s) > 90 ||
        clip.width !== 1080 || clip.height !== 1920 || clip.captions !== true) return invalid("clips");
    if (!f.storage_path.startsWith(`${job.tenantId}/${f.asset_id}/`)) return invalid("storage_path");
    let head: Awaited<ReturnType<NonNullable<RunnerDeps["storage"]>["info"]>>;
    try {
      head = await deps.storage.info(f.storage_path);
    } catch {
      // No asset statements run until every object has been verified.
      console.error("[tools.content-complete] storage HEAD failed", { jobId: job.id, clip: i + 1 });
      return toolsRefuse(500, "complete_failed");
    }
    if (!head || Number(head.size) !== f.size_bytes || (head.etag ?? "").replace(/"/g, "").toLowerCase() !== f.md5) return toolsRefuse(422, "upload_mismatch");
    const holds = `EXISTS (SELECT 1 FROM tool_jobs WHERE ${guard} AND result_json = ?)`;
    const leaseArgs = [...args, JSON.stringify(job.result)];
    const meta = JSON.stringify({ tool, tool_job_id: job.id, rights_status: "unknown", source: { url: job.input.url }, captions: true, file: { sha256: f.sha256, md5: f.md5 } });
    statements.push({ sql: `INSERT INTO marketing_asset (id, tenant_id, title, channel, format, status, source, author_agent, author_email,
      brand_slug, brand_name, asset_type, media_urls, slide_count, platforms, duration_s, meta, created_at, updated_at)
      SELECT ?, ?, ?, 'organic-instagram', 'video', 'draft', ?, 'human', ?, 'downloads', 'Downloads', 'video', '[]', 1, '[]', ?, ?, ?, ?
      WHERE ${holds} AND NOT EXISTS (SELECT 1 FROM marketing_asset WHERE tenant_id = ? AND id = ?)`,
      args: [f.asset_id, job.tenantId, f.title, `tool:video_remix:${job.id}:${i}`, job.createdByEmail || `profile:${job.createdBy}`, Number(clip.duration_s), meta, at, at, ...leaseArgs, job.tenantId, f.asset_id] });
    statements.push({ sql: `INSERT INTO marketing_asset_media (tenant_id, asset_id, kind, storage_bucket, storage_path, mime, bytes, width, height, label, created_at)
      SELECT ?, ?, 'video', ?, ?, 'video/mp4', ?, 1080, 1920, ?, ? WHERE ${holds}
      AND NOT EXISTS (SELECT 1 FROM marketing_asset_media WHERE tenant_id = ? AND asset_id = ? AND storage_path = ?)`,
      args: [job.tenantId, f.asset_id, MARKETING_MEDIA_BUCKET, f.storage_path, f.size_bytes, f.title, at, ...leaseArgs, job.tenantId, f.asset_id, f.storage_path] });
    result.push({ asset_id: f.asset_id, title: f.title, duration_s: Number(clip.duration_s) });
  }
  statements.push({ sql: `UPDATE tool_jobs SET status = 'done', stage = NULL, result_json = ?, asset_id = ?, finished_at = ?, updated_at = ?, error_code = NULL, error_message = NULL WHERE ${guard} AND result_json = ?`,
    args: [JSON.stringify({ clips: result, retired_uploads: manifest.retired_uploads ?? [] }), result[0].asset_id, at, at, ...args, JSON.stringify(job.result)] });
  const rs = await deps.db.batch(statements, "write");
  return rs.at(-1)?.rowsAffected === 1 ? toolsJson(200, { ok: true, duplicate: false, result: { clips: result } }) : repeat(ref, tool, deps);
}

/** Wait out every old signed URL before deleting superseded attempts; failed deletes stay queued. */
export async function sweepRetiredContentUploads(deps: RunnerDeps, tenantIds: readonly string[]): Promise<void> {
  if (!deps.storage || !tenantIds.length) return;
  const cutoff = new Date(deps.now.getTime() - 16 * 60 * 1000).toISOString();
  const rows = await deps.db.execute({
    sql: `SELECT id, tenant_id, status, result_json FROM tool_jobs WHERE tenant_id IN (${sqlPlaceholders(tenantIds.length)})
      AND tool_key = 'video_remix' AND status IN ('done','failed') AND finished_at < ?
      AND (result_json LIKE '%"retired_uploads"%' OR result_json LIKE '%"pending_uploads"%') LIMIT 50`,
    args: [...tenantIds, cutoff],
  });
  for (const row of rows.rows) {
    let result: Record<string, unknown>;
    try { result = JSON.parse(String(row.result_json)); } catch { continue; }
    const retired = row.status === "failed" ? contentUploadPaths(result) : Array.isArray(result.retired_uploads) ? result.retired_uploads : [];
    for (const path of retired) {
      if (typeof path !== "string" || !path.startsWith(`${row.tenant_id}/`) || path.includes("..")) throw new Error("Invalid retired content upload path");
      await deps.storage.remove(path);
    }
    delete result.retired_uploads;
    if (row.status === "failed") delete result.pending_uploads;
    await deps.db.execute({ sql: "UPDATE tool_jobs SET result_json = ? WHERE id = ? AND tenant_id = ? AND status IN ('done','failed') AND result_json = ?",
      args: [JSON.stringify(result), String(row.id), String(row.tenant_id), String(row.result_json)] });
  }
}
