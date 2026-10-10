/**
 * lib/os/runs/store.ts - department-channel conversations, runs and run events
 * (migration bravo__207_department_chat_runs).
 *
 * WHO CAN SEE WHAT. A conversation belongs to ONE person in ONE workspace.
 * Every statement here carries the workspace AND the person in its WHERE
 * clause; both come from the resolved session, never from a request body. An
 * owner or admin does not see a member's channel conversations (the product
 * rule: a channel chat is private to the person who had it, as the operator
 * chat's sessions are: /api/chat/sessions is scoped to tenant AND user).
 *
 * ONE DRIVER PER CONVERSATION. A run is `queued` until a driver claims it
 * (claimNextRun: one UPDATE that also checks nothing else in the conversation
 * is running), then `running` under that driver's lease until it finishes it.
 * The driver reports every few seconds (heartbeat); a running run whose driver
 * has not reported for RUN_STALE_MS is dead (the Worker was evicted), and
 * reapStale marks it `interrupted` so the next message can run. Every write by
 * the driver is guarded by its lease, so a driver that was declared dead cannot
 * overwrite what was decided without it.
 *
 * NOT APPLIED IS NOT SILENT. Before the migration runs, every call throws
 * RunsUnavailableError (the routes answer 503 chat_history_unavailable and log
 * it once); nothing pretends the history was saved.
 */
import "server-only";
import type { Client, InStatement, ResultSet } from "@libsql/client";
import {
  MAX_QUEUED_RUNS,
  MAX_TITLE_CHARS,
  RUN_STALE_MS,
  RUN_STALE_PRODUCER_MS,
  isRunEventKind,
  isRunStatus,
  type RunEvent,
  type RunEventKind,
  type RunSource,
  type RunStatus,
} from "./types";

export type RunScope = { tenantId: string; userId: string };

export class RunsUnavailableError extends Error {
  constructor() {
    super("chat_history_unavailable");
    this.name = "RunsUnavailableError";
  }
}

let missingLogged = false;
function guard(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err);
  if (/no such table: dept_chat_/i.test(message)) {
    if (!missingLogged) {
      missingLogged = true;
      console.error("[os.runs.store] dept_chat_* tables are missing (migration bravo__207 not applied): channel history is unavailable");
    }
    throw new RunsUnavailableError();
  }
  throw err;
}

async function exec(db: Client, stmt: InStatement): Promise<ResultSet> {
  try {
    return await db.execute(stmt);
  } catch (err) {
    return guard(err);
  }
}

function rows(rs: ResultSet): Array<Record<string, unknown>> {
  return rs.rows.map((r) => {
    const o: Record<string, unknown> = {};
    rs.columns.forEach((c, i) => {
      o[c] = (r as unknown as unknown[])[i];
    });
    return o;
  });
}

const s = (v: unknown): string => (v == null ? "" : String(v));
const sOrNull = (v: unknown): string | null => (v == null ? null : String(v));
const nOrNull = (v: unknown): number | null => (v == null || Number.isNaN(Number(v)) ? null : Number(v));
const iso = (d: Date): string => d.toISOString();
/**
 * A running run is stale when its writer has been silent too long, and how long
 * depends on the writer: the Worker's driver reports every few seconds, the
 * paired computer's bridge every ~25 s. `STALE` / `FRESH` take the two cutoffs
 * (producer first), which `cutoffs(now)` returns in that order.
 */
const STALE = `heartbeat_at < (CASE WHEN source = 'producer' THEN ? ELSE ? END)`;
const FRESH = `heartbeat_at >= (CASE WHEN source = 'producer' THEN ? ELSE ? END)`;
const cutoffs = (now: Date): [string, string] => [
  iso(new Date(now.getTime() - RUN_STALE_PRODUCER_MS)),
  iso(new Date(now.getTime() - RUN_STALE_MS)),
];

/** Reasoning and reply text exist while a run works; once it ends only the answer (final_text) and the trail stay. */
const TRANSIENT_KINDS = `('delta','thinking')`;

function newId(): string {
  return crypto.randomUUID();
}

// -- Conversations -------------------------------------------------------------

export type Conversation = {
  id: string;
  department: string;
  agentSlug: string;
  title: string;
  titleSource: "auto" | "user";
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string;
  /** Runs still queued or running: the list marks a chat that is still working. */
  activeRuns: number;
};

function conversationOf(r: Record<string, unknown>): Conversation {
  return {
    id: s(r.id),
    department: s(r.department_key),
    agentSlug: s(r.agent_slug),
    title: s(r.title),
    titleSource: r.title_source === "user" ? "user" : "auto",
    createdAt: s(r.created_at),
    updatedAt: s(r.updated_at),
    lastMessageAt: s(r.last_message_at),
    activeRuns: Number(r.active_runs ?? 0),
  };
}

const CONVERSATION_COLUMNS = `c.id, c.department_key, c.agent_slug, c.title, c.title_source, c.created_at, c.updated_at, c.last_message_at,
  (SELECT COUNT(*) FROM dept_chat_runs r WHERE r.conversation_id = c.id AND r.status IN ('queued','running')) AS active_runs`;

/** A title for a conversation: the first message, one line, cut short. */
export function titleFrom(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > MAX_TITLE_CHARS ? `${oneLine.slice(0, MAX_TITLE_CHARS - 1).trimEnd()}...` : oneLine;
}

export function cleanTitle(raw: unknown): string {
  return typeof raw === "string" ? titleFrom(raw) : "";
}

export async function createConversation(
  db: Client,
  scope: RunScope,
  input: { department: string; agentSlug: string; title?: string; now: Date },
): Promise<Conversation> {
  const id = newId();
  const at = iso(input.now);
  const title = cleanTitle(input.title);
  await exec(db, {
    sql: `INSERT INTO dept_chat_conversations (id, tenant_id, user_id, department_key, agent_slug, title, title_source, created_at, updated_at, last_message_at)
          VALUES (?, ?, ?, ?, ?, ?, 'auto', ?, ?, ?)`,
    args: [id, scope.tenantId, scope.userId, input.department, input.agentSlug, title, at, at, at],
  });
  return { id, department: input.department, agentSlug: input.agentSlug, title, titleSource: "auto", createdAt: at, updatedAt: at, lastMessageAt: at, activeRuns: 0 };
}

export async function getConversation(db: Client, scope: RunScope, id: string): Promise<Conversation | null> {
  const rs = await exec(db, {
    sql: `SELECT ${CONVERSATION_COLUMNS} FROM dept_chat_conversations c WHERE c.id = ? AND c.tenant_id = ? AND c.user_id = ?`,
    args: [id, scope.tenantId, scope.userId],
  });
  const r = rows(rs)[0];
  return r ? conversationOf(r) : null;
}

export async function listConversations(db: Client, scope: RunScope, department: string, limit = 60): Promise<Conversation[]> {
  const rs = await exec(db, {
    sql: `SELECT ${CONVERSATION_COLUMNS} FROM dept_chat_conversations c
          WHERE c.tenant_id = ? AND c.user_id = ? AND c.department_key = ?
          ORDER BY c.last_message_at DESC LIMIT ?`,
    args: [scope.tenantId, scope.userId, department, Math.max(1, Math.min(limit, 200))],
  });
  return rows(rs).map(conversationOf);
}

export async function renameConversation(db: Client, scope: RunScope, id: string, title: string, now: Date): Promise<boolean> {
  const clean = cleanTitle(title);
  if (!clean) return false;
  const rs = await exec(db, {
    sql: `UPDATE dept_chat_conversations SET title = ?, title_source = 'user', updated_at = ? WHERE id = ? AND tenant_id = ? AND user_id = ?`,
    args: [clean, iso(now), id, scope.tenantId, scope.userId],
  });
  return rs.rowsAffected > 0;
}

/**
 * Delete a conversation and everything in it. A run still working has its run
 * deleted under it: its driver's next heartbeat finds nothing and stops (the
 * model call it was making records `cancelled`).
 */
export async function deleteConversation(db: Client, scope: RunScope, id: string): Promise<boolean> {
  const owned = await getConversation(db, scope, id);
  if (!owned) return false;
  const args = [id, scope.tenantId, scope.userId];
  try {
    await db.batch(
      [
        {
          sql: `DELETE FROM dept_chat_run_events WHERE tenant_id = ? AND run_id IN (SELECT id FROM dept_chat_runs WHERE conversation_id = ? AND tenant_id = ? AND user_id = ?)`,
          args: [scope.tenantId, ...args],
        },
        { sql: `DELETE FROM dept_chat_runs WHERE conversation_id = ? AND tenant_id = ? AND user_id = ?`, args },
        { sql: `DELETE FROM dept_chat_conversations WHERE id = ? AND tenant_id = ? AND user_id = ?`, args },
      ],
      "write",
    );
  } catch (err) {
    return guard(err);
  }
  return true;
}

// -- Runs ----------------------------------------------------------------------

export type Run = {
  id: string;
  tenantId: string;
  userId: string;
  source: RunSource;
  /** The person may see the model's reasoning (owner, admin, operator). */
  showThinking: boolean;
  conversationId: string;
  department: string;
  agentSlug: string;
  seq: number;
  status: RunStatus;
  userText: string;
  chatMode: "plan" | "build";
  finalText: string | null;
  agent: Record<string, unknown> | null;
  errorCode: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  leaseId: string | null;
  heartbeatAt: string | null;
  cancelRequestedAt: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

function parseObject(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function runOf(r: Record<string, unknown>): Run {
  return {
    id: s(r.id),
    tenantId: s(r.tenant_id),
    userId: s(r.user_id),
    source: r.source === "producer" ? "producer" : "worker",
    showThinking: Number(r.show_thinking ?? 0) === 1,
    conversationId: s(r.conversation_id),
    department: s(r.department_key),
    agentSlug: s(r.agent_slug),
    seq: Number(r.seq),
    status: isRunStatus(r.status) ? r.status : "failed",
    userText: s(r.user_text),
    chatMode: r.chat_mode === "plan" ? "plan" : "build",
    finalText: sOrNull(r.final_text),
    agent: parseObject(r.agent_json),
    errorCode: sOrNull(r.error_code),
    inputTokens: nOrNull(r.input_tokens),
    outputTokens: nOrNull(r.output_tokens),
    leaseId: sOrNull(r.lease_id),
    heartbeatAt: sOrNull(r.heartbeat_at),
    cancelRequestedAt: sOrNull(r.cancel_requested_at),
    createdAt: s(r.created_at),
    startedAt: sOrNull(r.started_at),
    finishedAt: sOrNull(r.finished_at),
  };
}

export async function getRun(db: Client, scope: RunScope, runId: string): Promise<Run | null> {
  const rs = await exec(db, {
    sql: `SELECT * FROM dept_chat_runs WHERE id = ? AND tenant_id = ? AND user_id = ?`,
    args: [runId, scope.tenantId, scope.userId],
  });
  const r = rows(rs)[0];
  return r ? runOf(r) : null;
}

export async function listRuns(db: Client, scope: RunScope, conversationId: string, limit = 200): Promise<Run[]> {
  const rs = await exec(db, {
    sql: `SELECT * FROM dept_chat_runs WHERE conversation_id = ? AND tenant_id = ? AND user_id = ? ORDER BY seq ASC LIMIT ?`,
    args: [conversationId, scope.tenantId, scope.userId, Math.max(1, Math.min(limit, 500))],
  });
  return rows(rs).map(runOf);
}

export type EnqueueResult = { ok: true; run: Run } | { ok: false; reason: "no_conversation" | "queue_full" };

/**
 * Add a message to a conversation as a QUEUED run. One statement computes its
 * place in the order and refuses it when MAX_QUEUED_RUNS are already waiting;
 * the unique (conversation, seq) index settles two messages sent at once (one
 * retry takes the next place). A queued run that never runs writes nothing to
 * the AI usage ledger: only a run a driver starts calls a model.
 */
export async function enqueueRun(
  db: Client,
  scope: RunScope,
  input: { conversationId: string; text: string; chatMode: "plan" | "build"; showThinking: boolean; now: Date },
): Promise<EnqueueResult> {
  const id = newId();
  const at = iso(input.now);
  for (let attempt = 0; attempt < 3; attempt++) {
    let affected = 0;
    try {
      const rs = await db.execute({
        sql: `INSERT INTO dept_chat_runs (id, tenant_id, user_id, conversation_id, department_key, agent_slug, seq, status, user_text, chat_mode, show_thinking, created_at)
              SELECT ?, c.tenant_id, c.user_id, c.id, c.department_key, c.agent_slug,
                     COALESCE((SELECT MAX(r.seq) FROM dept_chat_runs r WHERE r.conversation_id = c.id), 0) + 1,
                     'queued', ?, ?, ?, ?
              FROM dept_chat_conversations c
              WHERE c.id = ? AND c.tenant_id = ? AND c.user_id = ?
                AND (SELECT COUNT(*) FROM dept_chat_runs q WHERE q.conversation_id = c.id AND q.status = 'queued') < ?`,
        args: [id, input.text, input.chatMode, input.showThinking ? 1 : 0, at, input.conversationId, scope.tenantId, scope.userId, MAX_QUEUED_RUNS],
      });
      affected = rs.rowsAffected;
    } catch (err) {
      if (/UNIQUE constraint failed: dept_chat_runs\.conversation_id/i.test(err instanceof Error ? err.message : String(err))) continue;
      return guard(err);
    }
    if (affected === 0) {
      const owned = await getConversation(db, scope, input.conversationId);
      return { ok: false, reason: owned ? "queue_full" : "no_conversation" };
    }
    await exec(db, {
      sql: `UPDATE dept_chat_conversations
            SET last_message_at = ?, updated_at = ?, title = CASE WHEN title = '' THEN ? ELSE title END
            WHERE id = ? AND tenant_id = ? AND user_id = ?`,
      args: [at, at, titleFrom(input.text), input.conversationId, scope.tenantId, scope.userId],
    });
    const run = await getRun(db, scope, id);
    if (!run) throw new Error("os.runs.enqueue: the run just written cannot be read");
    return { ok: true, run };
  }
  throw new Error("os.runs.enqueue: could not take a place in the order after 3 tries");
}

/**
 * Claim the conversation's next queued run, if nothing in it is running. One
 * UPDATE: the earliest queued run becomes `running` under `leaseId` only when
 * no run in the conversation is running, so two drivers cannot both start one.
 */
export async function claimNextRun(db: Client, scope: RunScope, conversationId: string, leaseId: string, now: Date): Promise<Run | null> {
  const at = iso(now);
  const rs = await exec(db, {
    sql: `UPDATE dept_chat_runs
          SET status = 'running', lease_id = ?, started_at = ?, heartbeat_at = ?
          WHERE tenant_id = ? AND user_id = ? AND conversation_id = ? AND status = 'queued'
            AND id = (SELECT q.id FROM dept_chat_runs q
                      WHERE q.conversation_id = ? AND q.tenant_id = ? AND q.user_id = ? AND q.status = 'queued'
                      ORDER BY q.seq ASC LIMIT 1)
            AND NOT EXISTS (SELECT 1 FROM dept_chat_runs x WHERE x.conversation_id = ? AND x.tenant_id = ? AND x.status = 'running')`,
    args: [leaseId, at, at, scope.tenantId, scope.userId, conversationId, conversationId, scope.tenantId, scope.userId, conversationId, scope.tenantId],
  });
  if (rs.rowsAffected === 0) return null;
  const got = await exec(db, {
    sql: `SELECT * FROM dept_chat_runs WHERE lease_id = ? AND conversation_id = ? AND tenant_id = ? AND user_id = ? AND status = 'running'`,
    args: [leaseId, conversationId, scope.tenantId, scope.userId],
  });
  const r = rows(got)[0];
  return r ? runOf(r) : null;
}

/** Whether the conversation has a run whose driver is alive (or one that is queued with none). */
export async function conversationActivity(db: Client, scope: RunScope, conversationId: string, now: Date): Promise<{ live: boolean; queued: number }> {
  const rs = await exec(db, {
    sql: `SELECT
            SUM(CASE WHEN status = 'running' AND ${FRESH} THEN 1 ELSE 0 END) AS live,
            SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued
          FROM dept_chat_runs WHERE conversation_id = ? AND tenant_id = ? AND user_id = ?`,
    args: [...cutoffs(now), conversationId, scope.tenantId, scope.userId],
  });
  const r = rows(rs)[0] ?? {};
  return { live: Number(r.live ?? 0) > 0, queued: Number(r.queued ?? 0) };
}

/**
 * The driver reports in. `owned` is false when the run is no longer this
 * lease's (reaped, finished elsewhere, or its conversation was deleted);
 * `cancel` is true when the person pressed Stop.
 */
export async function heartbeat(db: Client, scope: RunScope, runId: string, leaseId: string, now: Date): Promise<{ owned: boolean; cancel: boolean }> {
  const rs = await exec(db, {
    sql: `UPDATE dept_chat_runs SET heartbeat_at = ?
          WHERE id = ? AND tenant_id = ? AND user_id = ? AND lease_id = ? AND status = 'running'
          RETURNING cancel_requested_at`,
    args: [iso(now), runId, scope.tenantId, scope.userId, leaseId],
  });
  const r = rows(rs)[0];
  return r ? { owned: true, cancel: r.cancel_requested_at != null } : { owned: false, cancel: false };
}

/**
 * Append events to a run, in order. Each insert is conditional on the run still
 * existing (a deleted conversation leaves no orphan events). Returns false when
 * the run is gone.
 */
export async function appendEvents(db: Client, scope: RunScope, runId: string, events: readonly RunEvent[], now: Date): Promise<boolean> {
  if (events.length === 0) return true;
  const at = iso(now);
  const stmts: InStatement[] = events.map((e) => ({
    sql: `INSERT OR IGNORE INTO dept_chat_run_events (run_id, seq, tenant_id, kind, data_json, created_at)
          SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM dept_chat_runs WHERE id = ? AND tenant_id = ? AND user_id = ?)`,
    args: [runId, e.seq, scope.tenantId, e.kind, JSON.stringify(e.data), at, runId, scope.tenantId, scope.userId],
  }));
  try {
    const results = await db.batch(stmts, "write");
    return results.every((r) => r.rowsAffected > 0);
  } catch (err) {
    return guard(err);
  }
}

export type FinishInput = {
  status: Exclude<RunStatus, "queued" | "running">;
  finalText: string | null;
  errorCode: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  agent: Record<string, unknown> | null;
  now: Date;
};

/**
 * End a run the driver owns. Guarded by the lease and by `running`, so a run
 * that was reaped or cancelled by someone else keeps what they decided. The
 * reply-text events are dropped after (the answer is final_text now); the
 * trail's own events stay.
 */
export async function finishRun(db: Client, scope: RunScope, runId: string, leaseId: string, f: FinishInput): Promise<boolean> {
  const rs = await exec(db, {
    sql: `UPDATE dept_chat_runs
          SET status = ?, final_text = ?, error_code = ?, input_tokens = ?, output_tokens = ?, agent_json = ?, finished_at = ?
          WHERE id = ? AND tenant_id = ? AND user_id = ? AND lease_id = ? AND status = 'running'`,
    args: [f.status, f.finalText, f.errorCode, f.inputTokens, f.outputTokens, f.agent ? JSON.stringify(f.agent) : null, iso(f.now), runId, scope.tenantId, scope.userId, leaseId],
  });
  if (rs.rowsAffected === 0) return false;
  await exec(db, {
    sql: `DELETE FROM dept_chat_run_events WHERE run_id = ? AND tenant_id = ? AND kind IN ${TRANSIENT_KINDS}`,
    args: [runId, scope.tenantId],
  });
  return true;
}

async function nextEventSeq(db: Client, scope: RunScope, runId: string): Promise<number> {
  const rs = await exec(db, {
    sql: `SELECT COALESCE(MAX(seq), 0) AS top FROM dept_chat_run_events WHERE run_id = ? AND tenant_id = ?`,
    args: [runId, scope.tenantId],
  });
  return Number(rows(rs)[0]?.top ?? 0) + 1;
}

/** The closing events of a run that ended without its driver saying so. */
async function closeRun(db: Client, scope: RunScope, runId: string, status: RunStatus, error: { code: string; message: string } | null, now: Date): Promise<void> {
  let seq = await nextEventSeq(db, scope, runId);
  const events: RunEvent[] = [];
  if (error) events.push({ seq: seq++, kind: "error", data: error });
  events.push({ seq, kind: "done", data: { status } });
  await appendEvents(db, scope, runId, events, now);
  await exec(db, { sql: `DELETE FROM dept_chat_run_events WHERE run_id = ? AND tenant_id = ? AND kind IN ${TRANSIENT_KINDS}`, args: [runId, scope.tenantId] });
}

// -- A producer: the paired computer writes the events itself ---------------------

/**
 * A run by id alone, for a producer holding a run-scoped token
 * (./producer-token.ts). Everything the producer is allowed to do is decided
 * from THIS row: the workspace and the person are the run's, never the request's.
 */
export async function getRunForProducer(db: Client, runId: string): Promise<Run | null> {
  const rs = await exec(db, { sql: `SELECT * FROM dept_chat_runs WHERE id = ?`, args: [runId] });
  const r = rows(rs)[0];
  return r ? runOf(r) : null;
}

/**
 * The driver hands its running run to a producer (the bridge posts the events
 * from here on). Guarded by the driver's lease; from now on the run goes stale
 * after RUN_STALE_PRODUCER_MS of silence.
 */
export async function attachProducer(db: Client, scope: RunScope, runId: string, leaseId: string, now: Date): Promise<boolean> {
  const rs = await exec(db, {
    sql: `UPDATE dept_chat_runs SET source = 'producer', heartbeat_at = ?
          WHERE id = ? AND tenant_id = ? AND user_id = ? AND lease_id = ? AND status = 'running'`,
    args: [iso(now), runId, scope.tenantId, scope.userId, leaseId],
  });
  return rs.rowsAffected > 0;
}

/** A producer reports in (any post counts). `owned` is false when the run is not a running producer run. */
export async function producerHeartbeat(db: Client, run: Run, now: Date): Promise<{ owned: boolean; cancel: boolean }> {
  const rs = await exec(db, {
    sql: `UPDATE dept_chat_runs SET heartbeat_at = ?
          WHERE id = ? AND tenant_id = ? AND source = 'producer' AND status = 'running'
          RETURNING cancel_requested_at`,
    args: [iso(now), run.id, run.tenantId],
  });
  const r = rows(rs)[0];
  return r ? { owned: true, cancel: r.cancel_requested_at != null } : { owned: false, cancel: false };
}

/**
 * A producer says the run is over (done, or failed with a code). The answer is
 * the reply text it posted. Guarded by source and `running`, so a resent
 * `done` after the run ended changes nothing. Returns false then.
 */
export async function finishProducerRun(
  db: Client,
  run: Run,
  f: { status: "done" | "failed" | "cancelled"; errorCode: string | null; message: string | null; inputTokens: number | null; outputTokens: number | null; now: Date },
): Promise<boolean> {
  const scope: RunScope = { tenantId: run.tenantId, userId: run.userId };
  const text = await partialText(db, scope, run.id);
  const rs = await exec(db, {
    sql: `UPDATE dept_chat_runs
          SET status = ?, final_text = ?, error_code = ?, input_tokens = ?, output_tokens = ?, finished_at = ?
          WHERE id = ? AND tenant_id = ? AND source = 'producer' AND status = 'running'`,
    args: [f.status, text.trim() ? text : null, f.errorCode, f.inputTokens, f.outputTokens, iso(f.now), run.id, run.tenantId],
  });
  if (rs.rowsAffected === 0) return false;
  await closeRun(db, scope, run.id, f.status, f.errorCode && f.message ? { code: f.errorCode, message: f.message } : null, f.now);
  return true;
}

export const INTERRUPTED_MESSAGE = "This reply was interrupted before it finished. Send it again to retry.";

/**
 * Running runs in this conversation whose driver stopped reporting: mark them
 * `interrupted` and close their event list, so the queue behind them can run
 * and a browser following them stops waiting. Returns the runs it closed. Text
 * already written stays as the run's partial answer.
 */
export async function reapStale(db: Client, scope: RunScope, conversationId: string, now: Date): Promise<string[]> {
  const stale = rows(
    await exec(db, {
      sql: `SELECT id FROM dept_chat_runs
            WHERE conversation_id = ? AND tenant_id = ? AND user_id = ? AND status = 'running' AND ${STALE}`,
      args: [conversationId, scope.tenantId, scope.userId, ...cutoffs(now)],
    }),
  );
  const closed: string[] = [];
  for (const row of stale) {
    const id = s(row.id);
    const partial = await partialText(db, scope, id);
    const rs = await exec(db, {
      sql: `UPDATE dept_chat_runs SET status = 'interrupted', error_code = 'interrupted', final_text = ?, finished_at = ?
            WHERE id = ? AND tenant_id = ? AND user_id = ? AND status = 'running' AND ${STALE}`,
      args: [partial || null, iso(now), id, scope.tenantId, scope.userId, ...cutoffs(now)],
    });
    if (rs.rowsAffected === 0) continue;
    await closeRun(db, scope, id, "interrupted", { code: "interrupted", message: INTERRUPTED_MESSAGE }, now);
    closed.push(id);
  }
  return closed;
}

/** The reply text a run has written so far (its saved reply events, joined). */
export async function partialText(db: Client, scope: RunScope, runId: string): Promise<string> {
  const rs = await exec(db, {
    sql: `SELECT data_json FROM dept_chat_run_events WHERE run_id = ? AND tenant_id = ? AND kind = 'delta' ORDER BY seq ASC`,
    args: [runId, scope.tenantId],
  });
  return rows(rs)
    .map((r) => s(parseObject(r.data_json)?.text))
    .join("");
}

export type CancelResult = "cancelled" | "requested" | "already_finished" | "not_found";

/**
 * Stop a run. Queued: cancelled on the spot (it never ran: no model call, no
 * ledger row). Running with a live driver: the driver is asked (it ends the
 * model call, which records `cancelled`, and finishes the run). Running with a
 * dead driver: cancelled here.
 */
export async function requestCancel(db: Client, scope: RunScope, runId: string, now: Date): Promise<CancelResult> {
  const at = iso(now);
  const queued = await exec(db, {
    sql: `UPDATE dept_chat_runs SET status = 'cancelled', finished_at = ? WHERE id = ? AND tenant_id = ? AND user_id = ? AND status = 'queued'`,
    args: [at, runId, scope.tenantId, scope.userId],
  });
  if (queued.rowsAffected > 0) {
    await closeRun(db, scope, runId, "cancelled", null, now);
    return "cancelled";
  }
  const live = await exec(db, {
    sql: `UPDATE dept_chat_runs SET cancel_requested_at = COALESCE(cancel_requested_at, ?)
          WHERE id = ? AND tenant_id = ? AND user_id = ? AND status = 'running' AND ${FRESH}`,
    args: [at, runId, scope.tenantId, scope.userId, ...cutoffs(now)],
  });
  if (live.rowsAffected > 0) return "requested";
  // A dead driver's partial answer is kept, as reapStale keeps it: read it BEFORE
  // closing the run deletes the reply fragments.
  const partial = await partialText(db, scope, runId);
  const dead = await exec(db, {
    sql: `UPDATE dept_chat_runs SET status = 'cancelled', final_text = ?, finished_at = ?
          WHERE id = ? AND tenant_id = ? AND user_id = ? AND status = 'running' AND ${STALE}`,
    args: [partial.trim() ? partial : null, at, runId, scope.tenantId, scope.userId, ...cutoffs(now)],
  });
  if (dead.rowsAffected > 0) {
    await closeRun(db, scope, runId, "cancelled", null, now);
    return "cancelled";
  }
  return (await getRun(db, scope, runId)) ? "already_finished" : "not_found";
}

// -- Reading -------------------------------------------------------------------

export async function readEvents(db: Client, scope: RunScope, runId: string, afterSeq: number, limit = 500): Promise<RunEvent[]> {
  const rs = await exec(db, {
    sql: `SELECT seq, kind, data_json FROM dept_chat_run_events
          WHERE run_id = ? AND tenant_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`,
    args: [runId, scope.tenantId, afterSeq, Math.max(1, Math.min(limit, 1000))],
  });
  const out: RunEvent[] = [];
  for (const r of rows(rs)) {
    if (!isRunEventKind(r.kind)) continue;
    out.push({ seq: Number(r.seq), kind: r.kind as RunEventKind, data: parseObject(r.data_json) ?? {} });
  }
  return out;
}

/**
 * One round trip for a follower: the events after `afterSeq` and the run's row.
 * (A follower polls for as long as a run works; two statements per poll would
 * double the subrequests a Worker invocation is allowed.) `run` is null when the
 * run is gone (its conversation was deleted).
 */
export async function pollRun(db: Client, scope: RunScope, runId: string, afterSeq: number): Promise<{ events: RunEvent[]; run: Run | null }> {
  let results: ResultSet[];
  try {
    results = await db.batch(
      [
        {
          sql: `SELECT seq, kind, data_json FROM dept_chat_run_events WHERE run_id = ? AND tenant_id = ? AND seq > ? ORDER BY seq ASC LIMIT 500`,
          args: [runId, scope.tenantId, afterSeq],
        },
        { sql: `SELECT * FROM dept_chat_runs WHERE id = ? AND tenant_id = ? AND user_id = ?`, args: [runId, scope.tenantId, scope.userId] },
      ],
      "read",
    );
  } catch (err) {
    return guard(err);
  }
  const events: RunEvent[] = [];
  for (const r of rows(results[0])) {
    if (!isRunEventKind(r.kind)) continue;
    events.push({ seq: Number(r.seq), kind: r.kind as RunEventKind, data: parseObject(r.data_json) ?? {} });
  }
  const row = rows(results[1])[0];
  return { events, run: row ? runOf(row) : null };
}

/** The earliest run in the conversation that is still queued or running, after `afterRunSeq`. */
export async function nextActiveRun(db: Client, scope: RunScope, conversationId: string, afterRunSeq: number): Promise<Run | null> {
  const rs = await exec(db, {
    sql: `SELECT * FROM dept_chat_runs
          WHERE conversation_id = ? AND tenant_id = ? AND user_id = ? AND status IN ('queued','running') AND seq > ?
          ORDER BY seq ASC LIMIT 1`,
    args: [conversationId, scope.tenantId, scope.userId, afterRunSeq],
  });
  const r = rows(rs)[0];
  return r ? runOf(r) : null;
}

/** Saved trail events (everything but reply text) of a conversation's FINISHED runs, by run id. */
export async function readTrails(db: Client, scope: RunScope, conversationId: string): Promise<Map<string, RunEvent[]>> {
  const rs = await exec(db, {
    sql: `SELECT e.run_id, e.seq, e.kind, e.data_json
          FROM dept_chat_run_events e JOIN dept_chat_runs r ON r.id = e.run_id
          WHERE r.conversation_id = ? AND r.tenant_id = ? AND r.user_id = ? AND e.tenant_id = ?
            AND r.status NOT IN ('queued','running') AND e.kind NOT IN ${TRANSIENT_KINDS}
          ORDER BY r.seq ASC, e.seq ASC`,
    args: [conversationId, scope.tenantId, scope.userId, scope.tenantId],
  });
  const by = new Map<string, RunEvent[]>();
  for (const r of rows(rs)) {
    if (!isRunEventKind(r.kind)) continue;
    const list = by.get(s(r.run_id)) ?? [];
    list.push({ seq: Number(r.seq), kind: r.kind as RunEventKind, data: parseObject(r.data_json) ?? {} });
    by.set(s(r.run_id), list);
  }
  return by;
}

const HISTORY_PAIRS = 20;
const HISTORY_CHARS = 24_000;

/**
 * What the department is shown of the conversation so far: the questions it
 * answered and its answers, oldest first, ahead of run `beforeSeq`. A run that
 * failed, was cancelled or was interrupted is not a turn it had.
 */
export async function historyFor(db: Client, scope: RunScope, conversationId: string, beforeSeq: number): Promise<Array<{ role: "user" | "assistant"; content: string }>> {
  const rs = await exec(db, {
    sql: `SELECT user_text, final_text FROM dept_chat_runs
          WHERE conversation_id = ? AND tenant_id = ? AND user_id = ? AND status = 'done' AND seq < ? AND final_text IS NOT NULL
          ORDER BY seq DESC LIMIT ?`,
    args: [conversationId, scope.tenantId, scope.userId, beforeSeq, HISTORY_PAIRS],
  });
  // Newest first from the query; keep the newest that fit, then put them oldest first.
  const picked: Array<Record<string, unknown>> = [];
  let total = 0;
  for (const p of rows(rs)) {
    total += s(p.user_text).length + s(p.final_text).length;
    if (total > HISTORY_CHARS) break;
    picked.push(p);
  }
  return picked.reverse().flatMap((p) => [
    { role: "user" as const, content: s(p.user_text) },
    { role: "assistant" as const, content: s(p.final_text) },
  ]);
}

/** The most recent run in a conversation with its state, for "is this chat still working". */
export async function latestStatus(db: Client, scope: RunScope, conversationId: string): Promise<RunStatus | null> {
  const rs = await exec(db, {
    sql: `SELECT status FROM dept_chat_runs WHERE conversation_id = ? AND tenant_id = ? AND user_id = ? ORDER BY seq DESC LIMIT 1`,
    args: [conversationId, scope.tenantId, scope.userId],
  });
  const st = rows(rs)[0]?.status;
  return isRunStatus(st) ? st : null;
}
