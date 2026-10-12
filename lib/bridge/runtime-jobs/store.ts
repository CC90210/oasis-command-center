import "server-only";
import { createHash, randomUUID } from "node:crypto";
import type { Client, InStatement } from "@libsql/client";
import { getTursoClient } from "@/lib/turso";
import { liveSeat } from "@/lib/os/seat";
import {
  hasOnlyKeys,
  isFailureCode,
  isPlainObject,
  isProgressCode,
  isRuntimeAction,
  parseRuntimeEngine,
  safeProbePrompt,
  safeResultText,
  type RuntimeCapability,
  type RuntimeEngine,
  type RuntimeFailureCode,
  type RuntimeJobRow,
  type RuntimeProgressCode,
  type RuntimeClaimState,
} from "./types";

export const RUNTIME_LEASE_MS = 45_000;
export const RUNTIME_JOB_RATE_WINDOW_MS = 60_000;
export const RUNTIME_JOB_MAX_ACTIVE_PER_USER_PAIRING = 4;
export const RUNTIME_JOB_MAX_NEW_PER_WINDOW = 8;
export const RUNTIME_PROBE_FRESH_MS = 10 * 60_000;
export const RUNTIME_QUEUED_TTL_MS = 90_000;

type DbRow = Record<string, unknown>;

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string" || !value) return null;
  try {
    const parsed = JSON.parse(value);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function rowOf(row: DbRow): RuntimeJobRow {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    userId: String(row.user_id),
    pairingId: String(row.pairing_id),
    action: row.action as RuntimeJobRow["action"],
    engine: { kind: row.engine_kind as RuntimeJobRow["engine"]["kind"], name: String(row.engine_name) },
    prompt: row.prompt === null || row.prompt === undefined ? null : String(row.prompt),
    status: row.status as RuntimeJobRow["status"],
    idempotencyKey: String(row.idempotency_key),
    claimId: row.claim_id === null || row.claim_id === undefined ? null : String(row.claim_id),
    leaseId: row.lease_id === null || row.lease_id === undefined ? null : String(row.lease_id),
    claimedAt: row.claimed_at === null || row.claimed_at === undefined ? null : String(row.claimed_at),
    heartbeatAt: row.heartbeat_at === null || row.heartbeat_at === undefined ? null : String(row.heartbeat_at),
    deadlineAt: row.deadline_at === null || row.deadline_at === undefined ? null : String(row.deadline_at),
    progressCode: row.progress_code === null || row.progress_code === undefined ? null : (String(row.progress_code) as RuntimeProgressCode),
    resultCode: row.result_code === null || row.result_code === undefined ? null : String(row.result_code),
    result: parseJsonObject(row.result_json),
    errorCode: row.error_code === null || row.error_code === undefined ? null : (String(row.error_code) as RuntimeJobRow["errorCode"]),
    errorRetryable: row.error_retryable === null || row.error_retryable === undefined ? null : Number(row.error_retryable) === 1,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    finishedAt: row.finished_at === null || row.finished_at === undefined ? null : String(row.finished_at),
  };
}

export type RuntimeProbeReceipt = {
  /** The terminal probe job that produced this receipt. Older test fixtures
   * may omit it; durable engine saves always read receipts/jobs from storage. */
  jobId?: string;
  pairingId: string;
  engine: RuntimeEngine;
  ready: boolean;
  finishedAt: string;
};

export function runtimeProbeReceiptKey(pairingId: string, engine: RuntimeEngine): string {
  return `${pairingId}\u0000${engine.kind}\u0000${engine.name}`;
}

export function isFreshRuntimeProbeReceipt(receipt: RuntimeProbeReceipt | null | undefined, nowMs = Date.now()): boolean {
  if (!receipt?.ready) return false;
  const finishedMs = Date.parse(receipt.finishedAt);
  return Number.isFinite(finishedMs) && nowMs >= finishedMs && nowMs - finishedMs <= RUNTIME_PROBE_FRESH_MS;
}

/**
 * The newest terminal probe is the readiness receipt for an exact
 * pairing/runtime. Connector heartbeats may report installation and sign-in,
 * but only a server-recorded probe completion can make the UI say the runtime
 * is ready for agents. A newer failed probe revokes an older success.
 */
export async function readLatestRuntimeProbeReceipts(
  tenantId: string,
  pairingIds: readonly string[],
  db: Client = getTursoClient(),
): Promise<Map<string, RuntimeProbeReceipt>> {
  const out = new Map<string, RuntimeProbeReceipt>();
  if (!pairingIds.length) return out;
  const placeholders = pairingIds.map(() => "?").join(",");
  const result = await db.execute({
    sql: `SELECT id, pairing_id, engine_kind, engine_name, status, result_code, finished_at
            FROM bridge_runtime_jobs
           WHERE tenant_id = ? AND pairing_id IN (${placeholders}) AND action = 'probe'
             AND status IN ('completed', 'failed') AND finished_at IS NOT NULL
           ORDER BY finished_at DESC, updated_at DESC, id DESC`,
    args: [tenantId, ...pairingIds],
  });
  for (const raw of result.rows as unknown as DbRow[]) {
    const parsed = parseRuntimeEngine({ kind: raw.engine_kind, name: raw.engine_name });
    if (!parsed.ok) continue;
    const pairingId = String(raw.pairing_id ?? "");
    const finishedAt = String(raw.finished_at ?? "");
    if (!pairingId || !finishedAt) continue;
    const key = runtimeProbeReceiptKey(pairingId, parsed.engine);
    if (out.has(key)) continue;
    out.set(key, {
      jobId: String(raw.id),
      pairingId,
      engine: parsed.engine,
      ready: raw.status === "completed" && raw.result_code === "probe_ok",
      finishedAt,
    });
  }
  return out;
}

async function one(db: Client, statement: InStatement): Promise<RuntimeJobRow | null> {
  const result = await db.execute(statement);
  return result.rows[0] ? rowOf(result.rows[0] as DbRow) : null;
}

export type EnqueueRuntimeJobInput = {
  tenantId: string;
  userId: string;
  pairingId: string;
  action: "probe" | "auth";
  engine: RuntimeEngine;
  prompt?: string | null;
  now?: Date;
};

export type EnqueueRuntimeJobResult =
  | { ok: true; job: RuntimeJobRow; created: boolean }
  | { ok: false; code: "unsupported_action" | "unsupported_engine" | "invalid_prompt" | "secret_material_rejected" | "pairing_unavailable" | "idempotency_conflict" | "queue_full" | "rate_limited" };

type RuntimeOperationIdentity = Pick<EnqueueRuntimeJobInput, "tenantId" | "userId" | "pairingId" | "action" | "engine">;

/** Stable identity for one user asking one exact pairing to perform one
 * allowlisted action on one engine. Callers cannot defeat deduplication with
 * a new UUID; the store owns both this key and its short attempt window. */
export function runtimeOperationKey(input: RuntimeOperationIdentity): string {
  // CLI provider ids are case-insensitive; local model ids are not. Folding
  // an LM Studio/Ollama ref here made distinct models share one unique key
  // even though every lookup below correctly preserves their case.
  const engineName = input.engine.kind === "cli" ? input.engine.name.toLowerCase() : input.engine.name;
  const digest = createHash("sha256")
    .update(JSON.stringify([input.tenantId, input.userId, input.pairingId, input.action, input.engine.kind, engineName]))
    .digest("hex")
    .slice(0, 48);
  return `runtime:${digest}`;
}

function pairingApproved(row: Record<string, unknown> | undefined): boolean {
  return Boolean(row && !row.revoked_at && row.claim_enabled_at && row.paired_via !== "signup_secret");
}

async function expireQueuedRuntimeJobsForPairing(
  db: Client,
  tenantId: string,
  pairingId: string,
  now: Date,
): Promise<number> {
  const nowIso = now.toISOString();
  const cutoff = new Date(now.getTime() - RUNTIME_QUEUED_TTL_MS).toISOString();
  const result = await db.execute({
    sql: `UPDATE bridge_runtime_jobs
             SET status = 'failed', error_code = 'queue_expired', error_retryable = 1,
                 finished_at = ?, updated_at = ?
           WHERE tenant_id = ? AND pairing_id = ? AND status = 'queued' AND created_at <= ?`,
    args: [nowIso, nowIso, tenantId, pairingId, cutoff],
  });
  return result.rowsAffected;
}

async function expireQueuedRuntimeJobForOwner(
  db: Client,
  tenantId: string,
  userId: string,
  jobId: string,
  now: Date,
): Promise<void> {
  const nowIso = now.toISOString();
  const cutoff = new Date(now.getTime() - RUNTIME_QUEUED_TTL_MS).toISOString();
  await db.execute({
    sql: `UPDATE bridge_runtime_jobs
             SET status = 'failed', error_code = 'queue_expired', error_retryable = 1,
                 finished_at = ?, updated_at = ?
           WHERE tenant_id = ? AND user_id = ? AND id = ? AND status = 'queued' AND created_at <= ?`,
    args: [nowIso, nowIso, tenantId, userId, jobId, cutoff],
  });
}

async function runtimeJobCounts(
  db: Client,
  input: Pick<EnqueueRuntimeJobInput, "tenantId" | "userId" | "pairingId">,
  rateCutoff: string,
): Promise<{ active: number; recent: number }> {
  const counts = await db.execute({
    sql: `SELECT
            SUM(CASE WHEN status IN ('queued', 'running') THEN 1 ELSE 0 END) AS active_count,
            SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS recent_count
          FROM bridge_runtime_jobs
         WHERE tenant_id = ? AND user_id = ? AND pairing_id = ?`,
    args: [rateCutoff, input.tenantId, input.userId, input.pairingId],
  });
  const row = counts.rows[0] as Record<string, unknown> | undefined;
  return { active: Number(row?.active_count ?? 0), recent: Number(row?.recent_count ?? 0) };
}

export async function enqueueRuntimeJob(input: EnqueueRuntimeJobInput, db: Client = getTursoClient()): Promise<EnqueueRuntimeJobResult> {
  if (!isRuntimeAction(input.action)) return { ok: false, code: "unsupported_action" };
  const engine = parseRuntimeEngine(input.engine);
  if (!engine.ok) return { ok: false, code: engine.code === "unexpected_field" ? "unsupported_engine" : "unsupported_engine" };
  const prompt = safeProbePrompt(input.prompt);
  if (!prompt.ok) {
    if (prompt.code === "secret_material_rejected") return { ok: false, code: "secret_material_rejected" };
    return { ok: false, code: "invalid_prompt" };
  }
  if (input.action === "auth" && prompt.prompt !== null) return { ok: false, code: "invalid_prompt" };
  if (![input.tenantId, input.userId, input.pairingId].every((value) => typeof value === "string" && value.length > 0 && value.length <= 160)) {
    return { ok: false, code: "pairing_unavailable" };
  }

  const nowDate = input.now ?? new Date();
  const now = nowDate.toISOString();
  // A connector that is offline or lacks this runtime's capability must not
  // leave an unclaimed job reusable forever or permanently consume capacity.
  await expireQueuedRuntimeJobsForPairing(db, input.tenantId, input.pairingId, nowDate);
  const pairing = await db.execute({
    sql: "SELECT revoked_at, claim_enabled_at, paired_via FROM bridge_pairings WHERE id = ? AND tenant_id = ? LIMIT 1",
    args: [input.pairingId, input.tenantId],
  });
  if (!pairingApproved(pairing.rows[0] as Record<string, unknown> | undefined)) return { ok: false, code: "pairing_unavailable" };

  const reusable = await one(db, {
    sql: `SELECT j.* FROM bridge_runtime_jobs j
            JOIN bridge_pairings p ON p.id = j.pairing_id AND p.tenant_id = j.tenant_id
           WHERE j.tenant_id = ? AND j.user_id = ? AND j.pairing_id = ?
             AND j.action = ? AND j.engine_kind = ? AND j.engine_name = ?
             AND j.status IN ('queued', 'running')
             AND p.revoked_at IS NULL AND p.claim_enabled_at IS NOT NULL
             AND (p.paired_via IS NULL OR p.paired_via <> 'signup_secret')
           ORDER BY j.updated_at DESC, j.id DESC
           LIMIT 1`,
    args: [input.tenantId, input.userId, input.pairingId, input.action, engine.engine.kind, engine.engine.name],
  });
  if (reusable) {
    if (reusable.prompt !== prompt.prompt) return { ok: false, code: "idempotency_conflict" };
    return { ok: true, job: reusable, created: false };
  }

  const rateCutoff = new Date(nowDate.getTime() - RUNTIME_JOB_RATE_WINDOW_MS).toISOString();
  const counts = await runtimeJobCounts(db, input, rateCutoff);
  if (counts.active >= RUNTIME_JOB_MAX_ACTIVE_PER_USER_PAIRING) return { ok: false, code: "queue_full" };
  if (counts.recent >= RUNTIME_JOB_MAX_NEW_PER_WINDOW) return { ok: false, code: "rate_limited" };

  const operationKey = runtimeOperationKey({ ...input, engine: engine.engine });
  // A terminal receipt is audit history, not an active request. Anchor the
  // next attempt to the most recent terminal job so retries are immediate,
  // while concurrent clicks after that same receipt still converge on one
  // unique insert. This avoids both stale Test/Auth results and duplicate
  // work without trusting a dashboard-supplied idempotency token.
  const terminalAnchor = await one(db, {
    sql: `SELECT j.* FROM bridge_runtime_jobs j
           WHERE j.tenant_id = ? AND j.user_id = ? AND j.pairing_id = ?
             AND j.action = ? AND j.engine_kind = ? AND j.engine_name = ?
             AND j.status IN ('completed', 'failed')
           ORDER BY j.finished_at DESC, j.updated_at DESC, j.id DESC
           LIMIT 1`,
    args: [input.tenantId, input.userId, input.pairingId, input.action, engine.engine.kind, engine.engine.name],
  });
  const idempotencyKey = `${operationKey}:${terminalAnchor?.id ?? "initial"}`;
  const id = randomUUID();
  let inserted = 0;
  try {
    const result = await db.execute({
      sql: `INSERT INTO bridge_runtime_jobs
              (id, tenant_id, user_id, pairing_id, action, engine_kind, engine_name, prompt, status,
               idempotency_key, created_at, updated_at)
            SELECT ?, ?, ?, p.id, ?, ?, ?, ?, 'queued', ?, ?, ?
              FROM bridge_pairings p
             WHERE p.id = ? AND p.tenant_id = ? AND p.revoked_at IS NULL
               AND p.claim_enabled_at IS NOT NULL
               AND (p.paired_via IS NULL OR p.paired_via <> 'signup_secret')
               AND (
                 SELECT COUNT(*) FROM bridge_runtime_jobs active
                  WHERE active.tenant_id = ? AND active.user_id = ? AND active.pairing_id = ?
                    AND active.status IN ('queued', 'running')
               ) < ?
               AND (
                 SELECT COUNT(*) FROM bridge_runtime_jobs recent
                  WHERE recent.tenant_id = ? AND recent.user_id = ? AND recent.pairing_id = ?
                    AND recent.created_at >= ?
               ) < ?
            ON CONFLICT (tenant_id, pairing_id, idempotency_key) DO NOTHING`,
      args: [
        id,
        input.tenantId,
        input.userId,
        input.action,
        engine.engine.kind,
        engine.engine.name,
        prompt.prompt,
        idempotencyKey,
        now,
        now,
        input.pairingId,
        input.tenantId,
        input.tenantId,
        input.userId,
        input.pairingId,
        RUNTIME_JOB_MAX_ACTIVE_PER_USER_PAIRING,
        input.tenantId,
        input.userId,
        input.pairingId,
        rateCutoff,
        RUNTIME_JOB_MAX_NEW_PER_WINDOW,
      ],
    });
    inserted = result.rowsAffected;
  } catch (error) {
    console.error("[bridge.runtime-jobs.enqueue] insert failed", error instanceof Error ? error.message : String(error));
    throw error;
  }

  const job = await one(db, {
    sql: `SELECT j.* FROM bridge_runtime_jobs j
            JOIN bridge_pairings p ON p.id = j.pairing_id AND p.tenant_id = j.tenant_id
           WHERE j.tenant_id = ? AND j.pairing_id = ? AND j.idempotency_key = ?
             AND p.revoked_at IS NULL AND p.claim_enabled_at IS NOT NULL
             AND (p.paired_via IS NULL OR p.paired_via <> 'signup_secret')`,
    args: [input.tenantId, input.pairingId, idempotencyKey],
  });
  if (!job) {
    // The INSERT repeats both limits inside its one SQLite statement so
    // parallel, distinct requests cannot all pass the optimistic pre-check.
    // Re-read only to report which closed gate rejected the attempt.
    const after = await runtimeJobCounts(db, input, rateCutoff);
    if (after.active >= RUNTIME_JOB_MAX_ACTIVE_PER_USER_PAIRING) return { ok: false, code: "queue_full" };
    if (after.recent >= RUNTIME_JOB_MAX_NEW_PER_WINDOW) return { ok: false, code: "rate_limited" };
    return { ok: false, code: "pairing_unavailable" };
  }
  if (inserted === 0 && (job.status === "completed" || job.status === "failed")) {
    // The active request we raced completed between the first lookup and the
    // conflict read. Re-anchor once to that now-terminal receipt so this
    // caller still performs the requested retry instead of returning stale
    // output. The next call observes the newly queued row as reusable.
    return enqueueRuntimeJob(input, db);
  }
  if (job.userId !== input.userId || job.action !== input.action || job.engine.kind !== engine.engine.kind || job.engine.name !== engine.engine.name || job.prompt !== prompt.prompt) {
    return { ok: false, code: "idempotency_conflict" };
  }
  return { ok: true, job, created: inserted > 0 };
}

export async function recordRuntimeClaimState(
  tenantId: string,
  pairingId: string,
  state: RuntimeClaimState | null,
  db: Client = getTursoClient(),
): Promise<boolean> {
  const result = await db.execute({
    sql: `UPDATE bridge_pairings
             SET claim_runtime_state = CASE WHEN ? IS NULL THEN claim_runtime_state ELSE ? END
           WHERE id = ? AND tenant_id = ? AND revoked_at IS NULL
             AND claim_enabled_at IS NOT NULL
             AND (paired_via IS NULL OR paired_via <> 'signup_secret')`,
    args: [state ? 1 : null, state ? JSON.stringify(state) : null, pairingId, tenantId],
  });
  return result.rowsAffected === 1;
}

/** Fresh liveness check for each long-poll pass; a pairing revoked after the
 * request authenticated must stop that same request, not merely the next one. */
export type RuntimePairingApproval = "approved" | "not_approved" | "revoked";

export async function runtimePairingApproval(
  tenantId: string,
  pairingId: string,
  userId: string,
  db: Client = getTursoClient(),
): Promise<RuntimePairingApproval> {
  const result = await db.execute({
    sql: `SELECT revoked_at, claim_enabled_at, paired_via FROM bridge_pairings
           WHERE id = ? AND tenant_id = ? AND user_id = ?
           LIMIT 1`,
    args: [pairingId, tenantId, userId],
  });
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row || row.revoked_at) return "revoked";
  return pairingApproved(row) ? "approved" : "not_approved";
}

export async function runtimePairingLive(
  tenantId: string,
  pairingId: string,
  userId: string,
  db: Client = getTursoClient(),
): Promise<boolean> {
  return (await runtimePairingApproval(tenantId, pairingId, userId, db)) === "approved";
}

async function failRunningJobsForPairing(
  db: Client,
  tenantId: string,
  pairingId: string,
  code: "pairing_approval_lost" | "pairing_revoked",
  nowIso: string,
): Promise<void> {
  await db.execute({
    sql: `UPDATE bridge_runtime_jobs
             SET status = 'failed', error_code = ?, error_retryable = 0, finished_at = ?, updated_at = ?
           WHERE tenant_id = ? AND pairing_id = ? AND status = 'running'`,
    args: [code, nowIso, nowIso, tenantId, pairingId],
  });
}

function capabilityWhere(capabilities: RuntimeCapability[]): { sql: string; args: string[] } {
  if (capabilities.length === 0) return { sql: "0 = 1", args: [] };
  return {
    sql: capabilities.map(() => "(action = ? AND engine_kind = ? AND engine_name = ?)").join(" OR "),
    args: capabilities.flatMap((capability) => [capability.action, capability.engine.kind, capability.engine.name]),
  };
}

export async function claimRuntimeJob(
  input: { tenantId: string; pairingId: string; claimId: string; capabilities: RuntimeCapability[]; now?: Date },
  db: Client = getTursoClient(),
): Promise<RuntimeJobRow | null> {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  await expireQueuedRuntimeJobsForPairing(db, input.tenantId, input.pairingId, now);
  const approval = await db.execute({
    sql: "SELECT revoked_at, claim_enabled_at, paired_via FROM bridge_pairings WHERE id = ? AND tenant_id = ? LIMIT 1",
    args: [input.pairingId, input.tenantId],
  });
  const approvalRow = approval.rows[0] as Record<string, unknown> | undefined;
  if (!pairingApproved(approvalRow)) {
    await failRunningJobsForPairing(db, input.tenantId, input.pairingId, approvalRow && !approvalRow.revoked_at ? "pairing_approval_lost" : "pairing_revoked", nowIso);
    return null;
  }
  await db.execute({
    sql: `UPDATE bridge_runtime_jobs
             SET status = 'failed', error_code = 'lease_expired', finished_at = ?, updated_at = ?
           WHERE tenant_id = ? AND pairing_id = ? AND status = 'running'
             AND deadline_at IS NOT NULL AND deadline_at <= ?`,
    args: [nowIso, nowIso, input.tenantId, input.pairingId, nowIso],
  });

  const existing = await one(db, {
    sql: `SELECT j.* FROM bridge_runtime_jobs j
            JOIN bridge_pairings p ON p.id = j.pairing_id AND p.tenant_id = j.tenant_id
           WHERE j.tenant_id = ? AND j.pairing_id = ? AND j.claim_id = ?
             AND p.revoked_at IS NULL AND p.claim_enabled_at IS NOT NULL
             AND (p.paired_via IS NULL OR p.paired_via <> 'signup_secret')`,
    args: [input.tenantId, input.pairingId, input.claimId],
  });
  if (existing) return existing.status === "running" && existing.deadlineAt && existing.deadlineAt > nowIso ? existing : null;
  if (input.capabilities.length === 0) return null;

  const leaseId = randomUUID();
  const deadline = new Date(now.getTime() + RUNTIME_LEASE_MS).toISOString();
  const capability = capabilityWhere(input.capabilities);
  const statement: InStatement = {
    sql: `UPDATE bridge_runtime_jobs
             SET status = 'running', claim_id = ?, lease_id = ?, claimed_at = ?, heartbeat_at = ?,
                 deadline_at = ?, progress_code = 'starting', updated_at = ?
           WHERE id = (
             SELECT id FROM bridge_runtime_jobs
              WHERE tenant_id = ? AND pairing_id = ? AND status = 'queued'
                AND (${capability.sql})
              ORDER BY created_at, id LIMIT 1
           )
             AND tenant_id = ? AND pairing_id = ? AND status = 'queued'
             AND EXISTS (
               SELECT 1 FROM bridge_pairings p
                WHERE p.id = ? AND p.tenant_id = ? AND p.revoked_at IS NULL
                  AND p.claim_enabled_at IS NOT NULL
                  AND (p.paired_via IS NULL OR p.paired_via <> 'signup_secret')
             )
           RETURNING *`,
    args: [
      input.claimId,
      leaseId,
      nowIso,
      nowIso,
      deadline,
      nowIso,
      input.tenantId,
      input.pairingId,
      ...capability.args,
      input.tenantId,
      input.pairingId,
      input.pairingId,
      input.tenantId,
    ],
  };
  try {
    return await one(db, statement);
  } catch (error) {
    // A concurrent retry with the same claim_id may win the partial unique
    // index. Read its winner and return that exact lease; never claim another.
    const winner = await one(db, {
      sql: `SELECT j.* FROM bridge_runtime_jobs j
              JOIN bridge_pairings p ON p.id = j.pairing_id AND p.tenant_id = j.tenant_id
             WHERE j.tenant_id = ? AND j.pairing_id = ? AND j.claim_id = ?
               AND p.revoked_at IS NULL AND p.claim_enabled_at IS NOT NULL
               AND (p.paired_via IS NULL OR p.paired_via <> 'signup_secret')`,
      args: [input.tenantId, input.pairingId, input.claimId],
    });
    if (winner?.status === "running" && winner.deadlineAt && winner.deadlineAt > nowIso) return winner;
    console.error("[bridge.runtime-jobs.claim] claim failed", error instanceof Error ? error.message : String(error));
    throw error;
  }
}

/**
 * Fail closed after a connector acquired a runtime-action lease but before
 * the action is disclosed. Matching the exact job, claim, and lease keeps a
 * stale or concurrent claimant from terminalizing a different execution.
 */
export async function failClaimedRuntimeJobForInactiveRequester(input: {
  tenantId: string;
  pairingId: string;
  jobId: string;
  claimId: string;
  leaseId: string;
  now?: Date;
}, db: Client = getTursoClient()): Promise<boolean> {
  const nowIso = (input.now ?? new Date()).toISOString();
  const result = await db.execute({
    sql: `UPDATE bridge_runtime_jobs
             SET status = 'failed', error_code = 'requester_seat_inactive',
                 error_retryable = 0, finished_at = ?, updated_at = ?
           WHERE tenant_id = ? AND pairing_id = ? AND id = ?
             AND claim_id = ? AND lease_id = ? AND status = 'running'`,
    args: [
      nowIso,
      nowIso,
      input.tenantId,
      input.pairingId,
      input.jobId,
      input.claimId,
      input.leaseId,
    ],
  });
  return result.rowsAffected === 1;
}

type LeaseRefusal = {
  ok: false;
  code: "pairing_revoked" | "pairing_not_approved" | "requester_seat_inactive" | "lease_lost";
};
type LeaseOutcome = { ok: true } | LeaseRefusal;
type HeartbeatOutcome = { ok: true; deadlineAt: string } | LeaseRefusal;

type RuntimeLeaseInput = { tenantId: string; pairingId: string; jobId: string; leaseId: string };

/**
 * Re-check the original requester's workspace seat for every live-lease
 * mutation. The connector bearer proves which computer is speaking; it does
 * not keep the person who requested the action authorized after that person
 * is removed from the workspace. An inactive or unreadable seat terminalizes
 * only this exact lease before heartbeat/progress/result data can be accepted.
 */
async function liveRequesterForLease(
  db: Client,
  input: RuntimeLeaseInput,
  nowIso: string,
): Promise<{ ok: true; job: RuntimeJobRow } | LeaseRefusal> {
  const job = await one(db, {
    sql: `SELECT j.* FROM bridge_runtime_jobs j
            JOIN bridge_pairings p ON p.id = j.pairing_id AND p.tenant_id = j.tenant_id
           WHERE j.id = ? AND j.tenant_id = ? AND j.pairing_id = ? AND j.lease_id = ?
             AND j.status = 'running' AND j.deadline_at > ?
             AND p.revoked_at IS NULL AND p.claim_enabled_at IS NOT NULL
             AND (p.paired_via IS NULL OR p.paired_via <> 'signup_secret')`,
    args: [input.jobId, input.tenantId, input.pairingId, input.leaseId, nowIso],
  });
  if (!job) return leaseFailure(db, input, nowIso);

  let requesterLive = false;
  try {
    requesterLive = (await liveSeat(job.tenantId, job.userId)).live;
  } catch (error) {
    console.error("[bridge.runtime-jobs.requester-seat]", {
      tenantId: job.tenantId,
      jobId: job.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  if (requesterLive) return { ok: true, job };

  await db.execute({
    sql: `UPDATE bridge_runtime_jobs
             SET status = 'failed', error_code = 'requester_seat_inactive',
                 error_retryable = 0, finished_at = ?, updated_at = ?
           WHERE id = ? AND tenant_id = ? AND pairing_id = ? AND lease_id = ?
             AND status = 'running'`,
    args: [nowIso, nowIso, input.jobId, input.tenantId, input.pairingId, input.leaseId],
  });
  return { ok: false, code: "requester_seat_inactive" };
}

async function leaseFailure(
  db: Client,
  input: { tenantId: string; pairingId: string; jobId: string; leaseId: string },
  nowIso: string,
): Promise<LeaseRefusal> {
  const pairing = await db.execute({
    sql: "SELECT revoked_at, claim_enabled_at, paired_via FROM bridge_pairings WHERE id = ? AND tenant_id = ?",
    args: [input.pairingId, input.tenantId],
  });
  const row = pairing.rows[0] as Record<string, unknown> | undefined;
  if (!pairingApproved(row)) {
    const revoked = !row || Boolean(row.revoked_at);
    await db.execute({
      sql: `UPDATE bridge_runtime_jobs
               SET status = 'failed', error_code = ?, error_retryable = 0, finished_at = ?, updated_at = ?
             WHERE id = ? AND tenant_id = ? AND pairing_id = ? AND lease_id = ? AND status = 'running'`,
      args: [revoked ? "pairing_revoked" : "pairing_approval_lost", nowIso, nowIso, input.jobId, input.tenantId, input.pairingId, input.leaseId],
    });
    return { ok: false, code: revoked ? "pairing_revoked" : "pairing_not_approved" };
  }
  return { ok: false, code: "lease_lost" };
}

export async function heartbeatRuntimeJob(
  input: { tenantId: string; pairingId: string; jobId: string; leaseId: string; now?: Date },
  db: Client = getTursoClient(),
): Promise<HeartbeatOutcome> {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const requester = await liveRequesterForLease(db, input, nowIso);
  if (!requester.ok) return requester;
  const deadline = new Date(now.getTime() + RUNTIME_LEASE_MS).toISOString();
  const result = await db.execute({
    sql: `UPDATE bridge_runtime_jobs
             SET heartbeat_at = ?, deadline_at = ?, updated_at = ?
           WHERE id = ? AND tenant_id = ? AND pairing_id = ? AND lease_id = ?
             AND status = 'running' AND deadline_at > ?
             AND EXISTS (
               SELECT 1 FROM bridge_pairings p
                WHERE p.id = ? AND p.tenant_id = ? AND p.revoked_at IS NULL
                  AND p.claim_enabled_at IS NOT NULL
                  AND (p.paired_via IS NULL OR p.paired_via <> 'signup_secret')
             )`,
    args: [nowIso, deadline, nowIso, input.jobId, input.tenantId, input.pairingId, input.leaseId, nowIso, input.pairingId, input.tenantId],
  });
  return result.rowsAffected === 1 ? { ok: true, deadlineAt: deadline } : leaseFailure(db, input, nowIso);
}

export async function progressRuntimeJob(
  input: { tenantId: string; pairingId: string; jobId: string; leaseId: string; code: RuntimeProgressCode; now?: Date },
  db: Client = getTursoClient(),
): Promise<LeaseOutcome> {
  if (!isProgressCode(input.code)) return { ok: false, code: "lease_lost" };
  const nowIso = (input.now ?? new Date()).toISOString();
  const requester = await liveRequesterForLease(db, input, nowIso);
  if (!requester.ok) return requester;
  const result = await db.execute({
    sql: `UPDATE bridge_runtime_jobs
             SET progress_code = ?, updated_at = ?
           WHERE id = ? AND tenant_id = ? AND pairing_id = ? AND lease_id = ?
             AND status = 'running' AND deadline_at > ?
             AND EXISTS (
               SELECT 1 FROM bridge_pairings p
                WHERE p.id = ? AND p.tenant_id = ? AND p.revoked_at IS NULL
                  AND p.claim_enabled_at IS NOT NULL
                  AND (p.paired_via IS NULL OR p.paired_via <> 'signup_secret')
             )`,
    args: [input.code, nowIso, input.jobId, input.tenantId, input.pairingId, input.leaseId, nowIso, input.pairingId, input.tenantId],
  });
  return result.rowsAffected === 1 ? { ok: true } : leaseFailure(db, input, nowIso);
}

type CompleteInput = { tenantId: string; pairingId: string; jobId: string; leaseId: string; code: unknown; result: unknown; now?: Date };
type CompleteOutcome = LeaseOutcome | { ok: false; code: "unsupported_result_code" | "invalid_result" | "unexpected_result_field" };
type CompletionParse =
  | { ok: true; code: string; result: Record<string, unknown> }
  | { ok: false; code: "unsupported_result_code" | "invalid_result" | "unexpected_result_field" };

function completionFor(job: RuntimeJobRow, code: unknown, value: unknown): CompletionParse {
  if (!isPlainObject(value)) return { ok: false, code: "invalid_result" };
  if (job.action === "probe") {
    if (code !== "probe_ok") return { ok: false, code: "unsupported_result_code" };
    if (!hasOnlyKeys(value, ["answer", "model", "latency_ms"])) return { ok: false, code: "unexpected_result_field" };
    // A zero exit is not proof that the model followed the probe. Only the
    // signed job's exact canary promotes a runtime to agent-ready.
    if (value.answer !== "OASIS_RUNTIME_READY") return { ok: false, code: "invalid_result" };
    const answer = safeResultText(value.answer);
    if (!answer) return { ok: false, code: "invalid_result" };
    const result: Record<string, unknown> = { answer };
    if (value.model !== undefined) {
      const model = safeResultText(value.model, 96);
      if (!model) return { ok: false, code: "invalid_result" };
      result.model = model;
    }
    if (value.latency_ms !== undefined) {
      if (!Number.isInteger(value.latency_ms) || Number(value.latency_ms) < 0 || Number(value.latency_ms) > 600_000) return { ok: false, code: "invalid_result" };
      result.latency_ms = value.latency_ms;
    }
    return { ok: true, code: "probe_ok", result };
  }
  if (code !== "auth_ok") return { ok: false, code: "unsupported_result_code" };
  if (!hasOnlyKeys(value, ["authenticated"]) || value.authenticated !== true) return { ok: false, code: "invalid_result" };
  return { ok: true, code: "auth_ok", result: { authenticated: true } };
}

export async function completeRuntimeJob(input: CompleteInput, db: Client = getTursoClient()): Promise<CompleteOutcome> {
  const nowIso = (input.now ?? new Date()).toISOString();
  const requester = await liveRequesterForLease(db, input, nowIso);
  if (!requester.ok) return requester;
  const parsed = completionFor(requester.job, input.code, input.result);
  if (!parsed.ok) return parsed;
  const result = await db.execute({
    sql: `UPDATE bridge_runtime_jobs
             SET status = 'completed', result_code = ?, result_json = ?, finished_at = ?, updated_at = ?
           WHERE id = ? AND tenant_id = ? AND pairing_id = ? AND lease_id = ?
             AND status = 'running' AND deadline_at > ?
             AND EXISTS (
               SELECT 1 FROM bridge_pairings p
                WHERE p.id = ? AND p.tenant_id = ? AND p.revoked_at IS NULL
                  AND p.claim_enabled_at IS NOT NULL
                  AND (p.paired_via IS NULL OR p.paired_via <> 'signup_secret')
             )`,
    args: [parsed.code, JSON.stringify(parsed.result), nowIso, nowIso, input.jobId, input.tenantId, input.pairingId, input.leaseId, nowIso, input.pairingId, input.tenantId],
  });
  return result.rowsAffected === 1 ? { ok: true } : leaseFailure(db, input, nowIso);
}

export async function failRuntimeJob(
  input: { tenantId: string; pairingId: string; jobId: string; leaseId: string; code: RuntimeFailureCode; retryable: boolean; now?: Date },
  db: Client = getTursoClient(),
): Promise<LeaseOutcome | { ok: false; code: "unsupported_failure_code" }> {
  if (!isFailureCode(input.code)) return { ok: false, code: "unsupported_failure_code" };
  const nowIso = (input.now ?? new Date()).toISOString();
  const requester = await liveRequesterForLease(db, input, nowIso);
  if (!requester.ok) return requester;
  const result = await db.execute({
    sql: `UPDATE bridge_runtime_jobs
             SET status = 'failed', error_code = ?, error_retryable = ?, finished_at = ?, updated_at = ?
           WHERE id = ? AND tenant_id = ? AND pairing_id = ? AND lease_id = ?
             AND status = 'running' AND deadline_at > ?
             AND EXISTS (
               SELECT 1 FROM bridge_pairings p
                WHERE p.id = ? AND p.tenant_id = ? AND p.revoked_at IS NULL
                  AND p.claim_enabled_at IS NOT NULL
                  AND (p.paired_via IS NULL OR p.paired_via <> 'signup_secret')
             )`,
    args: [input.code, input.retryable ? 1 : 0, nowIso, nowIso, input.jobId, input.tenantId, input.pairingId, input.leaseId, nowIso, input.pairingId, input.tenantId],
  });
  return result.rowsAffected === 1 ? { ok: true } : leaseFailure(db, input, nowIso);
}

export async function readRuntimeJobForOwner(
  tenantId: string,
  userId: string,
  jobId: string,
  db: Client = getTursoClient(),
  now: Date = new Date(),
): Promise<RuntimeJobRow | null> {
  // Browser polling is itself a lifecycle driver. If no connector ever
  // claims the job, the dashboard receives a terminal repair instead of
  // spinning until only its local timeout fires.
  await expireQueuedRuntimeJobForOwner(db, tenantId, userId, jobId, now);
  return one(db, {
    sql: `SELECT * FROM bridge_runtime_jobs WHERE tenant_id = ? AND user_id = ? AND id = ?`,
    args: [tenantId, userId, jobId],
  });
}
