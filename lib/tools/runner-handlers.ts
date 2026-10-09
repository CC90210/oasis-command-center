/**
 * lib/tools/runner-handlers.ts - the five routes a tool runner calls
 * (claim, heartbeat, upload-url, complete, fail), as plain handlers taking
 * {db, env, now, storage} so tests drive them with a local database and a fake
 * object store. The routes under app/api/internal/tools/ are thin wrappers.
 *
 * ONE DOWNLOAD, END TO END
 *   claim       the runner checks in (tool_runners) and takes the oldest job
 *               of OASIS's own workspaces, with a lease (lib/tools/store.ts)
 *   heartbeat   every 60 s while it works: the lease is extended, the stage
 *               (downloading, uploading) shown on the card
 *   upload-url  the file's size and hashes are recorded; the server reserves
 *               the Library asset id and the storage path ONCE per job (a retry
 *               overwrites the same object) and answers a presigned PUT for that
 *               one object, valid 15 minutes. The bytes go from the computer
 *               straight to storage: the Worker never holds a video.
 *   complete    the server HEADs the object: it must exist, with the recorded
 *               size and an ETag equal to the recorded MD5. Then ONE transaction
 *               writes the Library asset, its video media row and the job's
 *               "done", the job's update last and guarded on the lease, so a
 *               lost lease writes nothing.
 *   fail        the job ends with the runner's code; an uploaded object is
 *               deleted (a failed delete is logged, never the answer).
 *
 * WHO. The producer `bea` serves OASIS's own workspaces only
 * (OASIS_INTERNAL_TENANT_IDS, as the Business Ledger's PRODUCER_TENANTS does):
 * a client workspace's job is never claimable by this runner, and every report
 * is guarded on this runner and this lease. No tenant id is ever sent to the
 * runner, and none is read from its body.
 *
 * WHERE THE VIDEO GOES. A third-party video with unknown rights: brand
 * `downloads` (its own Library tab, never OASIS's own counts), status draft,
 * meta.rights_status "unknown". The founders publish route refuses any brand
 * but OASIS's own, so a download cannot be posted from OASIS's accounts.
 */
import "server-only";
import { randomUUID } from "node:crypto";
import type { Client, InStatement } from "@libsql/client";
import { OASIS_INTERNAL_TENANT_IDS } from "@/lib/ai/tools/client-safe-registry";
import { r2Configured, r2StorageSurface } from "@/lib/r2-storage";
import { pathBelongsToTenant, sanitizeStorageFilename } from "@/lib/storage-helpers";
import { isRunnerCodeShape, storedRunnerCode, toolErrorLine } from "@/lib/tools/errors";
import {
  HEARTBEAT_SECONDS,
  LEASE_SECONDS,
  MARKETING_MEDIA_BUCKET,
  MAX_VIDEO_BYTES,
  POLL_AFTER_SECONDS,
  RUN_TIMEOUT_SECONDS,
  UPLOAD_URL_TTL_SECONDS,
} from "@/lib/tools/limits";
import { runnerToolKeys } from "@/lib/tools/registry";
import { authenticateToolsRequest, toolsJson, toolsRefuse, type ToolsProducer } from "@/lib/tools/runner-auth";
import {
  LEASE_GUARD,
  claimNextJob,
  jobInTenants,
  jobUnderLease,
  newLeaseId,
  sqlPlaceholders,
  sweepToolJobs,
  toolTablesInstalled,
  touchRunner,
  upsertRunner,
  type ToolJob,
} from "@/lib/tools/store";

/** The object store, as much of it as the runner routes use (lib/r2-storage.ts in production). */
export type ToolStorage = {
  createSignedUploadUrl(path: string): Promise<{ signedUrl: string }>;
  /** null: no such object. Throws when the store could not be asked. */
  info(path: string): Promise<{ size: number; etag: string | null } | null>;
  remove(path: string): Promise<void>;
};

export type RunnerDeps = {
  db: Client;
  env: Record<string, string | undefined>;
  now: Date;
  /** null: R2 is not configured, so nothing can be uploaded (never the Supabase fallback). */
  storage: ToolStorage | null;
};

/** The workspaces each producer's runner serves. OASIS's own, for now. */
export const PRODUCER_TENANTS: Readonly<Record<ToolsProducer, readonly string[]>> = {
  bea: [...OASIS_INTERNAL_TENANT_IDS],
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LEASE_RE = /^[0-9a-f]{32}$/;
const RUNNER_ID_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const MD5_RE = /^[0-9a-f]{32}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

const PLATFORMS: Readonly<Record<string, { name: string; channel: string }>> = {
  instagram: { name: "Instagram", channel: "organic-instagram" },
  tiktok: { name: "TikTok", channel: "organic-tiktok" },
  youtube: { name: "YouTube", channel: "organic-youtube" },
};

const invalid = (field: string, extra: Record<string, unknown> = {}) => toolsRefuse(422, "invalid_payload", { field, ...extra });
const notInstalled = (detail: string) => toolsRefuse(503, "not_installed", { detail });
const leaseLost = () => toolsRefuse(409, "lease_lost");

type Ident = { runnerKey: string; tenantIds: readonly string[] };
type LeaseRef = Ident & { jobId: string; leaseId: string };

function runnerIdent(producer: ToolsProducer, body: Record<string, unknown>): Ident | null {
  const id = body.runner_id;
  if (typeof id !== "string" || !RUNNER_ID_RE.test(id)) return null;
  return { runnerKey: `${producer}:${id}`, tenantIds: PRODUCER_TENANTS[producer] };
}

/** runner_id, job_id and lease_id, or the field that is wrong. */
function leaseRef(producer: ToolsProducer, body: Record<string, unknown>): LeaseRef | { field: string } {
  const ident = runnerIdent(producer, body);
  if (!ident) return { field: "runner_id" };
  if (typeof body.job_id !== "string" || !UUID_RE.test(body.job_id)) return { field: "job_id" };
  if (typeof body.lease_id !== "string" || !LEASE_RE.test(body.lease_id)) return { field: "lease_id" };
  return { ...ident, jobId: body.job_id, leaseId: body.lease_id };
}

function shortText(v: unknown, max: number): string | null {
  return typeof v === "string" && v.length >= 1 && v.length <= max && !CONTROL_RE.test(v) ? v : null;
}

/** Delete objects nothing points at. Best effort: a failure is logged, never thrown. */
async function removeQuietly(storage: ToolStorage | null, paths: Array<{ tenantId: string; path: string }>, where: string): Promise<void> {
  if (!storage) return;
  for (const p of paths) {
    if (!pathBelongsToTenant(p.tenantId, p.path)) continue;
    try {
      await storage.remove(p.path);
    } catch (err) {
      console.error(`[tools.${where}] could not delete an unused upload`, {
        tenantId: p.tenantId,
        path: p.path,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

// ---------------------------------------------------------------------------
// claim
// ---------------------------------------------------------------------------

export async function handleToolsClaim(req: Request, deps: RunnerDeps): Promise<Response> {
  const auth = await authenticateToolsRequest(req, deps.env, deps.now);
  if (!auth.ok) return auth.response;
  const b = auth.body;
  const ident = runnerIdent(auth.producer, b);
  if (!ident) return invalid("runner_id");
  const label = shortText(b.label, 60);
  if (!label || !label.trim()) return invalid("label");
  const version = shortText(b.version, 20);
  if (!version) return invalid("version");
  const allowed = runnerToolKeys() as readonly string[];
  if (!Array.isArray(b.tools) || b.tools.length === 0 || b.tools.length > 20 || !b.tools.every((t) => typeof t === "string" && allowed.includes(t))) {
    return invalid("tools");
  }
  const tools = [...new Set(b.tools as string[])];
  if (!(await toolTablesInstalled(deps.db))) return notInstalled("tables_missing");

  await upsertRunner(deps.db, { tenantIds: ident.tenantIds, runnerKey: ident.runnerKey, label: label.trim(), tools, version, now: deps.now });
  const swept = await sweepToolJobs(deps.db, ident.tenantIds, deps.now);
  await removeQuietly(deps.storage, swept.orphanUploads, "claim.sweep");

  const leaseId = newLeaseId();
  const job = await claimNextJob(deps.db, { tenantIds: ident.tenantIds, toolKeys: tools, runnerKey: ident.runnerKey, leaseId, now: deps.now });
  if (!job) return toolsJson(200, { ok: true, job: null, poll_after_seconds: POLL_AFTER_SECONDS });
  return toolsJson(200, {
    ok: true,
    poll_after_seconds: 0,
    job: {
      job_id: job.id,
      lease_id: leaseId,
      tool_key: job.toolKey,
      attempt: job.attempt,
      // Only what the tool needs: the link and its platform. Never the workspace.
      input: { url: job.input.url, platform: job.input.platform },
      limits: {
        max_bytes: MAX_VIDEO_BYTES,
        lease_seconds: LEASE_SECONDS,
        heartbeat_seconds: HEARTBEAT_SECONDS,
        run_timeout_seconds: RUN_TIMEOUT_SECONDS,
      },
      created_at: job.createdAt,
    },
  });
}

// ---------------------------------------------------------------------------
// heartbeat
// ---------------------------------------------------------------------------

export async function handleToolsHeartbeat(req: Request, deps: RunnerDeps): Promise<Response> {
  const auth = await authenticateToolsRequest(req, deps.env, deps.now);
  if (!auth.ok) return auth.response;
  const ref = leaseRef(auth.producer, auth.body);
  if ("field" in ref) return invalid(ref.field);
  const stage = auth.body.stage;
  if (stage !== "downloading" && stage !== "uploading") return invalid("stage");
  if (!(await toolTablesInstalled(deps.db))) return notInstalled("tables_missing");

  const at = deps.now.toISOString();
  const expires = new Date(deps.now.getTime() + LEASE_SECONDS * 1000).toISOString();
  const rs = await deps.db.execute({
    sql: `UPDATE tool_jobs SET status = 'running', stage = ?, heartbeat_at = ?, lease_expires_at = ?, updated_at = ?
          WHERE ${LEASE_GUARD} AND tenant_id IN (${sqlPlaceholders(ref.tenantIds.length)})`,
    args: [stage, at, expires, at, ref.jobId, ref.runnerKey, ref.leaseId, ...ref.tenantIds],
  });
  if (rs.rowsAffected !== 1) return leaseLost();
  await touchRunner(deps.db, ref.tenantIds, ref.runnerKey, deps.now);
  return toolsJson(200, { ok: true, lease_expires_at: expires });
}

// ---------------------------------------------------------------------------
// upload-url
// ---------------------------------------------------------------------------

/** The object name: the runner's file name, sanitized, always ending .mp4. */
function objectName(fileName: string): string {
  const clean = sanitizeStorageFilename(fileName).slice(0, 116);
  return /\.mp4$/i.test(clean) ? clean : `${clean}.mp4`;
}

export async function handleToolsUploadUrl(req: Request, deps: RunnerDeps): Promise<Response> {
  const auth = await authenticateToolsRequest(req, deps.env, deps.now);
  if (!auth.ok) return auth.response;
  const b = auth.body;
  const ref = leaseRef(auth.producer, b);
  if ("field" in ref) return invalid(ref.field);
  const fileName = shortText(b.file_name, 255);
  if (!fileName) return invalid("file_name");
  const size = b.size_bytes;
  if (typeof size !== "number" || !Number.isInteger(size) || size < 1 || size > MAX_VIDEO_BYTES) {
    return invalid("size_bytes", { max_bytes: MAX_VIDEO_BYTES });
  }
  if (typeof b.sha256 !== "string" || !SHA256_RE.test(b.sha256)) return invalid("sha256");
  if (typeof b.md5 !== "string" || !MD5_RE.test(b.md5)) return invalid("md5");
  if (b.content_type !== "video/mp4") return invalid("content_type");
  if (!(await toolTablesInstalled(deps.db))) return notInstalled("tables_missing");
  if (!deps.storage) return notInstalled("storage_not_configured");

  const job = await jobUnderLease(deps.db, ref);
  if (!job) return leaseLost();
  if (job.toolKey !== "video_download") return invalid("job_id");
  const sameFile = job.uploadBytes === size && job.uploadSha256 === b.sha256 && job.uploadMd5 === b.md5;
  // Recorded earlier IN THIS LEASE (a new lease clears these): a different file now is a runner bug.
  if (job.uploadBytes !== null && !sameFile) return toolsRefuse(409, "upload_conflict");

  // Reserved once per job and kept for every later attempt.
  const assetId = job.assetId ?? randomUUID();
  const path = job.uploadPath ?? `${job.tenantId}/${assetId}/${deps.now.getTime()}_${randomUUID()}_${objectName(fileName)}`;
  if (!pathBelongsToTenant(job.tenantId, path) || !path.startsWith(`${job.tenantId}/${assetId}/`)) {
    console.error("[tools.upload-url] refused a storage path outside the job's own folder", { jobId: job.id, tenantId: job.tenantId });
    return toolsRefuse(500, "upload_url_failed");
  }

  const at = deps.now.toISOString();
  const expires = new Date(deps.now.getTime() + LEASE_SECONDS * 1000).toISOString();
  const rs = await deps.db.execute({
    sql: `UPDATE tool_jobs
             SET asset_id = ?, upload_path = ?, upload_bytes = ?, upload_sha256 = ?, upload_md5 = ?,
                 status = 'running', stage = 'uploading', heartbeat_at = ?, lease_expires_at = ?, updated_at = ?
           WHERE ${LEASE_GUARD} AND tenant_id IN (${sqlPlaceholders(ref.tenantIds.length)})
             AND (asset_id IS NULL OR asset_id = ?) AND (upload_path IS NULL OR upload_path = ?)
             AND (upload_bytes IS NULL OR (upload_bytes = ? AND upload_sha256 = ? AND upload_md5 = ?))`,
    args: [
      assetId, path, size, b.sha256, b.md5, at, expires, at,
      ref.jobId, ref.runnerKey, ref.leaseId, ...ref.tenantIds,
      assetId, path, size, b.sha256, b.md5,
    ],
  });
  if (rs.rowsAffected !== 1) {
    // Moved since the read: the lease went, or another upload was recorded.
    return (await jobUnderLease(deps.db, ref)) ? toolsRefuse(409, "upload_conflict") : leaseLost();
  }

  let url: string;
  try {
    url = (await deps.storage.createSignedUploadUrl(path)).signedUrl;
  } catch (err) {
    console.error("[tools.upload-url] presign failed", { jobId: job.id, error: err instanceof Error ? err.message : String(err) });
    return toolsRefuse(500, "upload_url_failed");
  }
  return toolsJson(200, {
    ok: true,
    storage_path: path,
    // A bearer credential for ONE object for 15 minutes: never logged, here or on the runner.
    upload: { method: "PUT", url, headers: { "content-type": "video/mp4" }, expires_in: UPLOAD_URL_TTL_SECONDS },
  });
}

// ---------------------------------------------------------------------------
// complete
// ---------------------------------------------------------------------------

type VideoFacts = {
  width: number | null;
  height: number | null;
  duration_s: number | null;
  fps: number | null;
  vcodec: string | null;
  acodec: string | null;
  has_audio: boolean | null;
};

type SourceFacts = {
  platform: string;
  url: string;
  webpage_url: string | null;
  video_id: string | null;
  handle: string | null;
  uploader: string | null;
  uploader_url: string | null;
  channel: string | null;
  title: string | null;
  description: string | null;
  upload_date: string | null;
  view_count: number | null;
  like_count: number | null;
  comment_count: number | null;
  repost_count: number | null;
};

type Parsed<T> = { ok: true; value: T } | { ok: false; field: string };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function optText(v: unknown, max: number): string | null | undefined {
  if (v === null || v === undefined) return null;
  return typeof v === "string" && v.length <= max ? v : undefined;
}

function optHttpUrl(v: unknown): string | null | undefined {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string" || v.length > 2048) return undefined;
  try {
    const u = new URL(v);
    return u.protocol === "https:" || u.protocol === "http:" ? v : undefined;
  } catch {
    return undefined;
  }
}

function optCount(v: unknown): number | null | undefined {
  if (v === null || v === undefined) return null;
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined;
}

function optNumber(v: unknown, min: number): number | null | undefined {
  if (v === null || v === undefined) return null;
  return typeof v === "number" && Number.isFinite(v) && v >= min ? v : undefined;
}

function parseVideo(v: unknown): Parsed<VideoFacts> {
  if (!isObj(v)) return { ok: false, field: "video" };
  const width = optNumber(v.width, 1);
  const height = optNumber(v.height, 1);
  const out = {
    width: width === undefined || (width !== null && !Number.isInteger(width)) ? undefined : width,
    height: height === undefined || (height !== null && !Number.isInteger(height)) ? undefined : height,
    duration_s: optNumber(v.duration_s, 0),
    fps: optNumber(v.fps, 0),
    vcodec: optText(v.vcodec, 40),
    acodec: optText(v.acodec, 40),
    has_audio: v.has_audio === null || v.has_audio === undefined ? null : typeof v.has_audio === "boolean" ? v.has_audio : undefined,
  };
  for (const [k, val] of Object.entries(out)) if (val === undefined) return { ok: false, field: `video.${k}` };
  return { ok: true, value: out as VideoFacts };
}

function parseSource(v: unknown): Parsed<SourceFacts> {
  if (!isObj(v)) return { ok: false, field: "source" };
  const url = optHttpUrl(v.url);
  const out = {
    platform: typeof v.platform === "string" && PLATFORMS[v.platform] ? v.platform : undefined,
    url: url === null ? undefined : url,
    webpage_url: optHttpUrl(v.webpage_url),
    video_id: optText(v.video_id, 120),
    handle: optText(v.handle, 120),
    uploader: optText(v.uploader, 120),
    uploader_url: optHttpUrl(v.uploader_url),
    channel: optText(v.channel, 120),
    title: optText(v.title, 300),
    description: optText(v.description, 600),
    upload_date: v.upload_date === null || v.upload_date === undefined ? null : typeof v.upload_date === "string" && /^\d{8}$/.test(v.upload_date) ? v.upload_date : undefined,
    view_count: optCount(v.view_count),
    like_count: optCount(v.like_count),
    comment_count: optCount(v.comment_count),
    repost_count: optCount(v.repost_count),
  };
  for (const [k, val] of Object.entries(out)) if (val === undefined) return { ok: false, field: `source.${k}` };
  return { ok: true, value: out as SourceFacts };
}

function parseExtractor(v: unknown): Parsed<{ tool_version: string | null; ytdlp_version: string | null }> {
  if (!isObj(v)) return { ok: false, field: "extractor" };
  const tool = optText(v.tool_version, 40);
  const ytdlp = optText(v.ytdlp_version, 40);
  if (tool === undefined) return { ok: false, field: "extractor.tool_version" };
  if (ytdlp === undefined) return { ok: false, field: "extractor.ytdlp_version" };
  return { ok: true, value: { tool_version: tool, ytdlp_version: ytdlp } };
}

/** An ETag as R2 sends it ("<md5>", quoted), as a bare lowercase hex string. */
const normalizedEtag = (etag: string | null) => (etag ?? "").replace(/"/g, "").trim().toLowerCase();

export async function handleToolsComplete(req: Request, deps: RunnerDeps): Promise<Response> {
  const auth = await authenticateToolsRequest(req, deps.env, deps.now);
  if (!auth.ok) return auth.response;
  const b = auth.body;
  const ref = leaseRef(auth.producer, b);
  if ("field" in ref) return invalid(ref.field);
  if (typeof b.storage_path !== "string" || !b.storage_path || b.storage_path.length > 1024) return invalid("storage_path");
  const size = b.size_bytes;
  if (typeof size !== "number" || !Number.isInteger(size) || size < 1 || size > MAX_VIDEO_BYTES) return invalid("size_bytes", { max_bytes: MAX_VIDEO_BYTES });
  if (typeof b.sha256 !== "string" || !SHA256_RE.test(b.sha256)) return invalid("sha256");
  if (typeof b.md5 !== "string" || !MD5_RE.test(b.md5)) return invalid("md5");
  const video = parseVideo(b.video);
  if (!video.ok) return invalid(video.field);
  const source = parseSource(b.source);
  if (!source.ok) return invalid(source.field);
  const extractor = parseExtractor(b.extractor);
  if (!extractor.ok) return invalid(extractor.field);
  if (!(await toolTablesInstalled(deps.db))) return notInstalled("tables_missing");

  const job = await jobUnderLease(deps.db, ref);
  if (!job) return completeRepeatOrLost(deps.db, ref);
  if (job.toolKey !== "video_download") return invalid("job_id");
  // What upload-url recorded IN THIS LEASE, exactly.
  if (!job.uploadPath || !job.assetId || job.uploadPath !== b.storage_path) return invalid("storage_path");
  if (job.uploadBytes !== size) return invalid("size_bytes");
  if (job.uploadSha256 !== b.sha256) return invalid("sha256");
  if (job.uploadMd5 !== b.md5) return invalid("md5");
  const platform = typeof job.input.platform === "string" ? job.input.platform : "";
  if (source.value.platform !== platform || !PLATFORMS[platform]) return invalid("source.platform");
  if (!pathBelongsToTenant(job.tenantId, job.uploadPath)) return toolsRefuse(500, "complete_failed");
  if (!deps.storage) return notInstalled("storage_not_configured");

  // The object must be there, whole: the size recorded, and an ETag equal to the
  // MD5 recorded (a single-part PUT's ETag is its MD5). Nothing is written otherwise.
  let head: { size: number; etag: string | null } | null;
  try {
    head = await deps.storage.info(job.uploadPath);
  } catch (err) {
    console.error("[tools.complete] storage HEAD failed", { jobId: job.id, error: err instanceof Error ? err.message : String(err) });
    return toolsRefuse(500, "complete_failed");
  }
  if (!head) return toolsRefuse(422, "upload_mismatch", { detail: "missing" });
  if (Number(head.size) !== size) return toolsRefuse(422, "upload_mismatch", { detail: "size" });
  if (normalizedEtag(head.etag) !== b.md5) return toolsRefuse(422, "upload_mismatch", { detail: "etag" });

  const statements = completeStatements(job, ref, { size, sha256: b.sha256, md5: b.md5, video: video.value, source: source.value, extractor: extractor.value }, deps.now);
  const results = await deps.db.batch(statements, "write");
  if (results[results.length - 1].rowsAffected !== 1) return completeRepeatOrLost(deps.db, ref);
  return toolsJson(200, { ok: true, asset_id: job.assetId, duplicate: false });
}

/** A repeat for a job this runner and lease already finished is a success; anything else lost the lease. */
async function completeRepeatOrLost(db: Client, ref: LeaseRef): Promise<Response> {
  const job = await jobInTenants(db, ref.tenantIds, ref.jobId);
  if (job && job.status === "done" && job.claimedBy === ref.runnerKey && job.leaseId === ref.leaseId && job.assetId) {
    return toolsJson(200, { ok: true, asset_id: job.assetId, duplicate: true });
  }
  return leaseLost();
}

/**
 * The Library asset, its video row and the job's "done", in that order. Each
 * insert runs only while this lease still holds the job; the job's update goes
 * LAST (every guard above it sees the job as it was) and is the commit signal:
 * rowsAffected 1 = all three landed.
 */
function completeStatements(
  job: ToolJob,
  ref: LeaseRef,
  f: {
    size: number;
    sha256: string;
    md5: string;
    video: VideoFacts;
    source: SourceFacts;
    extractor: { tool_version: string | null; ytdlp_version: string | null };
  },
  now: Date,
): InStatement[] {
  const at = now.toISOString();
  const tenant = job.tenantId;
  const assetId = job.assetId as string;
  const path = job.uploadPath as string;
  const p = PLATFORMS[f.source.platform];
  const videoId = f.source.video_id?.trim() || null;
  const title = (f.source.title?.trim() || `${p.name} video${videoId ? ` ${videoId}` : ""}`).slice(0, 200);
  const meta = {
    tool: "video_download",
    tool_job_id: job.id,
    rights_status: "unknown",
    source: {
      platform: f.source.platform,
      url: f.source.url,
      webpage_url: f.source.webpage_url,
      video_id: videoId,
      handle: f.source.handle,
      uploader: f.source.uploader,
      uploader_url: f.source.uploader_url,
      channel: f.source.channel,
      title: f.source.title,
      description: f.source.description,
      upload_date: f.source.upload_date,
      metrics: {
        view_count: f.source.view_count,
        like_count: f.source.like_count,
        comment_count: f.source.comment_count,
        repost_count: f.source.repost_count,
      },
    },
    file: {
      sha256: f.sha256,
      md5: f.md5,
      bytes: f.size,
      width: f.video.width,
      height: f.video.height,
      fps: f.video.fps,
      vcodec: f.video.vcodec,
      acodec: f.video.acodec,
      has_audio: f.video.has_audio,
    },
    extractor: f.extractor,
  };
  const tin = sqlPlaceholders(ref.tenantIds.length);
  const leaseHolds = `EXISTS (SELECT 1 FROM tool_jobs WHERE ${LEASE_GUARD} AND tenant_id IN (${tin}) AND upload_path = ?)`;
  const leaseArgs = [ref.jobId, ref.runnerKey, ref.leaseId, ...ref.tenantIds, path];
  return [
    {
      // `source` is unique per workspace (marketing_asset_tenant_source_unique_idx),
      // so it names this run: two downloads are two assets.
      sql: `INSERT INTO marketing_asset (id, tenant_id, title, channel, format, status, source, author_agent, author_email,
                                         brand_slug, brand_name, asset_type, media_urls, slide_count, platforms, duration_s,
                                         meta, created_at, updated_at)
            SELECT ?, ?, ?, ?, 'video', 'draft', ?, 'human', ?, 'downloads', 'Downloads', 'video', '[]', 1, '[]', ?, ?, ?, ?
            WHERE ${leaseHolds}
              AND NOT EXISTS (SELECT 1 FROM marketing_asset WHERE tenant_id = ? AND id = ?)`,
      args: [
        assetId, tenant, title, p.channel, `tool:video_download:${job.id}`,
        job.createdByEmail || `profile:${job.createdBy}`, f.video.duration_s, JSON.stringify(meta), at, at,
        ...leaseArgs, tenant, assetId,
      ],
    },
    {
      sql: `INSERT INTO marketing_asset_media (tenant_id, asset_id, kind, storage_bucket, storage_path, mime, bytes, width, height, label, created_at)
            SELECT ?, ?, 'video', ?, ?, 'video/mp4', ?, ?, ?, ?, ?
            WHERE ${leaseHolds}
              AND NOT EXISTS (SELECT 1 FROM marketing_asset_media WHERE tenant_id = ? AND asset_id = ? AND kind = 'video')`,
      args: [
        tenant, assetId, MARKETING_MEDIA_BUCKET, path, f.size, f.video.width, f.video.height,
        `${p.name}${videoId ? ` ${videoId}` : ""}`, at,
        ...leaseArgs, tenant, assetId,
      ],
    },
    {
      sql: `UPDATE tool_jobs
               SET status = 'done', stage = NULL, asset_id = ?, result_json = ?, error_code = NULL, error_message = NULL,
                   finished_at = ?, updated_at = ?
             WHERE ${LEASE_GUARD} AND tenant_id IN (${tin}) AND upload_path = ?
               AND EXISTS (SELECT 1 FROM marketing_asset WHERE tenant_id = ? AND id = ?)
               AND EXISTS (SELECT 1 FROM marketing_asset_media WHERE tenant_id = ? AND asset_id = ? AND storage_path = ?)`,
      args: [
        assetId, JSON.stringify({ asset_id: assetId, title, platform: f.source.platform }), at, at,
        ...leaseArgs, tenant, assetId, tenant, assetId, path,
      ],
    },
  ];
}

// ---------------------------------------------------------------------------
// fail
// ---------------------------------------------------------------------------

export async function handleToolsFail(req: Request, deps: RunnerDeps): Promise<Response> {
  const auth = await authenticateToolsRequest(req, deps.env, deps.now);
  if (!auth.ok) return auth.response;
  const ref = leaseRef(auth.producer, auth.body);
  if ("field" in ref) return invalid(ref.field);
  if (!isRunnerCodeShape(auth.body.error_code)) return invalid("error_code");
  const code = storedRunnerCode(auth.body.error_code);
  if (!(await toolTablesInstalled(deps.db))) return notInstalled("tables_missing");

  const at = deps.now.toISOString();
  const rs = await deps.db.execute({
    sql: `UPDATE tool_jobs SET status = 'failed', stage = NULL, error_code = ?, error_message = ?, finished_at = ?, updated_at = ?
          WHERE ${LEASE_GUARD} AND tenant_id IN (${sqlPlaceholders(ref.tenantIds.length)})
          RETURNING tenant_id, upload_path`,
    args: [code, toolErrorLine(code, "runner"), at, at, ref.jobId, ref.runnerKey, ref.leaseId, ...ref.tenantIds],
  });
  const row = rs.rows[0];
  if (!row) {
    const job = await jobInTenants(deps.db, ref.tenantIds, ref.jobId);
    if (job && job.status === "failed" && job.claimedBy === ref.runnerKey && job.leaseId === ref.leaseId) {
      return toolsJson(200, { ok: true, duplicate: true });
    }
    return leaseLost();
  }
  const path = row.upload_path === null || row.upload_path === undefined ? null : String(row.upload_path);
  if (path) await removeQuietly(deps.storage, [{ tenantId: String(row.tenant_id), path }], "fail");
  return toolsJson(200, { ok: true, duplicate: false });
}

// ---------------------------------------------------------------------------
// Production storage
// ---------------------------------------------------------------------------

/**
 * The marketing-media bucket on R2, or null when R2 is not configured: never
 * the Supabase fallback lib/supabase-server.ts keeps for other callers.
 */
export async function r2ToolStorage(): Promise<ToolStorage | null> {
  if (!r2Configured()) return null;
  const bucket = r2StorageSurface().from(MARKETING_MEDIA_BUCKET);
  return {
    async createSignedUploadUrl(path) {
      const r = await bucket.createSignedUploadUrl(path);
      if (r.error || !r.data?.signedUrl) throw new Error(r.error?.message || "no signed URL");
      return { signedUrl: r.data.signedUrl };
    },
    async info(path) {
      const r = await bucket.info(path);
      if (r.error) {
        if (r.error.status === 404) return null;
        throw new Error(r.error.message);
      }
      return r.data ? { size: Number(r.data.size), etag: r.data.etag } : null;
    },
    async remove(path) {
      const r = await bucket.remove([path]);
      if (r.error) throw new Error(r.error.message);
    },
  };
}
