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
  COMPUTER_CLAIM_DEADLINE_MS,
  COMPUTER_MAX_QUEUED_MS,
  MAX_QUEUED_RUNS,
  MAX_TITLE_CHARS,
  PRODUCER_SEQ_BASE,
  RUN_STALE_MS,
  RUN_STALE_PRODUCER_MS,
  isRunEventKind,
  isRunExecutor,
  isRunOrigin,
  isRunStatus,
  isWorkspaceApiFallbackReason,
  type RunEvent,
  type RunEventKind,
  type RunExecutor,
  type RunOrigin,
  type RunSource,
  type RunStatus,
  type WorkspaceApiFallbackReason,
} from "./types";
import { billingForBridge, recordModelCall, type ModelUsage } from "@/lib/ai/usage";
import { isApiEngineProvider, type ApiEngineProvider } from "@/lib/ai/agent-engine";

export type RunScope = { tenantId: string; userId: string };

/** Exact hosted account identity frozen when a run enters the queue. */
export type RunApiSnapshot = { provider: ApiEngineProvider; model: string };

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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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
  origin: RunOrigin;
  automationId: string | null;
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
    origin: originOf(r.origin),
    automationId: sOrNull(r.automation_id),
  };
}

const CONVERSATION_COLUMNS = `c.id, c.department_key, c.agent_slug, c.title, c.title_source, c.created_at, c.updated_at, c.last_message_at, c.origin, c.automation_id,
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
  input: { department: string; agentSlug: string; title?: string; now: Date; origin?: RunOrigin; automationId?: string | null },
): Promise<Conversation> {
  const id = newId();
  const at = iso(input.now);
  const title = cleanTitle(input.title);
  await exec(db, {
    sql: `INSERT INTO dept_chat_conversations (id, tenant_id, user_id, department_key, agent_slug, title, title_source, created_at, updated_at, last_message_at, origin, automation_id)
          VALUES (?, ?, ?, ?, ?, ?, 'auto', ?, ?, ?, ?, ?)`,
    args: [id, scope.tenantId, scope.userId, input.department, input.agentSlug, title, at, at, at, input.origin ?? "chat", input.automationId ?? null],
  });
  return { id, department: input.department, agentSlug: input.agentSlug, title, titleSource: "auto", createdAt: at, updatedAt: at, lastMessageAt: at, activeRuns: 0, origin: input.origin ?? "chat", automationId: input.automationId ?? null };
}

/** Find or create the one hidden conversation that is an automation's durable record. */
export async function ensureAutomationConversation(
  db: Client,
  scope: RunScope,
  input: { automationId: string; department: string; agentSlug: string; title: string; now: Date },
): Promise<Conversation> {
  const at = iso(input.now);
  const title = cleanTitle(input.title);
  const id = newId();
  try {
    await db.execute({
      sql: `INSERT OR IGNORE INTO dept_chat_conversations
              (id, tenant_id, user_id, department_key, agent_slug, title, title_source, created_at, updated_at, last_message_at, origin, automation_id)
            VALUES (?, ?, ?, ?, ?, ?, 'auto', ?, ?, ?, 'automation', ?)`,
      args: [id, scope.tenantId, scope.userId, input.department, input.agentSlug, title, at, at, at, input.automationId],
    });
    // A payload repaired after a preflight failure replaces only internal
    // receipt metadata; the conversation is never a chat surface.
    await db.execute({
      sql: `UPDATE dept_chat_conversations
            SET department_key = ?, agent_slug = ?, title = ?, updated_at = ?
            WHERE tenant_id = ? AND user_id = ? AND origin = 'automation' AND automation_id = ?`,
      args: [input.department, input.agentSlug, title, at, scope.tenantId, scope.userId, input.automationId],
    });
  } catch (err) {
    return guard(err);
  }
  const rs = await exec(db, {
    sql: `SELECT ${CONVERSATION_COLUMNS} FROM dept_chat_conversations c
          WHERE c.tenant_id = ? AND c.user_id = ? AND c.origin = 'automation' AND c.automation_id = ?`,
    args: [scope.tenantId, scope.userId, input.automationId],
  });
  const row = rows(rs)[0];
  if (!row) throw new Error("os.runs.ensure_automation_conversation: conversation collision");
  return conversationOf(row);
}

/**
 * Create the one conversation named by a trusted, deterministic idempotency
 * key, or return the matching conversation another retry already created.
 * This is intentionally not exposed to browser input: Slack's signed queue
 * job uses it so a serverless timeout can re-follow the same durable run
 * instead of enqueueing a second model call.
 */
export async function ensureConversation(
  db: Client,
  scope: RunScope,
  input: { id: string; department: string; agentSlug: string; title?: string; now: Date },
): Promise<Conversation> {
  if (!UUID_RE.test(input.id)) throw new Error("os.runs.ensure_conversation: the id is not a lowercase UUID");
  const at = iso(input.now);
  const title = cleanTitle(input.title);
  try {
    await db.execute({
      sql: `INSERT OR IGNORE INTO dept_chat_conversations (id, tenant_id, user_id, department_key, agent_slug, title, title_source, created_at, updated_at, last_message_at)
            VALUES (?, ?, ?, ?, ?, ?, 'auto', ?, ?, ?)`,
      args: [input.id, scope.tenantId, scope.userId, input.department, input.agentSlug, title, at, at, at],
    });
  } catch (err) {
    return guard(err);
  }
  const existing = await getConversation(db, scope, input.id);
  if (!existing || existing.department !== input.department || existing.agentSlug !== input.agentSlug) {
    throw new Error("os.runs.ensure_conversation: deterministic id collision");
  }
  return existing;
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
            AND c.origin = 'chat'
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
  /** O4: who may claim this run (migration bravo__213). */
  executor: RunExecutor;
  /** O4: the bridge_pairings row (computer) that claimed it; null until claimed, or for a worker run. */
  claimedPairingId: string | null;
  /** O4: why it was queued (chat before test before automation in the claim CAS). */
  origin: RunOrigin;
  /** O4: claim time + 20 minutes -- the longest an MCP or run token may outlive. null until claimed. */
  deadlineAt: string | null;
  /** V2: the one bridge_pairings row allowed to claim this run. null is a legacy unbound row. */
  targetPairingId: string | null;
  /** V2's snapshotted engine. These two fields are either both set or both null. */
  runtimeEngineKind: "api" | "cli" | "local" | null;
  runtimeEngineName: string | null;
  /** V2's queue-time fallback consent. A later settings edit cannot add spend to an already queued run. */
  runtimeFallbackPolicy: "none" | "workspace_api" | null;
  /** Set only by the guarded computer -> worker fallback CAS, and copied into the public agent audit event. */
  runtimeFallbackReason: string | null;
  /** The exact workspace API provider/model this run may spend, if any. */
  runtimeApiProvider: ApiEngineProvider | null;
  runtimeApiModel: string | null;
  /** O5: the guided automation and exact wall-clock occurrence this run receipts. */
  automationId: string | null;
  scheduledFor: string | null;
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

function sourceOf(raw: unknown): RunSource {
  return raw === "producer" ? "producer" : raw === "automation" ? "automation" : "worker";
}

const executorOf = (v: unknown): RunExecutor => (isRunExecutor(v) ? v : "worker");
const originOf = (v: unknown): RunOrigin => (isRunOrigin(v) ? v : "chat");
const runtimeEngineKindOf = (v: unknown): "api" | "cli" | "local" | null =>
  v === "api" || v === "cli" || v === "local" ? v : null;

function runOf(r: Record<string, unknown>): Run {
  return {
    id: s(r.id),
    tenantId: s(r.tenant_id),
    userId: s(r.user_id),
    source: sourceOf(r.source),
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
    executor: executorOf(r.executor),
    claimedPairingId: sOrNull(r.claimed_pairing_id),
    origin: originOf(r.origin),
    deadlineAt: sOrNull(r.deadline_at),
    targetPairingId: sOrNull(r.target_pairing_id),
    runtimeEngineKind: runtimeEngineKindOf(r.runtime_engine_kind),
    runtimeEngineName: sOrNull(r.runtime_engine_name),
    runtimeFallbackPolicy: r.runtime_fallback_policy === "workspace_api" ? "workspace_api" : r.runtime_fallback_policy === "none" ? "none" : null,
    runtimeFallbackReason: sOrNull(r.runtime_fallback_reason),
    runtimeApiProvider: isApiEngineProvider(r.runtime_api_provider) ? r.runtime_api_provider : null,
    runtimeApiModel: sOrNull(r.runtime_api_model),
    automationId: sOrNull(r.automation_id),
    scheduledFor: sOrNull(r.scheduled_for),
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

export async function getAutomationRunForSlot(
  db: Client,
  scope: RunScope,
  automationId: string,
  scheduledFor: Date,
): Promise<Run | null> {
  const rs = await exec(db, {
    sql: `SELECT * FROM dept_chat_runs
          WHERE tenant_id = ? AND user_id = ? AND automation_id = ? AND scheduled_for = ?
          ORDER BY created_at ASC LIMIT 1`,
    args: [scope.tenantId, scope.userId, automationId, iso(scheduledFor)],
  });
  const row = rows(rs)[0];
  return row ? runOf(row) : null;
}

export type TerminalAutomationRunInput = {
  id: string;
  conversationId: string;
  automationId: string;
  scheduledFor: Date;
  origin: "automation" | "test";
  status: "failed" | "missed";
  text: string;
  finalText: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  now: Date;
};

/** A durable receipt for work refused before queueing, or for an old slot that
 * must be recorded but never replayed. No driver or model touches this row. */
export async function recordTerminalAutomationRun(
  db: Client,
  scope: RunScope,
  input: TerminalAutomationRunInput,
): Promise<{ run: Run; created: boolean }> {
  if (!RUN_ID_RE.test(input.id)) throw new Error("os.runs.terminal_automation: invalid run id");
  const at = iso(input.now);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const inserted = await db.execute({
        sql: `INSERT INTO dept_chat_runs
                (id, tenant_id, user_id, conversation_id, department_key, agent_slug, seq, status,
                 user_text, chat_mode, source, show_thinking, final_text, error_code, created_at,
                 finished_at, executor, origin, automation_id, scheduled_for, deadline_at)
              SELECT ?, c.tenant_id, c.user_id, c.id, c.department_key, c.agent_slug,
                     COALESCE((SELECT MAX(r.seq) FROM dept_chat_runs r WHERE r.conversation_id = c.id), 0) + 1,
                     ?, ?, 'build', 'automation', 0, ?, ?, ?, ?, 'worker', ?, ?, ?, ?
              FROM dept_chat_conversations c
              WHERE c.id = ? AND c.tenant_id = ? AND c.user_id = ? AND c.origin = 'automation'
                AND NOT (? = 'missed' AND EXISTS (
                  SELECT 1 FROM dept_chat_runs x
                  WHERE x.tenant_id = c.tenant_id AND x.automation_id = ? AND x.scheduled_for = ? AND x.status <> 'missed'))`,
        args: [
          input.id,
          input.status,
          input.text,
          input.finalText,
          input.errorCode,
          at,
          at,
          input.origin,
          input.automationId,
          iso(input.scheduledFor),
          at,
          input.conversationId,
          scope.tenantId,
          scope.userId,
          input.status,
          input.automationId,
          iso(input.scheduledFor),
        ],
      });
      if (inserted.rowsAffected === 0) {
        // A "missed" note never sits beside a real run of the same slot (a live run claimed it while
        // this tick was deciding): the real run is the record.
        const existing = input.status === "missed" ? await getAutomationRunForSlot(db, scope, input.automationId, input.scheduledFor) : null;
        if (existing) return { run: existing, created: false };
        throw new Error("os.runs.terminal_automation: conversation not found");
      }
      const events: RunEvent[] = [];
      let seq = 1;
      if (input.errorCode && input.errorMessage) {
        events.push({ seq: seq++, kind: "error", data: { code: input.errorCode, message: input.errorMessage } });
      }
      events.push({ seq, kind: "done", data: { status: input.status } });
      await appendEvents(db, scope, input.id, events, input.now);
      const run = await getRun(db, scope, input.id);
      if (!run) throw new Error("os.runs.terminal_automation: run just written cannot be read");
      return { run, created: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/UNIQUE constraint failed:\s*dept_chat_runs\.automation_id,\s*dept_chat_runs\.scheduled_for/i.test(message)) {
        const existing = await getAutomationRunForSlot(db, scope, input.automationId, input.scheduledFor);
        if (existing) return { run: existing, created: false };
      }
      if (/UNIQUE constraint failed:\s*dept_chat_runs\.id/i.test(message)) {
        const existing = await getRun(db, scope, input.id);
        if (existing && existing.automationId === input.automationId && existing.scheduledFor === iso(input.scheduledFor)) {
          return { run: existing, created: false };
        }
      }
      if (/UNIQUE constraint failed:\s*dept_chat_runs\.conversation_id/i.test(message)) continue;
      return guard(err);
    }
  }
  throw new Error("os.runs.terminal_automation: could not take a place after 3 tries");
}

/**
 * The conversation's NEWEST `limit` runs, oldest of them first (the order a
 * transcript reads). A conversation longer than the limit shows its latest
 * messages, never its first ones.
 */
export async function listRuns(db: Client, scope: RunScope, conversationId: string, limit = 200): Promise<Run[]> {
  const rs = await exec(db, {
    sql: `SELECT * FROM dept_chat_runs WHERE conversation_id = ? AND tenant_id = ? AND user_id = ? ORDER BY seq DESC LIMIT ?`,
    args: [conversationId, scope.tenantId, scope.userId, Math.max(1, Math.min(limit, 500))],
  });
  return rows(rs).map(runOf).reverse();
}

/** Whether the conversation holds a department task's run: it is then that automation's record, not a chat. */
export async function hasAutomationRun(db: Client, scope: RunScope, conversationId: string): Promise<boolean> {
  const rs = await exec(db, {
    sql: `SELECT 1 AS x FROM dept_chat_runs WHERE conversation_id = ? AND tenant_id = ? AND user_id = ? AND source = 'automation' LIMIT 1`,
    args: [conversationId, scope.tenantId, scope.userId],
  });
  return rs.rows.length > 0;
}

/** A run id minted by the caller (crypto.randomUUID): checked before it is stored, never trusted. */
const RUN_ID_RE = UUID_RE;

export type EnqueueResult =
  | { ok: true; run: Run; created: boolean }
  | { ok: false; reason: "no_conversation" | "queue_full" | "already_claimed" };

/**
 * Add a message to a conversation as a QUEUED run. One statement computes its
 * place in the order and refuses it when MAX_QUEUED_RUNS are already waiting;
 * the unique (conversation, seq) index settles two messages sent at once (one
 * retry takes the next place). A queued run that never runs writes nothing to
 * the AI usage ledger: only a run a driver starts calls a model.
 *
 * `id` and `source` are for a department task's run (lib/automations): the
 * automation records the run id before it enqueues, so a crash in between can
 * be reconciled, and source 'automation' keeps every chat driver off it.
 *
 * `executor` (O4) is 'computer' for a person whose effective engine is their
 * own paired computer: the row sits `queued` until the claim route's
 * compare-and-swap claims it (claimComputerRun) -- claimNextRun (the Worker's
 * own driver) explicitly excludes it, so send.ts starting NO driver for such a
 * message is a belt the claimNextRun filter is the suspenders for. `origin`
 * orders the claim CAS (chat before test before automation); O4 itself only
 * ever writes 'chat'.
 */
export async function enqueueRun(
  db: Client,
  scope: RunScope,
  input: {
    conversationId: string;
    text: string;
    chatMode: "plan" | "build";
    showThinking: boolean;
    now: Date;
    id?: string;
    source?: "automation";
    executor?: RunExecutor;
    origin?: RunOrigin;
    automationId?: string;
    scheduledFor?: Date;
    deadlineAt?: Date;
    targetPairingId?: string;
    runtimeEngineKind?: "api" | "cli" | "local";
    runtimeEngineName?: string;
    runtimeFallbackPolicy?: "none" | "workspace_api";
    runtimeFallbackReason?: WorkspaceApiFallbackReason;
    runtimeApiSnapshot?: RunApiSnapshot;
    /** Trusted retry key. A duplicate id reuses only an exactly matching run. */
    idempotent?: boolean;
  },
): Promise<EnqueueResult> {
  if (input.id !== undefined && !RUN_ID_RE.test(input.id)) throw new Error("os.runs.enqueue: the run id is not a lowercase UUID");
  if (input.idempotent && input.id === undefined) throw new Error("os.runs.enqueue: idempotent enqueue requires a run id");
  if (input.source !== undefined && input.source !== "automation") throw new Error("os.runs.enqueue: unknown run source");
  if (input.executor !== undefined && !isRunExecutor(input.executor)) throw new Error("os.runs.enqueue: unknown executor");
  if (input.origin !== undefined && !isRunOrigin(input.origin)) throw new Error("os.runs.enqueue: unknown origin");
  if (input.source === "automation") {
    if (!input.automationId?.trim() || !input.scheduledFor || !input.deadlineAt) {
      throw new Error("os.runs.enqueue: an automation run requires automationId, scheduledFor and deadlineAt");
    }
    const automationOrigin = input.origin ?? "automation";
    if (automationOrigin !== "automation" && automationOrigin !== "test") {
      throw new Error("os.runs.enqueue: an automation run needs automation or test origin");
    }
  } else if (input.automationId !== undefined || input.scheduledFor !== undefined || input.deadlineAt !== undefined) {
    throw new Error("os.runs.enqueue: automation metadata requires automation source");
  }
  const hasRuntimeSnapshot =
    input.targetPairingId !== undefined ||
    input.runtimeEngineKind !== undefined ||
    input.runtimeEngineName !== undefined ||
    input.runtimeFallbackPolicy !== undefined ||
    input.runtimeFallbackReason !== undefined ||
    input.runtimeApiSnapshot !== undefined;
  const hasComputerSnapshot =
    input.targetPairingId !== undefined ||
    input.runtimeEngineKind === "cli" ||
    input.runtimeEngineKind === "local" ||
    input.runtimeFallbackPolicy !== undefined ||
    input.runtimeFallbackReason !== undefined;
  if (hasComputerSnapshot) {
    const activatedFallback = input.runtimeFallbackReason !== undefined;
    if ((!activatedFallback && input.executor !== "computer") || (activatedFallback && (input.executor ?? "worker") !== "worker")) {
      throw new Error("os.runs.enqueue: a runtime snapshot requires the matching computer/fallback executor");
    }
    if (
      !input.targetPairingId?.trim() ||
      (input.runtimeEngineKind !== "cli" && input.runtimeEngineKind !== "local") ||
      !input.runtimeEngineName?.trim()
    ) {
      throw new Error("os.runs.enqueue: target pairing and engine snapshot must be complete");
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.targetPairingId)) {
      throw new Error("os.runs.enqueue: invalid target pairing");
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/.test(input.runtimeEngineName)) {
      throw new Error("os.runs.enqueue: invalid runtime engine name");
    }
    if (input.runtimeFallbackPolicy !== undefined && input.runtimeFallbackPolicy !== "none" && input.runtimeFallbackPolicy !== "workspace_api") {
      throw new Error("os.runs.enqueue: invalid runtime fallback policy");
    }
    if (input.runtimeFallbackPolicy === "workspace_api" && !input.runtimeApiSnapshot) {
      throw new Error("os.runs.enqueue: workspace API fallback requires an exact API snapshot");
    }
    if (
      activatedFallback &&
      (input.runtimeFallbackPolicy !== "workspace_api" || !isWorkspaceApiFallbackReason(input.runtimeFallbackReason))
    ) {
      throw new Error("os.runs.enqueue: activated fallback requires an allowed reason and policy");
    }
  }
  if (input.runtimeEngineKind === "api") {
    if ((input.executor ?? "worker") !== "worker" || input.targetPairingId !== undefined) {
      throw new Error("os.runs.enqueue: an API snapshot requires the worker executor");
    }
    if (!input.runtimeApiSnapshot || input.runtimeEngineName !== input.runtimeApiSnapshot.provider) {
      throw new Error("os.runs.enqueue: API provider and account snapshot must be complete");
    }
  }
  if (input.runtimeApiSnapshot) {
    if (!isApiEngineProvider(input.runtimeApiSnapshot.provider)) throw new Error("os.runs.enqueue: invalid API provider snapshot");
    const model = input.runtimeApiSnapshot.model.trim();
    if (!model || model.length > 240 || /[\u0000-\u001f\u007f]/.test(model)) {
      throw new Error("os.runs.enqueue: invalid API model snapshot");
    }
    if (input.runtimeEngineKind !== "api" && input.runtimeFallbackPolicy !== "workspace_api") {
      throw new Error("os.runs.enqueue: API snapshot is not used by this run");
    }
  }
  const id = input.id ?? newId();
  const source: RunSource = input.source ?? "worker";
  const executor: RunExecutor = input.executor ?? "worker";
  const origin: RunOrigin = input.origin ?? "chat";
  const at = iso(input.now);
  const scheduledFor = input.scheduledFor ? iso(input.scheduledFor) : null;
  const deadlineAt = input.deadlineAt ? iso(input.deadlineAt) : null;
  const matchesRetry = (run: Run): boolean =>
    run.conversationId === input.conversationId &&
    run.userText === input.text &&
    run.chatMode === input.chatMode &&
    run.showThinking === input.showThinking &&
    run.source === source &&
    run.executor === executor &&
    run.origin === origin &&
    run.targetPairingId === (input.targetPairingId ?? null) &&
    run.runtimeEngineKind === (input.runtimeEngineKind ?? null) &&
    run.runtimeEngineName === (input.runtimeEngineName ?? null) &&
    run.runtimeFallbackPolicy === (input.runtimeFallbackPolicy ?? (hasRuntimeSnapshot ? "none" : null)) &&
    run.runtimeFallbackReason === (input.runtimeFallbackReason ?? null) &&
    run.runtimeApiProvider === (input.runtimeApiSnapshot?.provider ?? null) &&
    run.runtimeApiModel === (input.runtimeApiSnapshot?.model.trim() ?? null) &&
    run.automationId === (input.automationId ?? null) &&
    run.scheduledFor === scheduledFor &&
    run.deadlineAt === deadlineAt;
  if (input.idempotent) {
    const existing = await getRun(db, scope, id);
    if (existing) {
      if (!matchesRetry(existing)) throw new Error("os.runs.enqueue: idempotency key reused with different input");
      return { ok: true, run: existing, created: false };
    }
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    let affected = 0;
    try {
      const rs = await db.execute({
        sql: `INSERT INTO dept_chat_runs (id, tenant_id, user_id, conversation_id, department_key, agent_slug, seq, status, user_text, chat_mode, source, show_thinking, executor, origin, automation_id, scheduled_for, deadline_at, target_pairing_id, runtime_engine_kind, runtime_engine_name, runtime_fallback_policy, runtime_fallback_reason, runtime_api_provider, runtime_api_model, created_at)
              SELECT ?, c.tenant_id, c.user_id, c.id, c.department_key, c.agent_slug,
                     COALESCE((SELECT MAX(r.seq) FROM dept_chat_runs r WHERE r.conversation_id = c.id), 0) + 1,
                     'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
              FROM dept_chat_conversations c
              WHERE c.id = ? AND c.tenant_id = ? AND c.user_id = ?
                AND (SELECT COUNT(*) FROM dept_chat_runs q WHERE q.conversation_id = c.id AND q.status = 'queued') < ?`,
        args: [
          id,
          input.text,
          input.chatMode,
          source,
          input.showThinking ? 1 : 0,
          executor,
          origin,
          input.automationId ?? null,
          scheduledFor,
          deadlineAt,
          input.targetPairingId ?? null,
          input.runtimeEngineKind ?? null,
          input.runtimeEngineName ?? null,
          input.runtimeFallbackPolicy ?? (hasRuntimeSnapshot ? "none" : null),
          input.runtimeFallbackReason ?? null,
          input.runtimeApiSnapshot?.provider ?? null,
          input.runtimeApiSnapshot?.model.trim() ?? null,
          at,
          input.conversationId,
          scope.tenantId,
          scope.userId,
          MAX_QUEUED_RUNS,
        ],
      });
      affected = rs.rowsAffected;
    } catch (err) {
      if (input.idempotent && /UNIQUE constraint failed:\s*dept_chat_runs\.id/i.test(err instanceof Error ? err.message : String(err))) {
        const existing = await getRun(db, scope, id);
        if (existing && matchesRetry(existing)) return { ok: true, run: existing, created: false };
        throw new Error("os.runs.enqueue: idempotency key collision");
      }
      if (/UNIQUE constraint failed:\s*dept_chat_runs\.automation_id,\s*dept_chat_runs\.scheduled_for/i.test(err instanceof Error ? err.message : String(err))) {
        return { ok: false, reason: "already_claimed" };
      }
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
    return { ok: true, run, created: true };
  }
  throw new Error("os.runs.enqueue: could not take a place in the order after 3 tries");
}

/**
 * Claim the conversation's next queued run, if nothing in it is running. One
 * UPDATE: the earliest queued run becomes `running` under `leaseId` only when
 * no run in the conversation is running, so two drivers cannot both start one.
 *
 * A CHAT driver's claim: it never takes an automation's run (source
 * 'automation'). Those run as their owner with the automation's own limits
 * (lookups, proposals, time), which only the automation driver carries
 * (claimAutomationRun); a chat driver would run one with the chat's.
 *
 * NEVER a computer-executor run (O4 security rule 6, "WORKER-DRIVEN RUNS"):
 * `executor = 'worker'` in the OUTER WHERE means a run a person's own paired
 * computer must answer can never be claimed and run here on the workspace's
 * API account. An explicitly opted-in fallback first changes the queued row
 * to executor='worker' through fallbackQueuedComputerRun's guarded CAS.
 * send.ts starting no driver for such a message is the first line; this
 * filter is the one that holds even if that is ever missed, bypassed, or
 * called from a path that does not know about O4.
 *
 * QUEUE ORDER ACROSS EXECUTORS (Codex review, 2026-10-11, [P2]). The INNER
 * subquery picks the conversation's earliest QUEUED run of EITHER executor
 * -- no `executor = 'worker'` filter there at all -- and the outer clause
 * then claims it ONLY IF that earliest row is itself executor='worker'. A
 * person who sent a computer-dispatched message (seq 1, still queued),
 * then switched engines and sent another (seq 2, executor='worker'), must
 * never have seq 2 run ahead of seq 1 in its own history: before this fix,
 * the inner subquery filtered to executor='worker' FIRST, so it found seq
 * 2 as "the earliest WORKER-executor queued run" and claimed it, skipping
 * seq 1 entirely. Now, with seq 1 still the conversation's overall
 * earliest-queued row, the id the subquery returns is seq 1's -- which
 * fails the outer `executor = 'worker'` check -- so this claims NOTHING
 * until seq 1 is claimed (by a computer) and finishes, exactly mirroring
 * claimComputerRun's own MIN(f.seq)-over-every-executor subquery below.
 */
export async function claimNextRun(db: Client, scope: RunScope, conversationId: string, leaseId: string, now: Date): Promise<Run | null> {
  const at = iso(now);
  const rs = await exec(db, {
    sql: `UPDATE dept_chat_runs
          SET status = 'running', lease_id = ?, started_at = ?, heartbeat_at = ?
          WHERE tenant_id = ? AND user_id = ? AND conversation_id = ? AND status = 'queued' AND source <> 'automation' AND executor = 'worker'
            AND id = (SELECT q.id FROM dept_chat_runs q
                      WHERE q.conversation_id = ? AND q.tenant_id = ? AND q.user_id = ? AND q.status = 'queued' AND q.source <> 'automation'
                      ORDER BY q.seq ASC LIMIT 1)
            AND NOT EXISTS (SELECT 1 FROM dept_chat_runs x WHERE x.conversation_id = ? AND x.tenant_id = ? AND x.status = 'running')`,
    args: [leaseId, at, at, scope.tenantId, scope.userId, conversationId, conversationId, scope.tenantId, scope.userId, conversationId, scope.tenantId],
  });
  if (rs.rowsAffected === 0) return null;
  return claimedBy(db, scope, conversationId, leaseId);
}

async function claimedBy(db: Client, scope: RunScope, conversationId: string, leaseId: string): Promise<Run | null> {
  const got = await exec(db, {
    sql: `SELECT * FROM dept_chat_runs WHERE lease_id = ? AND conversation_id = ? AND tenant_id = ? AND user_id = ? AND status = 'running'`,
    args: [leaseId, conversationId, scope.tenantId, scope.userId],
  });
  const r = rows(got)[0];
  return r ? runOf(r) : null;
}

/**
 * The automation driver's claim: exactly the run it names, only when that run
 * is an automation's, still queued, and nothing in its conversation is running.
 * One UPDATE, so two drivers (a dispatcher tick and its retry) cannot both
 * start it.
 */
export async function claimAutomationRun(
  db: Client,
  scope: RunScope,
  conversationId: string,
  runId: string,
  leaseId: string,
  now: Date,
): Promise<Run | null> {
  const at = iso(now);
  const rs = await exec(db, {
    sql: `UPDATE dept_chat_runs
          SET status = 'running', lease_id = ?, started_at = ?, heartbeat_at = ?
          WHERE id = ? AND tenant_id = ? AND user_id = ? AND conversation_id = ? AND source = 'automation' AND status = 'queued'
            AND NOT EXISTS (SELECT 1 FROM dept_chat_runs x WHERE x.conversation_id = ? AND x.tenant_id = ? AND x.status = 'running')`,
    args: [leaseId, at, at, runId, scope.tenantId, scope.userId, conversationId, conversationId, scope.tenantId],
  });
  if (rs.rowsAffected === 0) return null;
  return claimedBy(db, scope, conversationId, leaseId);
}

// -- O4: a person's own paired computer claims its runs (pull dispatch) ------

/** The pairing (computer) a claim call authenticates as; tenant and user come ONLY from the pairing row, never a request body. */
export type ClaimPairing = { tenantId: string; userId: string; pairingId: string };

/** Read the exact run the claim CAS would choose, without mutating it. V2
 * callers use this only to validate the connector's freshly reported state
 * for that run's snapshotted engine, then pass its id back into the CAS. */
export async function peekComputerRun(
  db: Client,
  pairing: ClaimPairing,
  protocol: "department_task_v1" | "department_task_v2" = "department_task_v1",
): Promise<Run | null> {
  const rs = await exec(db, {
    sql: `SELECT q.* FROM dept_chat_runs q
          WHERE q.tenant_id = ? AND q.executor = 'computer' AND q.status = 'queued'
            AND ((? = 'department_task_v2' AND q.target_pairing_id = ?) OR (q.target_pairing_id IS NULL AND q.user_id = ?))
            AND EXISTS (
              SELECT 1 FROM bridge_pairings bp
              WHERE bp.id = ? AND bp.tenant_id = ? AND bp.user_id = ? AND bp.revoked_at IS NULL AND bp.claim_enabled_at IS NOT NULL
            )
            AND q.seq = (SELECT MIN(f.seq) FROM dept_chat_runs f WHERE f.conversation_id = q.conversation_id AND f.status = 'queued')
            AND NOT EXISTS (SELECT 1 FROM dept_chat_runs x WHERE x.conversation_id = q.conversation_id AND x.status = 'running')
          ORDER BY CASE q.origin WHEN 'chat' THEN 0 WHEN 'test' THEN 1 ELSE 2 END, q.created_at
          LIMIT 1`,
    args: [
      pairing.tenantId,
      protocol,
      pairing.pairingId,
      pairing.userId,
      pairing.pairingId,
      pairing.tenantId,
      pairing.userId,
    ],
  });
  const row = rows(rs)[0];
  return row ? runOf(row) : null;
}

/**
 * The claim route's compare-and-swap. ONE person's computer-executor runs,
 * across every one of their conversations, chat before test before
 * automation, oldest first WITHIN its own conversation, and only when
 * nothing in that conversation is already running. Claiming ALSO hands the
 * run straight to the producer (source = 'producer') in the same statement:
 * a pull-claimed run writes its events through the identical door a
 * push-handed-over run does (./producer.ts ingestBatch, the events route's
 * existing `source = 'producer'` gate) -- O4 adds no new event-writing path.
 * `claimId` becomes the run's lease_id, so a lost answer retried with the
 * same claim_id is found again by findClaimedComputerRun, idempotently.
 *
 * THE PAIRING'S LIVE STATE IS PART OF THE SAME STATEMENT (Codex review,
 * 2026-10-11, [P1]). The claim route authenticates the bearer once, at
 * request start, then may long-poll for up to 20 s before this runs again;
 * a computer disconnected (its pairing revoked) mid-wait must never have a
 * NEWLY queued message, its conversation history and department context
 * handed to it on a later poll just because the request started before the
 * revocation. bridge_pairings lives in the SAME Turso database dept_chat_runs
 * does (both reachable from one libSQL connection; the Supabase-shaped
 * client is a different WRAPPER over the identical tables, never a
 * different database), so this EXISTS subquery re-checks revoked_at AND
 * claim_enabled_at, atomically, in the same UPDATE that claims the run --
 * not a read-then-decide two-step a revocation could land inside of.
 *
 * CLAIM-ID DEDUP IS ATOMIC WITH CLAIMING (Codex review, 2026-10-11, [P2]).
 * Two overlapping requests for the SAME (pairing, claim_id) -- a retry
 * racing its own original, both past the idempotent-retry lookup because
 * neither had claimed anything yet -- must never land on two DIFFERENT
 * runs: the connector asks about one claim_id once. The partial unique
 * index dept_chat_runs_pairing_claim_idx (bravo__213) makes the SECOND
 * commit of this UPDATE fail outright when it would set the SAME
 * (claimed_pairing_id, lease_id) pair onto a DIFFERENT row that is already
 * running under it -- caught here and reported as "lost the race" (null),
 * never left to bubble up as an unhandled 500. The caller (the claim
 * route) then asks findClaimedComputerRun for the WINNER's assignment
 * rather than treating this call as "nothing was claimable".
 *
 * QUEUE ORDER ACROSS EXECUTORS (Codex review, 2026-10-11, round 2, [P2]):
 * already correct, by construction, and left unchanged here -- documented
 * so the next reader does not "fix" it to match claimNextRun's bug. The
 * inner `f.seq` subquery that computes MIN(f.seq) carries NO executor
 * filter (unlike the OUTER `q.executor = 'computer'`, which only narrows
 * which rows this function may even consider claiming): it is the
 * conversation's overall earliest QUEUED seq, any executor, any origin. A
 * computer-executor candidate only matches `q.seq = MIN(f.seq)` when
 * NOTHING queued ahead of it -- worker-executor included -- so an earlier
 * worker-dispatched message never gets skipped the way claimNextRun's old
 * bug skipped an earlier computer-dispatched one.
 */
export async function claimComputerRun(
  db: Client,
  pairing: ClaimPairing,
  claimId: string,
  now: Date,
  protocol: "department_task_v1" | "department_task_v2" = "department_task_v1",
  expectedRunId: string | null = null,
): Promise<Run | null> {
  const at = iso(now);
  const deadline = iso(new Date(now.getTime() + COMPUTER_CLAIM_DEADLINE_MS));
  let rs: ResultSet;
  try {
    rs = await exec(db, {
      sql: `UPDATE dept_chat_runs
            SET status = 'running', source = 'producer', lease_id = ?, claimed_pairing_id = ?, started_at = ?, heartbeat_at = ?, deadline_at = ?
            WHERE status = 'queued' AND executor = 'computer' AND tenant_id = ?
              AND ((? = 'department_task_v2' AND target_pairing_id = ?) OR (target_pairing_id IS NULL AND user_id = ?))
              AND EXISTS (
                SELECT 1 FROM bridge_pairings bp
                WHERE bp.id = ? AND bp.tenant_id = ? AND bp.user_id = ? AND bp.revoked_at IS NULL AND bp.claim_enabled_at IS NOT NULL
              )
              AND (? IS NULL OR id = ?)
              AND id = (
                SELECT q.id FROM dept_chat_runs q
                WHERE q.tenant_id = ? AND q.executor = 'computer' AND q.status = 'queued'
                  AND ((? = 'department_task_v2' AND q.target_pairing_id = ?) OR (q.target_pairing_id IS NULL AND q.user_id = ?))
                  AND q.seq = (SELECT MIN(f.seq) FROM dept_chat_runs f WHERE f.conversation_id = q.conversation_id AND f.status = 'queued')
                  AND NOT EXISTS (SELECT 1 FROM dept_chat_runs x WHERE x.conversation_id = q.conversation_id AND x.status = 'running')
                ORDER BY CASE q.origin WHEN 'chat' THEN 0 WHEN 'test' THEN 1 ELSE 2 END, q.created_at
                LIMIT 1
              )
            RETURNING *`,
      args: [
        claimId,
        pairing.pairingId,
        at,
        at,
        deadline,
        pairing.tenantId,
        protocol,
        pairing.pairingId,
        pairing.userId,
        pairing.pairingId,
        pairing.tenantId,
        pairing.userId,
        expectedRunId,
        expectedRunId,
        pairing.tenantId,
        protocol,
        pairing.pairingId,
        pairing.userId,
      ],
    });
  } catch (err) {
    // SQLite reports a UNIQUE violation by COLUMN list, not index name:
    // "SQLITE_CONSTRAINT: UNIQUE constraint failed: dept_chat_runs.claimed_pairing_id, dept_chat_runs.lease_id"
    // (verified against a real libSQL file; `code` is "SQLITE_CONSTRAINT_UNIQUE"
    // on a LibsqlError, checked first as the more structured signal).
    const code = (err as { code?: unknown } | null)?.code;
    const message = err instanceof Error ? err.message : String(err);
    const isPairingClaimCollision =
      code === "SQLITE_CONSTRAINT_UNIQUE" || /UNIQUE constraint failed/i.test(message);
    if (isPairingClaimCollision && /claimed_pairing_id/i.test(message) && /lease_id/i.test(message)) return null;
    throw err;
  }
  const r = rows(rs)[0];
  return r ? runOf(r) : null;
}

/**
 * Set this run's first_in_line_at ONCE (Codex review, 2026-10-11, [P2]):
 * called every time a follower observes it queued. The CAS (COALESCE
 * against the existing value) means the FIRST observation wins and every
 * later one is a no-op that still returns the same, durable value -- never
 * a value kept only in one follower stream's local state, which a
 * reconnect (every ~25 s, TAIL_WINDOW_MS) would otherwise forget, resetting
 * the clock and letting a continuously busy computer's queue sail past
 * computer_busy_timeout into the 10-minute absolute cap instead.
 *
 * TRULY first in line, not merely "nothing RUNNING yet" (Codex review,
 * round 2, 2026-10-11, [P2]). The NOT EXISTS below is checked INSIDE this
 * same UPDATE -- atomic with the write, not a separate read the caller
 * decides from -- and requires no OTHER non-automation run in this
 * conversation, at a LOWER seq, that is still 'queued' OR 'running'. With
 * two computer messages queued (seq 1, seq 2) and neither claimed yet, a
 * follower of seq 2 used to set ITS OWN first_in_line_at immediately
 * (conversationActivity.live only checks 'running' rows, and nothing was
 * running yet), even though seq 1 -- still queued -- was genuinely ahead
 * of it. The moment seq 1 finished, seq 2's clock (already ticking since
 * whenever a follower first glanced at it) could already exceed
 * COMPUTER_BUSY_TIMEOUT_MS, failing it on the spot with zero real
 * first-in-line wait. Now seq 2 cannot set its own timestamp AT ALL while
 * seq 1 is still queued or running; the first observation AFTER seq 1
 * truly leaves the queue is the one that sets it, correctly, at zero.
 *
 * Returns null when the run is no longer queued, OR when something
 * earlier (any executor) is still queued or running ahead of it -- the
 * caller treats both the same way: no clock to protect against yet, so it
 * falls back to "now" (waited = 0) for this observation.
 */
export async function markFirstInLine(db: Client, scope: RunScope, run: Pick<Run, "id" | "conversationId" | "seq">, now: Date): Promise<string | null> {
  const rs = await exec(db, {
    sql: `UPDATE dept_chat_runs SET first_in_line_at = COALESCE(first_in_line_at, ?)
          WHERE id = ? AND tenant_id = ? AND user_id = ? AND status = 'queued'
            AND NOT EXISTS (
              SELECT 1 FROM dept_chat_runs x
              WHERE x.conversation_id = ? AND x.source <> 'automation' AND x.seq < ? AND x.status IN ('queued', 'running')
            )
          RETURNING first_in_line_at`,
    args: [iso(now), run.id, scope.tenantId, scope.userId, run.conversationId, run.seq],
  });
  const r = rows(rs)[0];
  return r ? sOrNull(r.first_in_line_at) : null;
}

/**
 * The idempotent-retry lookup: a run THIS pairing already claimed under
 * THIS claim_id, still running. Called only when claimComputerRun matched
 * nothing (every queued computer run was already claimed, or there was
 * none) -- the claim route then checks producerEventsExist to tell a safe
 * retry (mint fresh tokens again) from claim_already_started (409).
 */
export async function findClaimedComputerRun(
  db: Client,
  pairing: ClaimPairing,
  claimId: string,
  protocol: "department_task_v1" | "department_task_v2" = "department_task_v1",
): Promise<Run | null> {
  const rs = await exec(db, {
    sql: `SELECT * FROM dept_chat_runs
          WHERE lease_id = ? AND claimed_pairing_id = ? AND tenant_id = ? AND executor = 'computer' AND status = 'running'
            AND (? = 'department_task_v2' OR target_pairing_id IS NULL)`,
    args: [claimId, pairing.pairingId, pairing.tenantId, protocol],
  });
  const r = rows(rs)[0];
  return r ? runOf(r) : null;
}

/** Whether the computer has already posted at least one event for this run (the producer event range starts at PRODUCER_SEQ_BASE). */
export async function producerEventsExist(db: Client, run: Run): Promise<boolean> {
  const rs = await exec(db, {
    sql: `SELECT 1 AS x FROM dept_chat_run_events WHERE run_id = ? AND tenant_id = ? AND seq >= ? LIMIT 1`,
    args: [run.id, run.tenantId, PRODUCER_SEQ_BASE],
  });
  return rs.rows.length > 0;
}

/**
 * Fail ONE queued computer-executor run with `code` (the claim route's three
 * clocks: computer_not_answering, computer_busy_timeout, or a blocked
 * reason -- lib/os/runs/follow.ts owns the clocks; this is the guarded CAS
 * they act through). Guarded by status = 'queued' AND executor = 'computer',
 * so a run that was claimed a moment before this runs is left alone.
 */
export async function failQueuedComputerRun(db: Client, scope: RunScope, runId: string, code: string, now: Date): Promise<boolean> {
  const rs = await exec(db, {
    sql: `UPDATE dept_chat_runs SET status = 'failed', error_code = ?, finished_at = ?
          WHERE id = ? AND tenant_id = ? AND user_id = ? AND status = 'queued' AND executor = 'computer'`,
    args: [code, iso(now), runId, scope.tenantId, scope.userId],
  });
  if (rs.rowsAffected === 0) return false;
  const { failureCopy } = await import("@/lib/os/channel/outcome");
  const message = failureCopy(code, { canManageAi: false }).sentence;
  await closeRun(db, scope, runId, "failed", { code, message }, now);
  return true;
}

/**
 * Fail ONE queued automation run that could not start (another run held its
 * conversation, so the claim was refused). Without this the row would stay
 * `queued` for ever, count against the conversation's queue and read "Running
 * now". Guarded by status = 'queued' AND source = 'automation', so a run that
 * a driver claimed a moment before is left alone.
 */
export async function failQueuedAutomationRun(db: Client, scope: RunScope, runId: string, code: string, now: Date): Promise<boolean> {
  const rs = await exec(db, {
    sql: `UPDATE dept_chat_runs SET status = 'failed', error_code = ?, finished_at = ?
          WHERE id = ? AND tenant_id = ? AND user_id = ? AND source = 'automation' AND status = 'queued'`,
    args: [code, iso(now), runId, scope.tenantId, scope.userId],
  });
  if (rs.rowsAffected === 0) return false;
  const { failureCopy } = await import("@/lib/os/channel/outcome");
  const message = failureCopy(code, { canManageAi: false }).sentence;
  await closeRun(db, scope, runId, "failed", { code, message }, now);
  return true;
}

/**
 * True when this automation has a run that is queued or running right now (any
 * origin). A row whose driver stopped reporting two minutes ago does not count:
 * the executor's reaper closes it, and it must not block a person for ever.
 */
export async function automationHasLiveRun(db: Client, scope: RunScope, automationId: string, now: Date): Promise<boolean> {
  const rs = await exec(db, {
    sql: `SELECT 1 AS x FROM dept_chat_runs
          WHERE tenant_id = ? AND user_id = ? AND automation_id = ? AND status IN ('queued', 'running')
            AND COALESCE(heartbeat_at, started_at, created_at) > ? LIMIT 1`,
    args: [scope.tenantId, scope.userId, automationId, iso(new Date(now.getTime() - 120_000))],
  });
  return rows(rs).length > 0;
}

/**
 * Convert one still-queued exact-device run into a Worker run using the
 * workspace API. The queue-time policy and an availability-only reason are
 * both checked inside this function, while the UPDATE itself is the race gate
 * against a connector claiming the run. A claim that wins first leaves the
 * producer run untouched and returns false.
 */
export async function fallbackQueuedComputerRun(
  db: Client,
  scope: RunScope,
  runId: string,
  reason: WorkspaceApiFallbackReason,
): Promise<boolean> {
  if (!isWorkspaceApiFallbackReason(reason)) return false;
  const rs = await exec(db, {
    sql: `UPDATE dept_chat_runs
          SET executor = 'worker', runtime_fallback_reason = ?, first_in_line_at = NULL
          WHERE id = ? AND tenant_id = ? AND user_id = ?
            AND status = 'queued' AND executor = 'computer'
            AND runtime_fallback_policy = 'workspace_api'
          RETURNING id`,
    args: [reason, runId, scope.tenantId, scope.userId],
  });
  return rows(rs).length > 0;
}

/** Queued opt-in fallbacks that need a durable dispatcher. This deliberately
 * includes rows already promoted to executor=worker: a prior browser follower
 * or connector cleanup may have won the promotion CAS and then disappeared
 * before starting the hosted driver. */
export async function listQueuedFallbackRuns(db: Client, limit = 100): Promise<Run[]> {
  const rs = await exec(db, {
    sql: `SELECT * FROM dept_chat_runs
          WHERE status = 'queued' AND origin = 'chat'
            AND runtime_fallback_policy = 'workspace_api'
            AND (
              executor = 'computer'
              OR (executor = 'worker' AND runtime_fallback_reason IS NOT NULL)
            )
          ORDER BY created_at, id
          LIMIT ?`,
    args: [Math.max(1, Math.min(limit, 500))],
  });
  return rows(rs).map(runOf);
}

/** Worker fallbacks whose hosted driver stopped heartbeating. The durable
 * scheduler calls reapStale for these conversations before scanning queued
 * work, so an origin/request termination cannot leave the queue permanently
 * blocked behind a dead `running` row. */
export async function listStaleRunningFallbackRuns(db: Client, now: Date, limit = 100): Promise<Run[]> {
  const workerCutoff = iso(new Date(now.getTime() - RUN_STALE_MS));
  const rs = await exec(db, {
    sql: `SELECT * FROM dept_chat_runs
          WHERE status = 'running' AND source = 'worker' AND executor = 'worker'
            AND runtime_fallback_policy = 'workspace_api'
            AND runtime_fallback_reason IS NOT NULL
            AND heartbeat_at < ?
          ORDER BY heartbeat_at, id
          LIMIT ?`,
    args: [workerCutoff, Math.max(1, Math.min(limit, 500))],
  });
  return rows(rs).map(runOf);
}

/** End a queued fallback that cannot safely rebuild its requester/workspace
 * authorization. Both the pre-promotion and post-promotion shapes are guarded;
 * a connector/worker that claimed first wins and is never overwritten. */
export async function failQueuedFallbackRun(
  db: Client,
  scope: RunScope,
  runId: string,
  code: string,
  message: string,
  now: Date,
): Promise<boolean> {
  const rs = await exec(db, {
    sql: `UPDATE dept_chat_runs SET status = 'failed', error_code = ?, finished_at = ?
          WHERE id = ? AND tenant_id = ? AND user_id = ? AND status = 'queued'
            AND runtime_fallback_policy = 'workspace_api'
            AND (executor = 'computer' OR (executor = 'worker' AND runtime_fallback_reason IS NOT NULL))`,
    args: [code, iso(now), runId, scope.tenantId, scope.userId],
  });
  if (rs.rowsAffected === 0) return false;
  await closeRun(db, scope, runId, "failed", { code, message }, now);
  return true;
}

/**
 * Pre-claim cleanup, run once at the top of every claim call (O4 "Before
 * claiming, clean up for this person, so the queue never holds work
 * forever"): reap this person's own computer-executor runs a producer went
 * silent on past RUN_STALE_PRODUCER_MS, and fail any of their CHAT runs that
 * have sat queued past COMPUTER_MAX_QUEUED_MS. automation-run cleanup
 * (scheduled_for more than 12h old -> 'missed') is O5's: no run O4 enqueues
 * ever carries an automation_id, so there is nothing for it to do yet.
 */
export async function claimCleanup(db: Client, scope: RunScope, now: Date): Promise<{ reaped: string[]; timedOut: string[] }> {
  const reaped = await reapStaleComputerRuns(db, scope, now);
  const timedOut = await failLongQueuedComputerRuns(db, scope, now);
  return { reaped, timedOut };
}

/**
 * V2 cleanup follows the exact pairing snapshot rather than the connector
 * owner's user id. A workspace-default owner computer can legitimately run a
 * member's private conversation, so user-scoped cleanup would otherwise leave
 * that member's stale/expired rows behind forever. V1 keeps claimCleanup's
 * historical person scope.
 */
export async function claimCleanupForPairing(
  db: Client,
  target: { tenantId: string; pairingId: string },
  now: Date,
): Promise<{ reaped: string[]; timedOut: string[]; fellBack: string[] }> {
  const staleCutoff = iso(new Date(now.getTime() - RUN_STALE_PRODUCER_MS));
  const stale = rows(
    await exec(db, {
      sql: `SELECT id, user_id FROM dept_chat_runs
            WHERE tenant_id = ? AND target_pairing_id = ? AND executor = 'computer'
              AND status = 'running' AND source = 'producer' AND heartbeat_at < ?
            ORDER BY created_at, id`,
      args: [target.tenantId, target.pairingId, staleCutoff],
    }),
  );
  const reaped: string[] = [];
  for (const row of stale) {
    const id = s(row.id);
    const scope = { tenantId: target.tenantId, userId: s(row.user_id) };
    const partial = await partialText(db, scope, id);
    const rs = await exec(db, {
      sql: `UPDATE dept_chat_runs SET status = 'interrupted', error_code = 'interrupted', final_text = ?, finished_at = ?
            WHERE id = ? AND tenant_id = ? AND user_id = ? AND target_pairing_id = ?
              AND executor = 'computer' AND status = 'running' AND source = 'producer' AND heartbeat_at < ?`,
      args: [partial || null, iso(now), id, target.tenantId, scope.userId, target.pairingId, staleCutoff],
    });
    if (rs.rowsAffected === 0) continue;
    await closeRun(db, scope, id, "interrupted", { code: "interrupted", message: INTERRUPTED_MESSAGE }, now);
    reaped.push(id);
  }

  const queuedCutoff = iso(new Date(now.getTime() - COMPUTER_MAX_QUEUED_MS));
  const queued = rows(
    await exec(db, {
      sql: `SELECT id, user_id, runtime_fallback_policy FROM dept_chat_runs
            WHERE tenant_id = ? AND target_pairing_id = ? AND executor = 'computer'
              AND origin = 'chat' AND status = 'queued' AND created_at < ?
            ORDER BY created_at, id`,
      args: [target.tenantId, target.pairingId, queuedCutoff],
    }),
  );
  const timedOut: string[] = [];
  const fellBack: string[] = [];
  for (const row of queued) {
    const id = s(row.id);
    const scope = { tenantId: target.tenantId, userId: s(row.user_id) };
    if (row.runtime_fallback_policy === "workspace_api") {
      if (await fallbackQueuedComputerRun(db, scope, id, "computer_not_answering")) fellBack.push(id);
    } else if (await failQueuedComputerRun(db, scope, id, "computer_not_answering", now)) {
      timedOut.push(id);
    }
  }
  return { reaped, timedOut, fellBack };
}

/**
 * reapStale's per-run close loop, scoped to ONE PERSON across every
 * conversation they have (reapStale itself is per-conversation, which the
 * claim route does not know in advance -- a claim call is for a person, not
 * a chat). Only ever touches executor = 'computer' rows: a worker run going
 * stale is the chat driver's own reapStale, called from follow.ts as today.
 */
export async function reapStaleComputerRuns(db: Client, scope: RunScope, now: Date): Promise<string[]> {
  const cutoff = iso(new Date(now.getTime() - RUN_STALE_PRODUCER_MS));
  const stale = rows(
    await exec(db, {
      sql: `SELECT id FROM dept_chat_runs
            WHERE tenant_id = ? AND user_id = ? AND executor = 'computer' AND status = 'running' AND heartbeat_at < ?`,
      args: [scope.tenantId, scope.userId, cutoff],
    }),
  );
  const closed: string[] = [];
  for (const row of stale) {
    const id = s(row.id);
    const partial = await partialText(db, scope, id);
    const rs = await exec(db, {
      sql: `UPDATE dept_chat_runs SET status = 'interrupted', error_code = 'interrupted', final_text = ?, finished_at = ?
            WHERE id = ? AND tenant_id = ? AND user_id = ? AND executor = 'computer' AND status = 'running' AND heartbeat_at < ?`,
      args: [partial || null, iso(now), id, scope.tenantId, scope.userId, cutoff],
    });
    if (rs.rowsAffected === 0) continue;
    await closeRun(db, scope, id, "interrupted", { code: "interrupted", message: INTERRUPTED_MESSAGE }, now);
    closed.push(id);
  }
  return closed;
}

/**
 * The 10-minute absolute cap (O4 "OFFLINE AND HONEST"): a CHAT run that has
 * sat queued this long, whatever the computer last reported, fails
 * computer_not_answering so the page stops waiting. Scoped to this person,
 * across every conversation.
 */
export async function failLongQueuedComputerRuns(db: Client, scope: RunScope, now: Date): Promise<string[]> {
  const cutoff = iso(new Date(now.getTime() - COMPUTER_MAX_QUEUED_MS));
  const candidates = rows(
    await exec(db, {
      sql: `SELECT id FROM dept_chat_runs
            WHERE tenant_id = ? AND user_id = ? AND executor = 'computer' AND origin = 'chat' AND status = 'queued' AND created_at < ?`,
      args: [scope.tenantId, scope.userId, cutoff],
    }),
  );
  const failed: string[] = [];
  for (const row of candidates) {
    if (await failQueuedComputerRun(db, scope, s(row.id), "computer_not_answering", now)) failed.push(s(row.id));
  }
  return failed;
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
 * after RUN_STALE_PRODUCER_MS of silence. Never an automation's run: it runs in
 * the Worker only, and would lose its mark (source) if handed over.
 */
export async function attachProducer(db: Client, scope: RunScope, runId: string, leaseId: string, now: Date): Promise<boolean> {
  const rs = await exec(db, {
    sql: `UPDATE dept_chat_runs SET source = 'producer', heartbeat_at = ?
          WHERE id = ? AND tenant_id = ? AND user_id = ? AND lease_id = ? AND status = 'running' AND source <> 'automation'`,
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
  // Computer runs only (CodeRabbit, PR #589): on the push path the Worker's
  // meteredBridgeTurn already wrote this turn's usage row before
  // attachProducer handed the run over, so a second row would double-count
  // usage and the monthly run limit.
  if (run.executor === "computer") await recordProducerLedgerRow(db, run, f);
  return true;
}

/**
 * The usage-ledger row every producer run leaves, whatever its end -- the
 * same shape meteredBridgeTurn writes (lib/os/department-agent.ts) for a
 * department turn on the paired computer: provider 'bridge', the snapshotted
 * v2 runtime name (or legacy 'claude'), subscription/local billing, a known
 * cost of 0, real token counts. Before
 * this, finishProducerRun wrote NO row at all, so a department's 600-run
 * monthly cap never counted a computer-dispatched reply, and its usage
 * dashboard undercounted every workspace that answers on a paired computer.
 * Never throws: recordModelCall logs and swallows its own failure, so a
 * ledger-write fault can never stop the run's own terminal state from
 * landing (that UPDATE already committed, above).
 */
async function recordProducerLedgerRow(
  db: Client,
  run: Run,
  f: { status: "done" | "failed" | "cancelled"; errorCode: string | null; inputTokens: number | null; outputTokens: number | null; now: Date },
): Promise<void> {
  const billing = billingForBridge({ kind: run.runtimeEngineKind === "local" ? "local" : "cli" });
  const outcome = f.status === "done" ? "ok" : f.status === "cancelled" ? "cancelled" : "error";
  const usage: ModelUsage | null =
    f.inputTokens !== null || f.outputTokens !== null
      ? { inputTokens: f.inputTokens, outputTokens: f.outputTokens, cacheReadTokens: null, cacheWriteTokens: null }
      : null;
  const startedMs = run.startedAt ? Date.parse(run.startedAt) : NaN;
  await recordModelCall(
    {
      tenantId: run.tenantId,
      surface: "agents.chat",
      ...billing,
      departmentKey: run.department || null,
      teammateId: run.agentSlug || null,
      userId: run.userId,
      occurredAt: f.now,
      provider: "bridge",
      model: run.runtimeEngineName ?? "claude",
      usage,
      costMicroUsd: 0,
      costSource: "none",
      latencyMs: Number.isFinite(startedMs) ? Math.max(0, f.now.getTime() - startedMs) : null,
      outcome,
      errorCode: f.errorCode,
    },
    db,
  );
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

/**
 * Saved trail events (everything but reply text) of a conversation's FINISHED
 * runs, by run id. `fromSeq` limits it to the runs a transcript shows (the
 * newest ones, listRuns), so a long conversation does not read every trail it
 * ever had.
 */
export async function readTrails(db: Client, scope: RunScope, conversationId: string, opts: { fromSeq?: number } = {}): Promise<Map<string, RunEvent[]>> {
  const fromSeq = Number.isInteger(opts.fromSeq) ? Number(opts.fromSeq) : 0;
  const rs = await exec(db, {
    sql: `SELECT e.run_id, e.seq, e.kind, e.data_json
          FROM dept_chat_run_events e JOIN dept_chat_runs r ON r.id = e.run_id
          WHERE r.conversation_id = ? AND r.tenant_id = ? AND r.user_id = ? AND e.tenant_id = ? AND r.seq >= ?
            AND r.status NOT IN ('queued','running') AND e.kind NOT IN ${TRANSIENT_KINDS}
          ORDER BY r.seq ASC, e.seq ASC`,
    args: [conversationId, scope.tenantId, scope.userId, scope.tenantId, fromSeq],
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
