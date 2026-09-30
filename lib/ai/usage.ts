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
 * the call's ai_usage_events row and settles the reservation in ONE batch.
 * tests/ai-usage-no-unmetered-calls.test.ts fails if a file outside its
 * allow-list names a provider endpoint or SDK, and each allow-listed file must
 * take its meter from here.
 *
 * BUDGETS (tenant_ai_budgets, one row per tenant per UTC month).
 *   - NO ROW = NO CAP. That is explicit, not a fallback: a tenant is uncapped
 *     until an owner or OASIS writes a row for the month. Its calls are still
 *     recorded.
 *   - Reserve before: the worst case is the request's prompt, counted as its
 *     UTF-8 byte length (byte-level BPE never makes more tokens than bytes, so
 *     for text this is an upper bound; an attached PDF or image is an estimate),
 *     priced at the higher of the input and cache-write rates, plus
 *     maxOutputTokens at the output rate. `UPDATE ... WHERE spent + reserved +
 *     worst <= cap` either takes the reservation or refuses the call, so two
 *     concurrent calls can never both slip under the cap. Every call in a tool
 *     loop reserves for itself; one reservation never covers a loop.
 *   - Settle after: release the reservation and add the real cost. A cost that
 *     is unknown (the stream broke off before the provider reported its usage)
 *     settles at the reservation, so an unknown can only over-count.
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
 * FAILURES. begin() fails CLOSED when it cannot read the budget or the prices
 * (ai_usage_unavailable): a cap it cannot read is a cap it cannot enforce.
 * finish() never throws into the caller, whose model call already happened; a
 * row that cannot be written is logged loudly with everything but the content.
 */
import "server-only";
import type { Client, InStatement, InValue } from "@libsql/client";
import { getTursoClient } from "@/lib/turso";
import { newLedgerId } from "@/lib/ledger/emit";
import {
  AI_BUDGET_EXHAUSTED,
  AI_BUDGET_SENTENCES,
  AI_BUDGET_UNPRICED_MODEL,
  AI_USAGE_UNAVAILABLE,
  type AiBudgetCode,
} from "@/lib/ai/usage-codes";

export {
  AI_BUDGET_EXHAUSTED,
  AI_BUDGET_SENTENCES,
  AI_BUDGET_UNPRICED_MODEL,
  AI_USAGE_UNAVAILABLE,
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
/** Billed per token: a NULL cost here is an unknown, not a flat rate. */
export const METERED_BILLING_MODES: readonly BillingMode[] = ["byo_key", "platform", "managed"];

export const USAGE_OUTCOMES = ["ok", "error", "refused", "timeout", "cancelled"] as const;
export type UsageOutcome = (typeof USAGE_OUTCOMES)[number];

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
// Budgets
// ---------------------------------------------------------------------------

export type BudgetRow = { capMicroUsd: number; reservedMicroUsd: number; spentMicroUsd: number };
export type BudgetReservation = { tenantId: string; periodMonth: string; amountMicroUsd: number };

export async function readBudget(db: Client, tenantId: string, periodMonth: string): Promise<BudgetRow | null> {
  const rs = await db.execute({
    sql: `SELECT cap_micro_usd, reserved_micro_usd, spent_micro_usd FROM tenant_ai_budgets
          WHERE tenant_id = ? AND period_month = ?`,
    args: [tenantId, periodMonth],
  });
  const r = rs.rows[0];
  if (!r) return null;
  return {
    capMicroUsd: intOr0(r.cap_micro_usd),
    reservedMicroUsd: intOr0(r.reserved_micro_usd),
    spentMicroUsd: intOr0(r.spent_micro_usd),
  };
}

/**
 * Reserve `amountMicroUsd` of the tenant's month before a call.
 *   - no budget row for the month → null: NO CAP, nothing reserved;
 *   - a row and no price (amount null) → AiBudgetError ai_budget_unpriced_model;
 *   - a row the amount does not fit under → AiBudgetError ai_budget_exhausted.
 * `known` is the row the caller already read (undefined: read it here).
 */
export async function reserveBudget(args: {
  tenantId: string;
  periodMonth: string;
  amountMicroUsd: number | null;
  known?: BudgetRow | null;
  now?: Date;
  db?: Client;
}): Promise<BudgetReservation | null> {
  const db = args.db ?? getTursoClient();
  const budget = args.known === undefined ? await readBudget(db, args.tenantId, args.periodMonth) : args.known;
  if (!budget) return null;
  if (args.amountMicroUsd === null) throw new AiBudgetError(AI_BUDGET_UNPRICED_MODEL);
  const amount = Math.max(0, Math.ceil(args.amountMicroUsd));
  const rs = await db.execute({
    sql: `UPDATE tenant_ai_budgets
          SET reserved_micro_usd = reserved_micro_usd + ?, updated_at = ?
          WHERE tenant_id = ? AND period_month = ?
            AND spent_micro_usd + reserved_micro_usd + ? <= cap_micro_usd`,
    args: [amount, (args.now ?? new Date()).toISOString(), args.tenantId, args.periodMonth, amount],
  });
  if (rs.rowsAffected !== 1) throw new AiBudgetError(AI_BUDGET_EXHAUSTED);
  return { tenantId: args.tenantId, periodMonth: args.periodMonth, amountMicroUsd: amount };
}

/**
 * Settle a reservation: release it and add the real cost. An unknown cost
 * (null) settles at the reservation, so an unknown only ever over-counts.
 */
export function settleBudgetStatement(r: BudgetReservation, actualMicroUsd: number | null, now: Date = new Date()): InStatement {
  const spent = actualMicroUsd === null ? r.amountMicroUsd : Math.max(0, Math.round(actualMicroUsd));
  return {
    sql: `UPDATE tenant_ai_budgets
          SET reserved_micro_usd = MAX(reserved_micro_usd - ?, 0), spent_micro_usd = spent_micro_usd + ?, updated_at = ?
          WHERE tenant_id = ? AND period_month = ?`,
    args: [r.amountMicroUsd, spent, now.toISOString(), r.tenantId, r.periodMonth],
  };
}

export async function settleBudget(r: BudgetReservation, actualMicroUsd: number | null, db: Client = getTursoClient()): Promise<void> {
  await db.execute(settleBudgetStatement(r, actualMicroUsd));
}

// ---------------------------------------------------------------------------
// The row
// ---------------------------------------------------------------------------

export type ModelCallRecord = ModelCallContext & {
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
  outcome: UsageOutcome;
  errorCode?: string | null;
};

const COLUMNS = [
  "id", "tenant_id", "occurred_at", "provider", "model", "surface", "auth_kind", "billing_mode",
  "department_key", "job_id", "session_id", "teammate_id", "user_id", "attempt_no", "fallback_reason",
  "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "cost_micro_usd", "cost_source",
  "reserved_micro_usd", "latency_ms", "outcome", "error_code",
] as const;

const CODE_RE = /^[a-z][a-z0-9_.:-]{0,79}$/;

function validateRecord(r: ModelCallRecord): void {
  if (typeof r.tenantId !== "string" || !r.tenantId.trim()) throw new Error("ai_usage: a model call row needs a tenant");
  if (!isUsageSurface(r.surface)) throw new Error(`ai_usage: unknown surface ${JSON.stringify(r.surface)}`);
  if (!(AUTH_KINDS as readonly string[]).includes(r.authKind)) throw new Error(`ai_usage: unknown auth_kind ${r.authKind}`);
  if (!(BILLING_MODES as readonly string[]).includes(r.billingMode)) throw new Error(`ai_usage: unknown billing_mode ${r.billingMode}`);
  if (!(USAGE_OUTCOMES as readonly string[]).includes(r.outcome)) throw new Error(`ai_usage: unknown outcome ${r.outcome}`);
  if (!r.provider || !r.model) throw new Error("ai_usage: a model call row names its provider and model");
  if (r.errorCode != null && !CODE_RE.test(r.errorCode)) throw new Error(`ai_usage: error_code must be a code, got ${JSON.stringify(r.errorCode)}`);
}

/** The INSERT for one model call's row. It never runs it: see recordModelCall. */
export function modelCallInsert(r: ModelCallRecord): InStatement {
  validateRecord(r);
  const u = r.usage ?? null;
  const values: Record<(typeof COLUMNS)[number], InValue> = {
    id: newLedgerId(r.occurredAt.getTime()),
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
  };
  return {
    sql: `INSERT INTO ai_usage_events (${COLUMNS.join(", ")}) VALUES (${COLUMNS.map(() => "?").join(", ")})`,
    args: COLUMNS.map((c) => values[c]),
  };
}

/**
 * Write one model call's row. Never throws into the caller (its model call
 * already happened): a row that cannot be written is logged loudly, with every
 * field but the content (there is none in the row). Returns whether it landed.
 */
export async function recordModelCall(r: ModelCallRecord, extra: InStatement[] = [], db?: Client): Promise<boolean> {
  try {
    const client = db ?? getTursoClient();
    await client.batch([modelCallInsert(r), ...extra], "write");
    return true;
  } catch (err) {
    console.error("[ai/usage] could not record a model call", {
      tenantId: r.tenantId,
      surface: r.surface,
      provider: r.provider,
      model: r.model,
      outcome: r.outcome,
      errorCode: r.errorCode ?? null,
      costMicroUsd: r.costMicroUsd,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
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
      const base = {
        ...ctx,
        occurredAt,
        provider: call.provider,
        model: call.model,
        attemptNo: call.attemptNo,
        fallbackReason: call.fallbackReason ?? null,
      };

      let db: Client;
      let prices: PriceRow[];
      let reservation: BudgetReservation | null = null;
      try {
        db = client();
        const [p, budget] = await Promise.all([
          pricesFor(db, call.provider, call.model, occurredAt),
          readBudget(db, ctx.tenantId, period),
        ]);
        prices = p;
        if (budget) {
          const worst = worstCaseMicroUsd(p, call.promptBytes, call.maxOutputTokens);
          reservation = await reserveBudget({
            db,
            tenantId: ctx.tenantId,
            periodMonth: period,
            amountMicroUsd: worst,
            known: budget,
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
            [],
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
          const extra = reservation ? [settleBudgetStatement(reservation, cost.micro)] : [];
          await recordModelCall(
            {
              ...base,
              usage: end.usage ?? null,
              costMicroUsd: cost.micro,
              costSource: cost.source,
              reservedMicroUsd: reservation?.amountMicroUsd ?? null,
              latencyMs: Date.now() - started,
              outcome: end.outcome,
              errorCode: end.errorCode ?? null,
            },
            extra,
            db,
          );
          tally(cost.micro);
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
  /** Every recorded call in the month, refused ones included. */
  calls: number;
  /** Sum of the KNOWN costs. Read it next to unknownCostCalls: never "$0" when costs are unknown. */
  costMicroUsd: number;
  /** Per-token billed calls (byo_key / platform / managed) whose cost is unknown. */
  unknownCostCalls: number;
  /** Subscription and local calls: no per-call price, not an unknown. */
  flatRateCalls: number;
  refusedCalls: number;
  byDepartment: DepartmentUsage[];
  /** The month's cap, or null: no cap. */
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
                   SUM(CASE WHEN cost_micro_usd IS NULL AND billing_mode IN (${metered}) THEN 1 ELSE 0 END) AS unknown_cost,
                   SUM(CASE WHEN billing_mode IN ('subscription', 'local') THEN 1 ELSE 0 END) AS flat_rate,
                   SUM(CASE WHEN outcome = 'refused' THEN 1 ELSE 0 END) AS refused
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
  }
  return {
    tenantId,
    periodMonth,
    calls,
    costMicroUsd: cost,
    unknownCostCalls: unknown,
    flatRateCalls: flat,
    refusedCalls: refused,
    byDepartment,
    budget,
  };
}

/** The 402 a JSON route answers a budget refusal with. */
export function budgetRefusalResponse(code: AiBudgetCode): Response {
  return new Response(JSON.stringify({ ok: false, error: code, code, message: AI_BUDGET_SENTENCES[code] }), {
    status: 402,
    headers: { "content-type": "application/json" },
  });
}

/**
 * The route-level check before a stream opens, so a tenant already AT its cap
 * gets an HTTP 402 instead of a 200 stream carrying an error. It reserves
 * nothing: every call still reserves for itself in begin(). Returns the code
 * when the month has no headroom left, null otherwise (no row = no cap).
 */
export async function budgetExhaustedBeforeStream(tenantId: string, at: Date = new Date(), db: Client = getTursoClient()): Promise<AiBudgetCode | null> {
  const b = await readBudget(db, tenantId, periodMonthOf(at));
  if (!b) return null;
  return b.spentMicroUsd + b.reservedMicroUsd >= b.capMicroUsd ? AI_BUDGET_EXHAUSTED : null;
}
