/**
 * ai-usage-chat-routes.test.ts — the workspace chat (/api/chat and
 * /api/chat/resume) against the AI usage ledger, driven for real.
 *
 * WHY (OASIS OS plan v2 §F2.6). tests/ai-usage-ledger.test.ts proves the meter;
 * this proves the two routes the main chat widget talks to use it the way the
 * owner sees it:
 *   - at the month's cap the answer is an HTTP 402 BEFORE any stream opens or
 *     any provider is asked, and its `error` is the plain sentence the widget
 *     shows (components/ChatWidget.tsx renders `error`, not `message`);
 *   - a local model (Ollama) in that same capped workspace still runs: it costs
 *     nothing per call, so no cap applies to it;
 *   - a budget table that exists but cannot be read answers 503 in the same
 *     shape, never a stream that runs uncapped;
 *   - chat_sessions keeps a turn's tokens and cost TOGETHER: a turn whose cost is
 *     unknown leaves the last known pair, never a $0 and never this turn's
 *     tokens beside an older cost;
 *   - a session id from the body that is not the caller's own is not written
 *     into, and the turn's usage row is not filed under it.
 *
 * Everything runs against a local libSQL file with bravo__192 applied as the
 * lead applies it: the real signed session cookie, the real Turso adapter, the
 * real route handlers. next/headers and next/navigation are the only stand-ins
 * (as in tests/os-channels-honest.test.ts), and the provider is a stubbed
 * global fetch that records what it was sent.
 *
 * Run: node --conditions=react-server --import tsx tests/ai-usage-chat-routes.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createClient } from "@libsql/client";

const dbFile = join(mkdtempSync(join(tmpdir(), "ai-usage-chat-routes-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
process.env.EMPIRE_AUTH_BACKEND = "turso";
process.env.AUTH_SESSION_SECRET = "ai-usage-chat-routes-secret-long-enough-0000001";
process.env.BRAVO_FIELD_ENCRYPTION_KEY = "ai-usage-chat-routes-field-key-long-enough-001";
process.env.CHAT_RESUME_HMAC_KEY = "ai-usage-chat-routes-resume-hmac-key-long-0001";
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

// Two client workspaces: one AT its monthly cap, one with no cap.
const CAPPED = "7c7c7c7c-0000-4000-8000-00000000007c";
const OPEN = "6b6b6b6b-0000-4000-8000-00000000006b";
type U = { id: string; email: string };
const u = (n: number, email: string): U => ({ id: `0f000000-0000-4000-8000-${String(n).padStart(12, "0")}`, email });
const USERS = {
  cappedOwner: u(11, "owner@capped.test"), // the capped workspace's workspace key (Anthropic)
  cappedLocal: u(12, "local@capped.test"), // a teammate there whose own override is a local Ollama server
  openOwner: u(13, "owner@open.test"),
} as const;
const SENTENCE = "This month's AI budget is used. The owner can raise it.";
const UNAVAILABLE = "We could not check this workspace's AI budget just now. Try again in a moment.";

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

// ── provider stub ────────────────────────────────────────────────────────
type Sent = { url: string; body: string };
let sent: Sent[] = [];
let provider: (s: Sent) => Response = () => new Response("unset", { status: 599 });
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const s = { url: String(input instanceof Request ? input.url : input), body: String(init?.body ?? "") };
  sent.push(s);
  return provider(s);
}) as typeof fetch;
function sse(frames: Array<[string | null, unknown]>): Response {
  const body = frames.map(([e, d]) => `${e ? `event: ${e}\n` : ""}data: ${typeof d === "string" ? d : JSON.stringify(d)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}
const anthropicOk = (text: string, input: number, output: number) =>
  sse([
    ["message_start", { message: { usage: { input_tokens: input, output_tokens: 1 } } }],
    ["content_block_start", { index: 0, content_block: { type: "text" } }],
    ["content_block_delta", { index: 0, delta: { type: "text_delta", text } }],
    ["content_block_stop", { index: 0 }],
    ["message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: output } }],
    ["message_stop", {}],
  ]);
/** A reply that breaks off after its first frame: the provider never reports the call's usage. */
function anthropicBroken(): Response {
  const first = new TextEncoder().encode(`event: message_start\ndata: ${JSON.stringify({ message: { usage: { input_tokens: 10, output_tokens: 1 } } })}\n\n`);
  let pulled = false;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!pulled) {
          pulled = true;
          controller.enqueue(first);
        } else controller.error(new Error("connection reset"));
      },
    }),
    { status: 200 },
  );
}

// ── console.error capture ────────────────────────────────────────────────
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
    CREATE TABLE chat_sessions (id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), tenant_id TEXT NOT NULL,
      user_id TEXT, agent_key TEXT, provider TEXT, model TEXT, title TEXT,
      total_input_tokens INTEGER NOT NULL DEFAULT 0, total_output_tokens INTEGER NOT NULL DEFAULT 0,
      estimated_cost_usd REAL NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));
    CREATE TABLE chat_messages (id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), session_id TEXT, tenant_id TEXT,
      role TEXT, content TEXT, input_tokens INTEGER, output_tokens INTEGER, latency_ms INTEGER, error TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));
  `);
  await db.executeMultiple(readFileSync(join(process.cwd(), "database/turso/bravo__192_ai_usage.sql"), "utf8"));
  const { encryptField } = await import("../lib/field-encryption");
  const stamp = "2026-09-01T00:00:00Z";
  const profile = (id: string, user: U, tenant: string, role: string, owner: 0 | 1) => ({
    sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, onboarding_completed_at, full_name, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'Test Person', ?)`,
    args: [id, user.id, user.email, tenant, role, owner, stamp, stamp],
  });
  const config = (id: string, tenant: string, userId: string | null, prov: string, model: string, key: string) => ({
    sql: `INSERT INTO agent_model_config (id, tenant_id, user_id, agent_key, provider, model, encrypted_api_key, enabled, updated_at)
          VALUES (?, ?, ?, 'bravo', ?, ?, ?, 1, ?)`,
    args: [id, tenant, userId, prov, model, encryptField(key), stamp],
  });
  const period = new Date().toISOString().slice(0, 7);
  await db.batch(
    [
      ...Object.values(USERS).map((x) => ({ sql: `INSERT INTO "_supabase_auth_users" (id, email) VALUES (?, ?)`, args: [x.id, x.email] })),
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'capped-co', 'Capped Co')", args: [CAPPED] },
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'open-co', 'Open Co')", args: [OPEN] },
      profile("p-capped-owner", USERS.cappedOwner, CAPPED, "owner", 1),
      profile("p-capped-local", USERS.cappedLocal, CAPPED, "owner", 0),
      profile("p-open-owner", USERS.openOwner, OPEN, "owner", 1),
      config("c-capped", CAPPED, null, "anthropic", "claude-sonnet-4-6", "sk-ant-capped-0001"),
      // Ollama: the "key" is the local server's URL.
      config("c-capped-local", CAPPED, USERS.cappedLocal.id, "ollama", "llama3.3", "http://127.0.0.1:11434/v1"),
      config("c-open", OPEN, null, "anthropic", "claude-sonnet-4-6", "sk-ant-open-0001"),
      {
        sql: `INSERT INTO tenant_ai_budgets (tenant_id, period_month, cap_micro_usd, reserved_micro_usd, spent_micro_usd, created_at, updated_at)
              VALUES (?, ?, 1000, 0, 1000, ?, ?)`,
        args: [CAPPED, period, stamp, stamp],
      },
    ],
    "write",
  );

  const chatRoute = await import("../app/api/chat/route");
  const resumeRoute = await import("../app/api/chat/resume/route");
  const { signResumeState } = await import("../lib/resume-hmac");
  const { NextRequest } = await import("next/server");
  const post = (path: string, body: Record<string, unknown>) =>
    new NextRequest(`http://localhost${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const turn = (text: string, extra: Record<string, unknown> = {}) =>
    chatRoute.POST(post("/api/chat", { agent_key: "bravo", cloud_tools: "off", messages: [{ role: "user", content: text }], ...extra }));
  /**
   * The route persists AFTER it closes the stream, so reading the body is not
   * the end of the turn. Its last write for a workspace-key turn stamps the key's
   * last_used_at (after chat_sessions), so a turn is over once that is set again.
   */
  const settledTurn = async (configId: string, text: string, extra: Record<string, unknown> = {}) => {
    await db.execute({ sql: "UPDATE agent_model_config SET last_used_at = NULL WHERE id = ?", args: [configId] });
    const res = await turn(text, extra);
    const body = res.status === 200 ? await res.text() : "";
    for (let i = 0; i < 200; i += 1) {
      const r = await db.execute({ sql: "SELECT last_used_at FROM agent_model_config WHERE id = ?", args: [configId] });
      if (r.rows[0]?.last_used_at) return { res, events: parseSse(body) };
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("the turn never finished its writes");
  };
  const count = async (sql: string, args: (string | number)[] = []) => Number((await db.execute({ sql, args })).rows[0]?.n ?? 0);
  const usageRows = async (tenant: string) =>
    (await db.execute({ sql: "SELECT * FROM ai_usage_events WHERE tenant_id = ? ORDER BY id", args: [tenant] })).rows;
  const session = async (id: string) =>
    (await db.execute({ sql: "SELECT tenant_id, user_id, total_input_tokens, total_output_tokens, estimated_cost_usd, updated_at FROM chat_sessions WHERE id = ?", args: [id] })).rows[0];

  console.log("the cap");
  await check("/api/chat at the month's cap: HTTP 402 before any stream, the sentence in `error`, no provider asked, nothing written", async () => {
    await login(USERS.cappedOwner);
    sent = [];
    const sessionsBefore = await count("SELECT COUNT(*) AS n FROM chat_sessions");
    const res = await turn("What changed this week?");
    assert.equal(res.status, 402);
    assert.deepEqual(await res.json(), { ok: false, error: SENTENCE, code: "ai_budget_exhausted", message: SENTENCE });
    assert.equal(sent.length, 0, "a provider was asked");
    assert.equal(await count("SELECT COUNT(*) AS n FROM chat_sessions"), sessionsBefore, "a refused turn opened a session");
    assert.equal((await usageRows(CAPPED)).length, 0, "the pre-stream refusal sent no model call, so it has no call row");
  });

  await check("/api/chat/resume at the cap: HTTP 402 in the same shape, before the resumed call", async () => {
    await login(USERS.cappedOwner);
    sent = [];
    const state = { model: "claude-sonnet-4-6", system: "sys", history: [], iteration: 0, totalIn: 0, totalOut: 0 };
    const sig = signResumeState(state, { tenant_id: CAPPED, user_id: USERS.cappedOwner.id, agent_key: "bravo" });
    assert.ok(sig, "the test signs its resume state");
    const res = await resumeRoute.POST(
      post("/api/chat/resume", { agent_key: "bravo", resume_state: state, resume_signature: sig, tool_use_id: "tu_1", tool_result: { content: "{}", is_error: false } }),
    );
    assert.equal(res.status, 402);
    assert.deepEqual(await res.json(), { ok: false, error: SENTENCE, code: "ai_budget_exhausted", message: SENTENCE });
    assert.equal(sent.length, 0);
  });

  await check("a local model in the same capped workspace still runs: it costs nothing per call, so no cap applies", async () => {
    await login(USERS.cappedLocal);
    sent = [];
    provider = (s) =>
      s.url.startsWith("http://127.0.0.1:11434")
        ? sse([
            [null, { choices: [{ delta: { content: "local reply" } }] }],
            [null, { choices: [{ delta: {}, finish_reason: "stop" }] }],
            [null, { choices: [], usage: { prompt_tokens: 7, completion_tokens: 3 } }],
            [null, "[DONE]"],
          ])
        : new Response("unexpected", { status: 599 });
    const res = await turn("Summarise my notes");
    assert.equal(res.status, 200);
    const events = parseSse(await res.text());
    assert.ok(events.some((e) => e.event === "delta" && e.data.text === "local reply"), JSON.stringify(events));
    assert.ok(!events.some((e) => e.event === "error"), JSON.stringify(events));
    assert.ok(sent.some((s) => s.url.startsWith("http://127.0.0.1:11434")), "the local server was asked");
    const rows = await usageRows(CAPPED);
    assert.deepEqual(rows.map((r) => [r.billing_mode, r.outcome, r.cost_micro_usd, r.reserved_micro_usd]), [["local", "ok", null, null]]);
  });

  console.log("chat_sessions totals");
  let openSession = "";
  await check("a turn with a known cost writes its tokens and cost together", async () => {
    await login(USERS.openOwner);
    provider = () => anthropicOk("known", 1000, 200);
    const { res, events } = await settledTurn("c-open", "First question");
    assert.equal(res.status, 200);
    openSession = String(events.find((e) => e.event === "session")?.data.session_id || "");
    assert.ok(openSession, JSON.stringify(events));
    const s = await session(openSession);
    // 1000 in x $3 + 200 out x $15 = 6000 micro-USD.
    assert.deepEqual([Number(s.total_input_tokens), Number(s.total_output_tokens), Number(s.estimated_cost_usd)], [1000, 200, 0.006]);
  });

  await check("a turn whose cost is unknown leaves the last known tokens and cost, never $0 and never a mismatched pair", async () => {
    await login(USERS.openOwner);
    provider = () => anthropicBroken();
    const { events } = await settledTurn("c-open", "Second question", { session_id: openSession });
    assert.ok(events.some((e) => e.event === "error"), "the broken reply reached the widget as an error");
    const s = await session(openSession);
    assert.deepEqual([Number(s.total_input_tokens), Number(s.total_output_tokens), Number(s.estimated_cost_usd)], [1000, 200, 0.006]);
    const rows = await usageRows(OPEN);
    assert.deepEqual(rows.map((r) => [r.session_id, r.outcome, r.cost_micro_usd === null ? null : Number(r.cost_micro_usd)]), [
      [openSession, "ok", 6000],
      [openSession, "error", null],
    ]);
  });

  await check("a session id that is not the caller's is not written into, and the turn's usage is not filed under it", async () => {
    // A session that belongs to the OTHER workspace.
    const foreign = "f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0";
    await db.execute({
      sql: `INSERT INTO chat_sessions (id, tenant_id, user_id, agent_key, provider, model, title, total_input_tokens, total_output_tokens, estimated_cost_usd, updated_at)
            VALUES (?, ?, ?, 'bravo', 'anthropic', 'claude-sonnet-4-6', 'theirs', 5, 5, 0.5, '2026-09-01T00:00:00.000Z')`,
      args: [foreign, CAPPED, USERS.cappedOwner.id],
    });
    await login(USERS.openOwner);
    provider = () => anthropicOk("mine", 10, 2);
    const { res, events } = await settledTurn("c-open", "Write into someone else's session", { session_id: foreign });
    assert.equal(res.status, 200);
    const used = String(events.find((e) => e.event === "session")?.data.session_id || "");
    assert.ok(used && used !== foreign, "the turn was filed under the foreign session");
    assert.deepEqual(await session(foreign), {
      tenant_id: CAPPED,
      user_id: USERS.cappedOwner.id,
      total_input_tokens: 5,
      total_output_tokens: 5,
      estimated_cost_usd: 0.5,
      updated_at: "2026-09-01T00:00:00.000Z",
    });
    assert.equal(await count("SELECT COUNT(*) AS n FROM chat_messages WHERE session_id = ?", [foreign]), 0);
    assert.equal(await count("SELECT COUNT(*) AS n FROM ai_usage_events WHERE session_id = ?", [foreign]), 0);
    assert.equal(String((await session(used)).tenant_id), OPEN);
    // The caller's OWN session id is kept (the previous check's turn used it).
    assert.equal(await count("SELECT COUNT(*) AS n FROM chat_messages WHERE session_id = ?", [openSession]), 4);
  });

  console.log("/api/chat/resume totals");
  const resume = async (sessionId: string, model = "claude-sonnet-4-6") => {
    const state = { model, system: "sys", history: [{ role: "user", content: "go" }, { role: "assistant", content: [{ type: "tool_use", id: "tu_r", name: "read_file", input: {} }] }], iteration: 1, totalIn: 0, totalOut: 0 };
    const sig = signResumeState(state, { tenant_id: OPEN, user_id: USERS.openOwner.id, agent_key: "bravo" });
    const res = await resumeRoute.POST(
      post("/api/chat/resume", { agent_key: "bravo", session_id: sessionId, resume_state: state, resume_signature: sig, tool_use_id: "tu_r", tool_result: { content: "file text", is_error: false } }),
    );
    return { res, events: parseSse(await res.text()) };
  };
  /** The resume route's last write is the session row's updated_at. */
  const afterResume = async (sessionId: string, run: () => Promise<unknown>) => {
    await db.execute({ sql: "UPDATE chat_sessions SET updated_at = 'before' WHERE id = ?", args: [sessionId] });
    await run();
    for (let i = 0; i < 200; i += 1) {
      if ((await session(sessionId)).updated_at !== "before") return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("the resumed turn never finished its writes");
  };
  await check("a resumed turn with a known cost adds its tokens AND its cost to the session", async () => {
    await login(USERS.openOwner);
    provider = () => anthropicOk("resumed", 40, 4);
    await afterResume(openSession, async () => assert.equal((await resume(openSession)).res.status, 200));
    const s = await session(openSession);
    // + 40 in x $3 + 4 out x $15 = 180 micro-USD.
    assert.deepEqual([Number(s.total_input_tokens), Number(s.total_output_tokens)], [1040, 204]);
    assert.ok(Math.abs(Number(s.estimated_cost_usd) - 0.00618) < 1e-12, String(s.estimated_cost_usd));
  });

  await check("a resumed turn whose cost is unknown adds nothing: tokens and cost stay a matching pair", async () => {
    await login(USERS.openOwner);
    const before = await session(openSession);
    // The reply completes and reports its tokens, but the model has no verified price: the cost is unknown.
    provider = () => anthropicOk("resumed", 40, 4);
    await afterResume(openSession, async () => {
      const { events } = await resume(openSession, "claude-not-a-real-model");
      assert.ok(events.some((e) => e.event === "usage" || e.event === "delta"), JSON.stringify(events));
    });
    const rows = await usageRows(OPEN);
    assert.deepEqual([rows.at(-1)?.model, rows.at(-1)?.cost_micro_usd, Number(rows.at(-1)?.input_tokens)], ["claude-not-a-real-model", null, 40]);
    const s = await session(openSession);
    assert.deepEqual(
      [s.total_input_tokens, s.total_output_tokens, s.estimated_cost_usd].map(Number),
      [before.total_input_tokens, before.total_output_tokens, before.estimated_cost_usd].map(Number),
    );
  });

  await check("a resumed turn with a session id that is not the caller's writes nothing into it", async () => {
    await login(USERS.openOwner);
    const foreign = "f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0";
    const before = await session(foreign);
    const usageBefore = await count("SELECT COUNT(*) AS n FROM ai_usage_events WHERE session_id = ?", [foreign]);
    provider = () => anthropicOk("resumed", 40, 4);
    const { res, events } = await resume(foreign);
    assert.equal(res.status, 200);
    assert.ok(!events.some((e) => e.event === "session" && e.data.session_id === foreign), "the stream claimed the foreign session");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(await session(foreign), before);
    assert.equal(await count("SELECT COUNT(*) AS n FROM chat_messages WHERE session_id = ?", [foreign]), 0);
    assert.equal(await count("SELECT COUNT(*) AS n FROM ai_usage_events WHERE session_id = ?", [foreign]), usageBefore);
  });

  console.log("an unreadable budget");
  await check("a budget table that exists but cannot be read: HTTP 503 with the sentence in `error`, no stream, no provider", async () => {
    await db.executeMultiple(`
      ALTER TABLE tenant_ai_budgets RENAME TO tenant_ai_budgets_saved;
      CREATE TABLE tenant_ai_budgets (tenant_id TEXT NOT NULL);
    `);
    try {
      await login(USERS.openOwner);
      sent = [];
      const res = await turn("Anything");
      assert.equal(res.status, 503);
      assert.deepEqual(await res.json(), { ok: false, error: UNAVAILABLE, code: "ai_usage_unavailable", message: UNAVAILABLE });
      assert.equal(sent.length, 0);
    } finally {
      await db.executeMultiple(`
        DROP TABLE tenant_ai_budgets;
        ALTER TABLE tenant_ai_budgets_saved RENAME TO tenant_ai_budgets;
      `);
    }
  });

  console.error = realError;
  if (failures > 0) {
    for (const l of logged.slice(-12)) realError(...l);
    console.log(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("ai usage chat route tests passed");
}

main().catch((error) => {
  console.error = realError;
  console.error(error);
  process.exit(1);
});
