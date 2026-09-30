/**
 * chat-resume-signature.test.ts: a paused chat turn resumes with the
 * signature /api/chat emitted for it.
 *
 * WHY. When the model asks for a tool that runs on the owner's own machine
 * (send_email, read_file, bash...), /api/chat pauses the turn and sends the
 * browser a resume_state with an HMAC signature (lib/resume-hmac.ts). The
 * browser runs the tool and posts both back to /api/chat/resume. Production
 * has CHAT_RESUME_HMAC_KEY set, and every such resume was refused with
 * resume_signature_invalid: the signer hashed the state as the tool loop built
 * it, keys with an undefined value included (resume_state.maxTokens is
 * undefined on every chat turn), while the verifier hashed what came back
 * through JSON, which drops those keys. The tool had already run on the
 * owner's machine; the model never got to say what happened.
 *
 * It also checks what the signature must keep doing: it binds the state to the
 * workspace, the person and the agent it was issued to; the state names the
 * chat session it belongs to, and the resumed half is filed under THAT
 * session (the browser can send a stale or empty session id: ChatWidget reads
 * it from a closure taken before the turn's session event); anything edited in
 * the browser is refused; the comparison stays constant-time.
 *
 * Real libSQL file with bravo__192 applied, the real session cookie, the real
 * route handlers and the real HMAC helper with a key set. next/headers and
 * next/navigation are the only stand-ins; the model provider is a stubbed
 * global fetch.
 *
 * Run: node --conditions=react-server --import tsx tests/chat-resume-signature.test.ts
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createClient } from "@libsql/client";

const HMAC_KEY = "chat-resume-signature-test-hmac-key-0000000001";
const dbFile = join(mkdtempSync(join(tmpdir(), "chat-resume-signature-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
process.env.EMPIRE_AUTH_BACKEND = "turso";
process.env.AUTH_SESSION_SECRET = "chat-resume-signature-secret-long-enough-000001";
process.env.BRAVO_FIELD_ENCRYPTION_KEY = "chat-resume-signature-field-key-long-enough-01";
process.env.CHAT_RESUME_HMAC_KEY = HMAC_KEY;
delete process.env.BRAVO_RESUME_HMAC_KEY;
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

// OASIS's own workspace (lib/ai/tools/client-safe-registry.ts) is the only
// kind offered a bridge tool, so the only kind whose turn can pause.
const OASIS = "ef8d389e-3f15-43f2-ae00-3660f69a1452";
const OTHER = "5a5a5a5a-0000-4000-8000-00000000005a";
type U = { id: string; email: string };
const u = (n: number, email: string): U => ({ id: `0e000000-0000-4000-8000-${String(n).padStart(12, "0")}`, email });
const USERS = {
  oasisOwner: u(21, "owner@oasis.test"),
  otherOwner: u(22, "owner@other.test"),
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
/** The model asks for one tool; send_email runs on the owner's machine, so the turn pauses. */
const anthropicToolUse = (id: string, name: string, input: number, output: number) =>
  sse([
    ["message_start", { message: { usage: { input_tokens: input, output_tokens: 1 } } }],
    ["content_block_start", { index: 0, content_block: { type: "tool_use", id, name, input: {} } }],
    ["content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: '{"to":"someone@example.test"}' } }],
    ["content_block_stop", { index: 0 }],
    ["message_delta", { delta: { stop_reason: "tool_use" }, usage: { output_tokens: output } }],
    ["message_stop", {}],
  ]);

const logged: unknown[][] = [];
const realError = console.error;
console.error = (...args: unknown[]) => void logged.push(args);

type Ev = { event: string; data: Record<string, unknown> };
/** Parses the SSE body the way the browser does: each frame's data is JSON.parse'd. */
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

/** An independent canonical form (sorted keys) of a JSON-only value, for the v1 compatibility check. */
function sortedJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(sortedJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${sortedJson(o[k])}`).join(",")}}`;
}

async function main() {
  const { signResumeState, verifyResumeState } = await import("../lib/resume-hmac");
  const binding = { tenant_id: OASIS, user_id: USERS.oasisOwner.id, agent_key: "bravo" };
  /** A resume_state as the tool loop builds it: maxTokens and toolPalette are undefined on a chat turn. */
  const loopState = () => ({
    model: "claude-sonnet-4-6",
    system: "sys",
    history: [
      { role: "user", content: "Email the client" },
      { role: "assistant", content: [{ type: "tool_use", id: "tu_1", name: "send_email", input: { to: "someone@example.test" } }] },
    ],
    iteration: 0,
    totalIn: 1000,
    totalOut: 200,
    maxTokens: undefined,
    enableTools: true,
    toolPalette: undefined,
    chatMode: "build",
    excludeDeferredTools: false,
    bridgeAdvertisedTools: null,
    sessionId: "5e55105e55105e55105e55105e55105e",
  });
  /** What the resume route receives: the state after JSON.stringify (SSE) and JSON.parse (browser, then req.json()). */
  const overTheWire = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

  console.log("the signing helper");
  await check("a state the tool loop emits verifies after the trip through JSON the browser makes", () => {
    const state = loopState();
    const sig = signResumeState(state, binding);
    assert.ok(sig && sig.startsWith("v1."), String(sig));
    assert.deepEqual(verifyResumeState(overTheWire(state), sig, binding), { ok: true, binding });
    // A second trip (the resume route re-emits the state it was given) changes nothing either.
    assert.deepEqual(verifyResumeState(overTheWire(overTheWire(state)), sig, binding), { ok: true, binding });
  });

  await check("a state with nothing JSON would drop signs exactly as v1 always did (no signature changes meaning)", () => {
    const state = overTheWire(loopState());
    const expected = `v1.${createHmac("sha256", Buffer.from(HMAC_KEY, "utf8")).update(sortedJson({ state, binding }), "utf8").digest("base64url")}`;
    assert.equal(signResumeState(state, binding), expected);
  });

  await check("any change to what the state says is refused: tokens, history, model, the session it names", () => {
    const state = loopState();
    const sig = signResumeState(state, binding);
    const edits: Array<(s: Record<string, unknown>) => void> = [
      (s) => void (s.totalIn = 0),
      (s) => void (s.totalOut = 1),
      (s) => void (s.model = "claude-opus-4-1"),
      (s) => void (s.maxTokens = 64000),
      (s) => void (s.toolPalette = ["bash"]),
      (s) => void (s.chatMode = "build-all"),
      (s) => void (s.sessionId = "0therse55105e55105e55105e55105e0"),
      (s) => void delete s.sessionId,
      (s) => void ((s.history as Array<Record<string, unknown>>)[0].content = "Email everyone"),
    ];
    for (const edit of edits) {
      const tampered = overTheWire(state) as unknown as Record<string, unknown>;
      edit(tampered);
      assert.deepEqual(verifyResumeState(tampered, sig, binding), { ok: false, reason: "invalid" }, edit.toString());
    }
  });

  await check("the signature is bound to the workspace, the person and the agent it was issued to", () => {
    const state = loopState();
    const sig = signResumeState(state, binding);
    for (const other of [
      { ...binding, tenant_id: OTHER },
      { ...binding, user_id: USERS.otherOwner.id },
      { ...binding, agent_key: "maven" },
    ]) {
      assert.deepEqual(verifyResumeState(overTheWire(state), sig, other), { ok: false, reason: "invalid" }, JSON.stringify(other));
    }
    assert.deepEqual(verifyResumeState(overTheWire(state), sig, undefined), { ok: false, reason: "invalid" });
  });

  await check("missing, foreign-version and malformed signatures are refused by name", () => {
    const state = loopState();
    assert.deepEqual(verifyResumeState(state, "", binding), { ok: false, reason: "missing_signature" });
    assert.deepEqual(verifyResumeState(state, undefined, binding), { ok: false, reason: "missing_signature" });
    assert.deepEqual(verifyResumeState(state, "v2.abc", binding), { ok: false, reason: "version_mismatch" });
    assert.deepEqual(verifyResumeState(state, "v1.", binding), { ok: false, reason: "missing_signature" });
    assert.deepEqual(verifyResumeState(state, "v1.dG9vLXNob3J0", binding), { ok: false, reason: "invalid" });
  });

  await check("the comparison is constant-time: every same-length signature goes through crypto.timingSafeEqual", () => {
    // lib/resume-hmac.ts imports timingSafeEqual from "crypto"; the compiled
    // module reads it off the module object at call time, so this counts calls.
    const nodeCrypto = require("crypto") as typeof import("crypto");
    const real = nodeCrypto.timingSafeEqual;
    let calls = 0;
    nodeCrypto.timingSafeEqual = ((a: NodeJS.ArrayBufferView, b: NodeJS.ArrayBufferView) => {
      calls += 1;
      return real(a, b);
    }) as typeof real;
    try {
      const state = loopState();
      const sig = signResumeState(state, binding)!;
      assert.equal(verifyResumeState(overTheWire(state), sig, binding).ok, true);
      // Same length, last character changed: refused, and still compared in constant time.
      const flipped = sig.slice(0, -2) + (sig.slice(-2) === "AA" ? "AB" : "AA");
      assert.deepEqual(verifyResumeState(overTheWire(state), flipped, binding), { ok: false, reason: "invalid" });
      assert.equal(calls, 2, "a signature was compared without timingSafeEqual");
    } finally {
      nodeCrypto.timingSafeEqual = real;
    }
    const src = readFileSync(join(process.cwd(), "lib/resume-hmac.ts"), "utf8");
    assert.doesNotMatch(src, /(provided|expected|sig)\s*[!=]==\s*(provided|expected|sig)\b/, "a signature is compared with ===");
  });

  // ── the routes ─────────────────────────────────────────────────────────
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
  const config = (id: string, tenant: string, key: string) => ({
    sql: `INSERT INTO agent_model_config (id, tenant_id, user_id, agent_key, provider, model, encrypted_api_key, enabled, updated_at)
          VALUES (?, ?, NULL, 'bravo', 'anthropic', 'claude-sonnet-4-6', ?, 1, ?)`,
    args: [id, tenant, encryptField(key), stamp],
  });
  await db.batch(
    [
      ...Object.values(USERS).map((x) => ({ sql: `INSERT INTO "_supabase_auth_users" (id, email) VALUES (?, ?)`, args: [x.id, x.email] })),
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'oasis-ai-cc', 'OASIS')", args: [OASIS] },
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'other-co', 'Other Co')", args: [OTHER] },
      profile("p-oasis-owner", USERS.oasisOwner, OASIS),
      profile("p-other-owner", USERS.otherOwner, OTHER),
      config("c-oasis", OASIS, "sk-ant-oasis-0001"),
      config("c-other", OTHER, "sk-ant-other-0001"),
      // OASIS's paired machine is online, so its chat is offered the bridge tools (send_email among them).
      { sql: "INSERT INTO bridge_pairings (id, tenant_id, last_seen_at) VALUES ('bp-oasis', ?, ?)", args: [OASIS, new Date().toISOString()] },
    ],
    "write",
  );

  const chatRoute = await import("../app/api/chat/route");
  const resumeRoute = await import("../app/api/chat/resume/route");
  const { NextRequest } = await import("next/server");
  /** The browser's POST: the body is JSON.stringify'd, as ChatWidget does. */
  const post = (path: string, body: Record<string, unknown>) =>
    new NextRequest(`http://localhost${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const count = async (sql: string, args: (string | number)[] = []) => Number((await db.execute({ sql, args })).rows[0]?.n ?? 0);
  const session = async (id: string) =>
    (await db.execute({ sql: "SELECT total_input_tokens, total_output_tokens, estimated_cost_usd, updated_at FROM chat_sessions WHERE id = ?", args: [id] })).rows[0];
  const totals = async (id: string) => {
    const s = await session(id);
    return [Number(s.total_input_tokens), Number(s.total_output_tokens), Number(s.estimated_cost_usd)];
  };
  const assertTotals = (got: number[], want: [number, number, number]) => {
    assert.deepEqual(got.slice(0, 2), want.slice(0, 2), `tokens ${JSON.stringify(got)} != ${JSON.stringify(want)}`);
    assert.ok(Math.abs(got[2] - want[2]) < 1e-12, `cost ${got[2]} != ${want[2]}`);
  };

  /** One /api/chat turn that pauses on send_email; waits for its writes (the key's last_used_at is the last one). */
  const pausedTurn = async (text: string, extra: Record<string, unknown> = {}) => {
    await db.execute("UPDATE agent_model_config SET last_used_at = NULL WHERE id = 'c-oasis'");
    provider = () => anthropicToolUse("tu_send", "send_email", 1000, 200);
    const res = await chatRoute.POST(post("/api/chat", { agent_key: "bravo", cloud_tools: "tools", messages: [{ role: "user", content: text }], ...extra }));
    const body = await res.text();
    assert.equal(res.status, 200, body);
    for (let i = 0; i < 200; i += 1) {
      const r = await db.execute("SELECT last_used_at FROM agent_model_config WHERE id = 'c-oasis'");
      if (r.rows[0]?.last_used_at) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const events = parseSse(body);
    const sessionId = String(events.find((e) => e.event === "session")?.data.session_id || "");
    const pending = events.find((e) => e.event === "tool_use_pending")?.data;
    assert.ok(sessionId && pending, JSON.stringify(events));
    return { sessionId, pending: pending as { tool_use_id: string; resume_state: Record<string, unknown>; resume_signature: string } };
  };
  /** The browser's resume POST; waits for the route's last write (the session row's updated_at) when it opened a stream. */
  const resumeAs = async (
    body: { resume_state: unknown; resume_signature: unknown; session_id?: unknown; tool_use_id?: string },
    waitOn: string | null,
  ) => {
    if (waitOn) await db.execute({ sql: "UPDATE chat_sessions SET updated_at = 'before' WHERE id = ?", args: [waitOn] });
    const res = await resumeRoute.POST(
      post("/api/chat/resume", {
        agent_key: "bravo",
        session_id: body.session_id ?? null,
        resume_state: body.resume_state,
        resume_signature: body.resume_signature,
        tool_use_id: body.tool_use_id ?? "tu_send",
        tool_result: { content: "sent", is_error: false },
      }),
    );
    const text = await res.text();
    if (res.status === 200 && waitOn) {
      for (let i = 0; i < 200; i += 1) {
        if ((await session(waitOn)).updated_at !== "before") break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    return { status: res.status, text, events: res.status === 200 ? parseSse(text) : [] };
  };

  console.log("/api/chat -> the browser -> /api/chat/resume, with the signing key set");
  let first: Awaited<ReturnType<typeof pausedTurn>> | null = null;
  await check("a paused turn resumes with the signature /api/chat emitted, even when the browser sends no session id", async () => {
    await login(USERS.oasisOwner);
    first = await pausedTurn("Email the client");
    // The state names the session it belongs to, and it is signed with it.
    assert.equal(first.pending.resume_state.sessionId, first.sessionId);
    assert.ok(String(first.pending.resume_signature).startsWith("v1."), String(first.pending.resume_signature));
    assertTotals(await totals(first.sessionId), [1000, 200, 0.006]);

    sent = [];
    provider = () => anthropicOk("Sent. The client has it.", 40, 4);
    // ChatWidget posts the session id from a closure taken before this turn's
    // session event: on a new conversation that is null.
    const r = await resumeAs({ resume_state: first.pending.resume_state, resume_signature: first.pending.resume_signature, session_id: null }, first.sessionId);
    assert.equal(r.status, 200, r.text);
    assert.ok(!r.events.some((e) => e.event === "error"), JSON.stringify(r.events));
    assert.ok(r.events.some((e) => e.event === "delta" && e.data.text === "Sent. The client has it."), JSON.stringify(r.events));
    assert.deepEqual(r.events.find((e) => e.event === "usage")?.data, { input_tokens: 1040, output_tokens: 204 });
    assert.equal(sent.length, 1, "the resumed call was not sent exactly once");
    // Filed under the session the state was issued for: the call's usage row,
    // the resumed message, and the session's running totals.
    const row = (await db.execute({ sql: "SELECT surface, session_id, input_tokens, output_tokens, cost_micro_usd FROM ai_usage_events ORDER BY id DESC LIMIT 1" })).rows[0];
    assert.deepEqual([row.surface, row.session_id, Number(row.input_tokens), Number(row.output_tokens), Number(row.cost_micro_usd)], ["chat.resume", first.sessionId, 40, 4, 180]);
    assert.equal(await count("SELECT COUNT(*) AS n FROM chat_messages WHERE session_id = ? AND content LIKE '[resume after tool:%'", [first.sessionId]), 1);
    assertTotals(await totals(first.sessionId), [1040, 204, 0.00618]);
  });

  await check("a resume_state edited in the browser is refused before any model call", async () => {
    await login(USERS.oasisOwner);
    assert.ok(first, "the previous check paused a turn");
    const tampered = JSON.parse(JSON.stringify(first.pending.resume_state)) as Record<string, unknown>;
    tampered.totalIn = 0; // would make the resumed half look like the whole turn
    sent = [];
    const r = await resumeAs({ resume_state: tampered, resume_signature: first.pending.resume_signature }, null);
    assert.equal(r.status, 400);
    assert.deepEqual(JSON.parse(r.text), { ok: false, error: "resume_signature_invalid" });
    assert.equal(sent.length, 0);
  });

  await check("the emitted signature does not resume the turn in another workspace", async () => {
    assert.ok(first, "the first check paused a turn");
    await login(USERS.otherOwner);
    sent = [];
    const usageBefore = await count("SELECT COUNT(*) AS n FROM ai_usage_events");
    const r = await resumeAs({ resume_state: first.pending.resume_state, resume_signature: first.pending.resume_signature, session_id: first.sessionId }, null);
    assert.equal(r.status, 400);
    assert.deepEqual(JSON.parse(r.text), { ok: false, error: "resume_signature_invalid" });
    assert.equal(sent.length, 0);
    assert.equal(await count("SELECT COUNT(*) AS n FROM ai_usage_events"), usageBefore);
  });

  await check("a resumed turn that pauses again emits a signature the next resume accepts, for the same session", async () => {
    await login(USERS.oasisOwner);
    const paused = await pausedTurn("Email both clients");
    provider = () => anthropicToolUse("tu_send_2", "send_email", 30, 3);
    const again = await resumeAs({ resume_state: paused.pending.resume_state, resume_signature: paused.pending.resume_signature }, paused.sessionId);
    assert.equal(again.status, 200, again.text);
    const pending2 = again.events.find((e) => e.event === "tool_use_pending")?.data as
      | { tool_use_id: string; resume_state: Record<string, unknown>; resume_signature: string }
      | undefined;
    assert.ok(pending2, JSON.stringify(again.events));
    assert.equal(pending2.resume_state.sessionId, paused.sessionId);
    provider = () => anthropicOk("Both sent.", 20, 2);
    const done = await resumeAs(
      { resume_state: pending2.resume_state, resume_signature: pending2.resume_signature, tool_use_id: pending2.tool_use_id },
      paused.sessionId,
    );
    assert.equal(done.status, 200, done.text);
    assert.ok(!done.events.some((e) => e.event === "error"), JSON.stringify(done.events));
    assert.deepEqual(done.events.find((e) => e.event === "usage")?.data, { input_tokens: 1050, output_tokens: 205 });
    // 1000/200 at the first pause, +30/3 at the second, +20/2 at the end.
    assertTotals(await totals(paused.sessionId), [1050, 205, 0.006 + 0.000135 + 0.00009]);
  });

  await check("the resumed half is filed under the session the state names, never under a session id from the body", async () => {
    await login(USERS.oasisOwner);
    const other = await pausedTurn("Start another conversation");
    const target = await pausedTurn("Email the accountant");
    const otherBefore = await session(other.sessionId);
    const otherMessages = await count("SELECT COUNT(*) AS n FROM chat_messages WHERE session_id = ?", [other.sessionId]);
    provider = () => anthropicOk("Done.", 10, 1);
    const r = await resumeAs(
      { resume_state: target.pending.resume_state, resume_signature: target.pending.resume_signature, session_id: other.sessionId },
      target.sessionId,
    );
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(await session(other.sessionId), otherBefore);
    assert.equal(await count("SELECT COUNT(*) AS n FROM chat_messages WHERE session_id = ?", [other.sessionId]), otherMessages);
    assertTotals(await totals(target.sessionId), [1010, 201, 0.006 + 0.000045]);
  });

  await check("a signed state that names no session is refused: every state /api/chat issues names one", async () => {
    await login(USERS.oasisOwner);
    const state = overTheWire(loopState()) as unknown as Record<string, unknown>;
    delete state.sessionId;
    const sig = signResumeState(state, binding);
    sent = [];
    const r = await resumeAs({ resume_state: state, resume_signature: sig }, null);
    assert.equal(r.status, 400);
    assert.deepEqual(JSON.parse(r.text), { ok: false, error: "resume_state_missing_session" });
    assert.equal(sent.length, 0);
  });

  console.error = realError;
  if (failures > 0) {
    for (const l of logged.slice(-12)) realError(...l);
    console.log(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("chat resume signature tests passed");
}

main().catch((error) => {
  console.error = realError;
  console.error(error);
  process.exit(1);
});
