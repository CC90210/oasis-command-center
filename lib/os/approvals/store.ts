/**
 * lib/os/approvals/store.ts — every read and write for approvals and their
 * audit log.
 *
 * Raw SQL on the libSQL client, like lib/delivery/store.ts: these tables exist
 * only in Turso, and the statements that matter here are compare-and-swaps,
 * which are clearer (and provably atomic) as plain SQL.
 *
 * THREE RULES EVERY FUNCTION FOLLOWS
 *   1. Every statement is pinned to ONE tenant, and that tenant comes from the
 *      caller's resolved session (ApprovalScope, built in scope.ts) or, for the
 *      agent tool and the executor, from a server-side context that itself
 *      came from the session. No function takes a tenant from a request body.
 *      Reads a viewer makes also carry the viewer's department scope; comments
 *      are read THROUGH a join to their scoped parent approval.
 *   2. Every state change is a compare-and-swap on the current status, written
 *      in ONE batch with the approval_events row that records it. The event
 *      insert is conditioned on `changes() = 1`, so a CAS that lost a race
 *      writes no event and a retried call never logs twice. approval_events is
 *      append-only: nothing here UPDATEs or DELETEs it. Each lifecycle event
 *      is mirrored into the Business Ledger (outcome_events) in the same
 *      batch, guarded the same way (eventWithLedger below).
 *   3. Nothing is swallowed. A failed statement throws; the route turns it into
 *      a loud 500. An empty list means the query ran and matched nothing.
 *
 * Writes take a clock (`now`), so tests drive them against a local libSQL file.
 */
import { createHash, randomUUID } from "node:crypto";
import type { Client, InStatement, InValue, ResultSet } from "@libsql/client";
import type { DepartmentKey } from "@/lib/os/types";
import { emitIfChanged, type LedgerStatement } from "@/lib/ledger/emit";
import { isLedgerCode, isLedgerId, type LedgerActorType } from "@/lib/ledger/catalog";
import {
  APPROVAL_ACTION_KINDS,
  APPROVAL_STATUSES,
  DEPARTMENT_KEYS,
  RECENT_DECISIONS_DAYS,
  REQUESTER_TYPES,
  DEFAULT_APPROVAL_TTL_DAYS,
  canonicalJson,
  isExpired,
  isOneOf,
  isPayloadHash,
  mayDecideApproval,
  previewFor,
  scopeSeesNothing,
  validateComment,
  validateNewApproval,
  validateSendBackNote,
  type ActorType,
  type ApprovalActionKind,
  type ApprovalComment,
  type ApprovalEvent,
  type ApprovalScope,
  type ApprovalStatus,
  type DecidedVia,
  type ExecutionResult,
  type RequesterType,
  type RiskLevel,
} from "@/lib/os/approvals/rules";

/** A page never exceeds this; one more row is read to detect truncation. */
export const APPROVAL_LIST_LIMIT = 200;

type Row = Record<string, unknown>;

function rows(rs: ResultSet): Row[] {
  return rs.rows.map((r) => {
    const o: Row = {};
    rs.columns.forEach((c, i) => {
      const v = (r as unknown as unknown[])[i];
      o[c] = typeof v === "bigint" ? Number(v) : v;
    });
    return o;
  });
}

const s = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

/** sha256 of the canonical payload JSON, lowercase hex. */
export function payloadHashOf(payloadJson: string): string {
  return createHash("sha256").update(payloadJson, "utf8").digest("hex");
}

/** 32 lowercase hex characters, the shape doc 02 §3.1 gives every id. */
export function newApprovalId(): string {
  return randomUUID().replace(/-/g, "");
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export type ApprovalRow = {
  id: string;
  tenant_id: string;
  department_key: DepartmentKey | null;
  requested_by_type: RequesterType;
  requested_by_id: string | null;
  routine_run_id: string | null;
  action_kind: ApprovalActionKind;
  title: string;
  target_ref: string | null;
  payload_json: string;
  payload_hash: string;
  preview_text: string | null;
  revision: number;
  supersedes_id: string | null;
  risk_level: RiskLevel;
  status: ApprovalStatus;
  decided_by: string | null;
  decided_by_name: string | null;
  decided_at: string | null;
  decided_via: DecidedVia | null;
  decision_note: string | null;
  execute_after: string | null;
  executing_at: string | null;
  executed_at: string | null;
  execution_result: ExecutionResult | null;
  idempotency_key: string;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
};

function parseResult(v: unknown): ExecutionResult | null {
  if (typeof v !== "string" || !v.trim()) return null;
  try {
    const parsed = JSON.parse(v);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as ExecutionResult) : null;
  } catch {
    // Never silently: a result we cannot read is shown as a failure to read it,
    // not as "no result". The card says the outcome is unknown.
    console.error("[approvals.store] unparseable execution_result");
    return { outcome: "failed", reason: "result_unreadable", message: "The recorded outcome could not be read." };
  }
}

function mapApproval(r: Row): ApprovalRow {
  // The vocabularies below are enforced on write; an unknown value on read is
  // a row someone wrote around the store. It is surfaced as-is in the logs and
  // mapped to the most conservative value, never to "executed".
  const status = isOneOf(APPROVAL_STATUSES, r.status) ? r.status : "failed";
  if (status !== r.status) console.error("[approvals.store] unknown status on row", { id: r.id, status: r.status });
  return {
    id: String(r.id),
    tenant_id: String(r.tenant_id),
    department_key: isOneOf(DEPARTMENT_KEYS, r.department_key) ? r.department_key : null,
    requested_by_type: isOneOf(REQUESTER_TYPES, r.requested_by_type) ? r.requested_by_type : "human",
    requested_by_id: s(r.requested_by_id),
    routine_run_id: s(r.routine_run_id),
    action_kind: (isOneOf(APPROVAL_ACTION_KINDS, r.action_kind) ? r.action_kind : String(r.action_kind)) as ApprovalActionKind,
    title: String(r.title ?? ""),
    target_ref: s(r.target_ref),
    payload_json: String(r.payload_json ?? "{}"),
    payload_hash: String(r.payload_hash ?? ""),
    preview_text: s(r.preview_text),
    revision: Number(r.revision ?? 1) || 1,
    supersedes_id: s(r.supersedes_id),
    risk_level: (s(r.risk_level) ?? "normal") as RiskLevel,
    status,
    decided_by: s(r.decided_by),
    decided_by_name: s(r.decided_by_name),
    decided_at: s(r.decided_at),
    decided_via: s(r.decided_via) as DecidedVia | null,
    decision_note: s(r.decision_note),
    execute_after: s(r.execute_after),
    executing_at: s(r.executing_at),
    executed_at: s(r.executed_at),
    execution_result: parseResult(r.execution_result),
    idempotency_key: String(r.idempotency_key ?? ""),
    expires_at: s(r.expires_at),
    created_at: String(r.created_at ?? ""),
    updated_at: String(r.updated_at ?? ""),
  };
}

/** The payload as the executor and the card read it. Stored canonical, so this cannot fail on a row the store wrote. */
export function parsePayload(row: Pick<ApprovalRow, "payload_json">): Record<string, unknown> {
  const parsed = JSON.parse(row.payload_json);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("approval payload is not an object");
  return parsed as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

/** The display name of an auth user inside the row's own tenant. */
const nameOf = (col: string, tenantCol: string) =>
  `(SELECT COALESCE(NULLIF(up.display_name, ''), NULLIF(up.full_name, ''), up.email) FROM user_profiles up
     WHERE up.auth_user_id = ${col} AND up.tenant_id = ${tenantCol} LIMIT 1)`;

const SELECT_APPROVAL = `SELECT a.*, ${nameOf("a.decided_by", "a.tenant_id")} AS decided_by_name FROM approvals a`;

/**
 * The viewer's department cut as SQL. Owners see every row including
 * unattributed ones; anyone else sees only their departments' rows, and a
 * viewer with none matches nothing (`AND 0`), never "no filter".
 */
function deptScope(scope: ApprovalScope, alias = "a"): { sql: string; args: InValue[] } {
  if (scope.allDepartments) return { sql: "", args: [] };
  if (scope.departments.length === 0) return { sql: " AND 0", args: [] };
  return {
    sql: ` AND ${alias}.department_key IN (${scope.departments.map(() => "?").join(", ")})`,
    args: [...scope.departments],
  };
}

function requireTenant(tenantId: string): string {
  const t = (tenantId || "").trim();
  // An empty tenant must never reach a WHERE clause as "every tenant".
  if (!t) throw new Error("approvals: tenant id is required");
  return t;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export type ApprovalListView = "pending" | "decided" | "all";

export type ApprovalListFilter = {
  view: ApprovalListView;
  department?: DepartmentKey | null;
  /** Only rows this requester created (list_proposals). */
  requestedBy?: { type: RequesterType; id: string } | null;
  limit?: number;
};

export type Listed<T> = { rows: T[]; truncated: boolean };

/**
 * A page size as SQL LIMIT needs it: a whole number from 1 to
 * APPROVAL_LIST_LIMIT. A query string or a model hands over "2.7", "-5" or
 * "abc"; a fraction reaching LIMIT is a datatype-mismatch 500 and NaN is a
 * driver error, so every caller's number passes through here.
 */
export function listLimit(raw: unknown, fallback = 50): number {
  const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(Math.trunc(n), APPROVAL_LIST_LIMIT));
}

/**
 * A viewer's approvals. `pending` is the Needs-you queue (not expired);
 * `decided` is the last RECENT_DECISIONS_DAYS of decisions and outcomes,
 * including pending rows that expired in that window.
 */
export async function listApprovals(
  db: Client,
  scope: ApprovalScope,
  filter: ApprovalListFilter,
  now: Date,
): Promise<Listed<ApprovalRow>> {
  const tenantId = requireTenant(scope.tenantId);
  if (scopeSeesNothing(scope)) return { rows: [], truncated: false };
  const limit = listLimit(filter.limit);
  const nowIso = now.toISOString();
  const where: string[] = ["a.tenant_id = ?"];
  const args: InValue[] = [tenantId];
  let order = "a.created_at DESC";
  if (filter.view === "pending") {
    where.push("a.status = 'pending'", "(a.expires_at IS NULL OR a.expires_at > ?)");
    args.push(nowIso);
    // A queue: the one that has waited longest (and expires first) is on top.
    order = "a.created_at ASC";
  } else if (filter.view === "decided") {
    const since = new Date(now.getTime() - RECENT_DECISIONS_DAYS * 86_400_000).toISOString();
    where.push(
      "((a.status <> 'pending' AND a.updated_at >= ?) OR (a.status = 'pending' AND a.expires_at IS NOT NULL AND a.expires_at <= ? AND a.expires_at >= ?))",
    );
    args.push(since, nowIso, since);
    order = "COALESCE(a.executed_at, a.decided_at, a.updated_at) DESC";
  }
  if (filter.department) {
    where.push("a.department_key = ?");
    args.push(filter.department);
  }
  if (filter.requestedBy) {
    where.push("a.requested_by_type = ?", "a.requested_by_id = ?");
    args.push(filter.requestedBy.type, filter.requestedBy.id);
  }
  const d = deptScope(scope);
  const rs = await db.execute({
    sql: `${SELECT_APPROVAL} WHERE ${where.join(" AND ")}${d.sql} ORDER BY ${order}, a.id LIMIT ?`,
    args: [...args, ...d.args, limit + 1],
  });
  const all = rows(rs).map(mapApproval);
  return { rows: all.slice(0, limit), truncated: all.length > limit };
}

export type PendingCounts = { total: number; byDepartment: Partial<Record<DepartmentKey, number>>; unattributed: number };

/** How many approvals are waiting on this viewer, overall and per department. */
export async function countPendingApprovals(db: Client, scope: ApprovalScope, now: Date): Promise<PendingCounts> {
  const tenantId = requireTenant(scope.tenantId);
  const out: PendingCounts = { total: 0, byDepartment: {}, unattributed: 0 };
  if (scopeSeesNothing(scope)) return out;
  const d = deptScope(scope);
  const rs = await db.execute({
    sql: `SELECT a.department_key AS department_key, COUNT(*) AS n FROM approvals a
          WHERE a.tenant_id = ? AND a.status = 'pending' AND (a.expires_at IS NULL OR a.expires_at > ?)${d.sql}
          GROUP BY a.department_key`,
    args: [tenantId, now.toISOString(), ...d.args],
  });
  for (const r of rows(rs)) {
    const n = Number(r.n ?? 0);
    out.total += n;
    if (isOneOf(DEPARTMENT_KEYS, r.department_key)) out.byDepartment[r.department_key] = n;
    else out.unattributed += n;
  }
  return out;
}

/** One approval, if this viewer may see it. Null for another tenant's row and for a department outside the scope alike. */
export async function getApproval(db: Client, scope: ApprovalScope, id: string): Promise<ApprovalRow | null> {
  const tenantId = requireTenant(scope.tenantId);
  if (scopeSeesNothing(scope) || !id) return null;
  const d = deptScope(scope);
  const rs = await db.execute({
    sql: `${SELECT_APPROVAL} WHERE a.tenant_id = ? AND a.id = ?${d.sql} LIMIT 1`,
    args: [tenantId, id, ...d.args],
  });
  const r = rows(rs)[0];
  return r ? mapApproval(r) : null;
}

/**
 * One approval for a SERVER-SIDE caller acting inside a tenant it already
 * resolved (the executor, the agent tool). Still tenant-pinned; no department
 * cut, because the caller is not a viewer.
 */
export async function getApprovalInTenant(db: Client, tenantId: string, id: string): Promise<ApprovalRow | null> {
  const t = requireTenant(tenantId);
  if (!id) return null;
  const rs = await db.execute({ sql: `${SELECT_APPROVAL} WHERE a.tenant_id = ? AND a.id = ? LIMIT 1`, args: [t, id] });
  const r = rows(rs)[0];
  return r ? mapApproval(r) : null;
}

/** Comments on the given approvals, oldest first, read through the scoped parent. */
export async function listApprovalComments(
  db: Client,
  scope: ApprovalScope,
  approvalIds: readonly string[],
): Promise<Map<string, ApprovalComment[]>> {
  const tenantId = requireTenant(scope.tenantId);
  const out = new Map<string, ApprovalComment[]>();
  if (approvalIds.length === 0 || scopeSeesNothing(scope)) return out;
  const d = deptScope(scope);
  const rs = await db.execute({
    sql: `SELECT e.id, e.approval_id, e.actor_id, e.meta, e.created_at, ${nameOf("e.actor_id", "e.tenant_id")} AS author_name
          FROM approval_events e
          JOIN approvals a ON a.id = e.approval_id AND a.tenant_id = e.tenant_id
          WHERE e.tenant_id = ? AND e.event = 'commented'
            AND e.approval_id IN (${approvalIds.map(() => "?").join(", ")})${d.sql}
          ORDER BY e.created_at ASC, e.id ASC`,
    args: [tenantId, ...approvalIds, ...d.args],
  });
  for (const r of rows(rs)) {
    let body = "";
    try {
      const meta = JSON.parse(String(r.meta ?? "{}")) as { body?: unknown };
      body = typeof meta.body === "string" ? meta.body : "";
    } catch {
      console.error("[approvals.store] unparseable comment meta", { id: r.id });
    }
    const list = out.get(String(r.approval_id)) ?? [];
    list.push({
      id: String(r.id),
      body,
      author_id: s(r.actor_id),
      author_name: s(r.author_name),
      created_at: String(r.created_at ?? ""),
    });
    out.set(String(r.approval_id), list);
  }
  return out;
}

export type ApprovalEventRow = {
  id: string;
  approval_id: string;
  event: ApprovalEvent;
  actor_type: ActorType | null;
  actor_id: string | null;
  meta: Record<string, unknown> | null;
  created_at: string;
};

/** The whole audit trail of one approval, oldest first, through the scoped parent. */
export async function listApprovalEvents(db: Client, scope: ApprovalScope, approvalId: string): Promise<ApprovalEventRow[]> {
  const tenantId = requireTenant(scope.tenantId);
  if (scopeSeesNothing(scope)) return [];
  const d = deptScope(scope);
  const rs = await db.execute({
    sql: `SELECT e.* FROM approval_events e
          JOIN approvals a ON a.id = e.approval_id AND a.tenant_id = e.tenant_id
          WHERE e.tenant_id = ? AND e.approval_id = ?${d.sql}
          ORDER BY e.created_at ASC, e.rowid ASC`,
    args: [tenantId, approvalId, ...d.args],
  });
  return rows(rs).map((r) => {
    let meta: Record<string, unknown> | null = null;
    if (typeof r.meta === "string" && r.meta) {
      try {
        meta = JSON.parse(r.meta) as Record<string, unknown>;
      } catch {
        console.error("[approvals.store] unparseable event meta", { id: r.id });
      }
    }
    return {
      id: String(r.id),
      approval_id: String(r.approval_id),
      event: String(r.event) as ApprovalEvent,
      actor_type: s(r.actor_type) as ActorType | null,
      actor_id: s(r.actor_id),
      meta,
      created_at: String(r.created_at ?? ""),
    };
  });
}

// ---------------------------------------------------------------------------
// Event helper
// ---------------------------------------------------------------------------

type Actor = { type: ActorType; id: string | null };

/**
 * An approval_events INSERT that runs only if the statement immediately before
 * it in the same batch changed exactly one row. That is how a lost
 * compare-and-swap writes no event.
 */
function eventIfChanged(
  tenantId: string,
  approvalId: string,
  event: ApprovalEvent,
  actor: Actor,
  meta: Record<string, unknown> | null,
  nowIso: string,
  eventId: string = newApprovalId(),
): InStatement {
  return {
    sql: `INSERT INTO approval_events (id, tenant_id, approval_id, event, actor_type, actor_id, meta, created_at)
          SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE changes() = 1`,
    args: [eventId, tenantId, approvalId, event, actor.type, actor.id, meta ? JSON.stringify(meta) : null, nowIso],
  };
}

// ---------------------------------------------------------------------------
// Business Ledger mirror (lib/ledger, plan §F2)
// ---------------------------------------------------------------------------

const LEDGER_PRODUCER = "lib/os/approvals/store.ts";

type ApprovalLedgerKey =
  | "approval.requested"
  | "approval.edited"
  | "approval.approved"
  | "approval.sent_back"
  | "approval.executed"
  | "approval.failed"
  | "approval.expired";

/** A routine is the business's own automation, so the ledger calls it system. */
const LEDGER_ACTOR: Readonly<Record<ActorType, LedgerActorType>> = {
  user: "human",
  agent: "agent",
  routine: "system",
  system: "system",
};

/**
 * The approval_events row AND its ledger mirror, for the same batch, in that
 * order. The ledger INSERT is guarded by changes() = 1 on the event insert,
 * which is itself guarded by the compare-and-swap before it: a CAS that lost
 * writes neither row, and a ledger insert that fails rolls the decision back.
 *
 * Keyed appr:{approval_event_id}, so a later backfill from approval_events
 * lands on the same keys. That id is minted here for each event, so a key can
 * never be reused for other content, and these batches skip
 * assertNoPayloadConflicts; a chokepoint whose key comes from a provider id
 * must call it.
 *
 * The ledger holds ids and codes only: the send-back note, the comment and the
 * draft itself stay in approvals / approval_events. A requester id that is not
 * id-shaped (the requester is free text up to 200 characters) is recorded as a
 * NULL actor_id here and stays whole in approvals.requested_by_id.
 */
function eventWithLedger(
  tenantId: string,
  approvalId: string,
  event: ApprovalEvent,
  actor: Actor,
  meta: Record<string, unknown> | null,
  nowIso: string,
  ledger: { key: ApprovalLedgerKey; department: DepartmentKey | null; payload: Record<string, unknown> },
): [InStatement, LedgerStatement] {
  const eventId = newApprovalId();
  return [
    eventIfChanged(tenantId, approvalId, event, actor, meta, nowIso, eventId),
    emitIfChanged(
      {
        tenantId,
        eventKey: ledger.key,
        eventVersion: 1,
        occurredAt: nowIso,
        subject: { type: "approval", id: approvalId },
        department: ledger.department,
        actor: { type: LEDGER_ACTOR[actor.type], id: isLedgerId(actor.id) ? actor.id : null },
        source: "native",
        idempotencyKey: `appr:${eventId}`,
        causationId: eventId,
        approvalId,
        confidence: "verified",
        payload: ledger.payload,
        producer: LEDGER_PRODUCER,
      },
      new Date(nowIso),
    ),
  ];
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export type CreateApprovalResult =
  | { ok: true; created: boolean; approval: ApprovalRow }
  | { ok: false; error: string; field?: string; status?: ApprovalStatus; successorId?: string };

/**
 * Create an approval (an agent's proposal, a routine's output, a person's
 * request). Idempotent on (tenant, idempotency_key): a retry with the same key
 * and the same payload returns the first row (`created: false`); the same key
 * with a DIFFERENT payload is refused loudly, because that is a caller reusing
 * a key, and silently returning the old row would let a "yes" land on words
 * nobody proposed.
 *
 * `supersedesId` makes this a revision: the old row must be in the same
 * tenant, the same kind, still pending or sent back (or already cancelled with
 * no successor), and not already revised. A pending old row is cancelled in the
 * same batch, so two live revisions of one draft cannot exist.
 */
export async function createApproval(db: Client, input: unknown, now: Date): Promise<CreateApprovalResult> {
  const v = validateNewApproval(input);
  if (!v.ok) return v;
  const a = v.value;
  const nowIso = now.toISOString();
  const payloadJson = canonicalJson(a.payload);
  const hash = payloadHashOf(payloadJson);
  const id = newApprovalId();
  const idem = a.idempotencyKey ?? `auto:${id}`;
  const expiresAt = a.expiresAt
    ? new Date(a.expiresAt).toISOString()
    : new Date(now.getTime() + DEFAULT_APPROVAL_TTL_DAYS * 86_400_000).toISOString();
  const actor: Actor = {
    type: a.requestedBy.type === "human" ? "user" : a.requestedBy.type,
    id: a.requestedBy.id,
  };

  let revision = 1;
  const stmts: InStatement[] = [];
  let insertGuard = "1";
  const insertGuardArgs: InValue[] = [];

  if (a.supersedesId) {
    const old = await getApprovalInTenant(db, a.tenantId, a.supersedesId);
    if (!old) return { ok: false, error: "supersedes_not_found", field: "supersedes_id" };
    if (old.action_kind !== a.actionKind) return { ok: false, error: "supersedes_kind_mismatch", field: "supersedes_id" };
    if (!["pending", "sent_back", "cancelled"].includes(old.status)) {
      return { ok: false, error: "supersedes_not_revisable", status: old.status };
    }
    const successor = rows(
      await db.execute({
        sql: `${SELECT_APPROVAL} WHERE a.tenant_id = ? AND a.supersedes_id = ? LIMIT 1`,
        args: [a.tenantId, old.id],
      }),
    )[0];
    if (successor) {
      const prior = mapApproval(successor);
      // A retry of THIS revision (the caller's own key) gets the row it
      // already made, exactly as a retried create does; the same key with
      // other words is a reused key. Anyone else's revision is already_revised.
      if (a.idempotencyKey && prior.idempotency_key === idem) {
        if (prior.payload_hash !== hash || prior.action_kind !== a.actionKind) {
          console.error("[approvals.store] idempotency key reused with a different payload", { tenant: a.tenantId, key: idem });
          return { ok: false, error: "idempotency_key_reused" };
        }
        return { ok: true, created: false, approval: prior };
      }
      return { ok: false, error: "already_revised", successorId: prior.id };
    }
    revision = old.revision + 1;
    // 1. A pending old row is withdrawn — unless this key is already taken, in
    //    which case nothing in this batch may change anything.
    stmts.push({
      sql: `UPDATE approvals SET status = 'cancelled', updated_at = ?
            WHERE tenant_id = ? AND id = ? AND status = 'pending'
              AND NOT EXISTS (SELECT 1 FROM approvals WHERE tenant_id = ? AND idempotency_key = ?)`,
      args: [nowIso, a.tenantId, old.id, a.tenantId, idem],
    });
    stmts.push(eventIfChanged(a.tenantId, old.id, "superseded", actor, { successor_id: id }, nowIso));
    // 2. The new row goes in only while the old one is revisable and has no successor.
    insertGuard = `EXISTS (SELECT 1 FROM approvals WHERE tenant_id = ? AND id = ? AND status IN ('cancelled', 'sent_back'))
                   AND NOT EXISTS (SELECT 1 FROM approvals WHERE tenant_id = ? AND supersedes_id = ?)`;
    insertGuardArgs.push(a.tenantId, old.id, a.tenantId, old.id);
  }

  stmts.push({
    sql: `INSERT INTO approvals (id, tenant_id, department_key, requested_by_type, requested_by_id, routine_run_id,
            action_kind, title, target_ref, payload_json, payload_hash, preview_text, revision, supersedes_id,
            risk_level, status, idempotency_key, expires_at, created_at, updated_at)
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ? WHERE ${insertGuard}
          ON CONFLICT (tenant_id, idempotency_key) DO NOTHING`,
    args: [
      id,
      a.tenantId,
      a.departmentKey,
      a.requestedBy.type,
      a.requestedBy.id,
      a.routineRunId ?? null,
      a.actionKind,
      a.title,
      a.targetRef ?? null,
      payloadJson,
      hash,
      previewFor(a.actionKind, a.payload) || null,
      revision,
      a.supersedesId ?? null,
      a.riskLevel,
      idem,
      expiresAt,
      nowIso,
      nowIso,
      ...insertGuardArgs,
    ],
  });
  stmts.push(
    ...eventWithLedger(
      a.tenantId,
      id,
      "created",
      actor,
      { revision, ...(a.supersedesId ? { supersedes_id: a.supersedesId } : {}), payload_hash: hash },
      nowIso,
      a.supersedesId
        ? {
            key: "approval.edited",
            department: a.departmentKey,
            payload: { action_kind: a.actionKind, revision, supersedes_id: a.supersedesId, risk_level: a.riskLevel },
          }
        : {
            key: "approval.requested",
            department: a.departmentKey,
            payload: { action_kind: a.actionKind, revision, risk_level: a.riskLevel, requested_by_type: a.requestedBy.type },
          },
    ),
  );
  await db.batch(stmts, "write");

  const rs = await db.execute({
    sql: `${SELECT_APPROVAL} WHERE a.tenant_id = ? AND a.idempotency_key = ? LIMIT 1`,
    args: [a.tenantId, idem],
  });
  const existing = rows(rs)[0];
  if (!existing) {
    // Only a revision can insert nothing without a key conflict: the old row
    // moved on (approved, executing, or revised by a concurrent caller)
    // between the read and the batch.
    if (a.supersedesId) {
      const successor = await db.execute({
        sql: "SELECT id FROM approvals WHERE tenant_id = ? AND supersedes_id = ? LIMIT 1",
        args: [a.tenantId, a.supersedesId],
      });
      if (successor.rows.length) return { ok: false, error: "already_revised", successorId: String(successor.rows[0].id) };
    }
    const old = a.supersedesId ? await getApprovalInTenant(db, a.tenantId, a.supersedesId) : null;
    return { ok: false, error: "supersedes_not_revisable", ...(old ? { status: old.status } : {}) };
  }
  const row = mapApproval(existing);
  if (row.payload_hash !== hash || row.action_kind !== a.actionKind) {
    console.error("[approvals.store] idempotency key reused with a different payload", { tenant: a.tenantId, key: idem });
    return { ok: false, error: "idempotency_key_reused" };
  }
  return { ok: true, created: row.id === id, approval: row };
}

// ---------------------------------------------------------------------------
// Decide
// ---------------------------------------------------------------------------

export type Decision =
  | { kind: "approve"; payloadHash: string }
  | { kind: "send_back"; note: unknown };

export type DecideResult =
  | { ok: true; approval: ApprovalRow }
  | {
      ok: false;
      error: "not_found" | "forbidden" | "not_pending" | "expired" | "payload_mismatch" | "payload_hash_required" | string;
      field?: string;
      status?: ApprovalStatus;
    };

/**
 * Approve or send back. The decider is the SESSION user (scope.userId).
 *
 *   not_found         not this tenant's row, or outside the viewer's departments
 *                     (the same answer for both, so the response confirms nothing)
 *   forbidden         visible, but this viewer may not decide (read-only)
 *   expired           nobody decided in time; the row is marked expired now
 *   not_pending       someone already decided it (status says what happened)
 *   payload_mismatch  the hash presented is not this row's payload: the viewer
 *                     approved words they were not shown (a stale card)
 */
export async function decideApproval(
  db: Client,
  scope: ApprovalScope,
  id: string,
  decision: Decision,
  now: Date,
  via: DecidedVia = "app",
): Promise<DecideResult> {
  const tenantId = requireTenant(scope.tenantId);
  const row = await getApproval(db, scope, id);
  if (!row) return { ok: false, error: "not_found" };
  if (!mayDecideApproval(scope, row.department_key)) return { ok: false, error: "forbidden" };

  let note: string | null = null;
  if (decision.kind === "send_back") {
    const v = validateSendBackNote(decision.note);
    if (!v.ok) return v;
    note = v.value;
  } else if (!isPayloadHash(decision.payloadHash)) {
    return { ok: false, error: "payload_hash_required", field: "payload_hash" };
  }

  if (row.status !== "pending") return { ok: false, error: "not_pending", status: row.status };
  const nowIso = now.toISOString();
  if (isExpired(row.expires_at, nowIso)) {
    await expireApproval(db, tenantId, id, now);
    return { ok: false, error: "expired", status: "expired" };
  }

  const user: Actor = { type: "user", id: scope.userId };
  let batch: InStatement[];
  if (decision.kind === "approve") {
    batch = [
      {
        sql: `UPDATE approvals SET status = 'approved', decided_by = ?, decided_at = ?, decided_via = ?, updated_at = ?
              WHERE tenant_id = ? AND id = ? AND status = 'pending' AND payload_hash = ?
                AND (expires_at IS NULL OR expires_at > ?)`,
        args: [scope.userId, nowIso, via, nowIso, tenantId, id, decision.payloadHash, nowIso],
      },
      ...eventWithLedger(tenantId, id, "approved", user, { payload_hash: decision.payloadHash, via }, nowIso, {
        key: "approval.approved",
        department: row.department_key,
        payload: { action_kind: row.action_kind, decided_via: via },
      }),
    ];
  } else {
    batch = [
      {
        sql: `UPDATE approvals SET status = 'sent_back', decided_by = ?, decided_at = ?, decided_via = ?, decision_note = ?, updated_at = ?
              WHERE tenant_id = ? AND id = ? AND status = 'pending' AND (expires_at IS NULL OR expires_at > ?)`,
        args: [scope.userId, nowIso, via, note, nowIso, tenantId, id, nowIso],
      },
      ...eventWithLedger(tenantId, id, "sent_back", user, { note, via }, nowIso, {
        key: "approval.sent_back",
        department: row.department_key,
        payload: { action_kind: row.action_kind, decided_via: via },
      }),
    ];
  }
  const results = await db.batch(batch, "write");
  if (results[0].rowsAffected !== 1) {
    // The compare-and-swap lost. Say which of its conditions failed.
    const after = await getApproval(db, scope, id);
    if (!after) return { ok: false, error: "not_found" };
    if (after.status === "pending") {
      if (isExpired(after.expires_at, nowIso)) {
        await expireApproval(db, tenantId, id, now);
        return { ok: false, error: "expired", status: "expired" };
      }
      if (decision.kind === "approve" && after.payload_hash !== decision.payloadHash) {
        return { ok: false, error: "payload_mismatch", field: "payload_hash" };
      }
    }
    return { ok: false, error: "not_pending", status: after.status };
  }
  const updated = await getApproval(db, scope, id);
  if (!updated) throw new Error("approvals: decided row vanished");
  return { ok: true, approval: updated };
}

/** Mark a pending row whose expiry has passed. A no-op for any other row. */
export async function expireApproval(db: Client, tenantId: string, id: string, now: Date): Promise<boolean> {
  const t = requireTenant(tenantId);
  const nowIso = now.toISOString();
  // The mirror needs the kind and department; neither ever changes after create.
  const row = await getApprovalInTenant(db, t, id);
  if (!row) return false;
  const results = await db.batch(
    [
      {
        sql: `UPDATE approvals SET status = 'expired', updated_at = ?
              WHERE tenant_id = ? AND id = ? AND status = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?`,
        args: [nowIso, t, id, nowIso],
      },
      ...eventWithLedger(t, id, "expired", { type: "system", id: null }, null, nowIso, {
        key: "approval.expired",
        department: row.department_key,
        payload: { action_kind: row.action_kind },
      }),
    ],
    "write",
  );
  return results[0].rowsAffected === 1;
}

// ---------------------------------------------------------------------------
// Comment
// ---------------------------------------------------------------------------

export type CommentResult =
  | { ok: true; comment: ApprovalComment }
  | { ok: false; error: "not_found" | "forbidden" | string; field?: string };

/** A comment on any approval the viewer may decide, in any status. Status is not changed. */
export async function commentOnApproval(
  db: Client,
  scope: ApprovalScope,
  id: string,
  rawBody: unknown,
  now: Date,
): Promise<CommentResult> {
  const tenantId = requireTenant(scope.tenantId);
  const v = validateComment(rawBody);
  if (!v.ok) return v;
  const row = await getApproval(db, scope, id);
  if (!row) return { ok: false, error: "not_found" };
  if (!mayDecideApproval(scope, row.department_key)) return { ok: false, error: "forbidden" };
  const eventId = newApprovalId();
  const nowIso = now.toISOString();
  // Inserted THROUGH the tenant-pinned parent: no parent in this tenant, no row.
  const rs = await db.execute({
    sql: `INSERT INTO approval_events (id, tenant_id, approval_id, event, actor_type, actor_id, meta, created_at)
          SELECT ?, a.tenant_id, a.id, 'commented', 'user', ?, ?, ? FROM approvals a WHERE a.tenant_id = ? AND a.id = ?`,
    args: [eventId, scope.userId, JSON.stringify({ body: v.value }), nowIso, tenantId, id],
  });
  if (rs.rowsAffected !== 1) return { ok: false, error: "not_found" };
  const comments = await listApprovalComments(db, scope, [id]);
  const comment = comments.get(id)?.find((c) => c.id === eventId);
  if (!comment) throw new Error("approvals: comment not readable after insert");
  return { ok: true, comment };
}

// ---------------------------------------------------------------------------
// Execution state (used only by lib/os/approvals/execute.ts)
// ---------------------------------------------------------------------------

/**
 * approved → executing. True only for the ONE caller whose UPDATE changed the
 * row; every concurrent or later caller gets false and must not act.
 */
export async function claimForExecution(db: Client, tenantId: string, id: string, now: Date): Promise<boolean> {
  const t = requireTenant(tenantId);
  const nowIso = now.toISOString();
  const results = await db.batch(
    [
      {
        sql: `UPDATE approvals SET status = 'executing', executing_at = ?, updated_at = ?
              WHERE tenant_id = ? AND id = ? AND status = 'approved'`,
        args: [nowIso, nowIso, t, id],
      },
      eventIfChanged(t, id, "execution_started", { type: "system", id: null }, null, nowIso),
    ],
    "write",
  );
  return results[0].rowsAffected === 1;
}

type ExecutionOutcome = { status: "executed" | "failed"; result: ExecutionResult };
/** What the finish's ledger row needs from the approval; neither changes after create. */
export type ExecutionLedgerFacts = Pick<ApprovalRow, "action_kind" | "department_key">;

/**
 * The ledger mirror of a finish. Codes only: the executor's full account
 * (message, from, would_send) stays in execution_result and the
 * approval_events meta.
 */
function executionLedger(approval: ExecutionLedgerFacts, outcome: ExecutionOutcome) {
  const r = outcome.result as { outcome?: unknown; provider?: unknown; reason?: unknown };
  return outcome.status === "executed"
    ? {
        key: "approval.executed" as const,
        department: approval.department_key,
        payload: {
          action_kind: approval.action_kind,
          outcome: isLedgerCode(r.outcome) ? r.outcome : "unspecified",
          ...(isLedgerCode(r.provider) ? { provider: r.provider } : {}),
        },
      }
    : {
        key: "approval.failed" as const,
        department: approval.department_key,
        payload: { action_kind: approval.action_kind, reason: isLedgerCode(r.reason) ? r.reason : "unspecified" },
      };
}

/**
 * BEFORE the claim (execute.ts): prove the finish can record its ledger row.
 * The finish runs after the send; if its batch failed there (outcome_events
 * missing, or a row the ledger refuses), it would roll back and leave the
 * approval `executing` with the provider's result lost, although the email
 * went out. So both possible finish rows are built (and validated) now, and
 * outcome_events is read once. Either failing throws here, while the approval
 * is still `approved` and nothing has left the business.
 */
export async function assertExecutionLedgerReady(db: Client, approval: ApprovalRow, now: Date): Promise<void> {
  const t = requireTenant(approval.tenant_id);
  const nowIso = now.toISOString();
  const system: Actor = { type: "system", id: null };
  const probes: ExecutionOutcome[] = [
    { status: "executed", result: { outcome: "sent", provider: "readiness" } },
    { status: "failed", result: { outcome: "failed", reason: "readiness", message: "" } },
  ];
  for (const o of probes) eventWithLedger(t, approval.id, o.status, system, null, nowIso, executionLedger(approval, o));
  await db.execute({ sql: "SELECT 1 FROM outcome_events WHERE tenant_id = ? LIMIT 1", args: [t] });
}

/**
 * executing → executed | failed, with the executor's own account. Throws if
 * the row is not `executing`: under the claim above that cannot happen, and if
 * it ever does, a second writer exists and that is a loud bug, not a detail.
 *
 * `approval` is the row the executor already read after its claim. Nothing is
 * read here: this runs after the outward action, so it does only the one batch.
 */
export async function finishExecution(
  db: Client,
  tenantId: string,
  id: string,
  outcome: ExecutionOutcome,
  now: Date,
  approval: ExecutionLedgerFacts,
): Promise<void> {
  const t = requireTenant(tenantId);
  const nowIso = now.toISOString();
  const resultJson = JSON.stringify(outcome.result);
  const results = await db.batch(
    [
      {
        sql: `UPDATE approvals SET status = ?, executed_at = ?, execution_result = ?, updated_at = ?
              WHERE tenant_id = ? AND id = ? AND status = 'executing'`,
        args: [outcome.status, nowIso, resultJson, nowIso, t, id],
      },
      ...eventWithLedger(
        t,
        id,
        outcome.status,
        { type: "system", id: null },
        outcome.result as Record<string, unknown>,
        nowIso,
        executionLedger(approval, outcome),
      ),
    ],
    "write",
  );
  if (results[0].rowsAffected !== 1) {
    throw new Error(`approvals: finishExecution found ${id} not executing`);
  }
}

/** The tenants row the executor re-checks before acting. Null = no such workspace. */
export async function readTenantForExecution(
  db: Client,
  tenantId: string,
): Promise<{ id: string; slug: string | null } | null> {
  const t = requireTenant(tenantId);
  const rs = await db.execute({ sql: "SELECT id, slug FROM tenants WHERE id = ? LIMIT 1", args: [t] });
  const r = rows(rs)[0];
  return r ? { id: String(r.id), slug: s(r.slug) } : null;
}
