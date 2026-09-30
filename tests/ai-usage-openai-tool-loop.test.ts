/**
 * ai-usage-openai-tool-loop.test.ts: a multi-step tool turn on OpenAI or
 * OpenRouter counts every step's tokens.
 *
 * WHY. streamOpenAICompatibleWithTools (lib/cloud-tool-runner.ts) sends one
 * provider request per step of a tool turn. Each request reports its own
 * usage, and the loop kept only the last one: a three-step turn told the chat
 * (the `usage` event), chat_messages and chat_sessions the third step's tokens
 * while the ledger's cost was all three steps'. So the session's tokens were
 * under-reported and did not match its cost.
 *
 * What must hold, as for the Anthropic loop: each provider request is ONE
 * ai_usage_events row with that step's own tokens and cost, and the turn's
 * total is the sum of its steps, written to chat_sessions together with the
 * summed cost. A step with no usage report leaves the turn's tokens unknown:
 * no usage event and a NULL message row, never the other steps' sum as if it
 * were the turn's.
 *
 * Real libSQL file with bravo__192 applied (so gpt-5.4 has its seeded price),
 * the real session cookie and the real /api/chat handler. next/headers and
 * next/navigation are the only stand-ins; the provider is a stubbed global
 * fetch that answers each step with its own usage.
 *
 * Run: node --conditions=react-server --import tsx tests/ai-usage-openai-tool-loop.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createClient } from "@libsql/client";

const dbFile = join(mkdtempSync(join(tmpdir(), "ai-usage-openai-tool-loop-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
process.env.EMPIRE_AUTH_BACKEND = "turso";
process.env.AUTH_SESSION_SECRET = "ai-usage-openai-tool-loop-secret-long-enough-01";
process.env.BRAVO_FIELD_ENCRYPTION_KEY = "ai-usage-openai-tool-loop-field-key-long-0001";
delete process.env.OPERATOR_EMAIL;
delete process.env.OPERATOR_EMAIL_FALLBACK_ENABLED;
process.env.ADMIN_EMAILS = "";
for (const k of Object.keys(process.env)) {
  if (k.startsWith("PLATFORM_DEFAULT_") || k.startsWith("BRIDGE_")) delete process.env[k];
}

const SESSION_COOKIE_NAME = "oasis_session";
let sessionCookie: string | undefined;
function stub(request: string, exports: Record<string, unknown>) {
  const p = require.resolve(request);
  require.cache[p] = { id: p, filename: p, path: dirname(p), loaded: true, children: [], paths: [], exports } as unknown as NodeModule;
}
stub("next/headers", {
  cookies: async () => ({
    get: (name: string) => (name === SESSION_COOKIE_NAME && sessionCookie ? { name, value: sessionCookie } : undefined),
    getAll: () => (sessionCookie ? [{ name: SESSION_COOKIE_NAME, value: sessionCookie }] : []),
    has: (name: string) => name === SESSION_COOKIE_NAME && Boolean(sessionCookie),
    set: () => undefined,
  }),
  headers: async () => new Headers(),
  draftMode: async () => ({ isEnabled: false }),
});
stub("next/navigation", {
  notFound: () => {
    throw new Error("NEXT_HTTP_ERROR_FALLBACK;404");
  },
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT;${url}`);
  },
});

// Two client workspaces: one on its own OpenAI key, one on its own OpenRouter key.
const OPENAI_CO = "4a4a4a4a-0000-4000-8000-00000000004a";
const ROUTER_CO = "3b3b3b3b-0000-4000-8000-00000000003b";
type U = { id: string; email: string };
const u = (n: number, email: string): U => ({ id: `0d000000-0000-4000-8000-${String(n).padStart(12, "0")}`, email });
const USERS = {
  openaiOwner: u(31, "owner@openai-co.test"),
  routerOwner: u(32, "owner@router-co.test"),
} as const;

async function login(user: U) {
  const { signSession } = await import("../lib/turso-auth");
  sessionCookie = signSession({ sub: user.id, email: user.email, exp: Math.floor(Date.now() / 1000) + 3600, ver: 0 });
}

let failures = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${((e as Error).stack || (e as Error).message).split("\n").slice(0, 8).join("\n        ")}`);
  }
}

// ── provider stub: one scripted reply per step ──────────────────────────
type Sent = { url: string; body: string };
let sent: Sent[] = [];
let steps: Array<() => Response> = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const s = { url: String(input instanceof Request ? input.url : input), body: String(init?.body ?? "") };
  sent.push(s);
  if (!/api\.openai\.com|openrouter\.ai/.test(s.url)) return new Response("unexpected", { status: 404 });
  const next = steps.shift();
  return next ? next() : new Response("no step scripted", { status: 400 });
}) as typeof fetch;
function sse(frames: unknown[]): Response {
  const body = frames.map((d) => `data: ${typeof d === "string" ? d : JSON.stringify(d)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}
type Usage = Record<string, unknown> | null;
/** A step where the model asks for a tool (one this agent is not offered, so the loop answers it and runs another step). */
const toolStep = (callId: string, usage: Usage) => () =>
  sse([
    { choices: [{ delta: { tool_calls: [{ index: 0, id: callId, type: "function", function: { name: "not_a_real_tool", arguments: "" } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "{}" } }] } }] },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ...(usage ? [{ choices: [], usage }] : []),
    "[DONE]",
  ]);
/** The last step: the model answers in text. */
const textStep = (text: string, usage: Usage) => () =>
  sse([
    { choices: [{ delta: { content: text } }] },
    { choices: [{ delta: {}, finish_reason: "stop" }] },
    ...(usage ? [{ choices: [], usage }] : []),
    "[DONE]",
  ]);

const logged: unknown[][] = [];
const realError = console.error;
console.error = (...args: unknown[]) => void logged.push(args);

type Ev = { event: string; data: Record<string, unknown> };
function parseSse(text: string): Ev[] {
  return text
    .split("\n\n")
    .filter((f) => f.trim())
    .map((f) => {
      let event = "message";
      let data = "";
      for (const line of f.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      return { event, data: JSON.parse(data || "{}") as Record<string, unknown> };
    });
}

async function main() {
  const db = createClient({ url: `file:${dbFile}` });
  await db.executeMultiple(`
    CREATE TABLE "_supabase_auth_users" (id TEXT PRIMARY KEY, email TEXT NOT NULL,
      session_version INTEGER NOT NULL DEFAULT 0, banned_until TEXT, deleted_at TEXT);
    CREATE TABLE user_profiles (id TEXT PRIMARY KEY, auth_user_id TEXT, email TEXT, tenant_id TEXT,
      team_role TEXT, is_owner INTEGER DEFAULT 0, admin_access INTEGER DEFAULT 0,
      onboarding_completed_at TEXT, full_name TEXT, display_name TEXT, agents_enabled TEXT, custom_fields TEXT,
      updated_at TEXT, deactivated_at TEXT);
    CREATE TABLE tenants (id TEXT PRIMARY KEY, slug TEXT, name TEXT, custom_fields TEXT);
    CREATE TABLE tenant_manifests (id TEXT PRIMARY KEY, tenant_id TEXT, slug TEXT, manifest TEXT,
      version INTEGER, schema_version INTEGER, created_at TEXT, updated_at TEXT);
    CREATE TABLE agent_model_config (id TEXT PRIMARY KEY, tenant_id TEXT, user_id TEXT, agent_key TEXT,
      provider TEXT, model TEXT, encrypted_api_key TEXT, enabled INTEGER, system_prompt_override TEXT,
      display_name_override TEXT, last_used_at TEXT, updated_at TEXT);
    -- estimated_cost_usd is TEXT in the live bravo schema (Postgres numeric).
    CREATE TABLE chat_sessions (id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), tenant_id TEXT NOT NULL,
      user_id TEXT, agent_key TEXT, provider TEXT, model TEXT, title TEXT,
      total_input_tokens INTEGER NOT NULL DEFAULT 0, total_output_tokens INTEGER NOT NULL DEFAULT 0,
      estimated_cost_usd TEXT NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));
    CREATE TABLE chat_messages (id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), session_id TEXT, tenant_id TEXT,
      role TEXT, content TEXT, input_tokens INTEGER, output_tokens INTEGER, latency_ms INTEGER, error TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));
    CREATE TABLE bridge_pairings (id TEXT PRIMARY KEY, tenant_id TEXT, last_seen_at TEXT, tool_capabilities TEXT, revoked_at TEXT);
  `);
  await db.executeMultiple(readFileSync(join(process.cwd(), "database/turso/bravo__192_ai_usage.sql"), "utf8"));
  const { encryptField } = await import("../lib/field-encryption");
  const stamp = "2026-09-01T00:00:00Z";
  const profile = (id: string, user: U, tenant: string) => ({
    sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, onboarding_completed_at, full_name, updated_at)
          VALUES (?, ?, ?, ?, 'owner', 1, ?, 'Test Person', ?)`,
    args: [id, user.id, user.email, tenant, stamp, stamp],
  });
  const config = (id: string, tenant: string, prov: string, model: string, key: string) => ({
    sql: `INSERT INTO agent_model_config (id, tenant_id, user_id, agent_key, provider, model, encrypted_api_key, enabled, updated_at)
          VALUES (?, ?, NULL, 'bravo', ?, ?, ?, 1, ?)`,
    args: [id, tenant, prov, model, encryptField(key), stamp],
  });
  await db.batch(
    [
      ...Object.values(USERS).map((x) => ({ sql: `INSERT INTO "_supabase_auth_users" (id, email) VALUES (?, ?)`, args: [x.id, x.email] })),
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'openai-co', 'OpenAI Co')", args: [OPENAI_CO] },
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'router-co', 'Router Co')", args: [ROUTER_CO] },
      profile("p-openai-owner", USERS.openaiOwner, OPENAI_CO),
      profile("p-router-owner", USERS.routerOwner, ROUTER_CO),
      config("c-openai", OPENAI_CO, "openai", "gpt-5.4", "sk-openai-test-0001"),
      // No verified OpenRouter price is seeded: its cost is what OpenRouter reports (usage.cost, USD).
      config("c-router", ROUTER_CO, "openrouter", "openai/gpt-5.4", "sk-or-test-0001"),
    ],
    "write",
  );

  const chatRoute = await import("../app/api/chat/route");
  const { NextRequest } = await import("next/server");
  /**
   * One /api/chat turn with the native tool loop. The route persists AFTER it
   * closes the stream; its last write stamps the key's last_used_at.
   */
  const turn = async (configId: string, text: string) => {
    await db.execute({ sql: "UPDATE agent_model_config SET last_used_at = NULL WHERE id = ?", args: [configId] });
    const res = await chatRoute.POST(
      new NextRequest("http://localhost/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent_key: "bravo", cloud_tools: "tools", messages: [{ role: "user", content: text }] }),
      }),
    );
    const body = await res.text();
    assert.equal(res.status, 200, body);
    for (let i = 0; i < 200; i += 1) {
      const r = await db.execute({ sql: "SELECT last_used_at FROM agent_model_config WHERE id = ?", args: [configId] });
      if (r.rows[0]?.last_used_at) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const events = parseSse(body);
    const sessionId = String(events.find((e) => e.event === "session")?.data.session_id || "");
    assert.ok(sessionId, JSON.stringify(events));
    return { events, sessionId };
  };
  const rows = async (sessionId: string) =>
    (
      await db.execute({
        sql: `SELECT surface, provider, model, outcome, input_tokens, output_tokens, cache_read_tokens, cost_micro_usd, cost_source
              FROM ai_usage_events WHERE session_id = ? ORDER BY id`,
        args: [sessionId],
      })
    ).rows;
  const totals = async (id: string) => {
    const s = (await db.execute({ sql: "SELECT total_input_tokens, total_output_tokens, estimated_cost_usd FROM chat_sessions WHERE id = ?", args: [id] })).rows[0];
    return [Number(s.total_input_tokens), Number(s.total_output_tokens), Number(s.estimated_cost_usd)];
  };
  const assertTotals = (got: number[], want: [number, number, number]) => {
    assert.deepEqual(got.slice(0, 2), want.slice(0, 2), `tokens ${JSON.stringify(got)} != ${JSON.stringify(want)}`);
    assert.ok(Math.abs(got[2] - want[2]) < 1e-12, `cost ${got[2]} != ${want[2]}`);
  };
  const assistantTokens = async (sessionId: string) => {
    const r = (await db.execute({ sql: "SELECT input_tokens, output_tokens FROM chat_messages WHERE session_id = ? AND role = 'assistant'", args: [sessionId] })).rows;
    // null stays null: an unknown count is not 0.
    return r.map((x) => [x.input_tokens === null ? null : Number(x.input_tokens), x.output_tokens === null ? null : Number(x.output_tokens)]);
  };

  console.log("OpenAI: a three-step tool turn");
  await check("3 provider requests are 3 ai_usage_events rows, each with its own step's tokens and cost", async () => {
    await login(USERS.openaiOwner);
    sent = [];
    steps = [
      toolStep("call_1", { prompt_tokens: 1000, completion_tokens: 100 }),
      toolStep("call_2", { prompt_tokens: 1200, completion_tokens: 50 }),
      // 400 of the last prompt's tokens were a cache hit (billed at the cache-read rate).
      textStep("Here is the summary.", { prompt_tokens: 1400, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 400 } }),
    ];
    const { events, sessionId } = await turn("c-openai", "Summarise the week");
    assert.equal(sent.filter((s) => s.url.includes("api.openai.com")).length, 3, JSON.stringify(events));
    assert.ok(!events.some((e) => e.event === "error"), JSON.stringify(events));
    assert.ok(events.some((e) => e.event === "delta" && e.data.text === "Here is the summary."), JSON.stringify(events));
    // gpt-5.4 (bravo__192, the provider's page): $2.50 in, $15 out, $0.25 cache read, per million.
    //   step 1: 1000 x 2.5 + 100 x 15 = 4000 micro-USD
    //   step 2: 1200 x 2.5 + 50 x 15 = 3750
    //   step 3: (1400 - 400) x 2.5 + 400 x 0.25 + 200 x 15 = 5600
    assert.deepEqual(
      (await rows(sessionId)).map((r) => [r.surface, r.provider, r.model, r.outcome, Number(r.input_tokens), Number(r.output_tokens), Number(r.cache_read_tokens), Number(r.cost_micro_usd), r.cost_source]),
      [
        ["chat.tools", "openai", "gpt-5.4", "ok", 1000, 100, 0, 4000, "price_table"],
        ["chat.tools", "openai", "gpt-5.4", "ok", 1200, 50, 0, 3750, "price_table"],
        ["chat.tools", "openai", "gpt-5.4", "ok", 1000, 200, 400, 5600, "price_table"],
      ],
    );
  });

  await check("the turn's total is the sum of its steps: the usage event, the message and the session, beside the summed cost", async () => {
    await login(USERS.openaiOwner);
    steps = [
      toolStep("call_a", { prompt_tokens: 1000, completion_tokens: 100 }),
      toolStep("call_b", { prompt_tokens: 1200, completion_tokens: 50 }),
      textStep("Done.", { prompt_tokens: 1400, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 400 } }),
    ];
    const { events, sessionId } = await turn("c-openai", "Again, please");
    assert.deepEqual(events.find((e) => e.event === "usage")?.data, { input_tokens: 3600, output_tokens: 350 }, JSON.stringify(events));
    assert.deepEqual(await assistantTokens(sessionId), [[3600, 350]]);
    // 4000 + 3750 + 5600 = 13350 micro-USD.
    assertTotals(await totals(sessionId), [3600, 350, 0.01335]);
  });

  await check("a step whose stream repeats its usage report counts that step once: the last report stands, it is not added twice", async () => {
    await login(USERS.openaiOwner);
    steps = [
      // A provider that streams a running usage report and then the final one
      // for the same request: 1000 / 100 is this step's usage, not 1900 / 130.
      () =>
        sse([
          { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_r", type: "function", function: { name: "not_a_real_tool", arguments: "{}" } }] } }] },
          { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 900, completion_tokens: 30 } },
          { choices: [], usage: { prompt_tokens: 1000, completion_tokens: 100 } },
          "[DONE]",
        ]),
      textStep("Done.", { prompt_tokens: 1200, completion_tokens: 50 }),
    ];
    const { events, sessionId } = await turn("c-openai", "Once more, please");
    assert.deepEqual(
      (await rows(sessionId)).map((r) => [Number(r.input_tokens), Number(r.output_tokens), Number(r.cost_micro_usd)]),
      [
        [1000, 100, 4000],
        [1200, 50, 3750],
      ],
    );
    assert.deepEqual(events.find((e) => e.event === "usage")?.data, { input_tokens: 2200, output_tokens: 150 }, JSON.stringify(events));
    assert.deepEqual(await assistantTokens(sessionId), [[2200, 150]]);
    assertTotals(await totals(sessionId), [2200, 150, 0.00775]);
  });

  await check("a step the provider reports no usage for leaves the turn's tokens unknown: no usage event, a NULL message row, session totals unchanged", async () => {
    await login(USERS.openaiOwner);
    steps = [
      toolStep("call_x", { prompt_tokens: 1000, completion_tokens: 100 }),
      textStep("Done.", null),
    ];
    const { events, sessionId } = await turn("c-openai", "One more");
    const r = await rows(sessionId);
    assert.deepEqual(r.map((x) => [x.outcome, x.cost_micro_usd === null ? null : Number(x.cost_micro_usd)]), [["ok", 4000], ["ok", null]]);
    // Step 1's 1000 / 100 is not the turn's tokens: step 2's are unknown.
    assert.ok(!events.some((e) => e.event === "usage"), `a partial sum was sent as the turn's tokens: ${JSON.stringify(events)}`);
    assert.deepEqual(await assistantTokens(sessionId), [[null, null]]);
    assertTotals(await totals(sessionId), [0, 0, 0]);
  });

  console.log("OpenRouter: the cost OpenRouter reports per step");
  await check("each step is its own row at the cost OpenRouter reported for it, and the session adds all three", async () => {
    await login(USERS.routerOwner);
    sent = [];
    steps = [
      toolStep("call_1", { prompt_tokens: 800, completion_tokens: 40, cost: 0.001 }),
      toolStep("call_2", { prompt_tokens: 900, completion_tokens: 60, cost: 0.002 }),
      textStep("Router answer.", { prompt_tokens: 1000, completion_tokens: 120, cost: 0.0035 }),
    ];
    const { events, sessionId } = await turn("c-router", "Summarise the week");
    assert.equal(sent.filter((s) => s.url.includes("openrouter.ai")).length, 3, JSON.stringify(events));
    assert.deepEqual(
      (await rows(sessionId)).map((r) => [r.provider, Number(r.input_tokens), Number(r.output_tokens), Number(r.cost_micro_usd), r.cost_source]),
      [
        ["openrouter", 800, 40, 1000, "provider_reported"],
        ["openrouter", 900, 60, 2000, "provider_reported"],
        ["openrouter", 1000, 120, 3500, "provider_reported"],
      ],
    );
    assert.deepEqual(events.find((e) => e.event === "usage")?.data, { input_tokens: 2700, output_tokens: 220 });
    assertTotals(await totals(sessionId), [2700, 220, 0.0065]);
  });

  console.error = realError;
  if (failures > 0) {
    for (const l of logged.slice(-12)) realError(...l);
    console.log(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("ai usage openai tool loop tests passed");
}

main().catch((error) => {
  console.error = realError;
  console.error(error);
  process.exit(1);
});
