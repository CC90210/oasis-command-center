/**
 * lib/ai/usage.ts — the AI usage ledger: one row per model call, and the
 * monthly AI budget every metered call reserves against.
 *
 * WHY (OASIS OS plan v2 §F2.6, docs/os-revamp/03-connectors-ai-finance.md
 * §d.3). Nothing metered a model call: 16 lifetime chat sessions recorded $0,
 * and the department agents (F5) must be metered and capped before they ship.
 *
 * THE ONE DOOR. Every file that calls a model provider takes a ModelCallMeter
 * (built here by modelCallMeter, from the tenant the caller already resolved
 * from the session or the job) and wraps each request in it:
 *
 *   const call = await meter.begin({ provider, model, maxOutputTokens, promptBytes });
 *   ...send the request, read the provider's usage...
 *   await call.finish({ outcome: "ok", usage });
 *
 * begin() reserves the call's worst case against the tenant's month (below) and
 * THROWS an AiBudgetError when it does not fit; the caller turns that into an
 * HTTP 402 (or, mid-stream, an error event with the same code). finish() writes
 * the call's ai_usage_events row and settles the reservation.
 * tests/ai-usage-no-unmetered-calls.test.ts fails if a file outside its
 * allow-list names a provider endpoint or SDK, and each allow-listed file must
 * take its meter from here.
 *
 * BUDGETS (tenant_ai_budgets, one row per tenant per UTC month).
 *   - A CAP STANDS until it is changed. A month with no row of its own takes
 *     the cap of the tenant's latest earlier row, and the first reservation of
 *     the month writes that row, so a cap never lapses at 00:00 UTC on the 1st.
 *     A tenant with no row at all (or whose latest cap is NULL) has no cap. Its
 *     calls are still recorded.
 *   - Only per-token billing is capped. A subscription (a flat plan) or a local
 *     model (the tenant's own machine) costs nothing per call: begin() reads no
 *     budget and reserves nothing for them, and the pre-stream check passes them.
 *   - Reserve before: the worst case is the request's prompt, counted as its
 *     UTF-8 byte length (byte-level BPE never makes more tokens than bytes, so
 *     for text this is an upper bound; an attached PDF or image is an estimate),
 *     priced at the higher of the input and cache-write rates, plus
 *     maxOutputTokens at the output rate. The reservation and the call's
 *     `pending` row are written in ONE transaction, and only when
 *     `spent + reserved + worst <= cap`, so two concurrent calls can never both
 *     slip under the cap and no reservation exists without a row that names it.
 *     Every call in a tool loop reserves for itself; one reservation never
 *     covers a loop.
 *   - Settle after: finish() releases the reservation and adds the real cost,
 *     and turns the pending row into the call's row, in one transaction. A cost
 *     that is unknown (the stream broke off before the provider reported its
 *     usage) settles at the reservation, so an unknown can only over-count.
 *   - A reservation whose finish() never lands (the Worker was cancelled, hit a
 *     limit, or the write failed twice) EXPIRES: after RESERVATION_TTL_MS the
 *     tenant's next reservation settles it at the reservation (spent, never
 *     released as free) and marks its row `expired`. A finish that arrives after
 *     that still records the real usage and corrects the month by the difference.
 *   - A capped tenant calling a model with no verified price is refused
 *     (ai_budget_unpriced_model): its worst case cannot be reserved, and running
 *     it unmetered would walk past a hard cap.
 *   - NEVER a silent downgrade. At the cap the call is refused and the owner is
 *     told; nothing here swaps in a cheaper or free model.
 *
 * COST. From model_prices (effective-dated, tiered by prompt size, seeded only
 * with prices read on the provider's own page), or the provider's own reported
 * cost (OpenRouter usage.cost, which is USD). A model with no price row records
 * cost_micro_usd NULL, "unknown", never a guessed number. A call refused before
 * it was sent, or answered non-2xx, billed nothing: cost 0, cost_source none.
 * Subscription and local calls have no per-call price: cost NULL, and usageFor
 * counts them apart from the unknowns.
 *
 * FAILURES. begin() fails CLOSED when a budget or price table that exists
 * cannot be read (ai_usage_unavailable): a cap it cannot read is a cap it cannot
 * enforce. A table that does NOT exist (bravo__192 not applied) holds no cap:
 * the call runs uncapped and is logged loudly as ai_usage_ledger_not_installed,
 * so a forgotten migration never takes every AI feature down with it. finish()
 * never throws into the caller, whose model call already happened; a row that
 * cannot be written is logged loudly with everything but the content.
 */
import "server-only";
import type { Client, InStatement, InValue } from "@libsql/client";
import { getTursoClient } from "@/lib/turso";
import { newLedgerId } from "@/lib/ledger/emit";
import {
  AI_BUDGET_EXHAUSTED,
  AI_BUDGET_SENTENCES,
  AI_BUDGET_UNPRICED_MODEL,
  AI_USAGE_LEDGER_NOT_INSTALLED,
  AI_USAGE_UNAVAILABLE,
  AI_USAGE_UNAVAILABLE_SENTENCE,
  type AiBudgetCode,
} from "@/lib/ai/usage-codes";

export {
  AI_BUDGET_EXHAUSTED,
  AI_BUDGET_SENTENCES,
  AI_BUDGET_UNPRICED_MODEL,
  AI_USAGE_LEDGER_NOT_INSTALLED,
  AI_USAGE_UNAVAILABLE,
  AI_USAGE_UNAVAILABLE_SENTENCE,
  isAiBudgetCode,
  meterRefusalCode,
  type AiBudgetCode,
} from "@/lib/ai/usage-codes";

// ---------------------------------------------------------------------------
// Vocabularies (the migration keeps no CHECK on these; they live here)
// ---------------------------------------------------------------------------

export const AUTH_KINDS = ["api_key", "oauth", "subscription", "local", "managed"] as const;
export type AuthKind = (typeof AUTH_KINDS)[number];

/**
 * byo_key: the tenant's own key. platform: OASIS's platform key (verified
 * operator only). managed: OASIS's managed workspace key, billed to the tenant.
 * subscription: a flat plan. local: the tenant's own model server.
 */
export const BILLING_MODES = ["byo_key", "platform", "managed", "subscription", "local"] as const;
export type BillingMode = (typeof BILLING_MODES)[number];
/** Billed per token: a NULL cost here is an unknown, not a flat rate. The only modes a cap applies to. */
export const METERED_BILLING_MODES: readonly BillingMode[] = ["byo_key", "platform", "managed"];

function isMetered(mode: BillingMode): boolean {
  return METERED_BILLING_MODES.includes(mode);
}

/** How a call ended (CallEnd.outcome). */
export const USAGE_OUTCOMES = ["ok", "error", "refused", "timeout", "cancelled"] as const;
export type UsageOutcome = (typeof USAGE_OUTCOMES)[number];
/**
 * The two states of a reserved call's row before (or instead of) its end:
 * `pending` in flight, `expired` never finished and settled at its reservation.
 */
export const RESERVATION_STATES = ["pending", "expired"] as const;
/** What a row is written with: an end, or `pending` (expired is only ever set by the sweep). */
export type RowOutcome = UsageOutcome | "pending";

/** How long a reserved call may stay unfinished before the next reservation settles it. */
export const RESERVATION_TTL_MS = 30 * 60_000;

/** The code paths that call a model. The subscription router adds infer:<source>. */
export const USAGE_SURFACES = [
  "chat.tools", //           /api/chat, the native tool loop (Anthropic, OpenAI, OpenRouter)
  "chat.stream", //          /api/chat, the plain stream (markers / off / Google / Ollama)
  "chat.resume", //          /api/chat/resume, a paused tool loop continued
  "chat.compact", //         /api/chat/compact
  "agents.chat", //          /api/agents/chat, department channels and direct agent chats
  "agents.generate", //      /api/agents/generate, the AI agent builder
  "manifest.chat", //        /api/manifest/chat, the manifest editor
  "gmail_templates.solara", // /api/gmail-templates/[id]/solara, variant writer
  "probe", //                lib/agents/provider-probe.ts, Settings "Test"
  "document_extract", //     lib/ai-document-extractor.ts
  "tools.learn_from_link", // lib/tools/worker/learn-from-link.ts, Content > Tools "Learn from a link"
  "tools.repurpose_post", //  lib/tools/worker/repurpose-post.ts, Content > Tools "Repurpose a post"
] as const;
export type UsageSurface = (typeof USAGE_SURFACES)[number] | `infer:${string}`;
const INFER_SURFACE_RE = /^infer:[A-Za-z0-9_.:-]{1,100}$/;

export function isUsageSurface(s: unknown): s is UsageSurface {
  return typeof s === "string" && ((USAGE_SURFACES as readonly string[]).includes(s) || INFER_SURFACE_RE.test(s));
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Who a model call is for and how it is paid. Tenant from the session or the job, never a body. */
export type ModelCallContext = {
  tenantId: string;
  surface: UsageSurface;
  authKind: AuthKind;
  billingMode: BillingMode;
  departmentKey?: string | null;
  jobId?: string | null;
  sessionId?: string | null;
  /** The AI teammate's key or slug. */
  teammateId?: string | null;
  /** The signed-in person the call served. */
  userId?: string | null;
};

/**
 * A call's usage as the provider reported it. inputTokens is UNCACHED input
 * (billed at the base rate); cache reads and writes are separate. null = the
 * provider did not report that number.
 */
export type ModelUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  /** A cost the provider itself reported for the call, in USD (OpenRouter usage.cost). */
  providerCostUsd?: number | null;
};

export type CallEnd = {
  outcome: UsageOutcome;
  /** What the provider reported; omitted or null when it reported nothing. */
  usage?: ModelUsage | null;
  /** A code, never provider prose. */
  errorCode?: string | null;
  /**
   * The provider generated nothing: it answered non-2xx, so nothing was billed.
   * Records cost 0 (known zero) and releases the reservation.
   */
  notBilled?: boolean;
};

export type BeginCall = {
  provider: string;
  /** The model id actually sent. */
  model: string;
  /** The request's output cap (max_tokens and its equivalents). */
  maxOutputTokens: number;
  /** UTF-8 byte length of the request as sent (utf8Length of the JSON body). */
  promptBytes: number;
  /** 1 for a first attempt. */
  attemptNo?: number;
  /** Why this attempt moved to another provider or model, when it did. */
  fallbackReason?: string | null;
};

export type ModelCall = {
  /** Idempotent: the first finish records; later ones do nothing. */
  finish(end: CallEnd): Promise<void>;
};

export type MeterTotals = {
  /** Calls this meter finished (a refused call counts). */
  calls: number;
  /** Sum of the KNOWN costs. */
  costMicroUsd: number;
  /** Finished calls whose cost is unknown. */
  unknownCostCalls: number;
};

export type ModelCallMeter = {
  readonly context: Readonly<ModelCallContext>;
  /** Reserve and open one model call. Throws AiBudgetError at the cap. */
  begin(call: BeginCall): Promise<ModelCall>;
  totals(): MeterTotals;
};

/** A budget refusal: the route answers HTTP 402 with `sentence`. */
export class AiBudgetError extends Error {
  readonly code: AiBudgetCode;
  readonly status = 402 as const;
  readonly sentence: string;
  constructor(code: AiBudgetCode) {
    super(code);
    this.name = "AiBudgetError";
    this.code = code;
    this.sentence = AI_BUDGET_SENTENCES[code];
  }
}

/** The budget or the prices could not be read, so the call was not sent. */
export class AiUsageUnavailableError extends Error {
  readonly code = AI_USAGE_UNAVAILABLE;
  constructor(detail: string) {
    super(`${AI_USAGE_UNAVAILABLE}: ${detail}`);
    this.name = "AiUsageUnavailableError";
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();
/** UTF-8 byte length: the prompt-token upper bound begin() reserves on. */
export function utf8Length(s: string): number {
  return encoder.encode(s).length;
}

/** 'YYYY-MM' of an instant, in UTC. */
export function periodMonthOf(at: Date): string {
  return at.toISOString().slice(0, 7);
}

const PERIOD_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
function periodBounds(period: string): { from: string; to: string } {
  const m = PERIOD_RE.exec(period);
  if (!m) throw new Error(`ai_usage: period must be YYYY-MM, got ${JSON.stringify(period)}`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const from = new Date(Date.UTC(y, mo - 1, 1)).toISOString();
  const to = new Date(Date.UTC(y, mo, 1)).toISOString();
  return { from, to };
}

/** libSQL over HTTP can hand integers back as strings; zero must stay zero, NULL stay NULL. */
function intOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "bigint" ? Number(v) : Number(v);
  return Number.isFinite(n) ? n : null;
}
function intOr0(v: unknown): number {
  return intOrNull(v) ?? 0;
}

function tokenCount(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : null;
}

/**
 * A ledger table that does not exist: bravo__192 is not applied. Distinct from
 * a read that failed: no table holds no cap, while a table that cannot be read
 * may hold one.
 */
export function isLedgerNotInstalled(err: unknown): boolean {
  return /no such table/i.test(err instanceof Error ? err.message : String(err));
}

function logLedgerNotInstalled(where: string, fields: Record<string, unknown>, err: unknown): void {
  console.error(`[ai/usage] ${AI_USAGE_LEDGER_NOT_INSTALLED}: bravo__192 is not applied, so ${where} runs uncapped and unrecorded`, {
    ...fields,
    code: AI_USAGE_LEDGER_NOT_INSTALLED,
    error: err instanceof Error ? err.message : String(err),
  });
}

// ---------------------------------------------------------------------------
// Prices
// ---------------------------------------------------------------------------

/** One model_prices row (micro-USD per million tokens). */
export type PriceRow = {
  provider: string;
  model: string;
  effectiveFrom: string;
  inputTokensAbove: number;
  input: number;
  output: number;
  cacheRead: number | null;
  cacheWrite: number | null;
  sourceUrl: string;
};

/**
 * The price version in force at `at`: every tier of the newest effective_from
 * that is not after `at`. [] when the model has no price.
 */
export async function pricesFor(db: Client, provider: string, model: string, at: Date): Promise<PriceRow[]> {
  const rs = await db.execute({
    sql: `SELECT provider, model, effective_from, input_tokens_above, input_micro_usd_per_mtok,
                 output_micro_usd_per_mtok, cache_read_micro_usd_per_mtok, cache_write_micro_usd_per_mtok, source_url
          FROM model_prices
          WHERE provider = ? AND model = ? AND effective_from <= ?
          ORDER BY effective_from DESC, input_tokens_above ASC`,
    args: [provider, model, at.toISOString()],
  });
  const rows: PriceRow[] = rs.rows.map((r) => ({
    provider: String(r.provider),
    model: String(r.model),
    effectiveFrom: String(r.effective_from),
    inputTokensAbove: intOr0(r.input_tokens_above),
    input: intOr0(r.input_micro_usd_per_mtok),
    output: intOr0(r.output_micro_usd_per_mtok),
    cacheRead: intOrNull(r.cache_read_micro_usd_per_mtok),
    cacheWrite: intOrNull(r.cache_write_micro_usd_per_mtok),
    sourceUrl: String(r.source_url),
  }));
  if (rows.length === 0) return [];
  const newest = rows[0].effectiveFrom;
  return rows.filter((r) => r.effectiveFrom === newest);
}

/** The tier a prompt of `promptTokens` is billed at: the highest threshold it is above. */
function tierFor(prices: PriceRow[], promptTokens: number): PriceRow | null {
  let best: PriceRow | null = null;
  for (const p of prices) {
    const applies = p.inputTokensAbove === 0 || promptTokens > p.inputTokensAbove;
    if (applies && (!best || p.inputTokensAbove > best.inputTokensAbove)) best = p;
  }
  return best;
}

/**
 * The most a call can cost: `promptTokens` at the higher of the input and
 * cache-write rates plus `maxOutputTokens` at the output rate, in the tier the
 * prompt bound falls in. null when the model has no price.
 */
export function worstCaseMicroUsd(prices: PriceRow[], promptTokens: number, maxOutputTokens: number): number | null {
  const row = tierFor(prices, promptTokens);
  if (!row) return null;
  const inRate = Math.max(row.input, row.cacheWrite ?? 0);
  return Math.ceil((Math.max(0, promptTokens) * inRate + Math.max(0, maxOutputTokens) * row.output) / 1_000_000);
}

export type CostSource = "price_table" | "provider_reported" | "none";

/**
 * A call's cost in micro-USD, or null when it cannot be known: no price, a
 * token count the provider did not report, or a token kind the price has no
 * rate for. A provider-reported cost wins over the price table.
 */
export function costOf(prices: PriceRow[], usage: ModelUsage): { micro: number | null; source: CostSource | null } {
  const reported = usage.providerCostUsd;
  if (typeof reported === "number" && Number.isFinite(reported) && reported >= 0) {
    return { micro: Math.round(reported * 1_000_000), source: "provider_reported" };
  }
  const input = tokenCount(usage.inputTokens);
  const output = tokenCount(usage.outputTokens);
  const cacheRead = tokenCount(usage.cacheReadTokens);
  const cacheWrite = tokenCount(usage.cacheWriteTokens);
  if (input === null || output === null || cacheRead === null || cacheWrite === null) return { micro: null, source: null };
  const row = tierFor(prices, input + cacheRead + cacheWrite);
  if (!row) return { micro: null, source: null };
  if (cacheRead > 0 && row.cacheRead === null) return { micro: null, source: null };
  if (cacheWrite > 0 && row.cacheWrite === null) return { micro: null, source: null };
  const microTimesMillion =
    input * row.input + output * row.output + cacheRead * (row.cacheRead ?? 0) + cacheWrite * (row.cacheWrite ?? 0);
  return { micro: Math.round(microTimesMillion / 1_000_000), source: "price_table" };
}

// ---------------------------------------------------------------------------
// The row
// ---------------------------------------------------------------------------

export type ModelCallRecord = ModelCallContext & {
  /** The row's ULID; new when omitted. */
  id?: string;
  occurredAt: Date;
  provider: string;
  model: string;
  attemptNo?: number;
  fallbackReason?: string | null;
  usage?: ModelUsage | null;
  costMicroUsd: number | null;
  costSource: CostSource | null;
  reservedMicroUsd?: number | null;
  latencyMs: number | null;
  outcome: RowOutcome;
  errorCode?: string | null;
  /** A pending row's deadline (RESERVATION_TTL_MS after it was written). */
  expiresAt?: Date | null;
};

const COLUMNS = [
  "id", "tenant_id", "occurred_at", "provider", "model", "surface", "auth_kind", "billing_mode",
  "department_key", "job_id", "session_id", "teammate_id", "user_id", "attempt_no", "fallback_reason",
  "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "cost_micro_usd", "cost_source",
  "reserved_micro_usd", "latency_ms", "outcome", "error_code", "expires_at",
] as const;

const CODE_RE = /^[a-z][a-z0-9_.:-]{0,79}$/;

function validateOutcome(outcome: string, errorCode: string | null | undefined): void {
  if (!(USAGE_OUTCOMES as readonly string[]).includes(outcome) && outcome !== "pending") throw new Error(`ai_usage: unknown outcome ${outcome}`);
  if (errorCode != null && !CODE_RE.test(errorCode)) throw new Error(`ai_usage: error_code must be a code, got ${JSON.stringify(errorCode)}`);
}

function validateRecord(r: ModelCallRecord): void {
  if (typeof r.tenantId !== "string" || !r.tenantId.trim()) throw new Error("ai_usage: a model call row needs a tenant");
  if (!isUsageSurface(r.surface)) throw new Error(`ai_usage: unknown surface ${JSON.stringify(r.surface)}`);
  if (!(AUTH_KINDS as readonly string[]).includes(r.authKind)) throw new Error(`ai_usage: unknown auth_kind ${r.authKind}`);
  if (!(BILLING_MODES as readonly string[]).includes(r.billingMode)) throw new Error(`ai_usage: unknown billing_mode ${r.billingMode}`);
  if (!r.provider || !r.model) throw new Error("ai_usage: a model call row names its provider and model");
  validateOutcome(r.outcome, r.errorCode);
}

/** The row's columns and their values, in COLUMNS order. */
function rowValues(r: ModelCallRecord): InValue[] {
  validateRecord(r);
  const u = r.usage ?? null;
  const values: Record<(typeof COLUMNS)[number], InValue> = {
    id: r.id ?? newLedgerId(r.occurredAt.getTime()),
    tenant_id: r.tenantId,
    occurred_at: r.occurredAt.toISOString(),
    provider: r.provider,
    model: r.model,
    surface: r.surface,
    auth_kind: r.authKind,
    billing_mode: r.billingMode,
    department_key: r.departmentKey ?? null,
    job_id: r.jobId ?? null,
    session_id: r.sessionId ?? null,
    teammate_id: r.teammateId ?? null,
    user_id: r.userId ?? null,
    attempt_no: Math.max(1, Math.floor(r.attemptNo ?? 1)),
    fallback_reason: r.fallbackReason ?? null,
    input_tokens: tokenCount(u?.inputTokens),
    output_tokens: tokenCount(u?.outputTokens),
    cache_read_tokens: tokenCount(u?.cacheReadTokens),
    cache_write_tokens: tokenCount(u?.cacheWriteTokens),
    cost_micro_usd: r.costMicroUsd,
    cost_source: r.costSource,
    reserved_micro_usd: r.reservedMicroUsd ?? null,
    latency_ms: r.latencyMs === null ? null : Math.max(0, Math.round(r.latencyMs)),
    outcome: r.outcome,
    error_code: r.errorCode ?? null,
    expires_at: r.expiresAt ? r.expiresAt.toISOString() : null,
  };
  return COLUMNS.map((c) => values[c]);
}

const INSERT_INTO = `INSERT INTO ai_usage_events (${COLUMNS.join(", ")})`;
const PLACEHOLDERS = COLUMNS.map(() => "?").join(", ");

/** The INSERT for one model call's row. It never runs it: see recordModelCall. */
export function modelCallInsert(r: ModelCallRecord): InStatement {
  return { sql: `${INSERT_INTO} VALUES (${PLACEHOLDERS})`, args: rowValues(r) };
}

/**
 * Write one model call's row. Never throws into the caller (its model call
 * already happened): a row that cannot be written is logged loudly, with every
 * field but the content (there is none in the row). Returns whether it landed.
 */
export async function recordModelCall(r: ModelCallRecord, db?: Client): Promise<boolean> {
  try {
    await (db ?? getTursoClient()).execute(modelCallInsert(r));
    return true;
  } catch (err) {
    logUnrecorded(r, err);
    return false;
  }
}

function logUnrecorded(r: ModelCallRecord, err: unknown): void {
  console.error("[ai/usage] could not record a model call", {
    tenantId: r.tenantId,
    surface: r.surface,
    provider: r.provider,
    model: r.model,
    outcome: r.outcome,
    errorCode: r.errorCode ?? null,
    costMicroUsd: r.costMicroUsd,
    jobId: r.jobId ?? null,
    error: err instanceof Error ? err.message : String(err),
  });
}

/** The subscription router's rows (surface infer:<source>) are the only ones kept one per job. */
const INFER_JOB_ROW = `surface LIKE 'infer:%' AND job_id = ? AND tenant_id = ?`;

/**
 * Record a subscription-router request that waited on queued job `r.jobId`:
 * ONE row per job, however many calls wait on it. The call that queued the job
 * writes the row; a later call that adopts or collects the same job writes
 * nothing new, and when the row still says `timeout` (the first call stopped
 * waiting) the later call's end resolves it to ok or error, with the latency
 * from the row's occurred_at. A job with no row yet (queued before this ledger
 * existed) gets its row from whichever call sees it first. Never throws.
 */
export async function recordJobModelCall(r: ModelCallRecord & { jobId: string }, db?: Client): Promise<boolean> {
  try {
    const now = new Date(r.occurredAt.getTime() + Math.max(0, r.latencyMs ?? 0)).toISOString();
    const statements: InStatement[] = [
      {
        sql: `${INSERT_INTO} SELECT ${PLACEHOLDERS}
              WHERE NOT EXISTS (SELECT 1 FROM ai_usage_events WHERE ${INFER_JOB_ROW})`,
        args: [...rowValues(r), r.jobId, r.tenantId],
      },
    ];
    if (r.outcome !== "timeout") {
      statements.push({
        sql: `UPDATE ai_usage_events
              SET outcome = ?, error_code = ?,
                  latency_ms = MAX(CAST(ROUND((julianday(?) - julianday(occurred_at)) * 86400000) AS INTEGER), 0)
              WHERE ${INFER_JOB_ROW} AND outcome = 'timeout'`,
        args: [r.outcome, r.errorCode ?? null, now, r.jobId, r.tenantId],
      });
    }
    await (db ?? getTursoClient()).batch(statements, "write");
    return true;
  } catch (err) {
    logUnrecorded(r, err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

export type BudgetRow = { capMicroUsd: number; reservedMicroUsd: number; spentMicroUsd: number };
export type BudgetReservation = { tenantId: string; periodMonth: string; amountMicroUsd: number; eventId: string };

/**
 * The tenant's budget for `periodMonth`: the month's own row, or, when it has
 * none, the cap of the latest earlier row with nothing reserved or spent against
 * it yet (a cap stands until it is changed). null: no cap (no row at all, or a
 * NULL cap).
 */
export async function readBudget(db: Client, tenantId: string, periodMonth: string): Promise<BudgetRow | null> {
  const rs = await db.execute({
    sql: `SELECT period_month, cap_micro_usd, reserved_micro_usd, spent_micro_usd FROM tenant_ai_budgets
          WHERE tenant_id = ? AND period_month <= ?
          ORDER BY period_month DESC LIMIT 1`,
    args: [tenantId, periodMonth],
  });
  const r = rs.rows[0];
  if (!r || r.cap_micro_usd === null || r.cap_micro_usd === undefined) return null;
  const own = String(r.period_month) === periodMonth;
  return {
    capMicroUsd: intOr0(r.cap_micro_usd),
    reservedMicroUsd: own ? intOr0(r.reserved_micro_usd) : 0,
    spentMicroUsd: own ? intOr0(r.spent_micro_usd) : 0,
  };
}

/** The month's own row, from the latest earlier cap, when it has none yet. */
function carryCapForward(tenantId: string, periodMonth: string, now: string): InStatement {
  return {
    sql: `INSERT OR IGNORE INTO tenant_ai_budgets
            (tenant_id, period_month, cap_micro_usd, reserved_micro_usd, spent_micro_usd, created_at, updated_at)
          SELECT tenant_id, ?, cap_micro_usd, 0, 0, ?, ? FROM tenant_ai_budgets
          WHERE tenant_id = ? AND period_month < ?
          ORDER BY period_month DESC LIMIT 1`,
    args: [periodMonth, now, now, tenantId, periodMonth],
  };
}

/** The tenant's pending rows past their deadline (their month is their occurred_at's). */
const EXPIRED_PENDING = `e.tenant_id = :tenant AND e.outcome = 'pending' AND e.expires_at <= :now`;

/**
 * Settle every expired reservation of the tenant at its reservation (each in
 * its own month's row), then mark those rows expired. Runs first in every
 * reservation's transaction.
 */
function sweepExpired(tenantId: string, now: string): InStatement[] {
  const expiredInMonth = `(SELECT COALESCE(SUM(e.reserved_micro_usd), 0) FROM ai_usage_events e
                           WHERE ${EXPIRED_PENDING} AND substr(e.occurred_at, 1, 7) = tenant_ai_budgets.period_month)`;
  return [
    {
      sql: `UPDATE tenant_ai_budgets
            SET reserved_micro_usd = MAX(reserved_micro_usd - ${expiredInMonth}, 0),
                spent_micro_usd = spent_micro_usd + ${expiredInMonth},
                updated_at = :now
            WHERE tenant_id = :tenant
              AND EXISTS (SELECT 1 FROM ai_usage_events e
                          WHERE ${EXPIRED_PENDING} AND substr(e.occurred_at, 1, 7) = tenant_ai_budgets.period_month)`,
      args: { tenant: tenantId, now },
    },
    {
      sql: `UPDATE ai_usage_events SET outcome = 'expired', error_code = 'reservation_expired'
            WHERE tenant_id = :tenant AND outcome = 'pending' AND expires_at <= :now`,
      args: { tenant: tenantId, now },
    },
  ];
}

/**
 * Reserve `amountMicroUsd` of the tenant's month for the call `pending`
 * describes, in ONE transaction: carry the cap into the month when it has no
 * row yet, settle the tenant's expired reservations, write the call's pending
 * row only if the amount fits under the cap, and take the reservation only if
 * that row was written. Throws AiBudgetError ai_budget_exhausted when it does
 * not fit (nothing is reserved and no row is written).
 */
export async function reserveBudget(args: {
  pending: ModelCallRecord & { id: string };
  periodMonth: string;
  amountMicroUsd: number;
  now: Date;
  db?: Client;
}): Promise<BudgetReservation> {
  const db = args.db ?? getTursoClient();
  const r = args.pending;
  const amount = Math.max(0, Math.ceil(args.amountMicroUsd));
  const now = args.now.toISOString();
  const row: ModelCallRecord = {
    ...r,
    outcome: "pending",
    reservedMicroUsd: amount,
    expiresAt: new Date(args.now.getTime() + RESERVATION_TTL_MS),
  };
  const results = await db.batch(
    [
      carryCapForward(r.tenantId, args.periodMonth, now),
      ...sweepExpired(r.tenantId, now),
      {
        sql: `${INSERT_INTO} SELECT ${PLACEHOLDERS}
              WHERE EXISTS (SELECT 1 FROM tenant_ai_budgets
                            WHERE tenant_id = ? AND period_month = ? AND cap_micro_usd IS NOT NULL
                              AND spent_micro_usd + reserved_micro_usd + ? <= cap_micro_usd)`,
        args: [...rowValues(row), r.tenantId, args.periodMonth, amount],
      },
      {
        sql: `UPDATE tenant_ai_budgets SET reserved_micro_usd = reserved_micro_usd + ?, updated_at = ?
              WHERE tenant_id = ? AND period_month = ?
                AND EXISTS (SELECT 1 FROM ai_usage_events WHERE id = ? AND tenant_id = ? AND outcome = 'pending')`,
        args: [amount, now, r.tenantId, args.periodMonth, r.id, r.tenantId],
      },
    ],
    "write",
  );
  // [carry, sweep budgets, sweep rows, pending row, reservation]
  if (results[3].rowsAffected !== 1) throw new AiBudgetError(AI_BUDGET_EXHAUSTED);
  return { tenantId: r.tenantId, periodMonth: args.periodMonth, amountMicroUsd: amount, eventId: r.id };
}

/**
 * Settle a reservation and turn its pending row into the call's row, in one
 * transaction. What the month is charged depends on the row as it stands:
 *   - pending: release the reservation, add the real cost (the reservation when
 *     the cost is unknown);
 *   - expired (the sweep already charged the reservation): add the difference
 *     the real cost makes, or nothing when it is still unknown;
 *   - anything else (already finished): nothing. That makes a retry safe.
 */
function settleStatements(res: BudgetReservation, end: ModelCallRecord, now: Date): InStatement[] {
  validateOutcome(end.outcome, end.errorCode);
  const actual = end.costMicroUsd === null ? null : Math.max(0, Math.round(end.costMicroUsd));
  const rowOutcome = `(SELECT outcome FROM ai_usage_events WHERE id = :id AND tenant_id = :tenant)`;
  const u = end.usage ?? null;
  return [
    {
      sql: `UPDATE tenant_ai_budgets
            SET reserved_micro_usd = MAX(reserved_micro_usd - (CASE ${rowOutcome} WHEN 'pending' THEN :reserved ELSE 0 END), 0),
                spent_micro_usd = MAX(spent_micro_usd + (CASE ${rowOutcome} WHEN 'pending' THEN :spent WHEN 'expired' THEN :late ELSE 0 END), 0),
                updated_at = :now
            WHERE tenant_id = :tenant AND period_month = :period`,
      args: {
        id: res.eventId,
        tenant: res.tenantId,
        period: res.periodMonth,
        reserved: res.amountMicroUsd,
        spent: actual ?? res.amountMicroUsd,
        late: actual === null ? 0 : actual - res.amountMicroUsd,
        now: now.toISOString(),
      },
    },
    {
      sql: `UPDATE ai_usage_events
            SET input_tokens = :input, output_tokens = :output, cache_read_tokens = :cacheRead, cache_write_tokens = :cacheWrite,
                cost_micro_usd = :cost, cost_source = :source, latency_ms = :latency, outcome = :outcome,
                error_code = :errorCode, expires_at = NULL
            WHERE id = :id AND tenant_id = :tenant AND outcome IN ('pending', 'expired')`,
      args: {
        id: res.eventId,
        tenant: res.tenantId,
        input: tokenCount(u?.inputTokens),
        output: tokenCount(u?.outputTokens),
        cacheRead: tokenCount(u?.cacheReadTokens),
        cacheWrite: tokenCount(u?.cacheWriteTokens),
        cost: end.costMicroUsd,
        source: end.costSource,
        latency: end.latencyMs === null ? null : Math.max(0, Math.round(end.latencyMs)),
        outcome: end.outcome,
        errorCode: end.errorCode ?? null,
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// The meter
// ---------------------------------------------------------------------------

/**
 * A meter for the model calls one request (a chat turn, a job step, a probe)
 * makes for one tenant. Refuses to exist without a tenant: there is no default.
 */
export function modelCallMeter(context: ModelCallContext, opts: { db?: Client } = {}): ModelCallMeter {
  if (typeof context.tenantId !== "string" || !context.tenantId.trim()) {
    throw new Error("ai_usage: a model call needs the tenant it is for (from the session or the job)");
  }
  if (!isUsageSurface(context.surface)) throw new Error(`ai_usage: unknown surface ${JSON.stringify(context.surface)}`);
  const ctx: Readonly<ModelCallContext> = Object.freeze({ ...context });
  const totals: MeterTotals = { calls: 0, costMicroUsd: 0, unknownCostCalls: 0 };
  const client = () => opts.db ?? getTursoClient();

  const tally = (cost: number | null) => {
    totals.calls += 1;
    if (cost === null) totals.unknownCostCalls += 1;
    else totals.costMicroUsd += cost;
  };

  return {
    context: ctx,
    totals: () => ({ ...totals }),
    async begin(call: BeginCall): Promise<ModelCall> {
      const occurredAt = new Date();
      const started = Date.now();
      const period = periodMonthOf(occurredAt);
      const id = newLedgerId(occurredAt.getTime());
      const base = {
        ...ctx,
        id,
        occurredAt,
        provider: call.provider,
        model: call.model,
        attemptNo: call.attemptNo,
        fallbackReason: call.fallbackReason ?? null,
      };

      let db: Client | undefined = opts.db;
      let prices: PriceRow[] = [];
      let reservation: BudgetReservation | null = null;
      // A flat plan or the tenant's own machine: nothing to price, nothing to
      // cap, so nothing is read before the call (the row is still written).
      if (isMetered(ctx.billingMode)) {
        try {
          const d = client();
          db = d;
          let notInstalled: unknown = null;
          const orNotInstalled = <T>(fallback: T) => (err: unknown): T => {
            if (!isLedgerNotInstalled(err)) throw err;
            notInstalled = err;
            return fallback;
          };
          const [p, budget] = await Promise.all([
            pricesFor(d, call.provider, call.model, occurredAt).catch(orNotInstalled<PriceRow[]>([])),
            readBudget(d, ctx.tenantId, period).catch(orNotInstalled<BudgetRow | null>(null)),
          ]);
          if (notInstalled) {
            logLedgerNotInstalled("the model call", { tenantId: ctx.tenantId, surface: ctx.surface, provider: call.provider, model: call.model }, notInstalled);
          }
          prices = p;
          if (budget) {
            const worst = worstCaseMicroUsd(p, call.promptBytes, call.maxOutputTokens);
            if (worst === null) throw new AiBudgetError(AI_BUDGET_UNPRICED_MODEL);
            reservation = await reserveBudget({
              db: d,
              pending: { ...base, costMicroUsd: null, costSource: null, latencyMs: null, outcome: "pending" },
              periodMonth: period,
              amountMicroUsd: worst,
              now: occurredAt,
            });
          }
        } catch (err) {
          if (err instanceof AiBudgetError) {
            console.error("[ai/usage] model call refused at the budget", {
              tenantId: ctx.tenantId,
              surface: ctx.surface,
              provider: call.provider,
              model: call.model,
              code: err.code,
              period,
            });
            // A refused call billed nothing: cost 0 is a known zero.
            await recordModelCall(
              { ...base, costMicroUsd: 0, costSource: "none", latencyMs: Date.now() - started, outcome: "refused", errorCode: err.code },
              opts.db,
            );
            tally(0);
            throw err;
          }
          const detail = err instanceof Error ? err.message : String(err);
          console.error("[ai/usage] budget or prices unreadable; the model call was not sent", {
            tenantId: ctx.tenantId,
            surface: ctx.surface,
            provider: call.provider,
            model: call.model,
            error: detail,
          });
          throw new AiUsageUnavailableError(detail);
        }
      }

      let finished = false;
      return {
        async finish(end: CallEnd): Promise<void> {
          if (finished) return;
          finished = true;
          const cost: { micro: number | null; source: CostSource | null } = end.notBilled
            ? { micro: 0, source: "none" }
            : end.usage
              ? costOf(prices, end.usage)
              : { micro: null, source: null };
          const row: ModelCallRecord = {
            ...base,
            usage: end.usage ?? null,
            costMicroUsd: cost.micro,
            costSource: cost.source,
            reservedMicroUsd: reservation?.amountMicroUsd ?? null,
            latencyMs: Date.now() - started,
            outcome: end.outcome,
            errorCode: end.errorCode ?? null,
          };
          tally(cost.micro);
          if (!reservation) {
            await recordModelCall(row, db);
            return;
          }
          // The pending row already exists; settle it. Retried once: the
          // statements are safe to repeat (see settleStatements). If both fail
          // the row stays pending and the next reservation after it expires
          // settles it at the reservation, so the month only over-counts.
          const statements = settleStatements(reservation, row, new Date());
          for (let attempt = 1; attempt <= 2; attempt += 1) {
            try {
              await (db ?? client()).batch(statements, "write");
              return;
            } catch (err) {
              if (attempt === 2) {
                console.error("[ai/usage] could not settle a reserved model call; it stays pending until its reservation expires", {
                  tenantId: ctx.tenantId,
                  surface: ctx.surface,
                  provider: call.provider,
                  model: call.model,
                  eventId: reservation.eventId,
                  reservedMicroUsd: reservation.amountMicroUsd,
                  outcome: end.outcome,
                  costMicroUsd: cost.micro,
                  error: err instanceof Error ? err.message : String(err),
                });
              }
            }
          }
        },
      };
    },
  };
}

/**
 * How a chat route's resolved key is billed: the tenant's own key, OASIS's
 * platform key (verified operator only), or the tenant's own local server.
 */
export function billingForKey(provider: string, keySource: "tenant" | "platform"): { authKind: AuthKind; billingMode: BillingMode } {
  if (provider === "ollama") return { authKind: "local", billingMode: "local" };
  return { authKind: "api_key", billingMode: keySource === "platform" ? "platform" : "byo_key" };
}

// ---------------------------------------------------------------------------
// Read: the future AI brain settings page
// ---------------------------------------------------------------------------

export type DepartmentUsage = {
  /** null: calls no department made (a direct chat, a probe, a background job). */
  departmentKey: string | null;
  calls: number;
  costMicroUsd: number;
  unknownCostCalls: number;
};

export type UsageSummary = {
  tenantId: string;
  periodMonth: string;
  /** Every recorded call in the month, refused and in-flight ones included. */
  calls: number;
  /** Sum of the KNOWN costs. Read it next to unknownCostCalls: never "$0" when costs are unknown. */
  costMicroUsd: number;
  /** Finished per-token billed calls (byo_key / platform / managed) whose cost is unknown. */
  unknownCostCalls: number;
  /** Subscription and local calls: no per-call price, not an unknown. */
  flatRateCalls: number;
  refusedCalls: number;
  /** Reserved calls still in flight: not finished, so neither known nor unknown yet. */
  pendingCalls: number;
  byDepartment: DepartmentUsage[];
  /** The month's cap (carried forward when the month has no row of its own), or null: no cap. */
  budget: BudgetRow | null;
};

/** One tenant's AI usage for one UTC month ('YYYY-MM'). */
export async function usageFor(tenantId: string, periodMonth: string, db: Client = getTursoClient()): Promise<UsageSummary> {
  if (typeof tenantId !== "string" || !tenantId.trim()) throw new Error("ai_usage: usageFor needs a tenant");
  const { from, to } = periodBounds(periodMonth);
  const metered = METERED_BILLING_MODES.map(() => "?").join(", ");
  const [rs, budget] = await Promise.all([
    db.execute({
      sql: `SELECT department_key,
                   COUNT(*) AS calls,
                   COALESCE(SUM(cost_micro_usd), 0) AS cost,
                   SUM(CASE WHEN cost_micro_usd IS NULL AND outcome <> 'pending' AND billing_mode IN (${metered}) THEN 1 ELSE 0 END) AS unknown_cost,
                   SUM(CASE WHEN billing_mode IN ('subscription', 'local') THEN 1 ELSE 0 END) AS flat_rate,
                   SUM(CASE WHEN outcome = 'refused' THEN 1 ELSE 0 END) AS refused,
                   SUM(CASE WHEN outcome = 'pending' THEN 1 ELSE 0 END) AS pending
            FROM ai_usage_events
            WHERE tenant_id = ? AND occurred_at >= ? AND occurred_at < ?
            GROUP BY department_key
            ORDER BY department_key`,
      args: [...METERED_BILLING_MODES, tenantId, from, to],
    }),
    readBudget(db, tenantId, periodMonth),
  ]);
  const byDepartment: DepartmentUsage[] = [];
  let calls = 0;
  let cost = 0;
  let unknown = 0;
  let flat = 0;
  let refused = 0;
  let pending = 0;
  for (const r of rs.rows) {
    const d: DepartmentUsage = {
      departmentKey: r.department_key === null || r.department_key === undefined ? null : String(r.department_key),
      calls: intOr0(r.calls),
      costMicroUsd: intOr0(r.cost),
      unknownCostCalls: intOr0(r.unknown_cost),
    };
    byDepartment.push(d);
    calls += d.calls;
    cost += d.costMicroUsd;
    unknown += d.unknownCostCalls;
    flat += intOr0(r.flat_rate);
    refused += intOr0(r.refused);
    pending += intOr0(r.pending);
  }
  return {
    tenantId,
    periodMonth,
    calls,
    costMicroUsd: cost,
    unknownCostCalls: unknown,
    flatRateCalls: flat,
    refusedCalls: refused,
    pendingCalls: pending,
    byDepartment,
    budget,
  };
}

/**
 * The 402 a JSON route answers a budget refusal with. `error` carries the
 * owner's sentence (what the chat widget shows), `code` the machine code.
 */
export function budgetRefusalResponse(code: AiBudgetCode): Response {
  const sentence = AI_BUDGET_SENTENCES[code];
  return new Response(JSON.stringify({ ok: false, error: sentence, code, message: sentence }), {
    status: 402,
    headers: { "content-type": "application/json" },
  });
}

/** The 503 a JSON route answers when the budget could not be read, in the same shape. */
export function usageUnavailableResponse(): Response {
  return new Response(
    JSON.stringify({ ok: false, error: AI_USAGE_UNAVAILABLE_SENTENCE, code: AI_USAGE_UNAVAILABLE, message: AI_USAGE_UNAVAILABLE_SENTENCE }),
    { status: 503, headers: { "content-type": "application/json" } },
  );
}

/**
 * The route-level check before a stream opens, so a tenant already AT its cap
 * gets an HTTP 402 instead of a 200 stream carrying an error. It reserves
 * nothing: every call still reserves for itself in begin(). Returns the code
 * when the month has no headroom left, null otherwise: no cap, a flat-rate
 * billing mode (a cap never applies to it), or the ledger not installed yet.
 * Throws when a budget table that exists cannot be read.
 */
export async function budgetExhaustedBeforeStream(
  tenantId: string,
  billingMode: BillingMode,
  at: Date = new Date(),
  db?: Client,
): Promise<AiBudgetCode | null> {
  if (!isMetered(billingMode)) return null;
  let b: BudgetRow | null;
  try {
    b = await readBudget(db ?? getTursoClient(), tenantId, periodMonthOf(at));
  } catch (err) {
    if (!isLedgerNotInstalled(err)) throw err;
    logLedgerNotInstalled("the pre-stream budget check", { tenantId }, err);
    return null;
  }
  if (!b) return null;
  return b.spentMicroUsd + b.reservedMicroUsd >= b.capMicroUsd ? AI_BUDGET_EXHAUSTED : null;
}
