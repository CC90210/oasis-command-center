/**
 * lib/ledger/ingest.ts — POST /api/ledger/ingest, for the Python harnesses
 * (BEA, Maven, Atlas). They never write ledger tables; they send events here.
 *
 * AUTH. HMAC-SHA256 per producer over "<timestamp>.<raw body>", keyed with
 * LEDGER_INGEST_SECRET_<PRODUCER> (the lead provisions the values):
 *   x-ledger-producer   bea | maven | atlas
 *   x-ledger-timestamp  unix seconds; more than 5 minutes either side of now = 401
 *   x-ledger-signature  lowercase hex of the HMAC
 * The check reuses lib/founders-finances/stripe-signature.ts, which implements
 * exactly that scheme (timing-safe compare, 300 s window). A producer whose
 * secret is not set gets 503: fail closed, never "unset means open".
 * Nothing is written for a request that does not authenticate.
 *
 * TENANT. Taken from the SUBJECT, never from the credential: a lead, contact,
 * deal, customer or approval id must exist, and its row says which tenant it
 * belongs to. Other subjects (a message, a routine run) must name tenant_id
 * explicitly. Either way the tenant must be on the producer's allowlist
 * (OASIS's own workspaces only, for now) and must not be retired. Join keys
 * (contact_id, deal_id, customer_id) must exist in that same tenant.
 *
 * WHAT A PRODUCER MAY NOT CLAIM. The department is always the catalog's (a
 * different department_key is refused, never used), and a harness is a
 * machine: it may not record an event as a human's (actor.type "human") or as
 * human_confirmed. A person's own action reaches the ledger through the app
 * path that signed them in.
 *
 * FAILURE IS LOUD. A refused event is written to ledger_dead_letters (redacted)
 * and the response is non-2xx, so the producer keeps it and retries; valid
 * events in the same request are still written, once. Re-sending a batch is
 * safe: every event is idempotent on (tenant, idempotency_key), and the same
 * key with different content is refused as idempotency_key_reused.
 *
 *   200  every event written or already present
 *   400  the body is not {"events":[...]} of 1..MAX events (dead-lettered)
 *   401  unknown producer, missing/bad signature, or a stale timestamp
 *   413  body over MAX_BODY_BYTES
 *   422  at least one event refused (per-event results say which and why)
 *   503  this producer's secret is not configured
 *   500  the database failed; retry (idempotent, so nothing is written twice)
 */
import { createHash, randomUUID } from "node:crypto";
import type { Client, InStatement } from "@libsql/client";
import { canonicalJson } from "@/lib/os/approvals/rules";
import { OASIS_INTERNAL_TENANT_IDS } from "@/lib/ai/tools/client-safe-registry";
import { isRetiredTenant } from "@/lib/tenant/retired";
import { verifyStripeSignature } from "@/lib/founders-finances/stripe-signature";
import {
  PRODUCERS,
  catalogEntry,
  isLedgerId,
  isOneOf,
  looksPersonal,
  type CatalogEntry,
  type LedgerProducer,
  type SubjectType,
} from "@/lib/ledger/catalog";
import { findPayloadConflicts, insertLedgerRow, validateEvent, type EmitInput, type LedgerStatement } from "@/lib/ledger/emit";

export const MAX_EVENTS_PER_REQUEST = 100;
export const MAX_BODY_BYTES = 512 * 1024;
export const SIGNATURE_WINDOW_SECONDS = 300;
const MIN_SECRET_LENGTH = 32;

/** The tenants each producer may write. OASIS's own workspaces only, for now. */
export const PRODUCER_TENANTS: Readonly<Record<LedgerProducer, ReadonlySet<string>>> = {
  bea: OASIS_INTERNAL_TENANT_IDS,
  maven: OASIS_INTERNAL_TENANT_IDS,
  atlas: OASIS_INTERNAL_TENANT_IDS,
};

/** Subjects whose own row names their tenant. Anything else must carry tenant_id. */
const SUBJECT_TABLES: Partial<Record<SubjectType, string>> = {
  lead: "tenant_records",
  contact: "tenant_records",
  deal: "tenant_records",
  customer: "customers",
  approval: "approvals",
};
const JOIN_TABLES = { contact_id: "tenant_records", deal_id: "tenant_records", customer_id: "customers" } as const;

export function secretEnvName(producer: LedgerProducer): string {
  return `LEDGER_INGEST_SECRET_${producer.toUpperCase()}`;
}

export type IngestResult = {
  index: number;
  idempotency_key: string | null;
  status: "written" | "duplicate" | "rejected";
  error?: string;
  field?: string;
};

type Deps = { db: Client; env: Record<string, string | undefined>; now: Date };

const json = (status: number, body: Record<string, unknown>) => Response.json(body, { status });

// ---------------------------------------------------------------------------
// Dead letters
// ---------------------------------------------------------------------------

const SAFE_TOKEN = /^[A-Za-z0-9_.:/-]{0,200}$/;
/** A string a dead letter may keep: plain id/code/time characters, and not a phone, postal code or name (catalog PERSONAL_SHAPES). */
const isSafeToken = (v: string): boolean => SAFE_TOKEN.test(v) && !looksPersonal(v);
/** An integer of phone length (7 to 15 digits): 5145550199 sent as a number is still a phone number. */
const isPhoneLengthNumber = (v: number): boolean => Number.isInteger(v) && /^\d{7,15}$/.test(String(Math.abs(v)));

/** The event as sent, with every value and key that is not a plain id/code/time/small number replaced. */
export function redactForDeadLetter(v: unknown, depth = 0): unknown {
  if (depth > 6) return "[truncated]";
  if (v === null || typeof v === "boolean") return v;
  if (typeof v === "number") return isPhoneLengthNumber(v) ? "[redacted]" : v;
  if (typeof v === "string") return isSafeToken(v) ? v : "[redacted]";
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => redactForDeadLetter(x, depth + 1));
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, 100)) {
      out[isSafeToken(k) ? k : "[redacted-key]"] = redactForDeadLetter(x, depth + 1);
    }
    return out;
  }
  return "[unsupported]";
}

/**
 * The refused field's name, for the error column. Every field name is ours
 * except payload.<key> of an undeclared key, which is whatever the producer
 * sent (payload_field_unknown), so that key is held to the same rule as a value.
 */
function redactFieldName(field: string): string {
  const PAYLOAD = "payload.";
  if (!field.startsWith(PAYLOAD)) return field;
  const key = field.slice(PAYLOAD.length);
  return isSafeToken(key) ? field : `${PAYLOAD}[redacted-key]`;
}

function deadLetter(
  producer: LedgerProducer,
  raw: unknown,
  error: string,
  field: string | undefined,
  tenantHint: string | null,
  nowIso: string,
): InStatement {
  const ev = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const safe = (v: unknown) => (typeof v === "string" && v && isSafeToken(v) ? v : null);
  const fingerprint = createHash("sha256").update(`${producer}\n${canonicalJson(raw ?? null)}`, "utf8").digest("hex");
  return {
    sql: `INSERT INTO ledger_dead_letters (id, tenant_hint, producer, event_key, idempotency_key, fingerprint, payload_json,
            error, attempts, first_seen, last_seen)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
          ON CONFLICT (producer, fingerprint) DO UPDATE SET
            attempts = attempts + 1, last_seen = excluded.last_seen, error = excluded.error, resolved_at = NULL`,
    args: [
      randomUUID(),
      tenantHint && isLedgerId(tenantHint) ? tenantHint : null,
      producer,
      safe(ev.event_key),
      safe(ev.idempotency_key),
      fingerprint,
      canonicalJson(redactForDeadLetter(raw ?? null)),
      field ? `${error}:${redactFieldName(field)}` : error,
      nowIso,
      nowIso,
    ],
  };
}

// ---------------------------------------------------------------------------
// Tenant resolution
// ---------------------------------------------------------------------------

type Lookup = (table: string, id: string) => Promise<string | null>;

function tenantLookup(db: Client): Lookup {
  const cache = new Map<string, string | null>();
  return async (table, id) => {
    const key = `${table}\n${id}`;
    if (cache.has(key)) return cache.get(key) ?? null;
    // table comes from the constant maps above, never from the request.
    const rs = await db.execute({ sql: `SELECT tenant_id FROM ${table} WHERE id = ? LIMIT 1`, args: [id] });
    const t = rs.rows[0] ? String(rs.rows[0].tenant_id ?? "") || null : null;
    cache.set(key, t);
    return t;
  };
}

type Resolved = { ok: true; tenantId: string } | { ok: false; error: string; field?: string; tenantHint: string | null };

async function resolveTenant(producer: LedgerProducer, ev: Record<string, unknown>, lookup: Lookup): Promise<Resolved> {
  const explicit = typeof ev.tenant_id === "string" && ev.tenant_id.trim() ? ev.tenant_id.trim() : null;
  const subject = ev.subject && typeof ev.subject === "object" ? (ev.subject as Record<string, unknown>) : null;
  if (!subject || typeof subject.type !== "string") return { ok: false, error: "subject_required", field: "subject", tenantHint: explicit };
  if (!isLedgerId(subject.id)) return { ok: false, error: "not_an_id", field: "subject.id", tenantHint: explicit };

  let tenantId: string;
  const table = SUBJECT_TABLES[subject.type as SubjectType];
  if (table) {
    const owner = await lookup(table, subject.id);
    if (!owner) return { ok: false, error: "subject_not_found", field: "subject.id", tenantHint: explicit };
    if (explicit && explicit !== owner) return { ok: false, error: "tenant_mismatch", field: "tenant_id", tenantHint: owner };
    tenantId = owner;
  } else {
    if (!explicit) return { ok: false, error: "tenant_required", field: "tenant_id", tenantHint: null };
    tenantId = explicit;
  }
  if (!PRODUCER_TENANTS[producer].has(tenantId)) return { ok: false, error: "tenant_not_allowed", field: "tenant_id", tenantHint: tenantId };
  if (isRetiredTenant(tenantId)) return { ok: false, error: "tenant_retired", field: "tenant_id", tenantHint: tenantId };

  for (const [field, joinTable] of Object.entries(JOIN_TABLES)) {
    const v = ev[field];
    if (v === undefined || v === null) continue;
    if (!isLedgerId(v)) return { ok: false, error: "not_an_id", field, tenantHint: tenantId };
    if ((await lookup(joinTable, v)) !== tenantId) return { ok: false, error: "join_key_not_in_tenant", field, tenantHint: tenantId };
  }
  return { ok: true, tenantId };
}

function toEmitInput(
  producer: LedgerProducer,
  entry: CatalogEntry,
  tenantId: string,
  ev: Record<string, unknown>,
): EmitInput | { error: string; field: string } {
  const producerRef = ev.producer_ref;
  if (producerRef !== undefined && producerRef !== null && !isLedgerId(producerRef)) return { error: "producer_ref_invalid", field: "producer_ref" };
  // The catalog decides which department a key counts toward; a producer cannot re-file it.
  if (ev.department_key !== undefined && ev.department_key !== null && ev.department_key !== entry.department) {
    return { error: "department_not_allowed", field: "department_key" };
  }
  const subject = ev.subject as { type: string; id: string };
  const actor = (ev.actor && typeof ev.actor === "object" ? ev.actor : {}) as { type?: unknown; id?: unknown };
  if (actor.type === "human") return { error: "actor_not_allowed", field: "actor_type" };
  if (ev.confidence === "human_confirmed") return { error: "confidence_not_allowed", field: "confidence" };
  return {
    tenantId,
    eventKey: ev.event_key as string,
    eventVersion: ev.event_version as number,
    occurredAt: ev.occurred_at as string,
    subject: { type: subject.type, id: subject.id },
    contactId: ev.contact_id as string | null | undefined,
    dealId: ev.deal_id as string | null | undefined,
    customerId: ev.customer_id as string | null | undefined,
    department: entry.department,
    actor: { type: actor.type as EmitInput["actor"]["type"], id: actor.id as string | null | undefined },
    source: ev.source as EmitInput["source"],
    sourceRef: ev.source_ref as string | null | undefined,
    idempotencyKey: ev.idempotency_key as string,
    causationId: ev.causation_id as string | null | undefined,
    correlationId: ev.correlation_id as string | null | undefined,
    approvalId: ev.approval_id as string | null | undefined,
    routineRunId: ev.routine_run_id as string | null | undefined,
    touchId: ev.touch_id as string | null | undefined,
    valueCents: ev.value_cents as number | null | undefined,
    currency: ev.currency as string | null | undefined,
    confidence: ev.confidence as EmitInput["confidence"],
    payload: ev.payload as Record<string, unknown>,
    producer: producerRef ? `ingest:${producer}:${producerRef}` : `ingest:${producer}`,
  };
}

// ---------------------------------------------------------------------------
// The handler
// ---------------------------------------------------------------------------

/**
 * The body as text, reading at most `max` bytes. The body is read before the
 * signature can be checked (the HMAC covers it), and a chunked request carries
 * no Content-Length, so an unauthenticated caller must not be able to make the
 * handler buffer an unbounded body: past `max` the stream is cancelled and the
 * answer is null (413).
 */
async function readBodyCapped(req: Request, max: number): Promise<string | null> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel("body_too_large");
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export async function handleLedgerIngest(req: Request, deps: Deps): Promise<Response> {
  const producerHeader = (req.headers.get("x-ledger-producer") || "").trim().toLowerCase();
  if (!isOneOf(PRODUCERS, producerHeader)) return json(401, { ok: false, error: "unauthorized" });
  const producer: LedgerProducer = producerHeader;
  const secret = (deps.env[secretEnvName(producer)] || "").trim();
  if (secret.length < MIN_SECRET_LENGTH) {
    return json(503, { ok: false, error: "producer_not_configured", detail: `${secretEnvName(producer)} is not set (min ${MIN_SECRET_LENGTH} chars).` });
  }

  const declared = Number(req.headers.get("content-length") || "0");
  if (declared > MAX_BODY_BYTES) return json(413, { ok: false, error: "body_too_large" });
  const raw = await readBodyCapped(req, MAX_BODY_BYTES);
  if (raw === null) return json(413, { ok: false, error: "body_too_large" });

  const ts = (req.headers.get("x-ledger-timestamp") || "").trim();
  const sig = (req.headers.get("x-ledger-signature") || "").trim().toLowerCase();
  const verdict = verifyStripeSignature({
    payload: raw,
    header: ts && sig ? `t=${ts},v1=${sig}` : null,
    secret,
    nowSeconds: Math.floor(deps.now.getTime() / 1000),
    toleranceSeconds: SIGNATURE_WINDOW_SECONDS,
  });
  if (!verdict.ok) {
    return json(401, { ok: false, error: verdict.reason === "timestamp_outside_tolerance" ? "stale_timestamp" : "unauthorized" });
  }

  // Authenticated from here: a refusal is dead-lettered so Operations sees it.
  const nowIso = deps.now.toISOString();
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    await deps.db.execute(deadLetter(producer, { body_bytes: raw.length }, "body_invalid_json", undefined, null, nowIso));
    return json(400, { ok: false, error: "body_invalid_json" });
  }
  const events = body && typeof body === "object" && !Array.isArray(body) ? (body as { events?: unknown }).events : undefined;
  if (!Array.isArray(events) || events.length === 0 || events.length > MAX_EVENTS_PER_REQUEST) {
    const error = !Array.isArray(events) ? "events_required" : events.length === 0 ? "events_empty" : "events_too_many";
    await deps.db.execute(
      deadLetter(producer, { event_count: Array.isArray(events) ? events.length : null }, error, undefined, null, nowIso),
    );
    return json(400, { ok: false, error, max: MAX_EVENTS_PER_REQUEST });
  }

  const lookup = tenantLookup(deps.db);
  const results: IngestResult[] = [];
  const ledgerStmts: { index: number; stmt: LedgerStatement }[] = [];
  const letters: InStatement[] = [];
  const reject = (index: number, raw: unknown, error: string, field: string | undefined, tenantHint: string | null) => {
    const ev = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    results[index] = {
      index,
      idempotency_key: typeof ev.idempotency_key === "string" ? ev.idempotency_key : null,
      status: "rejected",
      error,
      ...(field ? { field } : {}),
    };
    letters.push(deadLetter(producer, raw, error, field, tenantHint, nowIso));
  };

  for (let i = 0; i < events.length; i++) {
    const rawEv = events[i];
    if (!rawEv || typeof rawEv !== "object" || Array.isArray(rawEv)) {
      reject(i, rawEv, "event_not_an_object", undefined, null);
      continue;
    }
    const ev = rawEv as Record<string, unknown>;
    const entry = catalogEntry(ev.event_key);
    if (!entry) {
      reject(i, ev, "event_key_unknown", "event_key", null);
      continue;
    }
    // One writer per event key: a producer sends only the keys the catalog gives it.
    if (!entry.producers.includes(producer)) {
      reject(i, ev, "producer_not_allowed_for_event", "event_key", null);
      continue;
    }
    const resolved = await resolveTenant(producer, ev, lookup);
    if (!resolved.ok) {
      reject(i, ev, resolved.error, resolved.field, resolved.tenantHint);
      continue;
    }
    const input = toEmitInput(producer, entry, resolved.tenantId, ev);
    if ("error" in input) {
      reject(i, ev, input.error, input.field, resolved.tenantId);
      continue;
    }
    const v = validateEvent(input, deps.now);
    if (!v.ok) {
      reject(i, ev, v.error, v.field, resolved.tenantId);
      continue;
    }
    ledgerStmts.push({ index: i, stmt: insertLedgerRow(v.value.row, false) });
  }

  // One transaction: the accepted rows and the dead letters commit together or
  // not at all (a 500, and the producer retries the whole request).
  const out = await deps.db.batch([...ledgerStmts.map((l) => l.stmt), ...letters], "write");
  ledgerStmts.forEach((l, n) => {
    results[l.index] = {
      index: l.index,
      idempotency_key: l.stmt.ledger.idempotencyKey,
      status: out[n].rowsAffected === 1 ? "written" : "duplicate",
    };
  });

  // The same key already holding other content: refuse it loudly, never keep
  // the old row and answer "duplicate".
  const conflicts = await findPayloadConflicts(deps.db, ledgerStmts.map((l) => l.stmt));
  if (conflicts.some((c) => c.problem === "missing")) {
    throw new Error("ledger ingest: an accepted event has no row after the batch");
  }
  const stampKey = (s: { tenantId: string; idempotencyKey: string; payloadHash: string }) =>
    `${s.tenantId}\n${s.idempotencyKey}\n${s.payloadHash}`;
  const mismatched = new Set(conflicts.map(stampKey));
  const late: InStatement[] = [];
  for (const l of ledgerStmts) {
    if (!mismatched.has(stampKey(l.stmt.ledger))) continue;
    const s = l.stmt.ledger;
    results[l.index] = { index: l.index, idempotency_key: s.idempotencyKey, status: "rejected", error: "idempotency_key_reused" };
    late.push(deadLetter(producer, events[l.index], "idempotency_key_reused", "idempotency_key", s.tenantId, nowIso));
  }
  if (late.length) {
    console.error("[ledger.ingest] idempotency key reused with different content", { producer, count: late.length });
    await deps.db.batch(late, "write");
  }

  const rejected = results.filter((r) => r.status === "rejected").length;
  if (rejected) console.error("[ledger.ingest] refused events", { producer, rejected, of: events.length });
  return json(rejected ? 422 : 200, { ok: rejected === 0, producer, results });
}
