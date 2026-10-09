/**
 * lib/tools/store.ts - the Toolkit's tables (migration bravo__206): one
 * tool_jobs row per run, one tool_runners row per runner per workspace it
 * serves.
 *
 * Every read and write names its tenant. Times are ISO strings from the
 * caller's `now` (lexically ordered, the format SQLite's strftime default
 * writes), so a test can move the clock. libSQL over HTTP returns integers as
 * strings: every count and attempts value goes through Number().
 *
 * THE CLAIM is one UPDATE (claimNextJob): it picks the oldest claimable job
 * and takes it in the same statement, and the claimable test is repeated in
 * the outer WHERE, so two runners can never take one job. A job whose lease
 * expired is claimable again (a new lease, attempts + 1) until MAX_ATTEMPTS.
 *
 * THE SWEEPS (sweepToolJobs) run at the start of every claim and every jobs
 * read, so nothing waits on a cron:
 *   attempts_exhausted  a runner job whose last allowed lease expired;
 *   runner_offline      a runner job no live runner can take: queued for 30
 *                       minutes, or its lease expired 30 minutes ago, while no
 *                       runner listing its tool was seen in 10 minutes;
 *   interrupted         a run inside a request that has not finished in 5
 *                       minutes (the request was cut off).
 * The first two return any recorded upload path so the caller can delete the
 * object nothing will ever point at.
 */
import "server-only";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Client, InStatement, InValue, Row } from "@libsql/client";
import { toolErrorLine } from "@/lib/tools/errors";
import {
  LEASE_SECONDS,
  MAX_ATTEMPTS,
  MAX_RUNNER_JOBS_IN_FLIGHT,
  QUEUED_OFFLINE_MINUTES,
  RUNNER_LIVE_MINUTES,
  WORKER_INTERRUPTED_MINUTES,
} from "@/lib/tools/limits";
import { toolByKey } from "@/lib/tools/registry";
import type { JobView, ToolJobStatus } from "@/lib/tools/types";

export type { JobView, ToolJobStatus };

export type ToolJob = {
  id: string;
  tenantId: string;
  toolKey: string;
  runsOn: "worker" | "runner";
  status: ToolJobStatus;
  stage: string | null;
  input: Record<string, unknown>;
  inputHash: string;
  idempotencyKey: string | null;
  dedupeKey: string | null;
  createdBy: string | null;
  createdByEmail: string | null;
  claimedBy: string | null;
  leaseId: string | null;
  claimedAt: string | null;
  heartbeatAt: string | null;
  leaseExpiresAt: string | null;
  attempts: number;
  assetId: string | null;
  uploadPath: string | null;
  uploadBytes: number | null;
  uploadSha256: string | null;
  uploadMd5: string | null;
  result: unknown;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
};

const JOB_COLUMNS =
  "id, tenant_id, tool_key, runs_on, status, stage, input_json, input_hash, idempotency_key, dedupe_key, " +
  "created_by, created_by_email, claimed_by, lease_id, claimed_at, heartbeat_at, lease_expires_at, attempts, " +
  "asset_id, upload_path, upload_bytes, upload_sha256, upload_md5, result_json, error_code, error_message, " +
  "created_at, updated_at, finished_at";

/** "no such table/column": migration bravo__206 is not applied. Any other error is a real failure. */
export function isMissingToolTables(err: unknown): boolean {
  return /no such table|no such column/i.test(err instanceof Error ? err.message : String(err));
}

/**
 * Both tables present? One statement: SQLite prepares the whole of it, so a
 * missing table fails it before anything runs. False = not installed; any
 * other error throws (a database that cannot be read is not "not set up").
 */
export async function toolTablesInstalled(db: Client): Promise<boolean> {
  try {
    await db.execute("SELECT (SELECT COUNT(*) FROM tool_jobs WHERE 0) AS j, (SELECT COUNT(*) FROM tool_runners WHERE 0) AS r");
    return true;
  } catch (err) {
    if (isMissingToolTables(err)) return false;
    throw err;
  }
}

const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function parseObject(v: unknown): Record<string, unknown> {
  if (typeof v !== "string" || !v) return {};
  try {
    const parsed = JSON.parse(v);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function parseAny(v: unknown): unknown {
  if (typeof v !== "string" || !v) return null;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

export function jobFromRow(r: Row | Record<string, unknown>): ToolJob {
  const row = r as Record<string, unknown>;
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    toolKey: String(row.tool_key),
    runsOn: String(row.runs_on) === "runner" ? "runner" : "worker",
    status: String(row.status) as ToolJobStatus,
    stage: str(row.stage),
    input: parseObject(row.input_json),
    inputHash: String(row.input_hash ?? ""),
    idempotencyKey: str(row.idempotency_key),
    dedupeKey: str(row.dedupe_key),
    createdBy: str(row.created_by),
    createdByEmail: str(row.created_by_email),
    claimedBy: str(row.claimed_by),
    leaseId: str(row.lease_id),
    claimedAt: str(row.claimed_at),
    heartbeatAt: str(row.heartbeat_at),
    leaseExpiresAt: str(row.lease_expires_at),
    attempts: num(row.attempts) ?? 0,
    assetId: str(row.asset_id),
    uploadPath: str(row.upload_path),
    uploadBytes: num(row.upload_bytes),
    uploadSha256: str(row.upload_sha256),
    uploadMd5: str(row.upload_md5),
    result: parseAny(row.result_json),
    errorCode: str(row.error_code),
    errorMessage: str(row.error_message),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    finishedAt: str(row.finished_at),
  };
}

const minutesBefore = (now: Date, minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();
const placeholders = (n: number) => Array.from({ length: n }, () => "?").join(", ");

/** A job id. */
export function newJobId(): string {
  return randomUUID();
}

/** A lease: 32 random hex characters, new on every claim. */
export function newLeaseId(): string {
  return randomBytes(16).toString("hex");
}

/** The identity of what a run was asked to do: its tool and its cleaned input. */
export function inputHashOf(toolKey: string, value: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify({ tool: toolKey, input: value }), "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Reads (always one tenant)
// ---------------------------------------------------------------------------

export async function getJob(db: Client, tenantId: string, id: string): Promise<ToolJob | null> {
  const rs = await db.execute({ sql: `SELECT ${JOB_COLUMNS} FROM tool_jobs WHERE id = ? AND tenant_id = ?`, args: [id, tenantId] });
  return rs.rows[0] ? jobFromRow(rs.rows[0]) : null;
}

/** The newest `limit` runs of one tool in one workspace. */
export async function listJobs(db: Client, tenantId: string, toolKey: string, limit: number): Promise<ToolJob[]> {
  const rs = await db.execute({
    sql: `SELECT ${JOB_COLUMNS} FROM tool_jobs WHERE tenant_id = ? AND tool_key = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
    args: [tenantId, toolKey, limit],
  });
  return rs.rows.map(jobFromRow);
}

export async function findByIdempotencyKey(db: Client, tenantId: string, key: string): Promise<ToolJob | null> {
  const rs = await db.execute({
    sql: `SELECT ${JOB_COLUMNS} FROM tool_jobs WHERE tenant_id = ? AND idempotency_key = ?`,
    args: [tenantId, key],
  });
  return rs.rows[0] ? jobFromRow(rs.rows[0]) : null;
}

export async function findInflightByDedupe(db: Client, tenantId: string, dedupeKey: string): Promise<ToolJob | null> {
  const rs = await db.execute({
    sql: `SELECT ${JOB_COLUMNS} FROM tool_jobs
          WHERE tenant_id = ? AND dedupe_key = ? AND status IN ('queued','claimed','running')
          ORDER BY created_at DESC LIMIT 1`,
    args: [tenantId, dedupeKey],
  });
  return rs.rows[0] ? jobFromRow(rs.rows[0]) : null;
}

export type LiveRunner = { label: string; tools: string[]; lastSeenAt: string };

/** Runners seen in the last RUNNER_LIVE_MINUTES that serve this workspace, newest first. */
export async function liveRunnersFor(db: Client, tenantId: string, now: Date): Promise<LiveRunner[]> {
  const rs = await db.execute({
    sql: `SELECT label, tools_json, last_seen_at FROM tool_runners
          WHERE tenant_id = ? AND last_seen_at >= ? ORDER BY last_seen_at DESC LIMIT 10`,
    args: [tenantId, minutesBefore(now, RUNNER_LIVE_MINUTES)],
  });
  return rs.rows.map((r) => {
    const tools = parseAny(r.tools_json);
    return {
      label: String(r.label),
      tools: Array.isArray(tools) ? tools.filter((t): t is string => typeof t === "string") : [],
      lastSeenAt: String(r.last_seen_at),
    };
  });
}

/** The live runner that serves this tool for this workspace, or null. */
export async function liveRunnerForTool(db: Client, tenantId: string, toolKey: string, now: Date): Promise<LiveRunner | null> {
  return (await liveRunnersFor(db, tenantId, now)).find((r) => r.tools.includes(toolKey)) ?? null;
}

// ---------------------------------------------------------------------------
// Writes from the session routes
// ---------------------------------------------------------------------------

export type NewJob = {
  id: string;
  tenantId: string;
  toolKey: string;
  runsOn: "worker" | "runner";
  input: Record<string, unknown>;
  inputHash: string;
  idempotencyKey: string;
  dedupeKey: string | null;
  createdBy: string | null;
  createdByEmail: string | null;
};

/**
 * Insert a run. A worker run starts `running` (it runs inside this request); a
 * runner run starts `queued`, and only while its workspace has fewer than
 * MAX_RUNNER_JOBS_IN_FLIGHT runner jobs in flight: the count and the insert are
 * ONE statement, so two clicks at once cannot make a sixth. Returns "full" when
 * that refused it. A unique violation (the same idempotency key, or the same
 * thing already in flight) throws, and the caller reads the row that won.
 */
export async function insertJob(db: Client, job: NewJob, now: Date): Promise<"inserted" | "full"> {
  const at = now.toISOString();
  const values: InValue[] = [
    job.id, job.tenantId, job.toolKey, job.runsOn, job.runsOn === "worker" ? "running" : "queued",
    JSON.stringify(job.input), job.inputHash, job.idempotencyKey, job.dedupeKey, job.createdBy, job.createdByEmail, at, at,
  ];
  const cols =
    "id, tenant_id, tool_key, runs_on, status, input_json, input_hash, idempotency_key, dedupe_key, created_by, created_by_email, created_at, updated_at";
  if (job.runsOn === "worker") {
    await db.execute({ sql: `INSERT INTO tool_jobs (${cols}) VALUES (${placeholders(values.length)})`, args: values });
    return "inserted";
  }
  const rs = await db.execute({
    sql: `INSERT INTO tool_jobs (${cols})
          SELECT ${placeholders(values.length)}
          WHERE (SELECT COUNT(*) FROM tool_jobs
                 WHERE tenant_id = ? AND runs_on = 'runner' AND status IN ('queued','claimed','running')) < ?`,
    args: [...values, job.tenantId, MAX_RUNNER_JOBS_IN_FLIGHT],
  });
  return rs.rowsAffected === 1 ? "inserted" : "full";
}

export type WorkerOutcome = { ok: true; result: unknown } | { ok: false; code: string };

/**
 * A run's own write (a training note), committed in the same transaction as
 * the run's "done": the write first, guarded on the run still running, then the
 * run's update, guarded on `guard` (the write really happened). A write that
 * was refused leaves the run running, and the caller fails it with its code.
 */
export type WorkerCommit = { statements: InStatement[]; guard: { sql: string; args: InValue[] } };

/**
 * End a run that ran inside its request. Only a run still `running` moves, so a
 * run the interrupted sweep already ended stays ended. Returns whether it moved.
 */
export async function finishWorkerJob(
  db: Client,
  tenantId: string,
  jobId: string,
  outcome: WorkerOutcome,
  now: Date,
  commit?: WorkerCommit,
): Promise<boolean> {
  const at = now.toISOString();
  if (!outcome.ok) {
    const rs = await db.execute({
      sql: `UPDATE tool_jobs SET status = 'failed', stage = NULL, error_code = ?, error_message = ?, finished_at = ?, updated_at = ?
            WHERE id = ? AND tenant_id = ? AND runs_on = 'worker' AND status = 'running'`,
      args: [outcome.code, toolErrorLine(outcome.code, "worker"), at, at, jobId, tenantId],
    });
    return rs.rowsAffected === 1;
  }
  const done: InStatement = {
    sql: `UPDATE tool_jobs SET status = 'done', stage = NULL, result_json = ?, error_code = NULL, error_message = NULL,
                 finished_at = ?, updated_at = ?
          WHERE id = ? AND tenant_id = ? AND runs_on = 'worker' AND status = 'running'${commit ? ` AND ${commit.guard.sql}` : ""}`,
    args: [JSON.stringify(outcome.result ?? null), at, at, jobId, tenantId, ...(commit ? commit.guard.args : [])],
  };
  if (!commit) return (await db.execute(done)).rowsAffected === 1;
  const results = await db.batch([...commit.statements, done], "write");
  return results[results.length - 1].rowsAffected === 1;
}

// ---------------------------------------------------------------------------
// Sweeps
// ---------------------------------------------------------------------------

export type SweepResult = { failed: number; orphanUploads: Array<{ tenantId: string; path: string }> };

/** The three sweeps (see the header), for these workspaces only, in one transaction. */
export async function sweepToolJobs(db: Client, tenantIds: readonly string[], now: Date): Promise<SweepResult> {
  if (!tenantIds.length) return { failed: 0, orphanUploads: [] };
  const at = now.toISOString();
  const tin = placeholders(tenantIds.length);
  const offlineCutoff = minutesBefore(now, QUEUED_OFFLINE_MINUTES);
  const results = await db.batch(
    [
      {
        sql: `UPDATE tool_jobs SET status = 'failed', stage = NULL, error_code = 'attempts_exhausted', error_message = ?,
                     finished_at = ?, updated_at = ?
              WHERE runs_on = 'runner' AND tenant_id IN (${tin}) AND status IN ('claimed','running')
                AND lease_expires_at < ? AND attempts >= ?
              RETURNING tenant_id, upload_path`,
        args: [toolErrorLine("attempts_exhausted", "runner"), at, at, ...tenantIds, at, MAX_ATTEMPTS],
      },
      {
        sql: `UPDATE tool_jobs SET status = 'failed', stage = NULL, error_code = 'runner_offline', error_message = ?,
                     finished_at = ?, updated_at = ?
              WHERE runs_on = 'runner' AND tenant_id IN (${tin})
                AND ((status = 'queued' AND created_at < ?) OR (status IN ('claimed','running') AND lease_expires_at < ?))
                AND NOT EXISTS (SELECT 1 FROM tool_runners r
                                WHERE r.tenant_id = tool_jobs.tenant_id AND r.last_seen_at >= ?
                                  AND EXISTS (SELECT 1 FROM json_each(r.tools_json) t WHERE t.value = tool_jobs.tool_key))
              RETURNING tenant_id, upload_path`,
        args: [toolErrorLine("runner_offline", "runner"), at, at, ...tenantIds, offlineCutoff, offlineCutoff, minutesBefore(now, RUNNER_LIVE_MINUTES)],
      },
      {
        sql: `UPDATE tool_jobs SET status = 'failed', stage = NULL, error_code = 'interrupted', error_message = ?,
                     finished_at = ?, updated_at = ?
              WHERE runs_on = 'worker' AND tenant_id IN (${tin}) AND status = 'running' AND updated_at < ?`,
        args: [toolErrorLine("interrupted", "worker"), at, at, ...tenantIds, minutesBefore(now, WORKER_INTERRUPTED_MINUTES)],
      },
    ],
    "write",
  );
  const orphanUploads: Array<{ tenantId: string; path: string }> = [];
  for (const rs of results.slice(0, 2)) {
    for (const r of rs.rows) {
      const path = str(r.upload_path);
      if (path) orphanUploads.push({ tenantId: String(r.tenant_id), path });
    }
  }
  return { failed: results.reduce((n, rs) => n + rs.rowsAffected, 0), orphanUploads };
}

// ---------------------------------------------------------------------------
// The runner's side (lib/tools/runner-handlers.ts)
// ---------------------------------------------------------------------------

/** Record that a runner checked in, once per workspace its producer serves. */
export async function upsertRunner(
  db: Client,
  args: { tenantIds: readonly string[]; runnerKey: string; label: string; tools: readonly string[]; version: string; now: Date },
): Promise<void> {
  const at = args.now.toISOString();
  const tools = JSON.stringify(args.tools);
  await db.batch(
    args.tenantIds.map((tenantId) => ({
      sql: `INSERT INTO tool_runners (tenant_id, runner_key, label, tools_json, version, last_seen_at, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (tenant_id, runner_key) DO UPDATE SET
              label = excluded.label, tools_json = excluded.tools_json, version = excluded.version,
              last_seen_at = excluded.last_seen_at, updated_at = excluded.updated_at`,
      args: [tenantId, args.runnerKey, args.label, tools, args.version, at, at, at],
    })),
    "write",
  );
}

/** A heartbeat also says the runner is alive. */
export async function touchRunner(db: Client, tenantIds: readonly string[], runnerKey: string, now: Date): Promise<void> {
  const at = now.toISOString();
  await db.execute({
    sql: `UPDATE tool_runners SET last_seen_at = ?, updated_at = ? WHERE runner_key = ? AND tenant_id IN (${placeholders(tenantIds.length)})`,
    args: [at, at, runnerKey, ...tenantIds],
  });
}

/**
 * Which jobs may be taken: never claimed, or claimed by a lease that has
 * expired. ONE fragment, used in the pick AND in the take, so a job another
 * runner holds is never taken twice.
 */
const CLAIMABLE = "(status = 'queued' OR (status IN ('claimed','running') AND lease_expires_at < ?))";

export type ClaimedJob = { id: string; tenantId: string; toolKey: string; input: Record<string, unknown>; attempt: number; createdAt: string };

/**
 * Take the oldest claimable runner job of these workspaces and tools, in one
 * statement. A new lease clears the previous attempt's recorded upload (its
 * size and hashes; the path stays, so a retry overwrites the same object).
 */
export async function claimNextJob(
  db: Client,
  args: { tenantIds: readonly string[]; toolKeys: readonly string[]; runnerKey: string; leaseId: string; now: Date },
): Promise<ClaimedJob | null> {
  if (!args.tenantIds.length || !args.toolKeys.length) return null;
  const at = args.now.toISOString();
  const expires = new Date(args.now.getTime() + LEASE_SECONDS * 1000).toISOString();
  const rs = await db.execute({
    sql: `UPDATE tool_jobs
             SET status = 'claimed', claimed_by = ?, lease_id = ?, claimed_at = ?, heartbeat_at = ?, lease_expires_at = ?,
                 attempts = attempts + 1, stage = NULL, upload_bytes = NULL, upload_sha256 = NULL, upload_md5 = NULL,
                 updated_at = ?
           WHERE id = (SELECT id FROM tool_jobs
                        WHERE runs_on = 'runner' AND tenant_id IN (${placeholders(args.tenantIds.length)})
                          AND tool_key IN (${placeholders(args.toolKeys.length)}) AND attempts < ? AND ${CLAIMABLE}
                        ORDER BY created_at ASC, id ASC LIMIT 1)
             AND attempts < ? AND ${CLAIMABLE}
           RETURNING id, tenant_id, tool_key, input_json, attempts, created_at`,
    args: [
      args.runnerKey, args.leaseId, at, at, expires, at,
      ...args.tenantIds, ...args.toolKeys, MAX_ATTEMPTS, at,
      MAX_ATTEMPTS, at,
    ],
  });
  const r = rs.rows[0];
  if (!r) return null;
  return {
    id: String(r.id),
    tenantId: String(r.tenant_id),
    toolKey: String(r.tool_key),
    input: parseObject(r.input_json),
    attempt: num(r.attempts) ?? 1,
    createdAt: String(r.created_at),
  };
}

/** The guard every report from a runner carries: this job, this runner, this lease, still in flight. */
export const LEASE_GUARD = "id = ? AND claimed_by = ? AND lease_id = ? AND status IN ('claimed','running')";

/** The job as a runner's lease sees it, or null when the lease no longer holds it. */
export async function jobUnderLease(
  db: Client,
  args: { tenantIds: readonly string[]; jobId: string; runnerKey: string; leaseId: string },
): Promise<ToolJob | null> {
  const rs = await db.execute({
    sql: `SELECT ${JOB_COLUMNS} FROM tool_jobs WHERE ${LEASE_GUARD} AND tenant_id IN (${placeholders(args.tenantIds.length)})`,
    args: [args.jobId, args.runnerKey, args.leaseId, ...args.tenantIds],
  });
  return rs.rows[0] ? jobFromRow(rs.rows[0]) : null;
}

/** The job by id within these workspaces, whatever its state (for the idempotent repeats). */
export async function jobInTenants(db: Client, tenantIds: readonly string[], jobId: string): Promise<ToolJob | null> {
  const rs = await db.execute({
    sql: `SELECT ${JOB_COLUMNS} FROM tool_jobs WHERE id = ? AND tenant_id IN (${placeholders(tenantIds.length)})`,
    args: [jobId, ...tenantIds],
  });
  return rs.rows[0] ? jobFromRow(rs.rows[0]) : null;
}

export { placeholders as sqlPlaceholders };

// ---------------------------------------------------------------------------
// What the session routes answer for one run
// ---------------------------------------------------------------------------

/** The link that was run, or the first 80 characters of the text. */
export function inputSummary(job: Pick<ToolJob, "input">): string {
  const i = job.input;
  if (typeof i.url === "string") return i.url;
  const t = typeof i.hook === "string" ? i.hook : typeof i.post === "string" ? i.post : "";
  return t.length > 80 ? `${t.slice(0, 80)}...` : t;
}

export function jobView(job: ToolJob): JobView {
  const failed = job.status === "failed";
  return {
    id: job.id,
    tool_key: job.toolKey,
    status: job.status,
    stage: job.stage,
    created_at: job.createdAt,
    updated_at: job.updatedAt,
    finished_at: job.finishedAt,
    input_summary: inputSummary(job),
    result: job.status === "done" ? job.result : null,
    error_code: failed ? job.errorCode : null,
    // The line is decided HERE, from the code: lib/tools/errors.ts owns the words.
    error_message: failed ? toolErrorLine(job.errorCode, toolByKey(job.toolKey)?.runsOn ?? job.runsOn) : null,
    asset_id: job.status === "done" ? job.assetId : null,
  };
}
