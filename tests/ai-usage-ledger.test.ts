/**
 * ai-usage-ledger.test.ts — every model call writes exactly one
 * ai_usage_events row, costs are real or NULL (never guessed), and the monthly
 * AI budget reserves before and settles after, refusing at the cap.
 *
 * WHY (OASIS OS plan v2 §F2.6, docs/os-revamp/03-connectors-ai-finance.md
 * §d.3). Nothing metered a model call: 16 lifetime chat sessions recorded $0,
 * and /api/chat priced turns from a hardcoded table that was already wrong. The
 * failures that matter are silent:
 *   - a call with no row (spend nobody sees), or two rows for one call;
 *   - an unknown cost written as 0, or a price nobody can trace;
 *   - a cap two concurrent calls both slip under, a cap an unknown cost walks
 *     past, or a cap that quietly swaps in a cheaper model;
 *   - a row filed under the wrong tenant, or under none.
 * Each is driven here against REAL libSQL (a temp file with bravo__192 applied
 * through the same BEGIN/END-aware split scripts/apply_turso_migration.py uses)
 * and the real call sites, with only the provider's HTTP stubbed.
 * The lint half (no call site bypasses the meter) is
 * tests/ai-usage-no-unmetered-calls.test.ts.
 *
 * Run: node --conditions=react-server --import tsx tests/ai-usage-ledger.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, type Client } from "@libsql/client";

const ROOT = process.cwd();
const dbFile = join(mkdtempSync(join(tmpdir(), "ai-usage-ledger-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
for (const key of Object.keys(process.env)) {
  if (key.startsWith("BRIDGE_")) delete process.env[key];
}

const OASIS = "ef8d389e-3f15-43f2-ae00-3660f69a1452"; // oasis-ai-cc
const CLIENT = "6b6b6b6b-0000-4000-8000-00000000006b"; // a client workspace
const CAPPED = "7c7c7c7c-0000-4000-8000-00000000007c"; // a client workspace with a monthly cap
const USER = "0f000000-0000-4000-8000-000000000001";

let failures = 0;
let passed = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${((e as Error).stack || (e as Error).message).split("\n").slice(0, 8).join("\n        ")}`);
  }
}

/** scripts/apply_turso_migration.py split_statements, line for line: a trigger body stays one statement. */
function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let buf: string[] = [];
  let depth = 0;
  for (const line of sql.split(/\r?\n/)) {
    const stripped = line.trim();
    if (!stripped || stripped.startsWith("--")) continue;
    buf.push(line);
    const upper = stripped.toUpperCase();
    if (/\bBEGIN\b/.test(upper)) depth += 1;
    if (/\bEND\s*;/.test(upper)) {
      depth = Math.max(0, depth - 1);
      if (depth === 0) {
        out.push(buf.join("\n").trim().replace(/;$/, "").trim());
        buf = [];
        continue;
      }
    }
    if (depth === 0 && stripped.endsWith(";")) {
      out.push(buf.join("\n").trim().replace(/;$/, "").trim());
      buf = [];
    }
  }
  const tail = buf.join("\n").trim().replace(/;$/, "").trim();
  if (tail) out.push(tail);
  return out.filter(Boolean);
}
const USAGE_SQL = readFileSync(join(ROOT, "database", "turso", "bravo__192_ai_usage.sql"), "utf8");

// ── provider stub ─────────────────────────────────────────────────────────
type Sent = { url: string; body: string };
let sent: Sent[] = [];
let script: Array<(s: Sent) => Response | Promise<Response>> = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const s = { url: String(input instanceof Request ? input.url : input), body: String(init?.body ?? "") };
  sent.push(s);
  const next = script.shift();
  assert.ok(next, `unscripted network call to ${s.url}`);
  return next(s);
}) as typeof fetch;
function play(...responses: Array<Response | ((s: Sent) => Response | Promise<Response>)>) {
  sent = [];
  script = responses.map((r) => (typeof r === "function" ? r : () => r));
}

function sseBody(frames: Array<[string | null, unknown]>): string {
  return frames.map(([e, d]) => `${e ? `event: ${e}\n` : ""}data: ${typeof d === "string" ? d : JSON.stringify(d)}\n\n`).join("");
}
const sse = (frames: Array<[string | null, unknown]>) =>
  new Response(sseBody(frames), { status: 200, headers: { "content-type": "text/event-stream" } });
/** A stream that sends `frames` and then errors (the connection dropped). */
function brokenSse(frames: Array<[string | null, unknown]>): Response {
  const bytes = new TextEncoder().encode(sseBody(frames));
  let sentOnce = false;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sentOnce) {
          sentOnce = true;
          controller.enqueue(bytes);
        } else controller.error(new Error("connection reset"));
      },
    }),
    { status: 200 },
  );
}
const anthropicStream = (text: string, usage: { input: number; output: number; cacheRead?: number; cacheWrite?: number }, stop = "end_turn") =>
  sse([
    ["message_start", { message: { usage: { input_tokens: usage.input, output_tokens: 1, cache_read_input_tokens: usage.cacheRead ?? 0, cache_creation_input_tokens: usage.cacheWrite ?? 0 } } }],
    ["content_block_start", { index: 0, content_block: { type: "text" } }],
    ["content_block_delta", { index: 0, delta: { type: "text_delta", text } }],
    ["content_block_stop", { index: 0 }],
    ["message_delta", { delta: { stop_reason: stop }, usage: { output_tokens: usage.output } }],
    ["message_stop", {}],
  ]);
const anthropicToolUse = (name: string, usage: { input: number; output: number }) =>
  sse([
    ["message_start", { message: { usage: { input_tokens: usage.input, output_tokens: 1 } } }],
    ["content_block_start", { index: 0, content_block: { type: "tool_use", id: `tu_${name}`, name } }],
    ["content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: "{}" } }],
    ["content_block_stop", { index: 0 }],
    ["message_delta", { delta: { stop_reason: "tool_use" }, usage: { output_tokens: usage.output } }],
    ["message_stop", {}],
  ]);
const openAIStream = (text: string, usage: Record<string, unknown>) =>
  sse([
    [null, { choices: [{ delta: { content: text } }] }],
    [null, { choices: [{ delta: {}, finish_reason: "stop" }] }],
    [null, { choices: [], usage }],
    [null, "[DONE]"],
  ]);

type Row = Record<string, unknown>;
async function rows(db: Client, where = "1", args: (string | number)[] = []): Promise<Row[]> {
  return (await db.execute({ sql: `SELECT * FROM ai_usage_events WHERE ${where} ORDER BY id`, args })).rows as unknown as Row[];
}
async function count(db: Client, sql: string, args: (string | number)[] = []): Promise<number> {
  return Number((await db.execute({ sql, args })).rows[0]?.n ?? 0);
}

async function main() {
  const db = createClient({ url: `file:${dbFile}` });
  const statements = splitStatements(USAGE_SQL);
  for (const s of statements) await db.execute(s);

  const usage = await import("../lib/ai/usage");
  const codes = await import("../lib/ai/usage-codes");
  const { streamChat, PROVIDER_REGISTRY } = await import("../lib/providers");
  const runner = await import("../lib/cloud-tool-runner");
  const probe = await import("../lib/agents/provider-probe");
  const extractor = await import("../lib/ai-document-extractor");
  const outcome = await import("../lib/os/channel/outcome");
  const { operatorPlatformFallback } = await import("../lib/operator-credentials");

  const period = usage.periodMonthOf(new Date());
  const meter = (over: Partial<import("../lib/ai/usage").ModelCallContext> = {}) =>
    usage.modelCallMeter({ tenantId: CLIENT, surface: "chat.stream", authKind: "api_key", billingMode: "byo_key", userId: USER, ...over });
  async function drain<T>(gen: AsyncGenerator<T>): Promise<T[]> {
    const out: T[] = [];
    for await (const ev of gen) out.push(ev);
    return out;
  }
  const chat = (provider: import("../lib/providers").Provider, model: string, m = meter(), maxTokens = 4096) =>
    drain(streamChat({ provider, model, apiKey: provider === "ollama" ? "" : "k", baseUrl: provider === "ollama" ? "http://127.0.0.1:11434/v1" : undefined, system: "s", messages: [{ role: "user", content: "hello" }], maxTokens, meter: m }));
  /** The rows written since `mark`. */
  const newRows = async (mark: number) => (await rows(db)).slice(mark);
  const total = async () => (await rows(db)).length;
  const setBudget = async (tenant: string, cap: number, spent = 0, reserved = 0) => {
    const now = new Date().toISOString();
    await db.execute({
      sql: `INSERT INTO tenant_ai_budgets (tenant_id, period_month, cap_micro_usd, reserved_micro_usd, spent_micro_usd, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (tenant_id, period_month) DO UPDATE SET cap_micro_usd = excluded.cap_micro_usd,
              reserved_micro_usd = excluded.reserved_micro_usd, spent_micro_usd = excluded.spent_micro_usd`,
      args: [tenant, period, cap, reserved, spent, now, now],
    });
  };
  const budget = async (tenant: string) => usage.readBudget(db, tenant, period);
  const prices = (provider: string, model: string) => usage.pricesFor(db, provider, model, new Date());

  // ── 1. Migration ─────────────────────────────────────────────────────────
  console.log("migration");
  await check("bravo__192 creates the three tables; tenant tables are tenant-first; re-running is a no-op", async () => {
    for (const t of ["ai_usage_events", "model_prices", "tenant_ai_budgets"]) {
      assert.equal(await count(db, "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?", [t]), 1, t);
    }
    for (const table of ["ai_usage_events", "tenant_ai_budgets"]) {
      const cols = (await db.execute(`PRAGMA table_info(${table})`)).rows;
      assert.equal(Number(cols.find((c) => c.name === "tenant_id")?.notnull), 1, `${table}.tenant_id NOT NULL`);
      // ai_usage_events' own primary key is its ULID id; tenant_ai_budgets'
      // primary key IS (tenant_id, period_month), so it is checked too.
      const idx = (await db.execute(`PRAGMA index_list(${table})`)).rows.filter(
        (i) => !(table === "ai_usage_events" && String(i.name).startsWith("sqlite_autoindex")),
      );
      assert.ok(idx.length > 0, `${table} has indexes`);
      for (const i of idx) {
        const first = (await db.execute(`PRAGMA index_info(${String(i.name)})`)).rows.find((c) => Number(c.seqno) === 0);
        assert.equal(first?.name, "tenant_id", `${table}.${String(i.name)} leads with tenant_id`);
      }
    }
    const priceRows = await count(db, "SELECT COUNT(*) AS n FROM model_prices");
    for (const s of statements) await db.execute(s);
    assert.equal(await count(db, "SELECT COUNT(*) AS n FROM model_prices"), priceRows, "re-running rewrote prices");
  });

  await check("a row never changes tenant (ai_usage_events and tenant_ai_budgets)", async () => {
    await usage.recordModelCall({ tenantId: OASIS, surface: "probe", authKind: "api_key", billingMode: "byo_key", occurredAt: new Date(), provider: "anthropic", model: "m", costMicroUsd: 0, costSource: "none", latencyMs: 1, outcome: "ok" });
    await assert.rejects(db.execute({ sql: "UPDATE ai_usage_events SET tenant_id = ? WHERE tenant_id = ?", args: [CLIENT, OASIS] }), /immutable/);
    await setBudget(OASIS, 10);
    await assert.rejects(db.execute({ sql: "UPDATE tenant_ai_budgets SET tenant_id = ? WHERE tenant_id = ?", args: [CLIENT, OASIS] }), /immutable/);
    await db.execute({ sql: "DELETE FROM tenant_ai_budgets WHERE tenant_id = ?", args: [OASIS] });
  });

  await check("model_prices holds only traced prices, for exactly the non-OpenRouter models this repo sends", async () => {
    const all = (await db.execute("SELECT * FROM model_prices ORDER BY provider, model, input_tokens_above")).rows;
    for (const r of all) {
      assert.ok(String(r.source_url).startsWith("https://"), `${r.model} has no source_url`);
      assert.match(String(r.source_fetched_on), /^\d{4}-\d{2}-\d{2}$/, `${r.model} has no fetch date`);
      assert.notEqual(String(r.provider), "openrouter", "OpenRouter reports its own cost; no OpenRouter price was verified");
    }
    // Every Anthropic / OpenAI / Google model the code can send has a price: the
    // pickers, the platform fallback, the probe default, the extractor.
    const sentModels = new Set<string>();
    for (const p of PROVIDER_REGISTRY) {
      if (p.value === "anthropic" || p.value === "openai" || p.value === "google") for (const m of p.models) sentModels.add(`${p.value}/${m.id}`);
    }
    for (const [p, m] of Object.entries(probe.PROBE_MODEL)) if (p !== "openrouter") sentModels.add(`${p}/${m}`);
    sentModels.add("anthropic/claude-sonnet-4-6"); // lib/ai-document-extractor.ts EXTRACT_MODEL
    for (const k of ["PLATFORM_DEFAULT_ANTHROPIC_API_KEY", "PLATFORM_DEFAULT_OPENAI_API_KEY", "PLATFORM_DEFAULT_GOOGLE_API_KEY"]) {
      const saved = process.env;
      const env = { ...saved };
      for (const other of ["PLATFORM_DEFAULT_OPENROUTER_API_KEY", "PLATFORM_DEFAULT_ANTHROPIC_API_KEY", "PLATFORM_DEFAULT_OPENAI_API_KEY", "PLATFORM_DEFAULT_GOOGLE_API_KEY"]) delete process.env[other];
      process.env[k] = "x";
      const f = operatorPlatformFallback();
      process.env = env;
      if (f) sentModels.add(`${f.provider}/${f.model}`);
    }
    const priced = new Set(all.map((r) => `${r.provider}/${r.model}`));
    assert.deepEqual([...sentModels].filter((m) => !priced.has(m)), [], "a model the code sends has no verified price");
    assert.deepEqual([...priced].filter((m) => !sentModels.has(m)), [], "a price for a model the code never sends");
    // The verified numbers themselves (micro-USD per million tokens), read 2026-09-29.
    const pin = (key: string) => all.filter((r) => `${r.provider}/${r.model}` === key).map((r) => [Number(r.input_tokens_above), Number(r.input_micro_usd_per_mtok), Number(r.output_micro_usd_per_mtok), r.cache_read_micro_usd_per_mtok === null ? null : Number(r.cache_read_micro_usd_per_mtok), r.cache_write_micro_usd_per_mtok === null ? null : Number(r.cache_write_micro_usd_per_mtok)]);
    assert.deepEqual(pin("anthropic/claude-sonnet-4-6"), [[0, 3000000, 15000000, 300000, 3750000]]);
    assert.deepEqual(pin("anthropic/claude-opus-4-7"), [[0, 5000000, 25000000, 500000, 6250000]]);
    assert.deepEqual(pin("anthropic/claude-haiku-4-5"), [[0, 1000000, 5000000, 100000, 1250000]]);
    assert.deepEqual(pin("openai/gpt-5.4"), [[0, 2500000, 15000000, 250000, null], [272000, 5000000, 22500000, 500000, null]]);
    assert.deepEqual(pin("openai/gpt-5.4-mini"), [[0, 750000, 4500000, 75000, null]]);
    assert.deepEqual(pin("google/gemini-2.5-pro"), [[0, 1250000, 10000000, 125000, null], [200000, 2500000, 15000000, 250000, null]]);
    assert.deepEqual(pin("google/gemini-2.5-flash"), [[0, 300000, 2500000, 30000, null]]);
  });

  await check("the vocabularies are pinned, and the channel copy says exactly what the recorder says", () => {
    assert.deepEqual([...usage.AUTH_KINDS], ["api_key", "oauth", "subscription", "local", "managed"]);
    assert.deepEqual([...usage.BILLING_MODES], ["byo_key", "platform", "managed", "subscription", "local"]);
    assert.deepEqual([...usage.USAGE_OUTCOMES], ["ok", "error", "refused", "timeout", "cancelled"]);
    assert.ok(usage.isUsageSurface("infer:lead-scoring") && !usage.isUsageSurface("infer:") && !usage.isUsageSurface("chat"));
    for (const code of codes.AI_BUDGET_CODES) {
      assert.ok(outcome.isTurnFailureCode(code), `${code} is not a channel failure code`);
      assert.equal(outcome.failureCopy(code, { canManageAi: true }).sentence, codes.AI_BUDGET_SENTENCES[code]);
      assert.equal(outcome.classifyStreamError(code), code);
    }
    assert.equal(codes.AI_BUDGET_SENTENCES.ai_budget_exhausted, "This month's AI budget is used. The owner can raise it.");
  });

  // ── 2. Cost ──────────────────────────────────────────────────────────────
  console.log("cost");
  await check("cost is price x tokens per kind, in the right tier; unknown is NULL, never 0; a provider's own cost wins", async () => {
    const sonnet = await prices("anthropic", "claude-sonnet-4-6");
    // 1000 in x $3 + 200 out x $15 + 5000 cache reads x $0.30 = 3000 + 3000 + 1500 micro-USD.
    assert.deepEqual(usage.costOf(sonnet, { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 5000, cacheWriteTokens: 0 }), { micro: 7500, source: "price_table" });
    // A cache write at the 5-minute rate: 2000 x $3.75 = 7500.
    assert.equal(usage.costOf(sonnet, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 2000 }).micro, 7500);
    const gpt = await prices("openai", "gpt-5.4");
    assert.equal(usage.costOf(gpt, { inputTokens: 272000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }).micro, 680000, "<= 272K is the short-context tier");
    assert.equal(usage.costOf(gpt, { inputTokens: 272001, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }).micro, 1360005, "> 272K is the long-context tier");
    // OpenAI lists no cache-write rate: a call that wrote the cache has an unknown cost.
    assert.deepEqual(usage.costOf(gpt, { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 5 }), { micro: null, source: null });
    assert.deepEqual(usage.costOf(sonnet, { inputTokens: null, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 }), { micro: null, source: null });
    assert.deepEqual(usage.costOf([], { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 }), { micro: null, source: null });
    assert.deepEqual(usage.costOf([], { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, providerCostUsd: 0.00123 }), { micro: 1230, source: "provider_reported" });
    // The worst case: the prompt bound at the higher of input and cache-write, plus max output.
    assert.equal(usage.worstCaseMicroUsd(sonnet, 1000, 100), Math.ceil((1000 * 3750000 + 100 * 15000000) / 1e6));
    assert.equal(usage.worstCaseMicroUsd([], 1000, 100), null);
  });

  // ── 3. streamChat: one row per call, every provider, every ending ────────
  console.log("streamChat");
  await check("a streamed Anthropic call writes one row: uncached input, cache reads, output, the priced cost", async () => {
    const mark = await total();
    play(anthropicStream("hi", { input: 1000, output: 200, cacheRead: 5000 }));
    const events = await chat("anthropic", "claude-sonnet-4-6", meter({ departmentKey: "sales", teammateId: "sales-agent", sessionId: "sess-1" }));
    assert.deepEqual(events.at(-1), { type: "done", inputTokens: 1000, outputTokens: 200 }, "the done event is unchanged");
    const r = await newRows(mark);
    assert.equal(r.length, 1);
    assert.equal(r[0].tenant_id, CLIENT);
    assert.equal(r[0].surface, "chat.stream");
    assert.equal(r[0].provider, "anthropic");
    assert.equal(r[0].model, "claude-sonnet-4-6");
    assert.equal(r[0].department_key, "sales");
    assert.equal(r[0].teammate_id, "sales-agent");
    assert.equal(r[0].session_id, "sess-1");
    assert.equal(r[0].user_id, USER);
    assert.equal(r[0].outcome, "ok");
    assert.deepEqual([r[0].input_tokens, r[0].output_tokens, r[0].cache_read_tokens, r[0].cache_write_tokens].map(Number), [1000, 200, 5000, 0]);
    assert.equal(Number(r[0].cost_micro_usd), 7500);
    assert.equal(r[0].cost_source, "price_table");
    assert.equal(r[0].reserved_micro_usd, null, "no budget row: nothing reserved");
    assert.match(String(r[0].id), /^[0-9A-HJKMNP-TV-Z]{26}$/, "a ULID");
  });

  await check("OpenAI: prompt_tokens minus the cached prefix is the input; one row, priced", async () => {
    const mark = await total();
    play(openAIStream("hi", { prompt_tokens: 1200, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 200 } }));
    const events = await chat("openai", "gpt-5.4-mini");
    assert.deepEqual(events.at(-1), { type: "done", inputTokens: 1200, outputTokens: 50 });
    const [r] = await newRows(mark);
    assert.deepEqual([r.input_tokens, r.output_tokens, r.cache_read_tokens].map(Number), [1000, 50, 200]);
    // 1000 x $0.75 + 50 x $4.50 + 200 x $0.075 = 750 + 225 + 15.
    assert.equal(Number(r.cost_micro_usd), 990);
    assert.equal((await newRows(mark)).length, 1);
  });

  await check("OpenRouter: its own reported cost (USD) is recorded, not a guess", async () => {
    const mark = await total();
    play(openAIStream("hi", { prompt_tokens: 40, completion_tokens: 8, cost: 0.000321 }));
    await chat("openrouter", "meta-llama/llama-3.3-70b-instruct");
    const r = await newRows(mark);
    assert.equal(r.length, 1);
    assert.equal(Number(r[0].cost_micro_usd), 321);
    assert.equal(r[0].cost_source, "provider_reported");
  });

  await check("Google: thinking tokens count as output; one row, priced", async () => {
    const mark = await total();
    play(
      sse([
        [null, { candidates: [{ content: { parts: [{ text: "hi" }] } }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 5 } }],
        [null, { candidates: [{ content: { parts: [{ text: "!" }] } }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10, thoughtsTokenCount: 30 } }],
      ]),
    );
    const events = await chat("google", "gemini-2.5-flash");
    assert.deepEqual(events.at(-1), { type: "done", inputTokens: 100, outputTokens: 10 });
    const r = await newRows(mark);
    assert.equal(r.length, 1);
    assert.deepEqual([r[0].input_tokens, r[0].output_tokens].map(Number), [100, 40]);
    // 100 x $0.30 + 40 x $2.50 = 30 + 100.
    assert.equal(Number(r[0].cost_micro_usd), 130);
  });

  await check("a local model (Ollama): billing local, cost NULL (no per-call price), still one row", async () => {
    const mark = await total();
    play(openAIStream("hi", { prompt_tokens: 7, completion_tokens: 3 }));
    await chat("ollama", "llama3.3", meter({ authKind: "local", billingMode: "local" }));
    const r = await newRows(mark);
    assert.equal(r.length, 1);
    assert.equal(r[0].billing_mode, "local");
    assert.equal(r[0].cost_micro_usd, null);
    assert.deepEqual([r[0].input_tokens, r[0].output_tokens].map(Number), [7, 3]);
  });

  await check("a model with no verified price records cost NULL (unknown), with its tokens", async () => {
    const mark = await total();
    play(anthropicStream("hi", { input: 10, output: 2 }));
    await chat("anthropic", "claude-not-a-real-model");
    const [r] = await newRows(mark);
    assert.equal(r.cost_micro_usd, null);
    assert.equal(r.cost_source, null);
    assert.equal(Number(r.input_tokens), 10);
  });

  await check("a provider refusal (non-2xx) is one row: outcome error, the status as a code, nothing billed", async () => {
    const mark = await total();
    play(new Response('{"error":"bad key"}', { status: 401 }));
    const events = await chat("anthropic", "claude-sonnet-4-6");
    assert.equal(events.length, 1);
    assert.match((events[0] as { message: string }).message, /^anthropic_401:/, "the error event is unchanged");
    const r = await newRows(mark);
    assert.equal(r.length, 1);
    assert.equal(r[0].outcome, "error");
    assert.equal(r[0].error_code, "http_401");
    assert.equal(Number(r[0].cost_micro_usd), 0);
    assert.equal(r[0].cost_source, "none");
    assert.equal(r[0].input_tokens, null, "no usage was reported, so none is invented");
  });

  await check("a stream that breaks off is one row: error stream_failed, cost unknown", async () => {
    const mark = await total();
    play(brokenSse([["message_start", { message: { usage: { input_tokens: 10, output_tokens: 1 } } }]]));
    await assert.rejects(chat("anthropic", "claude-sonnet-4-6"), /connection reset/);
    const r = await newRows(mark);
    assert.equal(r.length, 1);
    assert.equal(r[0].outcome, "error");
    assert.equal(r[0].error_code, "stream_failed");
    assert.equal(r[0].cost_micro_usd, null);
  });

  await check("a consumer that stops reading mid-reply leaves one row: cancelled, cost unknown", async () => {
    const mark = await total();
    play(anthropicStream("partial", { input: 10, output: 2 }));
    for await (const ev of streamChat({ provider: "anthropic", model: "claude-sonnet-4-6", apiKey: "k", messages: [{ role: "user", content: "x" }], meter: meter() })) {
      if (ev.type === "delta") break;
    }
    const r = await newRows(mark);
    assert.equal(r.length, 1);
    assert.equal(r[0].outcome, "cancelled");
    assert.equal(r[0].cost_micro_usd, null);
  });

  await check("no key, or no messages: nothing is sent, so there is no row", async () => {
    const mark = await total();
    play();
    const e1 = await drain(streamChat({ provider: "anthropic", model: "m", apiKey: "", messages: [{ role: "user", content: "x" }], meter: meter() }));
    const e2 = await drain(streamChat({ provider: "anthropic", model: "m", apiKey: "k", messages: [], meter: meter() }));
    assert.deepEqual([e1, e2].map((e) => (e[0] as { message: string }).message), ["missing_api_key", "empty_messages"]);
    assert.equal(sent.length, 0);
    assert.equal((await newRows(mark)).length, 0);
  });

  // ── 4. The budget ────────────────────────────────────────────────────────
  console.log("budget");
  const cappedMeter = (over: Partial<import("../lib/ai/usage").ModelCallContext> = {}) => meter({ tenantId: CAPPED, ...over });

  await check("no budget row = no cap: nothing is reserved and the call runs", async () => {
    assert.equal(await budget(CLIENT), null);
    assert.equal(await usage.reserveBudget({ tenantId: CLIENT, periodMonth: period, amountMicroUsd: 10 ** 12, db }), null);
    assert.equal(await usage.budgetExhaustedBeforeStream(CLIENT, new Date(), db), null);
  });

  await check("under a cap: reserve the worst case before, settle to the real cost after", async () => {
    await setBudget(CAPPED, 1_000_000);
    const mark = await total();
    let reservedDuringCall = -1;
    play(async (s) => {
      reservedDuringCall = (await budget(CAPPED))!.reservedMicroUsd;
      // The reservation is the sent request's bytes at the higher input rate plus max output.
      const worst = usage.worstCaseMicroUsd(await prices("anthropic", "claude-sonnet-4-6"), usage.utf8Length(s.body), 4096);
      assert.equal(reservedDuringCall, worst);
      return anthropicStream("hi", { input: 1000, output: 200, cacheRead: 5000 });
    });
    await chat("anthropic", "claude-sonnet-4-6", cappedMeter());
    assert.ok(reservedDuringCall > 60_000, `the worst case was reserved before the call (${reservedDuringCall})`);
    const b = await budget(CAPPED);
    assert.deepEqual(b, { capMicroUsd: 1_000_000, reservedMicroUsd: 0, spentMicroUsd: 7500 }, "settled to the real cost");
    const [r] = await newRows(mark);
    assert.equal(Number(r.reserved_micro_usd), reservedDuringCall);
    assert.equal(Number(r.cost_micro_usd), 7500);
  });

  await check("at the cap the call is refused with the budget code, nothing is sent, and the refusal is one row", async () => {
    await setBudget(CAPPED, 10_000, 9_999);
    const mark = await total();
    play();
    const events = await chat("anthropic", "claude-sonnet-4-6", cappedMeter());
    assert.deepEqual(events, [{ type: "error", message: "ai_budget_exhausted" }]);
    assert.equal(sent.length, 0, "a refused call reached the provider");
    const r = await newRows(mark);
    assert.equal(r.length, 1);
    assert.equal(r[0].outcome, "refused");
    assert.equal(r[0].error_code, "ai_budget_exhausted");
    assert.equal(Number(r[0].cost_micro_usd), 0);
    assert.deepEqual(await budget(CAPPED), { capMicroUsd: 10_000, reservedMicroUsd: 0, spentMicroUsd: 9_999 }, "a refusal reserves nothing");
    assert.equal(await usage.budgetExhaustedBeforeStream(CAPPED, new Date(), db), null, "there is still 1 micro-USD of headroom");
    await setBudget(CAPPED, 10_000, 10_000);
    assert.equal(await usage.budgetExhaustedBeforeStream(CAPPED, new Date(), db), "ai_budget_exhausted");
  });

  await check("the route answer for a budget refusal is HTTP 402 with the plain sentence", async () => {
    const res = usage.budgetRefusalResponse("ai_budget_exhausted");
    assert.equal(res.status, 402);
    assert.deepEqual(await res.json(), {
      ok: false,
      error: "ai_budget_exhausted",
      code: "ai_budget_exhausted",
      message: "This month's AI budget is used. The owner can raise it.",
    });
    assert.deepEqual(codes.sseErrorFrame("ai_budget_exhausted"), { code: "ai_budget_exhausted", message: "This month's AI budget is used. The owner can raise it." });
    assert.deepEqual(codes.sseErrorFrame("anthropic_401:x"), { message: "anthropic_401:x" });
  });

  await check("a capped tenant on a model with no verified price is refused, never run unmetered or downgraded", async () => {
    await setBudget(CAPPED, 10_000_000);
    const mark = await total();
    play();
    const events = await chat("anthropic", "claude-not-a-real-model", cappedMeter());
    assert.deepEqual(events, [{ type: "error", message: "ai_budget_unpriced_model" }]);
    assert.equal(sent.length, 0);
    const [r] = await newRows(mark);
    assert.equal(r.model, "claude-not-a-real-model", "the refusal names the model asked for; nothing was swapped in");
    assert.equal(r.error_code, "ai_budget_unpriced_model");
  });

  await check("two concurrent calls that each fit but not together: exactly one is reserved", async () => {
    const sonnet = await prices("anthropic", "claude-sonnet-4-6");
    const worst = usage.worstCaseMicroUsd(sonnet, 500, 4096)!;
    await setBudget(CAPPED, Math.floor(worst * 1.5));
    const results = await Promise.allSettled([
      usage.reserveBudget({ tenantId: CAPPED, periodMonth: period, amountMicroUsd: worst, db }),
      usage.reserveBudget({ tenantId: CAPPED, periodMonth: period, amountMicroUsd: worst, db }),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const refused = results.filter((r) => r.status === "rejected");
    assert.equal(ok.length, 1, "both reservations slipped under the cap");
    assert.equal(refused.length, 1);
    assert.equal(((refused[0] as PromiseRejectedResult).reason as { code: string }).code, "ai_budget_exhausted");
    assert.equal((await budget(CAPPED))!.reservedMicroUsd, worst);
  });

  await check("an unknown cost settles at the reservation (it can only over-count); a refused call releases it", async () => {
    await setBudget(CAPPED, 10_000_000);
    play(brokenSse([["message_start", { message: { usage: { input_tokens: 10, output_tokens: 1 } } }]]));
    let reserved = 0;
    script = [
      async (s) => {
        reserved = usage.worstCaseMicroUsd(await prices("anthropic", "claude-sonnet-4-6"), usage.utf8Length(s.body), 4096)!;
        return brokenSse([["message_start", { message: { usage: { input_tokens: 10, output_tokens: 1 } } }]]);
      },
    ];
    await assert.rejects(chat("anthropic", "claude-sonnet-4-6", cappedMeter()));
    assert.deepEqual(await budget(CAPPED), { capMicroUsd: 10_000_000, reservedMicroUsd: 0, spentMicroUsd: reserved });
    await setBudget(CAPPED, 10_000_000);
    play(new Response("{}", { status: 400 }));
    await chat("anthropic", "claude-sonnet-4-6", cappedMeter());
    assert.deepEqual(await budget(CAPPED), { capMicroUsd: 10_000_000, reservedMicroUsd: 0, spentMicroUsd: 0 }, "a refused request billed nothing");
  });

  await check("a budget that cannot be read refuses the call (ai_usage_unavailable), it never runs uncapped", async () => {
    const other = createClient({ url: `file:${join(mkdtempSync(join(tmpdir(), "ai-usage-empty-")), "empty.db")}` });
    const m = usage.modelCallMeter({ tenantId: CLIENT, surface: "chat.stream", authKind: "api_key", billingMode: "byo_key" }, { db: other });
    play();
    const logged: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void logged.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
    try {
      const events = await drain(streamChat({ provider: "anthropic", model: "claude-sonnet-4-6", apiKey: "k", messages: [{ role: "user", content: "x" }], meter: m }));
      assert.deepEqual(events, [{ type: "error", message: "ai_usage_unavailable" }]);
    } finally {
      console.error = orig;
    }
    assert.equal(sent.length, 0);
    assert.ok(logged.some((l) => l.includes("budget or prices unreadable")), "the refusal is logged loudly");
  });

  // ── 5. The tool loops ────────────────────────────────────────────────────
  console.log("tool loops");
  const ctx = { tenantId: CLIENT, userId: USER, agentKey: "sales-agent", authUserId: USER, isAdmin: false };
  const loopReq = (m: import("../lib/ai/usage").ModelCallMeter, model = "claude-sonnet-4-6") => ({
    apiKey: "k",
    model,
    system: "sys",
    messages: [{ role: "user" as const, content: "hi" }],
    excludeDeferredTools: true,
    bridgeAdvertisedTools: null,
    toolPalette: ["list_records"],
    meter: m,
  });

  await check("the Anthropic tool loop writes one row per iteration, each priced", async () => {
    const mark = await total();
    // A tool the client may not call is blocked (never executed) and the loop goes round again.
    play(anthropicToolUse("bash", { input: 100, output: 20 }), anthropicStream("done", { input: 150, output: 30 }));
    const events = await drain(runner.streamAnthropicWithTools(loopReq(meter({ surface: "chat.tools" })), ctx));
    assert.ok(events.some((e) => e.type === "done"));
    assert.equal(sent.length, 2);
    const r = await newRows(mark);
    assert.equal(r.length, 2, "one row per model call in the loop");
    assert.deepEqual(r.map((x) => [x.surface, Number(x.input_tokens), Number(x.output_tokens), Number(x.cost_micro_usd)]), [
      ["chat.tools", 100, 20, 600], // 100 x $3 + 20 x $15
      ["chat.tools", 150, 30, 900],
    ]);
  });

  await check("each loop iteration reserves for itself: the cap stops the loop at the iteration that would pass it", async () => {
    await setBudget(CAPPED, 80_000);
    const mark = await total();
    // Iteration 1 fits (worst case ~62K); it really costs 63K (1000 x $3 + 4000 x $15), so iteration 2 cannot fit.
    play(anthropicToolUse("bash", { input: 1000, output: 4000 }), anthropicStream("never", { input: 1, output: 1 }));
    const events = await drain(runner.streamAnthropicWithTools(loopReq(cappedMeter({ surface: "chat.tools" })), { ...ctx, tenantId: CAPPED }));
    assert.equal(sent.length, 1, "the second iteration reached the provider");
    assert.deepEqual(events.at(-1), { type: "error", message: "ai_budget_exhausted" });
    const r = await newRows(mark);
    assert.deepEqual(r.map((x) => x.outcome), ["ok", "refused"]);
    assert.deepEqual(await budget(CAPPED), { capMicroUsd: 80_000, reservedMicroUsd: 0, spentMicroUsd: 63_000 });
  });

  await check("a resumed tool loop meters its calls too (surface chat.resume)", async () => {
    const mark = await total();
    play(anthropicStream("resumed", { input: 40, output: 4 }));
    await drain(
      runner.resumeAnthropicTurn(
        { model: "claude-haiku-4-5", system: "sys", history: [], iteration: 0, totalIn: 0, totalOut: 0 },
        "tu_x",
        { content: "{}", is_error: false },
        ctx,
        "k",
        meter({ surface: "chat.resume" }),
      ),
    );
    const r = await newRows(mark);
    assert.equal(r.length, 1);
    assert.equal(r[0].surface, "chat.resume");
    assert.equal(r[0].model, "claude-haiku-4-5");
    assert.equal(Number(r[0].cost_micro_usd), 60); // 40 x $1 + 4 x $5
  });

  await check("the OpenAI-compatible tool loop writes one row per call, success and refusal", async () => {
    const mark = await total();
    play(openAIStream("hi", { prompt_tokens: 100, completion_tokens: 10 }), new Response("nope", { status: 403 }));
    const req = (m: import("../lib/ai/usage").ModelCallMeter) => ({ provider: "openai" as const, apiKey: "k", model: "gpt-5.4-mini", system: "s", messages: [{ role: "user" as const, content: "hi" }], toolPalette: ["list_records"], meter: m });
    await drain(runner.streamOpenAICompatibleWithTools(req(meter({ surface: "chat.tools" })), ctx));
    const refused = await drain(runner.streamOpenAICompatibleWithTools(req(meter({ surface: "chat.tools" })), ctx));
    assert.match((refused.at(-1) as { message: string }).message, /^openai_403:/);
    const r = await newRows(mark);
    assert.deepEqual(r.map((x) => [x.outcome, x.error_code, x.cost_micro_usd === null ? null : Number(x.cost_micro_usd)]), [
      ["ok", null, 120], // 100 x $0.75 + 10 x $4.50
      ["error", "http_403", 0],
    ]);
  });

  await check("the meter adds up a turn: known cost, and how many calls were unknown", async () => {
    const m = meter();
    play(anthropicStream("a", { input: 1000, output: 200, cacheRead: 5000 }), anthropicStream("b", { input: 1, output: 1 }));
    await chat("anthropic", "claude-sonnet-4-6", m);
    assert.deepEqual(m.totals(), { calls: 1, costMicroUsd: 7500, unknownCostCalls: 0 });
    await chat("anthropic", "claude-not-a-real-model", m);
    assert.deepEqual(m.totals(), { calls: 2, costMicroUsd: 7500, unknownCostCalls: 1 });
  });

  // ── 6. The probe and document extraction (not streamed) ──────────────────
  console.log("probe + extraction");
  await check("a probe is one row (surface probe): priced on success, 0 on a refusal, refused at the cap without a call", async () => {
    const mark = await total();
    play(new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }], usage: { input_tokens: 12, output_tokens: 1 } }), { status: 200 }));
    const ok = await probe.probeProvider("anthropic", "k", { meter: meter({ surface: "probe" }) });
    assert.equal(ok.ok, true);
    play(new Response("bad", { status: 401 }));
    const bad = await probe.probeProvider("anthropic", "k", { meter: meter({ surface: "probe" }) });
    assert.equal(bad.ok, false);
    const r = await newRows(mark);
    assert.deepEqual(r.map((x) => [x.surface, x.model, x.outcome, x.error_code, Number(x.cost_micro_usd)]), [
      ["probe", "claude-haiku-4-5", "ok", null, 17], // 12 x $1 + 1 x $5
      ["probe", "claude-haiku-4-5", "error", "http_401", 0],
    ]);
    await setBudget(CAPPED, 0);
    play();
    const capped = await probe.probeProvider("anthropic", "k", { meter: cappedMeter({ surface: "probe" }) });
    assert.deepEqual(capped, { ok: false, code: "ai_budget_exhausted", message: "This month's AI budget is used. The owner can raise it." });
    assert.equal(sent.length, 0);
  });

  await check("document extraction is one row per call, success and error", async () => {
    process.env.BRAVO_ANTHROPIC_API_KEY = "test-key";
    try {
      const mark = await total();
      const m = () => usage.modelCallMeter({ tenantId: OASIS, surface: "document_extract", authKind: "api_key", billingMode: "platform" });
      play(new Response(JSON.stringify({ content: [{ type: "text", text: '{"dba":"X"}' }], usage: { input_tokens: 2000, output_tokens: 100 } }), { status: 200 }));
      const ok = await extractor.extractApplicationFields(Buffer.from("%PDF-1.4"), "application/pdf", m());
      assert.deepEqual(ok, { ok: true, fields: { dba: "X" } });
      play(new Response("overloaded", { status: 529 }));
      const bad = await extractor.extractApplicationFields(Buffer.from("%PDF-1.4"), "application/pdf", m());
      assert.equal(bad.ok, false);
      const r = await newRows(mark);
      assert.deepEqual(r.map((x) => [x.tenant_id, x.surface, x.billing_mode, x.outcome, x.error_code, Number(x.cost_micro_usd)]), [
        [OASIS, "document_extract", "platform", "ok", null, 7500], // 2000 x $3 + 100 x $15
        [OASIS, "document_extract", "platform", "error", "http_529", 0],
      ]);
    } finally {
      delete process.env.BRAVO_ANTHROPIC_API_KEY;
    }
  });

  // ── 7. The subscription router ───────────────────────────────────────────
  console.log("subscription router");
  await db.executeMultiple(`
    CREATE TABLE inference_jobs (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      tenant_id TEXT, source TEXT NOT NULL, system TEXT, prompt TEXT NOT NULL,
      model_tier TEXT NOT NULL DEFAULT 'fast', max_tokens INTEGER NOT NULL DEFAULT 1024,
      status TEXT NOT NULL DEFAULT 'pending', result_text TEXT, error_message TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      claimed_at TEXT, completed_at TEXT
    );
  `);
  const router = await import("../lib/ai/infer");
  await check("the subscription router: a client is one refused row, no tenant is no row, OASIS is flat-rate", async () => {
    const mark = await total();
    const quiet = console.error;
    console.error = () => undefined;
    try {
      await router.inferForTenant(CLIENT, { source: "lead-scoring", system: "s", prompt: "p", maxTokens: 10, timeoutMs: 20 });
      await router.inferForTenant(null, { source: "lead-scoring", system: "s", prompt: "p", maxTokens: 10, timeoutMs: 20 });
      await router.inferForTenant(OASIS, { source: "lead-scoring", system: "s", prompt: "p", maxTokens: 10, timeoutMs: 20, modelTier: "smart" });
      const args = { source: "operator-email", prompt: "p", tenantId: OASIS, dedupeKey: "k-usage-1" };
      await router.queueInferForTenant(args, { timeoutMs: 10, pollMs: 5 });
      await db.execute({ sql: "UPDATE inference_jobs SET status = 'complete', result_text = 'done' WHERE source LIKE 'operator-email%'", args: [] });
      const collected = await router.queueInferForTenant(args, { timeoutMs: 10, pollMs: 5 });
      assert.deepEqual(collected, { ok: true, text: "done", reused: true });
    } finally {
      console.error = quiet;
    }
    const r = await newRows(mark);
    assert.deepEqual(r.map((x) => [x.tenant_id, x.surface, x.provider, x.model, x.billing_mode, x.outcome, x.error_code, x.cost_micro_usd === null ? null : Number(x.cost_micro_usd)]), [
      [CLIENT, "infer:lead-scoring", "claude_cli", "tier:fast", "subscription", "refused", "managed_runtime_not_configured", 0],
      [OASIS, "infer:lead-scoring", "claude_cli", "tier:smart", "subscription", "timeout", "queue_timeout", null],
      [OASIS, "infer:operator-email", "claude_cli", "tier:fast", "subscription", "timeout", "queue_timeout", null],
      // The collected result is the SAME job: no second row.
    ]);
  });

  // ── 8. Reading it back ───────────────────────────────────────────────────
  console.log("usageFor");
  await check("usageFor sums known cost, counts unknowns and flat-rate calls apart, splits by department, shows the cap", async () => {
    const T = "8d8d8d8d-0000-4000-8000-00000000008d";
    const base = { tenantId: T, authKind: "api_key" as const, occurredAt: new Date(), provider: "anthropic", model: "m", latencyMs: 1 };
    await usage.recordModelCall({ ...base, surface: "agents.chat", billingMode: "byo_key", departmentKey: "sales", costMicroUsd: 1000, costSource: "price_table", outcome: "ok" });
    await usage.recordModelCall({ ...base, surface: "agents.chat", billingMode: "byo_key", departmentKey: "sales", costMicroUsd: null, costSource: null, outcome: "ok" });
    await usage.recordModelCall({ ...base, surface: "agents.chat", billingMode: "byo_key", departmentKey: "finance", costMicroUsd: 0, costSource: "none", outcome: "refused", errorCode: "ai_budget_exhausted" });
    await usage.recordModelCall({ ...base, surface: "infer:x", billingMode: "subscription", authKind: "subscription", costMicroUsd: null, costSource: null, outcome: "ok" });
    // Another tenant's row and last month's row never count.
    await usage.recordModelCall({ ...base, tenantId: CLIENT, surface: "probe", billingMode: "byo_key", costMicroUsd: 99999, costSource: "price_table", outcome: "ok" });
    const lastMonth = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1) - 1000);
    await usage.recordModelCall({ ...base, occurredAt: lastMonth, surface: "probe", billingMode: "byo_key", costMicroUsd: 99999, costSource: "price_table", outcome: "ok" });
    await setBudget(T, 50_000, 1_000);
    const u = await usage.usageFor(T, period, db);
    assert.equal(u.calls, 4);
    assert.equal(u.costMicroUsd, 1000);
    assert.equal(u.unknownCostCalls, 1, "a per-token call with no known cost is unknown, never $0");
    assert.equal(u.flatRateCalls, 1, "a subscription call is flat-rate, not unknown");
    assert.equal(u.refusedCalls, 1);
    assert.deepEqual(u.byDepartment, [
      { departmentKey: null, calls: 1, costMicroUsd: 0, unknownCostCalls: 0 },
      { departmentKey: "finance", calls: 1, costMicroUsd: 0, unknownCostCalls: 0 },
      { departmentKey: "sales", calls: 2, costMicroUsd: 1000, unknownCostCalls: 1 },
    ]);
    assert.deepEqual(u.budget, { capMicroUsd: 50_000, reservedMicroUsd: 0, spentMicroUsd: 1_000 });
    assert.equal((await usage.usageFor(T, "2001-01", db)).calls, 0);
    await assert.rejects(usage.usageFor(T, "2026-13", db), /YYYY-MM/);
  });

  // ── 9. Guards ────────────────────────────────────────────────────────────
  console.log("guards");
  await check("a meter refuses to exist without a tenant, and a row refuses prose for a code", async () => {
    for (const t of ["", "   ", null as unknown as string]) {
      assert.throws(() => usage.modelCallMeter({ tenantId: t, surface: "chat.stream", authKind: "api_key", billingMode: "byo_key" }), /tenant/);
    }
    assert.throws(() => usage.modelCallMeter({ tenantId: CLIENT, surface: "made.up" as "probe", authKind: "api_key", billingMode: "byo_key" }), /surface/);
    assert.throws(() => usage.modelCallInsert({ tenantId: CLIENT, surface: "probe", authKind: "api_key", billingMode: "byo_key", occurredAt: new Date(), provider: "p", model: "m", costMicroUsd: null, costSource: null, latencyMs: 1, outcome: "error", errorCode: "Your credit balance is too low" }), /code/);
  });

  await check("a row that cannot be written is logged loudly and never breaks the caller", async () => {
    const broken = createClient({ url: `file:${join(mkdtempSync(join(tmpdir(), "ai-usage-broken-")), "b.db")}` });
    const logged: unknown[][] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void logged.push(a);
    try {
      const landed = await usage.recordModelCall({ tenantId: CLIENT, surface: "probe", authKind: "api_key", billingMode: "byo_key", occurredAt: new Date(), provider: "anthropic", model: "m", costMicroUsd: 5, costSource: "price_table", latencyMs: 1, outcome: "ok" }, [], broken);
      assert.equal(landed, false);
    } finally {
      console.error = orig;
    }
    assert.equal(logged.length, 1);
    assert.equal(logged[0][0], "[ai/usage] could not record a model call");
    assert.equal((logged[0][1] as { tenantId: string }).tenantId, CLIENT);
  });

  await check("every route that calls a model builds its meter from the session's tenant, and maps a budget refusal to 402", () => {
    const src = (p: string) => readFileSync(join(ROOT, p), "utf8");
    const wiring: Array<[string, RegExp[]]> = [
      ["app/api/chat/route.ts", [/surface: cloudToolsMode === "tools" && supportsNativeTools \? "chat\.tools" : "chat\.stream"/, /budgetExhaustedBeforeStream\(tenantId\)/, /return budgetRefusalResponse\(exhausted\)/]],
      ["app/api/chat/resume/route.ts", [/surface: "chat\.resume"/, /budgetExhaustedBeforeStream\(tenantId\)/, /return budgetRefusalResponse\(exhausted\)/]],
      ["app/api/chat/compact/route.ts", [/surface: "chat\.compact"/, /if \(isAiBudgetCode\(errorMessage\)\) return budgetRefusalResponse\(errorMessage\);/]],
      ["app/api/agents/chat/route.ts", [/surface: "agents\.chat"/, /refuse\(ctx, 402, exhausted/]],
      ["app/api/agents/generate/route.ts", [/tenantId: profile\.tenant_id,\s+surface: "agents\.generate"/, /if \(isAiBudgetCode\(streamError\)\) return budgetRefusalResponse\(streamError\);/]],
      ["app/api/manifest/chat/route.ts", [/tenantId: profile\.tenant_id,\s+surface: "manifest\.chat"/, /if \(isAiBudgetCode\(streamError\)\) return budgetRefusalResponse\(streamError\);/]],
      ["app/api/gmail-templates/[id]/solara/route.ts", [/tenantId: sess\.tenantId,\s+surface: "gmail_templates\.solara"/, /if \(isAiBudgetCode\(streamError\)\) return budgetRefusalResponse\(streamError\);/]],
      ["app/api/agent-config/test-connection/route.ts", [/probeMeter\(provider, ctx\.tenantId, ctx\.userId\)/, /isAiBudgetCode\(result\.code\) \? \{ status: 402 \}/]],
    ];
    for (const [file, patterns] of wiring) {
      const s = src(file);
      for (const re of patterns) assert.match(s, re, `${file} lost its metering: ${re}`);
      // The tenant is never read from the request body into a meter.
      assert.doesNotMatch(s, /modelCallMeter\(\{[^}]*(?:body|payload)\./, `${file} builds a meter from the request body`);
    }
    // The invented price table is gone.
    assert.doesNotMatch(src("app/api/chat/route.ts"), /estimateCostUsd/);
  });

  console.log(`\n${passed} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
  console.log("ai usage ledger tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
