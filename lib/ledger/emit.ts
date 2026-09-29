/**
 * lib/ledger/emit.ts — the ONE door into outcome_events.
 *
 * emit() and emitIfChanged() validate an event against the catalog and RETURN
 * an INSERT statement. They never run it. The caller puts it in the SAME
 * db.batch(..., "write") as the business write it records, so the two commit
 * or roll back together: a failed ledger insert undoes the business write, and
 * a business write that rolled back leaves no ledger row.
 *
 *   emit(input)           INSERT ... ON CONFLICT (tenant_id, idempotency_key)
 *                         DO NOTHING. A re-sent event is a no-op.
 *   emitIfChanged(input)  INSERT ... SELECT ... WHERE changes() = 1, for the
 *                         statement right after a compare-and-swap: a CAS that
 *                         lost writes no ledger row (the approvals store's
 *                         eventIfChanged pattern, lib/os/approvals/store.ts).
 *   assertNoPayloadConflicts(db, batch)
 *                         after the batch: the same idempotency key already
 *                         holding DIFFERENT content is a producer reusing a
 *                         key for another fact. Loud, never silently kept.
 *
 * Every refusal throws LedgerValidationError with a code and the field. There
 * is no default tenant: an event with no tenant is refused, never filed under
 * OASIS.
 */
import { createHash, randomBytes } from "node:crypto";
import type { Client, InValue } from "@libsql/client";
import type { DepartmentKey } from "@/lib/os/types";
import { canonicalJson } from "@/lib/os/approvals/rules";
import {
  ACTOR_TYPES,
  CONFIDENCES,
  CURRENCY_RE,
  DEPARTMENT_KEYS,
  JOIN_KEYS,
  SOURCES,
  catalogEntry,
  isLedgerId,
  isOneOf,
  validatePayload,
  type CatalogEntry,
  type JoinKey,
  type LedgerActorType,
  type LedgerConfidence,
  type LedgerSource,
  type Valid,
} from "@/lib/ledger/catalog";

export type EmitInput = {
  tenantId: string;
  eventKey: string;
  eventVersion: number;
  /** When it happened at the source (provider time). */
  occurredAt: string | Date;
  subject: { type: string; id: string };
  contactId?: string | null;
  dealId?: string | null;
  customerId?: string | null;
  /** Defaults to the catalog entry's department. */
  department?: DepartmentKey | null;
  actor: { type: LedgerActorType; id?: string | null };
  source: LedgerSource;
  sourceRef?: string | null;
  idempotencyKey: string;
  causationId?: string | null;
  correlationId?: string | null;
  approvalId?: string | null;
  routineRunId?: string | null;
  touchId?: string | null;
  valueCents?: number | null;
  currency?: string | null;
  confidence: LedgerConfidence;
  payload: Record<string, unknown>;
  /** The module that emitted it (a repo path), or ingest:<producer>. */
  producer: string;
};

/** One outcome_events row, as written. */
export type LedgerRow = {
  id: string;
  tenant_id: string;
  event_key: string;
  event_version: number;
  occurred_at: string;
  recorded_at: string;
  subject_type: string;
  subject_id: string;
  contact_id: string | null;
  deal_id: string | null;
  customer_id: string | null;
  department_key: DepartmentKey;
  actor_type: LedgerActorType;
  actor_id: string | null;
  source: LedgerSource;
  source_ref: string | null;
  idempotency_key: string;
  payload_hash: string;
  causation_id: string | null;
  correlation_id: string | null;
  approval_id: string | null;
  routine_run_id: string | null;
  touch_id: string | null;
  value_cents: number | null;
  currency: string | null;
  confidence: LedgerConfidence;
  payload_json: string;
  producer: string;
};

const COLUMNS = [
  "id", "tenant_id", "event_key", "event_version", "occurred_at", "recorded_at", "subject_type", "subject_id",
  "contact_id", "deal_id", "customer_id", "department_key", "actor_type", "actor_id", "source", "source_ref",
  "idempotency_key", "payload_hash", "causation_id", "correlation_id", "approval_id", "routine_run_id", "touch_id",
  "value_cents", "currency", "confidence", "payload_json", "producer",
] as const satisfies readonly (keyof LedgerRow)[];

/** What a caller (and assertNoPayloadConflicts) needs to know about a ledger statement after the batch. */
export type LedgerStamp = {
  tenantId: string;
  eventKey: string;
  idempotencyKey: string;
  payloadHash: string;
  /** emitIfChanged: the row is legitimately absent when the guarded change did not happen. */
  conditional: boolean;
};

/** An InStatement (sql + args) that also carries its stamp; db.batch reads only sql and args. */
export type LedgerStatement = { sql: string; args: InValue[]; ledger: LedgerStamp };

export class LedgerValidationError extends Error {
  readonly code: string;
  readonly field: string | undefined;
  constructor(code: string, field?: string) {
    super(`ledger: ${code}${field ? ` (${field})` : ""}`);
    this.name = "LedgerValidationError";
    this.code = code;
    this.field = field;
  }
}

// ---------------------------------------------------------------------------
// Ids and hashes
// ---------------------------------------------------------------------------

const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
let lastUlidMs = -1;
let lastUlidRandom: number[] = [];

/**
 * A ULID: 10 characters of millisecond time then 16 of randomness, Crockford
 * base32, so ids sort in the order they were minted. Monotonic within one
 * process: a second id in the same millisecond (or after the clock stepped
 * back) increments the random part instead of drawing a new one.
 */
export function newLedgerId(nowMs: number = Date.now()): string {
  let ms = Math.floor(nowMs);
  if (ms <= lastUlidMs) {
    ms = lastUlidMs;
    const next = [...lastUlidRandom];
    let i = next.length - 1;
    while (i >= 0 && next[i] === 31) next[i--] = 0;
    if (i < 0) throw new Error("ledger: ULID random part overflowed within one millisecond");
    next[i] += 1;
    lastUlidRandom = next;
  } else {
    lastUlidMs = ms;
    lastUlidRandom = Array.from(randomBytes(16), (b) => b & 31);
  }
  let time = "";
  for (let i = 0, t = ms; i < 10; i++, t = Math.floor(t / 32)) time = B32[t % 32] + time;
  return time + lastUlidRandom.map((d) => B32[d]).join("");
}

/**
 * sha256 of the event's CONTENT: what happened, to what, for how much. Not the
 * server time, the actor or the trace ids, so an honest re-send hashes the same
 * and a key reused for a different fact does not.
 */
export function ledgerPayloadHash(row: Pick<
  LedgerRow,
  "event_key" | "event_version" | "subject_type" | "subject_id" | "contact_id" | "deal_id" | "customer_id" | "value_cents" | "currency"
> & { payload: Record<string, unknown> }): string {
  const content = canonicalJson({
    event_key: row.event_key,
    event_version: row.event_version,
    subject_type: row.subject_type,
    subject_id: row.subject_id,
    contact_id: row.contact_id,
    deal_id: row.deal_id,
    customer_id: row.customer_id,
    value_cents: row.value_cents,
    currency: row.currency,
    payload: row.payload,
  });
  return createHash("sha256").update(content, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** An idempotency key or source ref: printable ASCII, no whitespace. */
const REF_RE = /^[\x21-\x7E]{1,256}$/;

const bad = (error: string, field?: string): { ok: false; error: string; field?: string } => ({ ok: false, error, ...(field ? { field } : {}) });

function optionalId(v: unknown, field: string): Valid<string | null> {
  if (v === undefined || v === null) return { ok: true, value: null };
  return isLedgerId(v) ? { ok: true, value: v } : bad("not_an_id", field);
}

function toIso(v: unknown): string | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v) && !Number.isNaN(Date.parse(v))) return new Date(v).toISOString();
  return null;
}

/**
 * An event checked against the catalog and turned into the row it writes.
 * Pure, and never throws on bad input: /api/ledger/ingest dead-letters the
 * refusal; emit() throws it.
 */
export function validateEvent(input: EmitInput, now: Date): Valid<{ row: LedgerRow; entry: CatalogEntry }> {
  if (!input || typeof input !== "object") return bad("event_not_an_object");
  const tenantId = typeof input.tenantId === "string" ? input.tenantId.trim() : "";
  if (!tenantId) return bad("tenant_required", "tenant_id");
  if (!isLedgerId(tenantId)) return bad("not_an_id", "tenant_id");

  const entry = catalogEntry(input.eventKey);
  if (!entry) return bad("event_key_unknown", "event_key");
  if (input.eventVersion !== entry.version) return bad("event_version_unsupported", "event_version");

  const occurredAt = toIso(input.occurredAt);
  if (!occurredAt) return bad("occurred_at_invalid", "occurred_at");

  const subject = input.subject;
  if (!subject || typeof subject !== "object") return bad("subject_required", "subject");
  if (!isOneOf(entry.subjectTypes, subject.type)) return bad("subject_type_not_allowed", "subject.type");
  if (!isLedgerId(subject.id)) return bad("not_an_id", "subject.id");

  const joins: Record<JoinKey, string | null> = { contact_id: null, deal_id: null, customer_id: null };
  const joinInputs: Record<JoinKey, unknown> = { contact_id: input.contactId, deal_id: input.dealId, customer_id: input.customerId };
  for (const k of JOIN_KEYS) {
    const r = optionalId(joinInputs[k], k);
    if (!r.ok) return r;
    joins[k] = r.value;
  }
  for (const k of entry.requiredJoinKeys) if (!joins[k]) return bad("join_key_required", k);

  const department = input.department ?? entry.department;
  if (!isOneOf(DEPARTMENT_KEYS, department)) return bad("department_unknown", "department_key");

  const actor = input.actor;
  if (!actor || !isOneOf(ACTOR_TYPES, actor.type)) return bad("actor_type_unknown", "actor_type");
  const actorId = optionalId(actor.id, "actor_id");
  if (!actorId.ok) return actorId;

  if (!isOneOf(SOURCES, input.source)) return bad("source_unknown", "source");
  const sourceRef = input.sourceRef ?? null;
  if (sourceRef !== null && !(typeof sourceRef === "string" && REF_RE.test(sourceRef))) return bad("source_ref_invalid", "source_ref");

  if (typeof input.idempotencyKey !== "string" || !REF_RE.test(input.idempotencyKey)) {
    return bad("idempotency_key_invalid", "idempotency_key");
  }

  const trace: Record<string, string | null> = {};
  for (const [field, v] of [
    ["causation_id", input.causationId],
    ["correlation_id", input.correlationId],
    ["approval_id", input.approvalId],
    ["routine_run_id", input.routineRunId],
    ["touch_id", input.touchId],
  ] as const) {
    const r = optionalId(v, field);
    if (!r.ok) return r;
    trace[field] = r.value;
  }

  const valueCents = input.valueCents ?? null;
  const currency = input.currency ?? null;
  if (valueCents !== null && !(typeof valueCents === "number" && Number.isSafeInteger(valueCents))) {
    return bad("value_cents_invalid", "value_cents");
  }
  if (currency !== null && !(typeof currency === "string" && CURRENCY_RE.test(currency))) return bad("currency_invalid", "currency");
  if (entry.value === "none" && (valueCents !== null || currency !== null)) return bad("value_not_allowed", "value_cents");
  if (entry.value === "required" && valueCents === null) return bad("value_required", "value_cents");
  if (valueCents !== null && currency === null) return bad("currency_required", "currency");
  if (valueCents === null && currency !== null) return bad("value_required", "value_cents");

  if (!isOneOf(CONFIDENCES, input.confidence)) return bad("confidence_unknown", "confidence");
  // A backfill reconstructs history after the fact; it never claims to have seen it.
  if (input.source === "backfill" && input.confidence !== "inferred") return bad("backfill_must_be_inferred", "confidence");

  const payload = validatePayload(entry.payload, input.payload);
  if (!payload.ok) return payload;

  if (typeof input.producer !== "string" || !REF_RE.test(input.producer)) return bad("producer_invalid", "producer");

  const content = {
    event_key: entry.key,
    event_version: entry.version,
    subject_type: subject.type,
    subject_id: subject.id,
    contact_id: joins.contact_id,
    deal_id: joins.deal_id,
    customer_id: joins.customer_id,
    value_cents: valueCents,
    currency,
  };
  const row: LedgerRow = {
    id: newLedgerId(now.getTime()),
    tenant_id: tenantId,
    ...content,
    occurred_at: occurredAt,
    recorded_at: now.toISOString(),
    department_key: department,
    actor_type: actor.type,
    actor_id: actorId.value,
    source: input.source,
    source_ref: sourceRef,
    idempotency_key: input.idempotencyKey,
    payload_hash: ledgerPayloadHash({ ...content, payload: payload.value }),
    causation_id: trace.causation_id,
    correlation_id: trace.correlation_id,
    approval_id: trace.approval_id,
    routine_run_id: trace.routine_run_id,
    touch_id: trace.touch_id,
    confidence: input.confidence,
    payload_json: canonicalJson(payload.value),
    producer: input.producer,
  };
  return { ok: true, value: { row, entry } };
}

// ---------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------

const COLUMN_LIST = COLUMNS.join(", ");
const PLACEHOLDERS = COLUMNS.map(() => "?").join(", ");

function stamp(row: LedgerRow, conditional: boolean): LedgerStamp {
  return { tenantId: row.tenant_id, eventKey: row.event_key, idempotencyKey: row.idempotency_key, payloadHash: row.payload_hash, conditional };
}

/** The INSERT for a row that validateEvent produced. */
export function insertLedgerRow(row: LedgerRow, conditional: boolean): LedgerStatement {
  const args = COLUMNS.map((c) => row[c] as InValue);
  const sql = conditional
    ? `INSERT INTO outcome_events (${COLUMN_LIST}) SELECT ${PLACEHOLDERS} WHERE changes() = 1
       ON CONFLICT (tenant_id, idempotency_key) DO NOTHING`
    : `INSERT INTO outcome_events (${COLUMN_LIST}) VALUES (${PLACEHOLDERS})
       ON CONFLICT (tenant_id, idempotency_key) DO NOTHING`;
  return { sql, args, ledger: stamp(row, conditional) };
}

function validOrThrow(input: EmitInput, now: Date): LedgerRow {
  const v = validateEvent(input, now);
  if (!v.ok) throw new LedgerValidationError(v.error, v.field);
  return v.value.row;
}

/** The ledger INSERT for the caller's own batch. Idempotent on (tenant, key). */
export function emit(input: EmitInput, now: Date = new Date()): LedgerStatement {
  return insertLedgerRow(validOrThrow(input, now), false);
}

/**
 * The ledger INSERT that runs only if the statement immediately before it in
 * the same batch changed exactly one row. Put it straight after the
 * compare-and-swap (or after the audit-event insert that is itself guarded by
 * it): a CAS that lost writes no ledger row.
 */
export function emitIfChanged(input: EmitInput, now: Date = new Date()): LedgerStatement {
  return insertLedgerRow(validOrThrow(input, now), true);
}

// ---------------------------------------------------------------------------
// After the batch
// ---------------------------------------------------------------------------

export type PayloadConflict = LedgerStamp & {
  problem: "payload_mismatch" | "missing";
  storedHash: string | null;
};

export class LedgerConflictError extends Error {
  readonly conflicts: PayloadConflict[];
  constructor(conflicts: PayloadConflict[]) {
    super(
      `ledger: ${conflicts.length} idempotency conflict(s): ` +
        conflicts.map((c) => `${c.problem} ${c.eventKey} key=${c.idempotencyKey}`).join("; "),
    );
    this.name = "LedgerConflictError";
    this.conflicts = conflicts;
  }
}

function stampsOf(statements: readonly unknown[]): LedgerStamp[] {
  const out: LedgerStamp[] = [];
  for (const s of statements) {
    const st = s && typeof s === "object" ? (s as { ledger?: LedgerStamp }).ledger : undefined;
    if (st && typeof st.idempotencyKey === "string") out.push(st);
  }
  return out;
}

/**
 * Read back every ledger key in a batch that has run. A key whose stored hash
 * differs from what this batch meant to write is a `payload_mismatch`. An
 * unconditional statement with no row at all is `missing` (the statement was
 * never put in the batch); a conditional one with no row is fine (its guarded
 * change did not happen).
 */
export async function findPayloadConflicts(db: Client, statements: readonly unknown[]): Promise<PayloadConflict[]> {
  const stamps = stampsOf(statements);
  if (stamps.length === 0) return [];
  const byTenant = new Map<string, LedgerStamp[]>();
  for (const s of stamps) byTenant.set(s.tenantId, [...(byTenant.get(s.tenantId) ?? []), s]);
  const conflicts: PayloadConflict[] = [];
  for (const [tenantId, list] of byTenant) {
    const stored = new Map<string, string>();
    const keys = [...new Set(list.map((s) => s.idempotencyKey))];
    for (let i = 0; i < keys.length; i += 100) {
      const chunk = keys.slice(i, i + 100);
      const rs = await db.execute({
        sql: `SELECT idempotency_key, payload_hash FROM outcome_events
              WHERE tenant_id = ? AND idempotency_key IN (${chunk.map(() => "?").join(", ")})`,
        args: [tenantId, ...chunk],
      });
      for (const r of rs.rows) stored.set(String(r.idempotency_key), String(r.payload_hash));
    }
    for (const s of list) {
      const h = stored.get(s.idempotencyKey) ?? null;
      if (h === null) {
        if (!s.conditional) conflicts.push({ ...s, problem: "missing", storedHash: null });
      } else if (h !== s.payloadHash) {
        conflicts.push({ ...s, problem: "payload_mismatch", storedHash: h });
      }
    }
  }
  return conflicts;
}

/** findPayloadConflicts, loud: any conflict throws LedgerConflictError. */
export async function assertNoPayloadConflicts(db: Client, statements: readonly unknown[]): Promise<void> {
  const conflicts = await findPayloadConflicts(db, statements);
  if (conflicts.length) {
    console.error("[ledger] idempotency conflict after batch", conflicts.map((c) => ({ tenant: c.tenantId, key: c.idempotencyKey, problem: c.problem })));
    throw new LedgerConflictError(conflicts);
  }
}
