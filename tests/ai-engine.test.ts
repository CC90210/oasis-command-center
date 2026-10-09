/**
 * ai-engine.test.ts - ONE switchable engine for the departments and the coding
 * harness (CC, 2026-10-09), driven against real libSQL with only the network
 * stubbed (the AI providers and the paired computer's bridge).
 *
 *   1. What powers your agents is stored once and read back; switching the AI
 *      account's PROVIDER works with a saved key, both ways, tested first.
 *   2. A department turn runs on an app on the paired computer through the
 *      bridge when that is the choice (no key, no budget, no API credits), and
 *      on the AI account, saying so, when the computer can't be reached.
 *   3. The CLI status words: a check that did not finish is never "Needs auth"
 *      or "Not installed" (CC's PC, 2026-10-09 heartbeat).
 *   4. Every "what powers this" label opens Settings > AI brain at the engine.
 *   5. The channel's messages are laid out as bubbles with room to read.
 *
 * Run: node --conditions=react-server --import tsx tests/ai-engine.test.ts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createClient } from "@libsql/client";

const ROOT = process.cwd();
const dbFile = join(mkdtempSync(join(tmpdir(), "ai-engine-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
process.env.EMPIRE_AUTH_BACKEND = "turso";
process.env.AUTH_SESSION_SECRET = "ai-engine-test-secret-long-enough-0000000001";
process.env.BRAVO_FIELD_ENCRYPTION_KEY = "ai-engine-test-field-key-long-enough-0000001";
process.env.BRIDGE_BEARER_TOKEN_OASIS_AI_CC = "bearer-oasis-test";
delete process.env.OPERATOR_EMAIL;
delete process.env.OPERATOR_EMAIL_FALLBACK_ENABLED;
process.env.ADMIN_EMAILS = "";
for (const k of ["PLATFORM_DEFAULT_OPENROUTER_API_KEY", "PLATFORM_DEFAULT_ANTHROPIC_API_KEY", "PLATFORM_DEFAULT_OPENAI_API_KEY", "PLATFORM_DEFAULT_GOOGLE_API_KEY"]) {
  delete process.env[k];
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

// Two client modules this suite drives (the paired-computer card's sign-in
// call, the harness header's reads) import next/link, which creates a context
// at import time; react-server's React exports none. The same inert stand-ins
// as tests/ai-workspace-account.test.ts: nothing here renders them.
// eslint-disable-next-line @typescript-eslint/no-require-imports -- the CJS export object tsx-compiled modules read
const reactCjs = require("react") as Record<string, unknown>;
if (typeof reactCjs.createContext !== "function") {
  reactCjs.createContext = (value: unknown) => ({ _currentValue: value, Provider: ({ children }: { children?: unknown }) => children, Consumer: () => null });
}

const OASIS = "ef8d389e-3f15-43f2-ae00-3660f69a1452";
const ALPHA = "a1a1a1a1-0000-4000-8000-0000000000a1";
const BRIDGE = "https://bridge.oasis.test";
type U = { id: string; email: string };
const u = (n: number, email: string): U => ({ id: `0f000000-0000-4000-8000-${String(n).padStart(12, "0")}`, email });
const USERS = {
  cc: u(1, "conaugh@oasisai.work"), // the verified platform operator, OASIS owner
  alpha: u(3, "owner@alpha.test"),
  alphaRep: u(4, "rep@alpha.test"),
} as const;
const KEY_ANTH = "sk-ant-alpha-anthropic-key-0001";
const KEY_OR = "sk-or-v1-alpha-openrouter-key-0002";

async function login(user: U | null) {
  if (!user) {
    sessionCookie = undefined;
    return;
  }
  const { signSession } = await import("../lib/turso-auth");
  sessionCookie = signSession({ sub: user.id, email: user.email, exp: Math.floor(Date.now() / 1000) + 3600, ver: 0 });
}

let failures = 0;
let passed = 0;
let finished = false;
process.on("exit", () => {
  if (finished) return;
  console.log("ai-engine: STOPPED before the end (something never settled)");
  process.exitCode = 1;
});
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

// -- network stub: AI providers and the paired computer's bridge ---------------
type Sent = { url: string; headers: Record<string, string>; body: Record<string, unknown> | null };
let sent: Sent[] = [];
let answer: (s: Sent) => Response | Promise<Response> = () => new Response("unset", { status: 599 });
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  const headers: Record<string, string> = {};
  new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
  let body: Record<string, unknown> | null = null;
  try {
    body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
  } catch {
    body = null;
  }
  const s = { url, headers, body };
  sent.push(s);
  return answer(s);
}) as typeof fetch;
const sse = (frames: Array<[string | null, unknown]>) =>
  new Response(frames.map(([e, d]) => `${e ? `event: ${e}\n` : ""}data: ${typeof d === "string" ? d : JSON.stringify(d)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
const anthropicOk = (text: string) =>
  sse([
    ["message_start", { message: { usage: { input_tokens: 12 } } }],
    ["content_block_delta", { delta: { type: "text_delta", text } }],
    ["message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } }],
    ["message_stop", {}],
  ]);
const openrouterOk = (text: string) =>
  sse([
    [null, { choices: [{ delta: { content: text } }] }],
    [null, { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2 } }],
    [null, "[DONE]"],
  ]);
/** The bridge's /chat answering as Claude Code does (bravo_cli/bridge_chat_server.py emit names). */
const bridgeOk = (text: string) => sse([["session", { session_id: "s1" }], ["tool", { name: "Read" }], ["delta", { text }], ["done", { input_tokens: 0, output_tokens: 0 }]]);
const keyOf = (s: Sent) => s.headers["x-api-key"] ?? s.headers["authorization"]?.replace(/^Bearer /, "") ?? null;

const logged: unknown[][] = [];
console.error = (...args: unknown[]) => {
  logged.push(args);
};

function parseSse(text: string): Array<{ event: string; data: Record<string, unknown> }> {
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
      onboarding_completed_at TEXT, full_name TEXT, display_name TEXT, agents_enabled TEXT, updated_at TEXT,
      deactivated_at TEXT);
    CREATE TABLE tenants (id TEXT PRIMARY KEY, slug TEXT, name TEXT, custom_fields TEXT);
    CREATE TABLE tenant_manifests (id TEXT PRIMARY KEY, tenant_id TEXT, slug TEXT UNIQUE, manifest TEXT,
      version INTEGER, schema_version INTEGER, created_at TEXT, updated_at TEXT);
    CREATE TABLE agents (slug TEXT PRIMARY KEY, name TEXT, category TEXT, short_description TEXT, description TEXT,
      base_prompt TEXT, required_tools TEXT, suggested_model TEXT, pricing TEXT, is_public INTEGER,
      is_oasis_managed INTEGER, created_by TEXT, tenant_id TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE agent_model_config (
      id TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))) PRIMARY KEY,
      tenant_id TEXT NOT NULL, agent_key TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
      encrypted_api_key TEXT, system_prompt_override TEXT, enabled INTEGER NOT NULL DEFAULT 1,
      last_used_at TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      user_id TEXT, display_name_override TEXT);
    CREATE UNIQUE INDEX idx_agent_model_config_default_per_agent ON agent_model_config (tenant_id, agent_key) WHERE (user_id IS NULL);
    CREATE UNIQUE INDEX idx_agent_model_config_override_per_user ON agent_model_config (tenant_id, user_id, agent_key) WHERE (user_id IS NOT NULL);
  `);
  await db.executeMultiple(readFileSync(join(ROOT, "database/turso/bravo__192_ai_usage.sql"), "utf8"));
  await db.executeMultiple(readFileSync(join(ROOT, "database/turso/bravo__191_agent_turn_outcomes.sql"), "utf8"));

  const { encryptField, decryptField } = await import("../lib/field-encryption");
  const { SUGA_SEED } = await import("../lib/manifest/seeds");
  const { parseManifest } = await import("../lib/manifest/schema");
  const stamp = "2026-09-01T00:00:00Z";
  const manifest = (slug: string) => JSON.stringify(parseManifest({ ...SUGA_SEED, tenant_slug: slug, pages: SUGA_SEED.pages.filter((p) => p.path) } as never));
  const profile = (id: string, user: U, tenant: string, role: string, owner: 0 | 1) => ({
    sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, onboarding_completed_at, full_name, agents_enabled, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'Test Person', '["sdr"]', ?)`,
    args: [id, user.id, user.email, tenant, role, owner, stamp, stamp],
  });
  const anthCipher = encryptField(KEY_ANTH);
  await db.batch(
    [
      ...Object.values(USERS).map((x) => ({ sql: `INSERT INTO "_supabase_auth_users" (id, email) VALUES (?, ?)`, args: [x.id, x.email] })),
      // OASIS: its bridge is CC's paired computer behind a tunnel (production: tenants.custom_fields.bridge_url).
      { sql: "INSERT INTO tenants (id, slug, name, custom_fields) VALUES (?, 'oasis-ai-cc', 'OASIS AI', ?)", args: [OASIS, JSON.stringify({ bridge_url: BRIDGE })] },
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'alpha-co', 'Alpha Co')", args: [ALPHA] },
      {
        sql: "INSERT INTO tenant_manifests (id, tenant_id, slug, manifest, version, schema_version, created_at, updated_at) VALUES ('m-alpha', ?, 'alpha-co', ?, 1, 1, ?, ?)",
        args: [ALPHA, manifest("alpha-co"), stamp, stamp],
      },
      profile("p-cc", USERS.cc, OASIS, "owner", 1),
      profile("p-alpha", USERS.alpha, ALPHA, "owner", 1),
      profile("p-alpha-rep", USERS.alphaRep, ALPHA, "closer", 0),
      // Alpha's AI account (Anthropic), the teammate row a connect stamped with
      // the same key, and an OpenRouter key an older team connect left on another row.
      { sql: "INSERT INTO agent_model_config (tenant_id, user_id, agent_key, provider, model, encrypted_api_key, enabled, updated_at) VALUES (?, NULL, '__workspace__', 'anthropic', 'claude-sonnet-4-6', ?, 1, ?)", args: [ALPHA, anthCipher, stamp] },
      { sql: "INSERT INTO agent_model_config (tenant_id, user_id, agent_key, provider, model, encrypted_api_key, enabled, updated_at) VALUES (?, NULL, 'sdr', 'anthropic', 'claude-sonnet-4-6', ?, 1, ?)", args: [ALPHA, anthCipher, stamp] },
      { sql: "INSERT INTO agent_model_config (tenant_id, user_id, agent_key, provider, model, encrypted_api_key, enabled, updated_at) VALUES (?, NULL, 'customer-support', 'openrouter', 'anthropic/claude-sonnet-4.6', ?, 1, ?)", args: [ALPHA, encryptField(KEY_OR), stamp] },
      // OASIS's legacy `bravo` account row: the fallback when CC's computer can't be reached.
      { sql: "INSERT INTO agent_model_config (tenant_id, user_id, agent_key, provider, model, encrypted_api_key, enabled, updated_at) VALUES (?, NULL, 'bravo', 'anthropic', 'claude-sonnet-4-6', ?, 1, ?)", args: [OASIS, encryptField("sk-ant-oasis-fallback-0003"), stamp] },
    ],
    "write",
  );

  const engineLib = await import("../lib/ai/agent-engine");
  const store = await import("../lib/ai/agent-engine-store");
  const account = await import("../lib/ai/workspace-account");
  const bridgeTurn = await import("../lib/ai/bridge-turn");
  const policy = await import("../lib/bridge-cli-policy");
  const { prepareAgentTurn, streamAgentTurn } = await import("../lib/os/department-agent");
  const { departmentBySlug } = await import("../lib/os/departments");
  const outcome = await import("../lib/os/channel/outcome");
  const providerRoute = await import("../app/api/agent-config/workspace-provider/route");
  const bulk = await import("../app/api/agent-config/bulk-provider/route");
  const cliAuth = await import("../app/api/bridge/cli-auth/route");
  const harness = await import("../lib/admin/harness-targets");
  const engineRoute = await import("../app/api/ai/engine/route");
  const chat = await import("../app/api/agents/chat/route");
  const cliStatus = await import("../lib/bridge-cli-status");
  const cliRuntime = await import("../lib/cli-runtime");
  const layout = await import("../components/agents/chat-layout");
  const { channelEngine } = await import("../components/os/department/channel");
  const { NextRequest } = await import("next/server");
  const req = (url: string, method: string, body?: unknown) =>
    new NextRequest(`http://localhost${url}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const jsonOf = async (res: Response) => ({ status: res.status, body: (await res.json()) as Record<string, unknown> });
  const sales = departmentBySlug("sales")!;
  const rowsOf = async (tenant: string) =>
    (await db.execute({ sql: "SELECT agent_key, provider, model, encrypted_api_key, enabled FROM agent_model_config WHERE tenant_id = ? AND user_id IS NULL ORDER BY agent_key", args: [tenant] })).rows.map((r) => ({
      agent_key: String(r.agent_key),
      provider: String(r.provider),
      model: String(r.model),
      key: r.encrypted_api_key === null ? null : decryptField(String(r.encrypted_api_key)),
      cipher: r.encrypted_api_key === null ? null : String(r.encrypted_api_key),
      enabled: Number(r.enabled),
    }));

  console.log("ai-engine:");
  // -- 1. One choice, stored once; switching provider works --------------------
  console.log("1. what powers your agents");
  await check("no engine row is the AI account; a choice is stored on its own keyless row and read back", async () => {
    assert.deepEqual(await store.readAgentEngine(ALPHA), { kind: "api" });
    await store.saveAgentEngine(ALPHA, { kind: "cli", cli: "codex" });
    assert.deepEqual(await store.readAgentEngine(ALPHA), { kind: "cli", cli: "codex" });
    await store.saveAgentEngine(ALPHA, { kind: "local", model: "llama3.3" });
    assert.deepEqual(await store.readAgentEngine(ALPHA), { kind: "local", model: "llama3.3" });
    const row = (await rowsOf(ALPHA)).find((r) => r.agent_key === engineLib.ENGINE_AGENT_KEY);
    assert.ok(row && row.cipher === null, "the engine row holds no key");
    await store.saveAgentEngine(ALPHA, { kind: "api" });
    assert.deepEqual(await store.readAgentEngine(ALPHA), { kind: "api" });
    assert.equal(engineLib.parseEngineChoice({ kind: "cli", cli: "bash" }), null);
    assert.equal(engineLib.parseEngineChoice({ kind: "local", model: "x y; rm" }), null);
    assert.deepEqual(engineLib.engineFromRow({ provider: "cli", model: "nope" }), { kind: "api" });
  });

  await check("the provider switch moves the AI account to a SAVED key (tested first), keeps the old key, and switches back without a paste", async () => {
    await login(USERS.alpha);
    answer = (s) => (s.url.includes("openrouter.ai") ? openrouterOk("Here is a short answer.") : anthropicOk("Here is a short answer."));
    sent = [];
    const first = await jsonOf(await providerRoute.POST(req("/api/agent-config/workspace-provider", "POST", { provider: "openrouter" })));
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(sent.length, 1, "exactly one test answer before the switch");
    assert.equal(keyOf(sent[0]), KEY_OR, "the test ran on the saved OpenRouter key");
    const acct = await account.readWorkspaceAiAccount(ALPHA);
    assert.ok(account.hasUsableKey(acct) && acct.provider === "openrouter");
    assert.equal(decryptField(acct.encryptedApiKey), KEY_OR);
    const rows = await rowsOf(ALPHA);
    const keptAnth = rows.find((r) => r.agent_key === store.savedKeyAgentKey("anthropic"));
    assert.ok(keptAnth && keptAnth.key === KEY_ANTH, "the outgoing Anthropic key is kept on its own row");
    assert.equal(rows.find((r) => r.agent_key === "sdr")?.provider, "openrouter", "the teammate that held the old key moved with the team");
    // Back to Anthropic: no paste, the kept key answers.
    sent = [];
    const back = await jsonOf(await providerRoute.POST(req("/api/agent-config/workspace-provider", "POST", { provider: "anthropic" })));
    assert.equal(back.status, 200, JSON.stringify(back.body));
    assert.equal(keyOf(sent[0]), KEY_ANTH);
    const again = await account.readWorkspaceAiAccount(ALPHA);
    assert.ok(account.hasUsableKey(again) && again.provider === "anthropic" && decryptField(again.encryptedApiKey) === KEY_ANTH);
  });

  await check("a provider with no saved key, a member, and a failed test change nothing, each in a plain sentence", async () => {
    const before = JSON.stringify(await rowsOf(ALPHA));
    const none = await jsonOf(await providerRoute.POST(req("/api/agent-config/workspace-provider", "POST", { provider: "openai" })));
    assert.equal(none.status, 409);
    assert.match(String(none.body.message), /No OpenAI Direct key is saved for this workspace yet\. Connect it on the OpenAI Direct card below\./);
    answer = () => new Response(JSON.stringify({ error: { message: "credit balance is too low" } }), { status: 400 });
    const refused = await jsonOf(await providerRoute.POST(req("/api/agent-config/workspace-provider", "POST", { provider: "openrouter" })));
    assert.equal(refused.status, 422);
    assert.match(String(refused.body.message), /did not pass the test, so nothing was changed/);
    await login(USERS.alphaRep);
    const member = await jsonOf(await providerRoute.POST(req("/api/agent-config/workspace-provider", "POST", { provider: "openrouter" })));
    assert.equal(member.status, 403);
    assert.equal(JSON.stringify(await rowsOf(ALPHA)), before, "nothing was written");
  });

  await check("a saved key not in use can be removed (its provider's team disconnect); the account in use is untouched", async () => {
    await login(USERS.alpha);
    const calls: string[] = [];
    const client = await import("../components/settings/agent-engine-client");
    const r = await client.removeSavedKey("openrouter", async (url, init) => {
      calls.push(`${init.method} ${url}`);
      return bulk.DELETE(req(url, String(init.method)));
    });
    assert.deepEqual(r, { ok: true });
    assert.deepEqual(calls, ["DELETE /api/agent-config/bulk-provider?provider=openrouter"]);
    const rows = await rowsOf(ALPHA);
    assert.ok(!rows.some((x) => x.provider === "openrouter"), "every OpenRouter row, the kept one included, is gone");
    const acct = await account.readWorkspaceAiAccount(ALPHA);
    assert.ok(account.hasUsableKey(acct) && acct.provider === "anthropic", "the account in use is untouched");
    assert.deepEqual(await store.readSavedProviders(ALPHA), ["anthropic"]);
    // Put the OpenRouter key back for the checks below (a kept key, as a switch leaves it).
    await store.keepSavedKey({ tenantId: ALPHA, provider: "openrouter", model: "anthropic/claude-sonnet-4.6", encryptedApiKey: encryptField(KEY_OR) });
  });

  await check("the engine route: a client workspace can't reach CC's computer, so an app engine is refused before anything is saved", async () => {
    await login(USERS.alpha);
    sent = [];
    const r = await jsonOf(await engineRoute.PUT(req("/api/ai/engine", "PUT", { engine: { kind: "cli", cli: "claude" } })));
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "bridge_unavailable");
    assert.equal(sent.length, 0, "no request left the server");
    assert.deepEqual(await store.readAgentEngine(ALPHA), { kind: "api" });
    const got = await jsonOf(await engineRoute.GET());
    assert.equal(got.status, 200);
    assert.deepEqual(got.body.engine, { kind: "api" });
    assert.deepEqual(got.body.bridge, { reachable: false });
    assert.ok((got.body.savedProviders as string[]).includes("openrouter"), "the kept OpenRouter key is switchable");
  });

  await check("the engine route: OASIS's owner picks Codex; it answers one test reply through the bridge FIRST, then it is saved", async () => {
    await login(USERS.cc);
    sent = [];
    answer = (s) => (s.url === `${BRIDGE}/chat` ? bridgeOk("Ready when you are.") : new Response("unexpected", { status: 599 }));
    // OASIS with nothing saved runs on the CLI bridge (CC: "for my workspace they don't use API keys").
    assert.deepEqual(await store.readAgentEngine(OASIS), { kind: "cli", cli: "claude" });
    const shown = await jsonOf(await engineRoute.GET());
    assert.equal(shown.body.workspace, "oasis");
    assert.deepEqual(shown.body.bridge, { reachable: true });
    const r = await jsonOf(await engineRoute.PUT(req("/api/ai/engine", "PUT", { engine: { kind: "cli", cli: "codex" } })));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(sent.length, 1);
    assert.equal(sent[0].url, `${BRIDGE}/chat`);
    assert.equal(sent[0].headers.authorization, "Bearer bearer-oasis-test", "the server-only bearer, as the coding harness's proxy sends it");
    assert.equal(sent[0].body?.cli_provider, "codex", "an owner keeps the app they chose");
    assert.equal(sent[0].body?.chat_mode, "plan");
    assert.equal(sent[0].body?.agent, "bravo", "the test answers in the Chief of Staff's harness");
    assert.match(String((sent[0].body?.messages as Array<{ content: string }>)[0].content), /^This message comes from the Chief of Staff channel of the OASIS Command Center\./);
    assert.equal(sent[0].body?.tenant_id, OASIS);
    assert.deepEqual(await store.readAgentEngine(OASIS), { kind: "cli", cli: "codex" });
    // A test that fails changes nothing.
    answer = () => sse([["error", { code: "cli_not_authenticated", message: "codex: not signed in" }], ["done", {}]]);
    const bad = await jsonOf(await engineRoute.PUT(req("/api/ai/engine", "PUT", { engine: { kind: "cli", cli: "gemini" } })));
    assert.equal(bad.status, 422);
    assert.match(String(bad.body.message), /nothing was changed\. The AI app on your paired computer could not answer\./);
    assert.deepEqual(await store.readAgentEngine(OASIS), { kind: "cli", cli: "codex" });
  });

  // -- 2. Department turns run in the department's agent harness -----------------
  console.log("2. department turns");
  const ccCaller = { target: { baseUrl: BRIDGE, bearerToken: "bearer-oasis-test" }, tenantId: OASIS, userId: USERS.cc.id, teamRole: "owner" };
  const dept = (slug: string) => departmentBySlug(slug)!;
  type Caller = typeof ccCaller;
  const oasisTurn = (deptSlug: string, agentSlug: string, bridge: (() => Promise<Caller | null>) | null) =>
    prepareAgentTurn({
      tenantId: OASIS,
      tenantSlug: "oasis-ai-cc",
      agentSlug,
      department: dept(deptSlug),
      operator: { name: "CC", email: USERS.cc.email },
      platformFallback: null,
      revealModel: true,
      userId: USERS.cc.id,
      bridge,
    });
  const clientTurn = (bridge: (() => Promise<Caller | null>) | null) =>
    prepareAgentTurn({
      tenantId: ALPHA,
      tenantSlug: "alpha-co",
      agentSlug: "sdr",
      department: sales,
      operator: { name: "Owner", email: USERS.alpha.email },
      platformFallback: null,
      revealModel: false,
      userId: USERS.alpha.id,
      bridge,
    });
  await check("OASIS Sales on Codex: the turn runs in the Chief of Staff's harness through the bridge, with the channel's instructions, no key, no API credits", async () => {
    await store.saveAgentEngine(OASIS, { kind: "cli", cli: "codex" });
    const prepared = await oasisTurn("sales", "sdr", async () => ccCaller);
    assert.ok(prepared.ok, JSON.stringify(prepared));
    if (!prepared.ok || prepared.turn.engine.kind === "api") return assert.fail("not a bridge turn");
    assert.equal(prepared.turn.engine.runsOn, "Codex in the Chief of Staff & Operations harness on your paired computer");
    assert.equal(prepared.turn.engine.spend, "cli_subscription");
    assert.equal(prepared.turn.engine.harness.agent, "bravo");
    assert.equal(prepared.turn.apiKey, "", "no key is used");
    sent = [];
    answer = (s) => (s.url === `${BRIDGE}/chat` ? bridgeOk("Pipeline is healthy.") : new Response("no provider call expected", { status: 599 }));
    const events = [];
    for await (const ev of streamAgentTurn(prepared.turn, [{ role: "user", content: "earlier" }, { role: "assistant", content: "ok" }, { role: "user", content: "How is the pipeline?" }])) events.push(ev);
    assert.deepEqual(events, [{ type: "delta", text: "Pipeline is healthy." }, { type: "done", inputTokens: 0, outputTokens: 0 }]);
    assert.equal(sent.length, 1, "only the bridge was called: no AI provider");
    assert.equal(sent[0].body?.agent, "bravo", "Sales runs in the Chief of Staff's harness (its CLAUDE.md and skills route it)");
    assert.equal(sent[0].body?.cli_provider, "codex");
    assert.equal(sent[0].body?.chat_mode, "plan", "read and answer only");
    const msgs = sent[0].body?.messages as Array<{ role: string; content: string }>;
    assert.equal(msgs.length, 1, "the bridge runs the app on one message");
    assert.match(msgs[0].content, /^This message comes from the Sales channel of the OASIS Command Center\. Work it the way you normally do in this folder/);
    assert.ok(msgs[0].content.includes(prepared.turn.system.trim().slice(0, 80)), "the channel's own instructions, identity lock included");
    assert.match(msgs[0].content, /CONVERSATION SO FAR:\nUser: earlier\n\nYou: ok/);
    assert.match(msgs[0].content, /MESSAGE TO ANSWER:\nHow is the pipeline\?$/);
  });

  await check("each OASIS department runs in its own harness: Marketing in the CMO's, Finance in the CFO's, the rest in the Chief of Staff's", async () => {
    const want: Record<string, string> = { chief_of_staff: "bravo", sales: "bravo", client_success: "bravo", operations: "bravo", marketing: "maven", finance: "atlas" };
    for (const [key, agent] of Object.entries(want)) assert.equal(harness.harnessForDepartment(key)?.agent, agent, key);
    const marketing = await oasisTurn("marketing", "maven", async () => ccCaller);
    assert.ok(marketing.ok, JSON.stringify(marketing));
    if (!marketing.ok || marketing.turn.engine.kind === "api") return assert.fail("not a bridge turn");
    assert.equal(marketing.turn.engine.harness.agent, "maven");
    assert.equal(marketing.turn.engine.runsOn, "Codex in the Marketing harness on your paired computer");
    const req2 = bridgeTurn.bridgeTurnRequest({ caller: ccCaller, engine: { kind: "cli", cli: "claude" }, agentSlug: "atlas", tenantSlug: "oasis-ai-cc", system: "S", messages: [{ role: "user", content: "hi" }], maxTokens: 10, harness: { agent: "atlas", department: "Finance" } });
    assert.equal(req2.body.agent, "atlas");
  });

  await check("OASIS with the computer NOT reachable: the AI account answers, and the turn says what was chosen", async () => {
    const prepared = await oasisTurn("sales", "sdr", async () => null);
    assert.ok(prepared.ok, JSON.stringify(prepared));
    if (!prepared.ok) return;
    assert.equal(prepared.turn.engine.kind, "api");
    assert.equal(prepared.turn.engine.fellBackFrom, "Codex on your paired computer");
    assert.equal(prepared.turn.engine.spend, "api_credits");
    // A Slack mention (no resolver) does the same.
    const slack = await oasisTurn("sales", "sdr", null);
    assert.ok(slack.ok && slack.turn.engine.kind === "api" && slack.turn.engine.fellBackFrom !== null);
  });

  await check("the harness path is OASIS-only: a client workspace on an app engine is answered by its API account, even with a reachable bridge", async () => {
    await store.saveAgentEngine(ALPHA, { kind: "cli", cli: "claude" });
    let asked = 0;
    const prepared = await clientTurn(async () => {
      asked += 1;
      return { ...ccCaller, tenantId: ALPHA };
    });
    assert.ok(prepared.ok, JSON.stringify(prepared));
    if (!prepared.ok) return;
    assert.equal(prepared.turn.engine.kind, "api");
    assert.equal(prepared.turn.provider, "anthropic");
    assert.equal(asked, 0, "the bridge is not even asked for a client workspace");
  });

  await check("the chat route tells the owner what answered and whose credits it spent (agent event)", async () => {
    await login(USERS.alpha);
    answer = (s) => (s.url.includes("anthropic.com") ? anthropicOk("Hi.") : new Response("x", { status: 599 }));
    const res = await chat.POST(req("/api/agents/chat", "POST", { agent_slug: "sdr", department: "sales", messages: [{ role: "user", content: "hi" }] }));
    assert.equal(res.status, 200);
    const evs = parseSse(await res.text());
    const agentEv = evs.find((e) => e.event === "agent");
    assert.ok(agentEv, JSON.stringify(evs));
    assert.equal(agentEv.data.spend, "api_credits");
    assert.match(String(agentEv.data.runs_on), /\(API\)$/);
    assert.equal(agentEv.data.fell_back_from, "Claude Code on your paired computer", "the reply says the chosen app did not answer");
    assert.equal(agentEv.data.model, undefined, "the model id stays operator detail");
    await store.saveAgentEngine(ALPHA, { kind: "api" });
  });

  await check("bridge errors become two plain failure codes, never raw text", async () => {
    const prepared = await oasisTurn("sales", "sdr", async () => ccCaller);
    assert.ok(prepared.ok);
    if (!prepared.ok) return;
    const drain = async () => {
      const out = [];
      for await (const ev of streamAgentTurn(prepared.turn, [{ role: "user", content: "hi" }])) out.push(ev);
      return out;
    };
    answer = () => {
      throw new TypeError("fetch failed");
    };
    const down = await drain();
    assert.equal(outcome.classifyStreamError((down[0] as { message: string }).message), "bridge_unreachable");
    answer = () => sse([["error", { code: "cli_not_found", message: "Claude Code CLI isn't installed" }], ["done", {}]]);
    const cliErr = await drain();
    assert.equal(outcome.classifyStreamError((cliErr[0] as { message: string }).message), "cli_failed");
    answer = () => sse([["done", {}]]);
    assert.deepEqual(await drain(), [{ type: "error", message: "empty_reply:empty" }]);
    assert.match(outcome.failureCopy("bridge_unreachable", { canManageAi: true }).sentence, /computer could not be reached/);
    assert.ok(outcome.isAccountScoped("cli_failed"), "one engine per workspace: a verdict every channel shares");
  });

  await check("a local model goes to the bridge's /local-chat with the real system prompt; the server never calls a local address", async () => {
    await store.saveAgentEngine(OASIS, { kind: "local", model: "llama3.3" });
    const prepared = await oasisTurn("sales", "sdr", async () => ccCaller);
    assert.ok(prepared.ok);
    if (!prepared.ok) return;
    sent = [];
    answer = () => sse([["delta", { text: "local hi" }], ["done", { input_tokens: 3, output_tokens: 2 }]]);
    const out = [];
    for await (const ev of streamAgentTurn(prepared.turn, [{ role: "user", content: "hi" }])) out.push(ev);
    assert.deepEqual(out.at(-1), { type: "done", inputTokens: 3, outputTokens: 2 });
    assert.equal(sent[0].url, `${BRIDGE}/local-chat`);
    assert.equal(sent[0].body?.model, "llama3.3");
    assert.equal(sent[0].body?.system, prepared.turn.system);
    assert.ok(sent.every((s) => s.url.startsWith(BRIDGE)));
    await store.saveAgentEngine(OASIS, { kind: "cli", cli: "codex" });
  });

  // -- The ledger sees the engine (CC, 2026-10-09: the product catches its own errors) --
  // lib/health/department-chat-checks.ts reads ai_usage_events. A turn that fell
  // back from the chosen engine, and a turn that ran on the paired computer,
  // used to leave nothing to read.
  const usageRows = async () =>
    (await db.execute("SELECT * FROM ai_usage_events ORDER BY occurred_at, id")).rows.map((r) => ({ ...r }) as Record<string, unknown>);
  const drainTurn = async (turn: Parameters<typeof streamAgentTurn>[0]) => {
    const out = [];
    for await (const ev of streamAgentTurn(turn, [{ role: "user", content: "How is the pipeline?" }])) out.push(ev);
    return out;
  };
  const bridgeTurnFor = async () => {
    const prepared = await oasisTurn("sales", "sdr", async () => ccCaller);
    assert.ok(prepared.ok && prepared.turn.engine.kind !== "api", JSON.stringify(prepared));
    if (!prepared.ok) throw new Error("not prepared");
    return prepared.turn;
  };

  await check("a turn that fell back from the chosen engine records engine_unreachable:<app> on its API call", async () => {
    await db.execute("DELETE FROM ai_usage_events");
    const prepared = await oasisTurn("sales", "sdr", async () => null);
    assert.ok(prepared.ok && prepared.turn.engine.kind === "api" && prepared.turn.engine.fellBackFrom !== null);
    if (!prepared.ok) return;
    answer = (s) => (s.url.includes("anthropic.com") ? anthropicOk("Answered by the API account.") : new Response("x", { status: 599 }));
    await drainTurn(prepared.turn);
    const rows = await usageRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].fallback_reason, "engine_unreachable:codex");
    assert.equal(rows[0].billing_mode, "byo_key", "the API account answered and is billed as before");
    assert.equal(rows[0].outcome, "ok");
    // A Slack mention (no resolver) falls back the same way; a local engine says "local".
    await store.saveAgentEngine(OASIS, { kind: "local", model: "llama3.3" });
    const slack = await oasisTurn("sales", "sdr", null);
    assert.ok(slack.ok);
    if (!slack.ok) return;
    await db.execute("DELETE FROM ai_usage_events");
    await drainTurn(slack.turn);
    assert.equal((await usageRows())[0].fallback_reason, "engine_unreachable:local");
    await store.saveAgentEngine(OASIS, { kind: "cli", cli: "codex" });
  });

  await check("a turn answered by its chosen engine records no fallback; a model swap and an engine fallback are BOTH kept, joined with +", async () => {
    const { meterWithFallbackReason, resolveCall } = await import("../lib/ai/model-registry");
    const { engineFallbackReason } = engineLib;
    const seen: Array<string | null | undefined> = [];
    const spy = {
      context: {} as never,
      totals: () => ({ calls: 0, costMicroUsd: 0, unknownCostCalls: 0 }),
      begin: async (call: { fallbackReason?: string | null }) => {
        seen.push(call.fallbackReason);
        return { finish: async () => undefined };
      },
    };
    const begin = { provider: "anthropic", model: "m", maxOutputTokens: 1, promptBytes: 1 };
    const engineOnly = meterWithFallbackReason(spy, engineFallbackReason({ kind: "cli", cli: "claude" }));
    await engineOnly.begin(begin);
    const retired = resolveCall("anthropic", "claude-3-5-sonnet-20241022", engineOnly);
    assert.ok(retired.swap, "the saved model is gone, so it is swapped");
    await retired.meter.begin(begin);
    const swapOnly = resolveCall("anthropic", "claude-3-5-sonnet-20241022", spy);
    await swapOnly.meter.begin(begin);
    assert.equal(seen[0], "engine_unreachable:claude");
    assert.equal(seen[1], `${retired.swap!.fallbackReason}+engine_unreachable:claude`);
    assert.equal(seen[2], swapOnly.swap!.fallbackReason, "without an engine fallback the swap reason is unchanged");
    assert.equal(engineFallbackReason({ kind: "local", model: "llama3.3" }), "engine_unreachable:local");
    assert.equal(meterWithFallbackReason(spy, null), spy, "no reason, no wrapper");
    // An engine that answered writes nothing of the kind (next test reads the row).
  });

  await check("a department turn on the paired computer writes exactly ONE row: provider bridge, the app named, cost 0, no reservation", async () => {
    await db.execute("DELETE FROM ai_usage_events");
    const turn = await bridgeTurnFor();
    answer = (s) => (s.url === `${BRIDGE}/chat` ? bridgeOk("Pipeline is healthy.") : new Response("no provider call expected", { status: 599 }));
    const events = await drainTurn(turn);
    assert.deepEqual(events, [{ type: "delta", text: "Pipeline is healthy." }, { type: "done", inputTokens: 0, outputTokens: 0 }], "the turn's events are unchanged");
    const rows = await usageRows();
    assert.equal(rows.length, 1, "one row per bridge turn");
    const r = rows[0];
    assert.deepEqual(
      [r.provider, r.model, r.surface, r.auth_kind, r.billing_mode, r.department_key, r.outcome, r.error_code, r.fallback_reason],
      ["bridge", "codex", "agents.chat", "subscription", "subscription", "sales", "ok", null, null],
    );
    assert.equal(r.cost_micro_usd, 0);
    assert.equal(r.cost_source, "none");
    assert.equal(r.reserved_micro_usd, null, "nothing reserved");
    assert.equal(r.expires_at, null);
    assert.equal(Number(r.output_tokens), 5, "the bridge reported none: characters / 4, rounded up, so a reply with words is never 0");
    assert.ok(r.latency_ms !== null && Number(r.latency_ms) >= 0, "latency runs from the start of the turn");
  });

  await check("the bridge's own token counts are recorded when it reports them; a local model is named and billed local", async () => {
    await db.execute("DELETE FROM ai_usage_events");
    await store.saveAgentEngine(OASIS, { kind: "local", model: "llama3.3" });
    const turn = await bridgeTurnFor();
    answer = () => sse([["delta", { text: "local hi" }], ["done", { input_tokens: 31, output_tokens: 9 }]]);
    await drainTurn(turn);
    const [r] = await usageRows();
    assert.deepEqual([r.provider, r.model, r.auth_kind, r.billing_mode, r.outcome], ["bridge", "llama3.3", "local", "local", "ok"]);
    assert.deepEqual([Number(r.input_tokens), Number(r.output_tokens)], [31, 9]);
    await store.saveAgentEngine(OASIS, { kind: "cli", cli: "codex" });
  });

  await check("a bridge turn that fails writes a failure row with the channel's code; an EMPTY reply is a failure, never ok", async () => {
    const turn = await bridgeTurnFor();
    const run = async (respond: () => Response) => {
      await db.execute("DELETE FROM ai_usage_events");
      answer = respond;
      await drainTurn(turn);
      const rows = await usageRows();
      assert.equal(rows.length, 1);
      return rows[0];
    };
    const down = await run(() => {
      throw new TypeError("fetch failed");
    });
    assert.deepEqual([down.outcome, down.error_code, down.cost_micro_usd], ["error", "bridge_unreachable", 0]);
    const cli = await run(() => sse([["error", { code: "cli_not_found", message: "Claude Code CLI isn't installed" }], ["done", {}]]));
    assert.deepEqual([cli.outcome, cli.error_code], ["error", "cli_failed"]);
    const http = await run(() => new Response("no", { status: 503 }));
    assert.deepEqual([http.outcome, http.error_code], ["error", "bridge_unreachable"]);
    const empty = await run(() => sse([["done", { input_tokens: 5, output_tokens: 0 }]]));
    assert.deepEqual([empty.outcome, empty.error_code, Number(empty.output_tokens)], ["error", "empty_reply_empty", 0]);
    const blank = await run(() => sse([["delta", { text: "   " }], ["done", {}]]));
    assert.equal(blank.outcome, "error", "whitespace is not an answer");
  });

  await check("a bridge turn reserves no budget: a workspace at its cap still answers on its paired computer, and no reservation is left", async () => {
    await db.execute("DELETE FROM ai_usage_events");
    const month = new Date().toISOString().slice(0, 7);
    await db.execute({
      sql: `INSERT INTO tenant_ai_budgets (tenant_id, period_month, cap_micro_usd, reserved_micro_usd, spent_micro_usd, created_at, updated_at)
            VALUES (?, ?, 1, 0, 1, ?, ?)`,
      args: [OASIS, month, stamp, stamp],
    });
    try {
      const turn = await bridgeTurnFor();
      answer = () => bridgeOk("Still answering.");
      const events = await drainTurn(turn);
      assert.equal(events[0].type, "delta");
      const rows = await usageRows();
      assert.deepEqual(rows.map((r) => [r.outcome, r.reserved_micro_usd]), [["ok", null]]);
      assert.equal(rows.filter((r) => r.outcome === "pending").length, 0);
      const budget = (await db.execute({ sql: "SELECT reserved_micro_usd FROM tenant_ai_budgets WHERE tenant_id = ?", args: [OASIS] })).rows[0];
      assert.equal(Number(budget.reserved_micro_usd), 0, "the cap's reserved total did not move");
    } finally {
      await db.execute({ sql: "DELETE FROM tenant_ai_budgets WHERE tenant_id = ?", args: [OASIS] });
    }
  });

  await check("a consumer that stops reading leaves a cancelled row, not an ok one", async () => {
    await db.execute("DELETE FROM ai_usage_events");
    const turn = await bridgeTurnFor();
    answer = () => bridgeOk("A long answer the reader walks away from.");
    for await (const ev of streamAgentTurn(turn, [{ role: "user", content: "hi" }])) {
      if (ev.type === "delta") break;
    }
    const [r] = await usageRows();
    assert.equal(r.outcome, "cancelled");
  });

  await check("one rule for who runs which app: a member is pinned to Claude Code with its tools switched off; the proxy route uses the same rule", () => {
    const member = policy.bridgeCliPolicy("closer", "codex");
    assert.equal(member.cliProvider, "claude");
    assert.ok(member.disallowedTools.length > 0);
    assert.deepEqual(policy.bridgeCliPolicy("owner", "gemini"), { cliProvider: "gemini", disallowedTools: [] });
    const turnReq = bridgeTurn.bridgeTurnRequest({
      caller: { ...ccCaller, teamRole: "closer" },
      engine: { kind: "cli", cli: "codex" },
      agentSlug: "sdr",
      tenantSlug: "oasis-ai-cc",
      system: "S",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 100,
      harness: { agent: "bravo", department: "Sales" },
    });
    assert.equal(turnReq.body.cli_provider, "claude");
    assert.ok((turnReq.body.disallowed_tools as string[]).length > 0);
    const proxy = readFileSync(join(ROOT, "app/api/bridge/chat/route.ts"), "utf8");
    assert.match(proxy, /bridgeCliPolicy\(\s*auth\.teamRole,/);
  });

  await check("the bridge gate: CC (operator, OASIS) reaches OASIS's computer; a client owner reaches nothing", async () => {
    await login(USERS.cc);
    const cc = await bridgeTurn.bridgeCallerForSession(OASIS);
    assert.ok(cc, "CC reaches his paired computer");
    assert.equal(cc!.target.baseUrl, BRIDGE);
    assert.equal(cc!.teamRole, "owner");
    assert.equal(await bridgeTurn.bridgeCallerForSession(ALPHA), null, "the gate's workspace must be the turn's");
    await login(USERS.alpha);
    assert.equal(await bridgeTurn.bridgeCallerForSession(ALPHA), null);
  });

  await check("the channel header names the engine AND the harness, and says when the chosen app can't be reached", () => {
    const brain = { provider: "anthropic" as const, providerLabel: "Anthropic", model: "claude-sonnet-4-6", modelLabel: "Claude Sonnet 4.6", savedModel: null };
    assert.deepEqual(channelEngine({ kind: "cli", cli: "codex" }, true, brain, "Marketing"), {
      line: "Codex in the Marketing harness on your paired computer",
      spend: "cli_subscription",
      note: null,
    });
    const fell = channelEngine({ kind: "cli", cli: "codex" }, false, brain, "Marketing");
    assert.equal(fell.spend, "api_credits");
    assert.match(String(fell.note), /^Codex on your paired computer is chosen, but the computer can't be reached right now, so your AI account answers\.$/);
    assert.deepEqual(channelEngine({ kind: "api" }, false, brain).note, null);
  });

  await check("ONE setting: the coding harness's route comes from what powers your agents, and there is no second picker", () => {
    assert.deepEqual(engineLib.harnessRouteFor({ kind: "cli", cli: "codex" }), { mode: "cli", runtime: "codex", note: null });
    assert.deepEqual(engineLib.harnessRouteFor({ kind: "api" }), { mode: "cloud_only", runtime: "claude", note: null });
    assert.equal(engineLib.harnessRouteFor({ kind: "local", model: "llama3.3" }).runtime, "claude");
    const widget = readFileSync(join(ROOT, "components/ChatWidget.tsx"), "utf8");
    assert.doesNotMatch(widget, /aria-label="Chat route"|renderCliOption|writeHarnessOverride/, "the harness's own route picker is gone");
    assert.match(widget, /const route = harnessRouteFor\(engine\);/);
    assert.match(widget, /setChatModeState\(route\.mode\);\s*setCliRuntimeState\(route\.runtime\);/);
    const card = readFileSync(join(ROOT, "components/settings/LocalCliProvidersCard.tsx"), "utf8");
    assert.doesNotMatch(card, /role="radiogroup"|chooseCli|writeCliRuntime/, "the paired-computer card has no picker");
    // Nothing that powers a department reads the browser-local route.
    for (const rel of ["lib/os/department-agent.ts", "lib/ai/bridge-turn.ts", "app/api/agents/chat/route.ts"]) {
      assert.doesNotMatch(readFileSync(join(ROOT, rel), "utf8"), /cli-runtime|readCliRuntime|cliRuntime/, rel);
    }
  });

  await check("Connect / Reconnect: the bridge starts the app's own sign-in on the paired computer, with the app's real command", async () => {
    // The real commands (checked against the installed apps on CC's PC, 2026-10-09).
    assert.equal(cliStatus.CLI_SIGN_IN.claude.command, "claude auth login");
    assert.equal(cliStatus.CLI_SIGN_IN.codex.command, "codex login");
    assert.match(cliStatus.CLI_SIGN_IN.gemini.command, /^gemini\s+\(then choose "Sign in with Google", or type \/auth\)$/);
    await login(USERS.cc);
    sent = [];
    answer = (s) =>
      s.url === `${BRIDGE}/exec-tool`
        ? new Response(JSON.stringify({ ok: true, output: "codex sign-in started. https://auth.openai.com/...", is_error: false }), { status: 200 })
        : new Response("x", { status: 599 });
    const r = await jsonOf(await cliAuth.POST(new Request("http://localhost/api/bridge/cli-auth", { method: "POST", body: JSON.stringify({ provider: "codex" }) })));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(sent.length, 1);
    assert.equal(sent[0].headers.authorization, "Bearer bearer-oasis-test");
    assert.deepEqual(sent[0].body, { tool_name: "cli_auth_start", input: { provider: "codex" } });
    assert.equal(r.body.command, "codex login");
    assert.match(String(r.body.output), /https:\/\/auth\.openai\.com/);
    // A bridge that does not answer is said plainly, with the command to run there.
    answer = () => {
      throw new TypeError("fetch failed");
    };
    const down = await jsonOf(await cliAuth.POST(new Request("http://localhost/api/bridge/cli-auth", { method: "POST", body: JSON.stringify({ provider: "claude" }) })));
    assert.equal(down.status, 502);
    assert.match(String(down.body.message), /On that computer, run: claude auth login$/);
    // A client owner reaches no bridge: refused before anything is sent.
    await login(USERS.alpha);
    sent = [];
    const client = await jsonOf(await cliAuth.POST(new Request("http://localhost/api/bridge/cli-auth", { method: "POST", body: JSON.stringify({ provider: "gemini" }) })));
    assert.equal(client.status, 403);
    assert.equal(sent.length, 0);
    // The card's button calls exactly this route.
    const calls: string[] = [];
    const { startCliSignIn } = await import("../components/settings/LocalCliProvidersCard");
    const res = await startCliSignIn("codex", async (url, init) => {
      calls.push(`${init.method} ${url} ${String(init.body)}`);
      return new Response(JSON.stringify({ ok: true, message: "Started.", output: "" }), { status: 200 });
    });
    assert.deepEqual(res, { ok: true, text: "Started." });
    assert.deepEqual(calls, ['POST /api/bridge/cli-auth {"provider":"codex"}']);
    const src = readFileSync(join(ROOT, "components/settings/LocalCliProvidersCard.tsx"), "utf8");
    assert.match(src, /\{cs !== "ready" && \(/, "every card that is not ready offers Connect");
  });

  await check("the coding harness never spins forever: each read has a time limit and says why it failed", async () => {
    const readiness = await import("../lib/admin/chat-readiness");
    const timeout = Object.assign(new Error("signal timed out"), { name: "TimeoutError" });
    assert.equal(readiness.agentConfigReadFailure(timeout), "Couldn't read your agent settings: the server didn't answer within 15 seconds. Refresh to try again.");
    const widget = readFileSync(join(ROOT, "components/ChatWidget.tsx"), "utf8");
    assert.match(widget, /fetch\("\/api\/agent-config", \{ signal: AbortSignal\.timeout\(CONFIG_READ_TIMEOUT_MS\) \}\)/);
    assert.match(widget, /if \(configsError\) \{/);
    const header = await import("../components/admin/RunnerStatusHeader");
    const hung = await header.readRunner("/api/bridge/warm-status", async () => {
      throw timeout;
    });
    assert.deepEqual(hung, { error: "timeout" });
    assert.equal(header.describeRunner({ warm: hung, cli: null }).computer, "Couldn't check your computer: no answer in 12 seconds.");
    const src = readFileSync(join(ROOT, "components/admin/RunnerStatusHeader.tsx"), "utf8");
    assert.doesNotMatch(src, /await Promise\.all\(\[readRunner/, "one slow read must not hold the other line");
    assert.match(src, /signal: AbortSignal\.timeout\(RUNNER_READ_TIMEOUT_MS\)/);
  });

  // -- 3. CLI status words --------------------------------------------------------
  console.log("3. CLI status");
  await check("CC's PC (heartbeat 2026-10-09 17:54Z): Claude ready, Gemini's unfinished check is 'not confirmed', Codex 'not detected'", () => {
    const meta = {
      via: "paired_bridge_heartbeat",
      providers: {
        claude: { installed: true, authenticated: true, version: "2.1.270 (Claude Code)" },
        codex: { installed: false, authenticated: false, version: null },
        gemini: { installed: true, authenticated: false, version: null },
      },
    };
    const now = Date.parse("2026-10-09T17:55:00Z");
    const snap = cliStatus.normalizeCliSnapshot(meta, "2026-10-09T17:54:32.945Z", now);
    assert.ok(snap.ok);
    if (!snap.ok) return;
    const words = Object.fromEntries((["claude", "codex", "gemini"] as const).map((p) => [p, cliStatus.CLI_STATE_LABEL[cliStatus.cliStatusState(snap.data[p])]]));
    assert.deepEqual(words, { claude: "Ready", codex: "Not detected", gemini: "Sign-in not confirmed" });
    // A FINISHED check that said no is the only "Needs sign-in".
    const signedOut = cliStatus.normalizeCliSnapshot({ providers: { ...meta.providers, gemini: { installed: true, authenticated: false, version: "0.63.0" } } }, "2026-10-09T17:54:32.945Z", now);
    assert.ok(signedOut.ok && cliStatus.cliStatusState(signedOut.data.gemini) === "needs_sign_in");
    // A newer bridge that says its check timed out is unknown, whatever else it sent.
    const timedOut = cliStatus.normalizeCliSnapshot({ providers: { ...meta.providers, gemini: { installed: true, authenticated: false, version: "0.63.0", probe: "timeout" } } }, "2026-10-09T17:54:32.945Z", now);
    assert.ok(timedOut.ok && cliStatus.cliStatusState(timedOut.data.gemini) === "unknown");
  });

  await check("the paired-computer card never locks an app out, and never says 'Needs auth' or 'Not installed'", () => {
    const src = readFileSync(join(ROOT, "components/settings/LocalCliProvidersCard.tsx"), "utf8");
    assert.doesNotMatch(src, /"Needs auth"|"Not installed"/);
    assert.doesNotMatch(src, /disabled=\{!ready\}/, "an app the report got wrong could not be chosen");
    assert.match(src, /cliStatusState\(/);
    const panel = readFileSync(join(ROOT, "components/BridgeCliPanel.tsx"), "utf8");
    assert.match(panel, /CLI_STATE_LABEL\[cli\]/);
  });

  // -- 4 + 5. The label opens AI brain at the engine; the chat has room ---------
  console.log("4-5. label and layout");
  await check("every 'what powers this' label opens Settings > AI brain at the engine section", () => {
    assert.equal(engineLib.ENGINE_SETTINGS_HREF, "/settings/ai#engine");
    const settings = readFileSync(join(ROOT, "components/settings/SettingsContent.tsx"), "utf8");
    assert.match(settings, /id="engine"/, "the section the link opens (OpenSectionOnHash opens a <details> by id)");
    const widget = readFileSync(join(ROOT, "components/ChatWidget.tsx"), "utf8");
    assert.match(widget, /href=\{ENGINE_SETTINGS_HREF\}[\s\S]{0,200}data-testid="harness-engine"/);
  });

  await check("the channel renders its label as that link, and its messages as bubbles with room to read (rendered)", () => {
    // The render needs whole React: drop the suite's react-server condition,
    // which CI passes down through NODE_OPTIONS (as tests/ai-workspace-account.test.ts does).
    const nodeOptions = (process.env.NODE_OPTIONS || "")
      .split(/\s+/)
      .filter((tok) => tok && !/^(--conditions|-C)(=|$)/.test(tok) && tok !== "react-server")
      .join(" ");
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_OPTIONS: nodeOptions };
    if (!nodeOptions) delete env.NODE_OPTIONS;
    const r = spawnSync(process.execPath, ["--import", "tsx", "tests/ai-engine.render.ts"], { encoding: "utf8", env, timeout: 120_000 });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const html = JSON.parse(r.stdout.trim().split("\n").pop() || "{}") as Record<string, string>;
    assert.match(html.header, /<a (?=[^>]*data-testid="channel-engine")(?=[^>]*href="\/settings\/ai#engine")[^>]*>/);
    assert.match(html.header, /Claude Code on your paired computer/);
    assert.match(html.header, /subscription, no API credits/);
    assert.match(html.fallback, /Fallback in use/);
    assert.match(html.fallback, /can&#x27;t be reached right now/);
  });

  await check("bubbles: sized to their text (max 42rem / 88%), yours right, the department's left, 1.65 line height, 20px apart, 'via' under its bubble", () => {
    assert.match(layout.chatBubbleClass("user"), /max-w-\[min\(42rem,88%\)\]/);
    assert.match(layout.chatBubbleClass("assistant"), /leading-\[1\.65\]/);
    assert.match(layout.chatBubbleClass("assistant"), /px-4 py-3/);
    assert.match(layout.chatRowClass("user"), /items-end/);
    assert.match(layout.chatRowClass("assistant"), /items-start/);
    assert.match(layout.CHAT_LIST_CLASS, /gap-5/);
    assert.doesNotMatch(layout.CHAT_VIA_CLASS, /-mt-/, "the via line is never pulled up into the bubble");
    const src = readFileSync(join(ROOT, "components/agents/AgentChat.tsx"), "utf8");
    assert.match(src, /className=\{chatBubbleClass\(t\.role\)\}/);
    assert.match(src, /<div className=\{CHAT_VIA_CLASS\}>via \{t\.runtime\}<\/div>/);
    assert.doesNotMatch(src, /ml-8 rounded-xl|mr-8 rounded-xl|-mt-2/);
  });

  finished = true;
  console.log(`\n${passed} passed, ${failures} failed`);
  if (failures) {
    for (const l of logged.slice(-10)) process.stdout.write(`  log: ${JSON.stringify(l).slice(0, 300)}\n`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.log(err);
  process.exit(1);
});
