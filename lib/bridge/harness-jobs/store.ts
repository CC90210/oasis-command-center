import "server-only";
import { randomUUID } from "node:crypto";
import type { Client } from "@libsql/client";
import { getTursoClient } from "@/lib/turso";
import { CLAIM_FRESH_MS } from "@/lib/devices/presence";
import {
  isHarnessEventType,
  isPlainObject,
  type HarnessChatMode,
  type HarnessEngine,
  type HarnessEvent,
  type HarnessJob,
  type HarnessRequest,
} from "./types";

export const HARNESS_CLAIM_TIMEOUT_MS = 30_000;
export const HARNESS_LEASE_STALE_MS = 60_000;
export const HARNESS_JOB_TTL_MS = 12 * 60_000;
const MAX_EVENT_BYTES = 64_000;
const MAX_EVENT_BATCH = 32;

type DbRow = Record<string, unknown>;

function parseRequest(value: unknown): HarnessRequest {
  if (typeof value !== "string") throw new Error("harness request missing");
  const parsed = JSON.parse(value) as unknown;
  if (!isPlainObject(parsed)) throw new Error("harness request invalid");
  return parsed as HarnessRequest;
}

function rowOf(row: DbRow): HarnessJob {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    userId: String(row.user_id),
    pairingId: String(row.pairing_id),
    agentKey: String(row.agent_key),
    engine: { kind: row.engine_kind as HarnessEngine["kind"], name: String(row.engine_name) },
    chatMode: row.chat_mode as HarnessChatMode,
    repoWrites: Number(row.repo_writes) === 1,
    request: parseRequest(row.request_json),
    status: row.status as HarnessJob["status"],
    claimId: row.claim_id == null ? null : String(row.claim_id),
    leaseId: row.lease_id == null ? null : String(row.lease_id),
    claimedAt: row.claimed_at == null ? null : String(row.claimed_at),
    heartbeatAt: row.heartbeat_at == null ? null : String(row.heartbeat_at),
    deadlineAt: String(row.deadline_at),
    errorCode: row.error_code == null ? null : String(row.error_code),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    finishedAt: row.finished_at == null ? null : String(row.finished_at),
  };
}

function safeText(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.length <= max ? value : undefined;
}

/** Keep the browser's established SSE vocabulary, but never persist arbitrary
 * connector JSON. Tool output is deliberately omitted: it can contain local
 * secrets and the assistant's final answer is the durable chat record. */
export function sanitizeHarnessEvent(raw: unknown): HarnessEvent | null {
  if (!isPlainObject(raw) || !Number.isInteger(raw.seq) || Number(raw.seq) <= 0 || !isHarnessEventType(raw.type) || !isPlainObject(raw.data)) {
    return null;
  }
  const seq = Number(raw.seq);
  const data = raw.data;
  let clean: Record<string, unknown>;
  switch (raw.type) {
    case "delta": {
      const value = safeText(data.text, 16_000);
      if (value === undefined) return null;
      clean = { text: value };
      break;
    }
    case "session": {
      const value = safeText(data.session_id, 200);
      if (!value || !/^[A-Za-z0-9_.:-]+$/.test(value)) return null;
      clean = { session_id: value };
      break;
    }
    case "agent_status": {
      const phase = safeText(data.phase, 40);
      if (!phase || !["queued", "spawning", "thinking", "tool", "warm_resume"].includes(phase)) return null;
      clean = { phase };
      const agent = safeText(data.agent, 80);
      if (agent) clean.agent = agent;
      // Never persist an absolute cwd. The connector sends only the agent key.
      const repo = safeText(data.repo, 80);
      if (repo) clean.repo = repo;
      break;
    }
    case "info": {
      clean = {};
      for (const key of ["chat_mode", "honored", "detail", "runtime"] as const) {
        const value = safeText(data[key], key === "detail" ? 1_000 : 120);
        if (value) clean[key] = value;
      }
      break;
    }
    case "tool": {
      const name = safeText(data.name, 120);
      if (!name) return null;
      clean = { name };
      for (const key of ["raw_name", "tool_use_id"] as const) {
        const value = safeText(data[key], 200);
        if (value) clean[key] = value;
      }
      break;
    }
    case "tool_result": {
      clean = {};
      for (const key of ["name", "tool_use_id"] as const) {
        const value = safeText(data[key], 200);
        if (value) clean[key] = value;
      }
      clean.error = data.error === true;
      break;
    }
    case "tool_progress": {
      const name = safeText(data.name, 120);
      if (!name) return null;
      clean = { name, elapsed_s: Math.max(0, Math.min(21_600, Number(data.elapsed_s) || 0)) };
      break;
    }
    case "error": {
      clean = {
        code: safeText(data.code, 120) || "harness_failed",
        message: safeText(data.message, 1_000) || "The selected computer could not finish this turn.",
      };
      const detail = safeText(data.detail, 1_500);
      if (detail) clean.detail = detail;
      break;
    }
    case "done": {
      clean = {};
      for (const key of ["input_tokens", "output_tokens"] as const) {
        const value = Number(data[key]);
        if (Number.isInteger(value) && value >= 0 && value <= 100_000_000) clean[key] = value;
      }
      break;
    }
  }
  if (JSON.stringify(clean).length > MAX_EVENT_BYTES) return null;
  return { seq, type: raw.type, data: clean };
}

function validEngine(engine: HarnessEngine): boolean {
  if (engine.kind === "cli") return ["claude", "codex", "opencode"].includes(engine.name);
  return /^(?:ollama|lmstudio)\/[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,139}$/.test(engine.name);
}

export async function enqueueHarnessJob(input: {
  tenantId: string;
  userId: string;
  pairingOwnerId: string;
  pairingId: string;
  agentKey: string;
  engine: HarnessEngine;
  chatMode: HarnessChatMode;
  repoWrites: boolean;
  request: HarnessRequest;
  now?: Date;
}, db: Client = getTursoClient()): Promise<{ ok: true; job: HarnessJob } | { ok: false; code: string }> {
  if (!validEngine(input.engine)) return { ok: false, code: "runtime_engine_not_allowed" };
  if (!/^[a-z][a-z0-9_-]{0,79}$/.test(input.agentKey)) return { ok: false, code: "agent_invalid" };
  if (input.repoWrites && !(input.chatMode === "build" && input.engine.kind === "cli" && input.engine.name === "codex")) {
    return { ok: false, code: "repo_write_sandbox_unavailable" };
  }
  if (input.request.messages.length === 0 || input.request.messages.length > 200) return { ok: false, code: "messages_invalid" };
  if (input.request.attachments.length > 5) return { ok: false, code: "attachments_invalid" };
  const nowDate = input.now ?? new Date();
  const now = nowDate.toISOString();
  const claimFreshAfter = new Date(nowDate.getTime() - CLAIM_FRESH_MS).toISOString();
  const deadline = new Date(nowDate.getTime() + HARNESS_JOB_TTL_MS).toISOString();
  const id = randomUUID();
  const requestJson = JSON.stringify(input.request);
  if (requestJson.length > 1_000_000) return { ok: false, code: "payload_too_large" };
  const result = await db.execute({
    sql: `INSERT INTO bridge_harness_jobs
            (id, tenant_id, user_id, pairing_id, agent_key, engine_kind, engine_name,
             chat_mode, repo_writes, request_json, status, deadline_at, created_at, updated_at)
          SELECT ?, ?, ?, p.id, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?
            FROM bridge_pairings p
           WHERE p.id = ? AND p.tenant_id = ? AND p.user_id = ?
             AND p.revoked_at IS NULL AND p.claim_enabled_at IS NOT NULL
             AND (p.paired_via IS NULL OR p.paired_via <> 'signup_secret')
             AND p.claim_state_at > ?
             AND COALESCE(p.claim_capacity, 0) > 0
             AND COALESCE(p.claim_in_flight, 0) = 0
             AND NULLIF(TRIM(COALESCE(p.claim_blocked_reason, '')), '') IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM bridge_harness_jobs h
                WHERE h.tenant_id = p.tenant_id AND h.pairing_id = p.id
                  AND h.status IN ('queued', 'running')
             )
             AND NOT EXISTS (
               SELECT 1 FROM bridge_runtime_jobs r
                WHERE r.tenant_id = p.tenant_id AND r.pairing_id = p.id
                  AND r.status IN ('queued', 'running')
             )
             AND NOT EXISTS (
               SELECT 1 FROM dept_chat_runs d
                WHERE d.tenant_id = p.tenant_id
                  AND ((d.status = 'running' AND d.claimed_pairing_id = p.id)
                    OR (d.status = 'queued' AND d.target_pairing_id = p.id))
             )`,
    args: [
      id, input.tenantId, input.userId, input.agentKey, input.engine.kind, input.engine.name,
      input.chatMode, input.repoWrites ? 1 : 0, requestJson, deadline, now, now,
      input.pairingId, input.tenantId, input.pairingOwnerId, claimFreshAfter,
    ],
  });
  if (result.rowsAffected !== 1) {
    const state = await db.execute({
      sql: `SELECT p.revoked_at, p.claim_enabled_at, p.paired_via,
                   p.claim_state_at, p.claim_capacity, p.claim_in_flight, p.claim_blocked_reason,
                   EXISTS (
                     SELECT 1 FROM bridge_harness_jobs h
                      WHERE h.tenant_id = p.tenant_id AND h.pairing_id = p.id
                        AND h.status IN ('queued', 'running')
                   ) AS harness_active,
                   EXISTS (
                     SELECT 1 FROM bridge_runtime_jobs r
                      WHERE r.tenant_id = p.tenant_id AND r.pairing_id = p.id
                        AND r.status IN ('queued', 'running')
                   ) AS runtime_active,
                   EXISTS (
                     SELECT 1 FROM dept_chat_runs d
                      WHERE d.tenant_id = p.tenant_id
                        AND ((d.status = 'running' AND d.claimed_pairing_id = p.id)
                          OR (d.status = 'queued' AND d.target_pairing_id = p.id))
                   ) AS department_active
              FROM bridge_pairings p
             WHERE p.id = ? AND p.tenant_id = ? AND p.user_id = ?
             LIMIT 1`,
      args: [input.pairingId, input.tenantId, input.pairingOwnerId],
    });
    const row = state.rows[0] as DbRow | undefined;
    if (!row || row.revoked_at || !row.claim_enabled_at || row.paired_via === "signup_secret") {
      return { ok: false, code: "pairing_unavailable" };
    }
    if (
      Number(row.harness_active) === 1 ||
      Number(row.runtime_active) === 1 ||
      Number(row.department_active) === 1
    ) {
      return { ok: false, code: "computer_busy" };
    }
    const claimStateAt = typeof row.claim_state_at === "string" ? Date.parse(row.claim_state_at) : NaN;
    if (!Number.isFinite(claimStateAt) || claimStateAt <= nowDate.getTime() - CLAIM_FRESH_MS) {
      return { ok: false, code: "computer_not_answering" };
    }
    if (String(row.claim_blocked_reason ?? "").trim()) return { ok: false, code: "computer_blocked" };
    if (Number(row.claim_capacity ?? 0) <= 0 || Number(row.claim_in_flight ?? 0) > 0) {
      return { ok: false, code: "computer_busy" };
    }
    // A concurrent admission won the queue after our guarded INSERT checked.
    return { ok: false, code: "computer_busy" };
  }
  const row = await db.execute({ sql: "SELECT * FROM bridge_harness_jobs WHERE tenant_id = ? AND user_id = ? AND id = ?", args: [input.tenantId, input.userId, id] });
  return { ok: true, job: rowOf(row.rows[0] as DbRow) };
}

async function expireJobs(db: Client, tenantId: string, pairingId: string, now: Date): Promise<void> {
  const nowIso = now.toISOString();
  const claimCutoff = new Date(now.getTime() - HARNESS_CLAIM_TIMEOUT_MS).toISOString();
  const leaseCutoff = new Date(now.getTime() - HARNESS_LEASE_STALE_MS).toISOString();
  await db.execute({
    sql: `UPDATE bridge_harness_jobs
             SET status = 'failed', error_code = CASE WHEN status = 'queued' THEN 'computer_not_answering' ELSE 'producer_stale' END,
                 finished_at = ?, updated_at = ?
           WHERE tenant_id = ? AND pairing_id = ?
             AND ((status = 'queued' AND created_at <= ?)
               OR (status = 'running' AND (deadline_at <= ? OR COALESCE(heartbeat_at, claimed_at) <= ?)))`,
    args: [nowIso, nowIso, tenantId, pairingId, claimCutoff, nowIso, leaseCutoff],
  });
}

export async function claimHarnessJob(input: {
  tenantId: string;
  pairingId: string;
  claimId: string;
  now?: Date;
}, db: Client = getTursoClient()): Promise<HarnessJob | null> {
  const nowDate = input.now ?? new Date();
  const now = nowDate.toISOString();
  await expireJobs(db, input.tenantId, input.pairingId, nowDate);
  const existing = await db.execute({
    sql: `SELECT * FROM bridge_harness_jobs
           WHERE tenant_id = ? AND pairing_id = ? AND claim_id = ? AND status = 'running'
           LIMIT 1`,
    args: [input.tenantId, input.pairingId, input.claimId],
  });
  if (existing.rows[0]) return rowOf(existing.rows[0] as DbRow);
  const leaseId = randomUUID();
  const claimed = await db.execute({
    sql: `UPDATE bridge_harness_jobs
             SET status = 'running', claim_id = ?, lease_id = ?, claimed_at = ?, heartbeat_at = ?, updated_at = ?
           WHERE id = (
             SELECT id FROM bridge_harness_jobs
              WHERE tenant_id = ? AND pairing_id = ? AND status = 'queued' AND deadline_at > ?
              ORDER BY created_at ASC, id ASC LIMIT 1
           ) AND status = 'queued'
           RETURNING *`,
    args: [input.claimId, leaseId, now, now, now, input.tenantId, input.pairingId, now],
  });
  return claimed.rows[0] ? rowOf(claimed.rows[0] as DbRow) : null;
}

/** Fail closed after a connector acquired a lease but before its response may
 * expose the request payload. Matching the exact lease and claim makes this a
 * compare-and-set: a stale claimant cannot terminalize a newer execution. */
async function failClaimedHarnessJobForInactiveSeat(input: {
  tenantId: string;
  pairingId: string;
  jobId: string;
  claimId: string;
  leaseId: string;
  errorCode: "requester_seat_inactive" | "pairing_owner_seat_inactive";
  now?: Date;
}, db: Client = getTursoClient()): Promise<boolean> {
  const now = (input.now ?? new Date()).toISOString();
  const result = await db.execute({
    sql: `UPDATE bridge_harness_jobs
             SET status = 'failed', error_code = ?,
                 finished_at = ?, updated_at = ?
           WHERE tenant_id = ? AND pairing_id = ? AND id = ?
             AND claim_id = ? AND lease_id = ? AND status = 'running'`,
    args: [input.errorCode, now, now, input.tenantId, input.pairingId, input.jobId, input.claimId, input.leaseId],
  });
  return result.rowsAffected === 1;
}

export async function failClaimedHarnessJobForInactiveRequester(
  input: Omit<Parameters<typeof failClaimedHarnessJobForInactiveSeat>[0], "errorCode">,
  db: Client = getTursoClient(),
): Promise<boolean> {
  return failClaimedHarnessJobForInactiveSeat({ ...input, errorCode: "requester_seat_inactive" }, db);
}

export async function failClaimedHarnessJobForInactivePairingOwner(
  input: Omit<Parameters<typeof failClaimedHarnessJobForInactiveSeat>[0], "errorCode">,
  db: Client = getTursoClient(),
): Promise<boolean> {
  return failClaimedHarnessJobForInactiveSeat({ ...input, errorCode: "pairing_owner_seat_inactive" }, db);
}

export async function appendHarnessEvents(input: {
  tenantId: string;
  jobId: string;
  events: unknown[];
  now?: Date;
}, db: Client = getTursoClient()): Promise<{ ok: true; terminal: boolean } | { ok: false; code: string }> {
  if (input.events.length === 0 || input.events.length > MAX_EVENT_BATCH) return { ok: false, code: "events_invalid" };
  const events = input.events.map(sanitizeHarnessEvent);
  if (events.some((event) => event === null)) return { ok: false, code: "event_invalid" };
  const clean = events as HarnessEvent[];
  const now = (input.now ?? new Date()).toISOString();
  const jobResult = await db.execute({
    sql: "SELECT * FROM bridge_harness_jobs WHERE tenant_id = ? AND id = ? LIMIT 1",
    args: [input.tenantId, input.jobId],
  });
  if (!jobResult.rows[0]) return { ok: false, code: "job_not_found" };
  const job = rowOf(jobResult.rows[0] as DbRow);
  if (job.status !== "running") return { ok: false, code: "job_not_running" };
  if (job.deadlineAt <= now) return { ok: false, code: "job_expired" };
  const maxResult = await db.execute({
    sql: "SELECT COALESCE(MAX(seq), 0) AS max_seq FROM bridge_harness_job_events WHERE tenant_id = ? AND job_id = ?",
    args: [input.tenantId, input.jobId],
  });
  const maxSeq = Number(maxResult.rows[0]?.max_seq ?? 0);
  if (clean.some((event) => event.seq > maxSeq + MAX_EVENT_BATCH)) return { ok: false, code: "event_sequence_invalid" };
  for (const event of clean) {
    await db.execute({
      sql: `INSERT OR IGNORE INTO bridge_harness_job_events (tenant_id, job_id, seq, event_type, data_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [input.tenantId, input.jobId, event.seq, event.type, JSON.stringify(event.data), now],
    });
  }
  const error = clean.find((event) => event.type === "error");
  const done = clean.some((event) => event.type === "done");
  const errorCode = error ? String(error.data.code || "harness_failed") : null;
  await db.execute({
    sql: `UPDATE bridge_harness_jobs
             SET heartbeat_at = ?, updated_at = ?,
                 error_code = COALESCE(?, error_code),
                 status = CASE WHEN ? = 1 THEN CASE WHEN COALESCE(?, error_code) IS NULL THEN 'completed' ELSE 'failed' END ELSE status END,
                 finished_at = CASE WHEN ? = 1 THEN ? ELSE finished_at END
           WHERE tenant_id = ? AND id = ? AND status = 'running'`,
    args: [now, now, errorCode, done ? 1 : 0, errorCode, done ? 1 : 0, now, input.tenantId, input.jobId],
  });
  return { ok: true, terminal: done };
}

export async function heartbeatHarnessJob(input: { tenantId: string; jobId: string; now?: Date }, db: Client = getTursoClient()): Promise<boolean> {
  const now = (input.now ?? new Date()).toISOString();
  const result = await db.execute({
    sql: `UPDATE bridge_harness_jobs SET heartbeat_at = ?, updated_at = ?
           WHERE tenant_id = ? AND id = ? AND status = 'running' AND deadline_at > ?`,
    args: [now, now, input.tenantId, input.jobId, now],
  });
  return result.rowsAffected === 1;
}

/** Cancel only a still-active task owned by this browser actor. A connector
 * heartbeat/event posted after this transition receives job_not_running and
 * uses that refusal as its local cancellation signal. */
export async function cancelHarnessJob(input: {
  tenantId: string;
  userId: string;
  jobId: string;
  now?: Date;
}, db: Client = getTursoClient()): Promise<boolean> {
  const now = (input.now ?? new Date()).toISOString();
  const result = await db.execute({
    sql: `UPDATE bridge_harness_jobs
             SET status = 'cancelled', error_code = 'browser_disconnected',
                 finished_at = ?, updated_at = ?
           WHERE tenant_id = ? AND user_id = ? AND id = ?
             AND status IN ('queued', 'running')`,
    args: [now, now, input.tenantId, input.userId, input.jobId],
  });
  return result.rowsAffected === 1;
}

export async function readHarnessJob(input: { tenantId: string; userId: string; jobId: string }, db: Client = getTursoClient()): Promise<HarnessJob | null> {
  const result = await db.execute({
    sql: "SELECT * FROM bridge_harness_jobs WHERE tenant_id = ? AND user_id = ? AND id = ? LIMIT 1",
    args: [input.tenantId, input.userId, input.jobId],
  });
  if (!result.rows[0]) return null;
  const job = rowOf(result.rows[0] as DbRow);
  if (job.status === "queued" && Date.parse(job.createdAt) <= Date.now() - HARNESS_CLAIM_TIMEOUT_MS) {
    await expireJobs(db, job.tenantId, job.pairingId, new Date());
    return readHarnessJob(input, db);
  }
  if (job.status === "running" && (Date.parse(job.deadlineAt) <= Date.now() || Date.parse(job.heartbeatAt ?? job.claimedAt ?? job.createdAt) <= Date.now() - HARNESS_LEASE_STALE_MS)) {
    await expireJobs(db, job.tenantId, job.pairingId, new Date());
    return readHarnessJob(input, db);
  }
  return job;
}

export async function readHarnessJobForProducer(input: { tenantId: string; jobId: string }, db: Client = getTursoClient()): Promise<HarnessJob | null> {
  const result = await db.execute({
    sql: "SELECT * FROM bridge_harness_jobs WHERE tenant_id = ? AND id = ? LIMIT 1",
    args: [input.tenantId, input.jobId],
  });
  return result.rows[0] ? rowOf(result.rows[0] as DbRow) : null;
}

export async function readHarnessEvents(input: { tenantId: string; jobId: string; after: number }, db: Client = getTursoClient()): Promise<HarnessEvent[]> {
  const result = await db.execute({
    sql: `SELECT seq, event_type, data_json FROM bridge_harness_job_events
           WHERE tenant_id = ? AND job_id = ? AND seq > ? ORDER BY seq ASC LIMIT 100`,
    args: [input.tenantId, input.jobId, input.after],
  });
  return result.rows.map((row) => ({
    seq: Number(row.seq),
    type: String(row.event_type) as HarnessEvent["type"],
    data: JSON.parse(String(row.data_json)) as Record<string, unknown>,
  }));
}
