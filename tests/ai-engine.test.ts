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
  alphaRace: u(5, "race-owner@alpha.test"),
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
/** The bridge's "tool" event, as the channel receives it: the kind of step in plain words, never its path or command. */
const STEP = { type: "tool", phase: "start", label: "Reading a file", ok: null };
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
      user_id TEXT, display_name_override TEXT, computer_pairing_id TEXT, fallback_policy TEXT,
      runtime_probe_job_id TEXT, runtime_probe_pairing_id TEXT, runtime_probe_engine_kind TEXT,
      runtime_probe_engine_name TEXT, runtime_probe_engine_version TEXT, runtime_probe_verified_at TEXT);
    CREATE UNIQUE INDEX idx_agent_model_config_default_per_agent ON agent_model_config (tenant_id, agent_key) WHERE (user_id IS NULL);
    CREATE UNIQUE INDEX idx_agent_model_config_override_per_user ON agent_model_config (tenant_id, user_id, agent_key) WHERE (user_id IS NOT NULL);
    CREATE UNIQUE INDEX idx_agent_model_config_engine_per_user ON agent_model_config (tenant_id, user_id, agent_key)
      WHERE user_id IS NOT NULL AND agent_key = '__engine__';
    CREATE TABLE bridge_pairings (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT, label TEXT, bridge_token_hash TEXT,
      machine_fingerprint TEXT, last_seen_at TEXT, revoked_at TEXT, created_at TEXT,
      scope TEXT, paired_via TEXT, claim_enabled_at TEXT, claim_enabled_by TEXT,
      claim_state_at TEXT, claim_capacity INTEGER, claim_blocked_reason TEXT,
      claim_protocols TEXT, claim_runtime_state TEXT
    );
    CREATE TABLE bridge_runtime_jobs (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, pairing_id TEXT NOT NULL,
      action TEXT NOT NULL, engine_kind TEXT NOT NULL, engine_name TEXT NOT NULL, prompt TEXT,
      status TEXT NOT NULL, idempotency_key TEXT NOT NULL, claim_id TEXT, lease_id TEXT,
      claimed_at TEXT, heartbeat_at TEXT, deadline_at TEXT, progress_code TEXT, result_code TEXT,
      result_json TEXT, error_code TEXT, error_retryable INTEGER, created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, finished_at TEXT
    );
  `);
  await db.executeMultiple(readFileSync(join(ROOT, "database/turso/bravo__192_ai_usage.sql"), "utf8"));
  await db.executeMultiple(readFileSync(join(ROOT, "database/turso/bravo__191_agent_turn_outcomes.sql"), "utf8"));
  await db.executeMultiple(readFileSync(join(ROOT, "database/turso/bravo__207_department_chat_runs.sql"), "utf8"));
  await db.executeMultiple(readFileSync(join(ROOT, "database/turso/bravo__213_dept_runs_computer.sql"), "utf8"));
  await db.execute("ALTER TABLE dept_chat_runs ADD COLUMN target_pairing_id TEXT");
  await db.execute("ALTER TABLE dept_chat_runs ADD COLUMN runtime_engine_kind TEXT");
  await db.execute("ALTER TABLE dept_chat_runs ADD COLUMN runtime_engine_name TEXT");
  await db.execute("ALTER TABLE dept_chat_runs ADD COLUMN runtime_fallback_policy TEXT");
  await db.execute("ALTER TABLE dept_chat_runs ADD COLUMN runtime_fallback_reason TEXT");
  await db.execute("ALTER TABLE dept_chat_runs ADD COLUMN runtime_api_provider TEXT");
  await db.execute("ALTER TABLE dept_chat_runs ADD COLUMN runtime_api_model TEXT");
  // O1: authorizeBridgeRequest now also gates on the workspace's agents
  // owner (lib/agents-owner.ts). CC must be named here or every "CC reaches
  // his paired computer" check below would fail on the NEW gate instead of
  // proving what this file exists to prove.
  await db.executeMultiple(readFileSync(join(ROOT, "database/turso/bravo__210_workspace_agents_owner.sql"), "utf8"));

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
      { sql: "INSERT INTO workspace_agents_owner (tenant_id, auth_user_id, set_by, set_at) VALUES (?, ?, 'test', ?)", args: [OASIS, USERS.cc.id, stamp] },
      profile("p-alpha", USERS.alpha, ALPHA, "owner", 1),
      profile("p-alpha-rep", USERS.alphaRep, ALPHA, "closer", 0),
      profile("p-alpha-race", USERS.alphaRace, ALPHA, "owner", 1),
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
  const harness = await import("../lib/admin/harness-targets");
  const chat = await import("../app/api/agents/chat/route");
  const cliStatus = await import("../lib/bridge-cli-status");
  const layout = await import("../components/agents/chat-layout");
  const { channelEngine } = await import("../components/os/department/channel");
  const { NextRequest } = await import("next/server");
  const req = (url: string, method: string, body?: unknown) =>
    new NextRequest(`http://localhost${url}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const jsonOf = async (res: Response) => ({ status: res.status, body: (await res.json()) as Record<string, unknown> });
  // Fixture repair between concurrency cases. Production activation is tested
  // through the staged receipt + engine CAS above; using that paid-probe route
  // for test cleanup would intentionally exhaust its five-attempt safety cap.
  const resetWorkspaceFixture = async (provider: "anthropic" | "openai" | "google" | "openrouter", apiKey: string, model: string) => {
    const now = Date.now();
    const encrypted = encryptField(apiKey);
    const reset = await db.batch(
      [
        {
          sql: "UPDATE agent_model_config SET provider = ?, model = ?, encrypted_api_key = ?, enabled = 1, updated_at = ? WHERE tenant_id = ? AND user_id IS NULL AND agent_key IN ('__workspace__', 'sdr')",
          args: [provider, model, encrypted, new Date(now - 1).toISOString(), ALPHA],
        },
        {
          sql: "UPDATE agent_model_config SET updated_at = ? WHERE tenant_id = ? AND user_id IS NULL AND agent_key = ?",
          args: [new Date(now - 2).toISOString(), ALPHA, store.savedKeyAgentKey(provider)],
        },
      ],
      "write",
    );
    assert.ok(reset[0].rowsAffected >= 1, "fixture workspace account was missing");
    await store.saveAgentEngine(ALPHA, { kind: "api" });
    return { status: 200, body: { ok: true } };
  };
  const sales = departmentBySlug("sales")!;
  const rowsOf = async (tenant: string) =>
    (await db.execute({ sql: "SELECT agent_key, provider, model, encrypted_api_key, enabled, computer_pairing_id, fallback_policy FROM agent_model_config WHERE tenant_id = ? AND user_id IS NULL ORDER BY agent_key", args: [tenant] })).rows.map((r) => ({
      agent_key: String(r.agent_key),
      provider: String(r.provider),
      model: String(r.model),
      key: r.encrypted_api_key === null ? null : decryptField(String(r.encrypted_api_key)),
      cipher: r.encrypted_api_key === null ? null : String(r.encrypted_api_key),
      enabled: Number(r.enabled),
      pairingId: r.computer_pairing_id === null ? null : String(r.computer_pairing_id),
      fallback: r.fallback_policy === null ? null : String(r.fallback_policy),
    }));

  console.log("ai-engine:");
  // -- 1. One choice, stored once; switching provider works --------------------
  console.log("1. what powers your agents");
  await check("no engine row is the AI account; a choice is stored on its own keyless row and read back", async () => {
    assert.deepEqual(await store.readAgentEngine(ALPHA), { kind: "api" });
    await store.saveAgentEngine(ALPHA, { kind: "cli", cli: "codex", pairingId: "pair-alpha", fallback: "none" });
    assert.deepEqual(await store.readAgentEngine(ALPHA), { kind: "cli", cli: "codex", pairingId: "pair-alpha", fallback: "none" });
    await store.saveAgentEngine(ALPHA, { kind: "local", model: "ollama/llama3.3", pairingId: "pair-alpha", fallback: "workspace_api" });
    assert.deepEqual(await store.readAgentEngine(ALPHA), {
      kind: "local",
      model: "ollama/llama3.3",
      pairingId: "pair-alpha",
      fallback: "workspace_api",
    });
    const row = (await rowsOf(ALPHA)).find((r) => r.agent_key === engineLib.ENGINE_AGENT_KEY);
    assert.ok(row && row.cipher === null, "the engine row holds no key");
    assert.equal(row.pairingId, "pair-alpha", "the exact computer is stored on the canonical engine row");
    assert.equal(row.fallback, "workspace_api", "fallback is explicit, never inferred");
    await store.saveAgentEngine(ALPHA, { kind: "api" });
    assert.deepEqual(await store.readAgentEngine(ALPHA), { kind: "api" });
    assert.equal(engineLib.parseEngineChoice({ kind: "cli", cli: "bash" }), null);
    assert.equal(engineLib.parseEngineChoice({ kind: "local", model: "x y; rm" }), null);
    assert.deepEqual(engineLib.engineFromRow({ provider: "cli", model: "nope" }), { kind: "api" });
  });

  await check("a canonical engine created during a legacy provider probe wins atomically", async () => {
    await login(USERS.alpha);
    await db.execute({
      sql: "DELETE FROM agent_model_config WHERE tenant_id = ? AND user_id IS NULL AND agent_key = '__engine__'",
      args: [ALPHA],
    });
    const beforeAccount = await account.readWorkspaceAiAccount(ALPHA);
    assert.ok(account.hasUsableKey(beforeAccount) && beforeAccount.provider === "anthropic");
    let enteredResolve!: () => void;
    let releaseResolve!: () => void;
    const entered = new Promise<void>((resolve) => (enteredResolve = resolve));
    const release = new Promise<void>((resolve) => (releaseResolve = resolve));
    answer = async (sentRequest) => {
      if (sentRequest.url.includes("openrouter.ai")) {
        enteredResolve();
        await release;
        return openrouterOk("The legacy key works.");
      }
      return anthropicOk("The canonical key works.");
    };
    sent = [];
    const staleConnect = bulk.POST(
      req("/api/agent-config/bulk-provider", "POST", {
        provider: "openrouter",
        api_key: KEY_OR,
        model: "anthropic/claude-sonnet-4.6",
        scope: "tenant",
      }),
    );
    await entered;
    await store.saveAgentEngine(ALPHA, { kind: "api", provider: "anthropic" });
    releaseResolve();
    const blocked = await jsonOf(await staleConnect);
    assert.equal(blocked.status, 409, JSON.stringify(blocked.body));
    assert.equal(blocked.body.error, "engine_upgrade_required");
    assert.equal(sent.length, 1, "the deliberately blocked provider probe did not run exactly once");
    assert.deepEqual(await store.readAgentEngine(ALPHA), { kind: "api", provider: "anthropic" });
    const afterAccount = await account.readWorkspaceAiAccount(ALPHA);
    assert.ok(
      account.hasUsableKey(afterAccount) &&
        afterAccount.provider === "anthropic" &&
        decryptField(afterAccount.encryptedApiKey) === decryptField(beforeAccount.encryptedApiKey),
      "the losing legacy request changed the workspace account",
    );
  });

  await check("a legacy provider activation that wins first makes the canonical API save lose atomically", async () => {
    await db.execute({
      sql: "DELETE FROM agent_model_config WHERE tenant_id = ? AND user_id IS NULL AND agent_key = '__engine__'",
      args: [ALPHA],
    });
    const staleSnapshot = await account.readWorkspaceAccountSnapshot(ALPHA);
    assert.ok(account.hasUsableKey(staleSnapshot.account) && staleSnapshot.account.provider === "anthropic");
    const legacyStamp = await account.readAccountStamp(ALPHA);
    const legacy = await account.connectWorkspaceAccountInOneStep({
      tenantId: ALPHA,
      stamp: legacyStamp,
      provider: "openrouter",
      model: "anthropic/claude-sonnet-4.6",
      encryptedApiKey: encryptField(KEY_OR),
      agentKeys: [],
      requireEngineAbsent: true,
    });
    assert.equal(legacy.committed, true, "the legacy writer did not win the arranged interleaving");
    const canonical = await account.saveApiEngineIfAccountAndEngineCurrent({
      tenantId: ALPHA,
      stamp: staleSnapshot.stamp,
      engine: { userId: null, expectedVersion: null, choice: { kind: "api", provider: "anthropic" } },
    });
    assert.equal(canonical, false, "a canonical engine was saved against a changed account snapshot");
    assert.equal(await store.readAgentEngineVersion(ALPHA), null, "the losing canonical request left an engine row");
    const afterLegacy = await account.readWorkspaceAiAccount(ALPHA);
    assert.ok(account.hasUsableKey(afterLegacy) && afterLegacy.provider === "openrouter" && decryptField(afterLegacy.encryptedApiKey) === KEY_OR);
    await resetWorkspaceFixture("anthropic", KEY_ANTH, "claude-sonnet-4-6");
    await store.saveAgentEngine(ALPHA, { kind: "api", provider: "anthropic" });
  });

  await check("the pre-engine provider-switch endpoint fails closed without changing keys", async () => {
    await login(USERS.alpha);
    answer = (s) => (s.url.includes("openrouter.ai") ? openrouterOk("Here is a short answer.") : anthropicOk("Here is a short answer."));
    sent = [];
    const before = JSON.stringify(await rowsOf(ALPHA));
    const first = await jsonOf(await providerRoute.POST(req("/api/agent-config/workspace-provider", "POST", { provider: "openrouter" })));
    assert.equal(first.status, 409, JSON.stringify(first.body));
    assert.equal(first.body.error, "engine_upgrade_required");
    assert.match(String(first.body.message), /Refresh Settings > AI brain/);
    assert.equal(sent.length, 0, "the retired endpoint spent API credits");
    assert.equal(JSON.stringify(await rowsOf(ALPHA)), before, "the retired endpoint changed provider state");
    const acct = await account.readWorkspaceAiAccount(ALPHA);
    assert.ok(account.hasUsableKey(acct) && acct.provider === "anthropic" && decryptField(acct.encryptedApiKey) === KEY_ANTH);
  });

  await check("a stale direct workspace-key connect cannot split the active account from the canonical engine", async () => {
    await login(USERS.alpha);
    answer = (s) => (s.url.includes("openrouter.ai") ? openrouterOk("This must not run.") : anthropicOk("This must not run."));
    sent = [];
    const before = JSON.stringify(await rowsOf(ALPHA));
    const attempted = await jsonOf(
      await bulk.POST(
        req("/api/agent-config/bulk-provider", "POST", {
          provider: "openrouter",
          api_key: KEY_OR,
          model: "anthropic/claude-sonnet-4.6",
          scope: "tenant",
        }),
      ),
    );
    assert.equal(attempted.status, 409, JSON.stringify(attempted.body));
    assert.equal(attempted.body.error, "engine_upgrade_required");
    assert.equal(sent.length, 0, "the stale connect spent API credits before it was rejected");
    assert.equal(JSON.stringify(await rowsOf(ALPHA)), before, "the stale connect changed provider state");
    assert.deepEqual(await store.readAgentEngine(ALPHA), { kind: "api", provider: "anthropic" });
  });

  await check("a personal canonical engine also blocks the retired workspace-key activation path", async () => {
    await db.execute({
      sql: "DELETE FROM agent_model_config WHERE tenant_id = ? AND user_id IS NULL AND agent_key = '__engine__'",
      args: [ALPHA],
    });
    const personalSaved = await store.savePersonAgentEngineIfCurrent(
      ALPHA,
      USERS.alpha.id,
      { kind: "api", provider: "anthropic" },
      null,
    );
    assert.equal(personalSaved, true);
    answer = () => openrouterOk("This must not run.");
    sent = [];
    const before = await account.readWorkspaceAiAccount(ALPHA);
    const attempted = await jsonOf(
      await bulk.POST(
        req("/api/agent-config/bulk-provider", "POST", {
          provider: "openrouter",
          api_key: KEY_OR,
          model: "anthropic/claude-sonnet-4.6",
          scope: "tenant",
        }),
      ),
    );
    assert.equal(attempted.status, 409, JSON.stringify(attempted.body));
    assert.equal(attempted.body.error, "engine_upgrade_required");
    assert.equal(sent.length, 0, "the retired connect spent API credits despite a personal canonical engine");
    const after = await account.readWorkspaceAiAccount(ALPHA);
    assert.ok(
      account.hasUsableKey(before) &&
        account.hasUsableKey(after) &&
        after.provider === before.provider &&
        decryptField(after.encryptedApiKey) === decryptField(before.encryptedApiKey),
      "the retired connect changed the shared account behind a personal engine",
    );
    const personalVersion = await store.readPersonAgentEngineVersion(ALPHA, USERS.alpha.id);
    assert.ok(personalVersion);
    assert.equal(await store.clearPersonEngineIfCurrent(ALPHA, USERS.alpha.id, personalVersion), true);
    await store.saveAgentEngine(ALPHA, { kind: "api", provider: "anthropic" });
  });

  await check("the retired provider route still validates input and permissions without changing anything", async () => {
    const before = JSON.stringify(await rowsOf(ALPHA));
    const invalid = await jsonOf(await providerRoute.POST(req("/api/agent-config/workspace-provider", "POST", { provider: "not-a-provider" })));
    assert.equal(invalid.status, 400);
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
  });

  await check("stage-only rejects a local provider before probing or writing", async () => {
    await login(USERS.alpha);
    answer = () => {
      throw new Error("a rejected local stage must not probe");
    };
    sent = [];
    const before = JSON.stringify(await rowsOf(ALPHA));
    const rejected = await jsonOf(
      await bulk.POST(
        req("/api/agent-config/bulk-provider", "POST", {
          provider: "ollama",
          api_key: "http://127.0.0.1:11434",
          model: "llama3.3",
          scope: "tenant",
          stage_only: true,
        }),
      ),
    );
    assert.equal(rejected.status, 400, JSON.stringify(rejected.body));
    assert.equal(rejected.body.error, "stage_unsupported_provider");
    assert.equal(sent.length, 0, "a rejected local stage reached a provider or local-model server");
    assert.equal(JSON.stringify(await rowsOf(ALPHA)), before, "a rejected local stage changed provider rows");
  });

  await check("a first-time workspace key stays inactive until Use atomically switches the account and engine", async () => {
    await login(USERS.alpha);
    answer = (s) => (s.url.includes("openrouter.ai") ? openrouterOk("The staged key works.") : anthropicOk("The current key works."));
    sent = [];
    const staged = await jsonOf(
      await bulk.POST(
        req("/api/agent-config/bulk-provider", "POST", {
          provider: "openrouter",
          api_key: KEY_OR,
          model: "anthropic/claude-sonnet-4.6",
          scope: "tenant",
          stage_only: true,
        }),
      ),
    );
    assert.equal(staged.status, 200, JSON.stringify(staged.body));
    assert.equal(staged.body.staged, true);
    assert.equal(typeof staged.body.staged_key_receipt, "string", "staging did not return an immutable key receipt");
    assert.equal(staged.body.workspace_account, false, "staging silently activated the workspace account");
    assert.deepEqual(staged.body.applied_to, [], "staging rewrote teammate rows before Use");
    const beforeUse = await account.readWorkspaceAiAccount(ALPHA);
    assert.ok(account.hasUsableKey(beforeUse) && beforeUse.provider === "anthropic", "the workspace account changed before Use");
    assert.equal((await rowsOf(ALPHA)).find((r) => r.agent_key === "sdr")?.provider, "anthropic");
    const cached = await store.readSavedKey(ALPHA, "openrouter");
    assert.ok(cached?.source === "kept" && decryptField(cached.encryptedApiKey) === KEY_OR, "the tested key was not staged inactive");

    const engineRoute = await import("../app/api/ai/engine/route");
    const version = await store.readAgentEngineVersion(ALPHA);
    sent = [];
    const used = await jsonOf(
      await engineRoute.PUT(
        req("/api/ai/engine", "PUT", {
          scope: "workspace",
          expected_version: version,
          expected_saved_key_receipt: staged.body.staged_key_receipt,
          engine: { mode: "api", provider: "openrouter" },
        }),
      ),
    );
    assert.equal(used.status, 200, JSON.stringify(used.body));
    assert.equal(sent.length, 1, "Use did not verify the exact staged key once");
    assert.equal(keyOf(sent[0]), KEY_OR);
    const afterUse = await account.readWorkspaceAiAccount(ALPHA);
    assert.ok(account.hasUsableKey(afterUse) && afterUse.provider === "openrouter" && decryptField(afterUse.encryptedApiKey) === KEY_OR);
    assert.deepEqual(await store.readAgentEngine(ALPHA), { kind: "api", provider: "openrouter" });
    const teammate = (await rowsOf(ALPHA)).find((r) => r.agent_key === "sdr");
    assert.ok(teammate?.provider === "openrouter" && teammate.key === KEY_OR, "the workspace switch left a teammate on the old provider");

    // Restore the fixture through the same atomic account + engine switch.
    const savedAnth = await store.readSavedKey(ALPHA, "anthropic");
    assert.ok(savedAnth, "the outgoing Anthropic key was not cached for a switch back");
    const restored = await jsonOf(
      await engineRoute.PUT(
        req("/api/ai/engine", "PUT", {
          scope: "workspace",
          expected_version: await store.readAgentEngineVersion(ALPHA),
          expected_saved_key_receipt: savedAnth.receipt,
          engine: { mode: "api", provider: "anthropic" },
        }),
      ),
    );
    assert.equal(restored.status, 200, JSON.stringify(restored.body));

    // Replacing the key for the provider already selected follows the same
    // staged transaction; it must not be mistaken for "already in use".
    const replacement = "sk-ant-alpha-replacement-key-0004";
    const stagedReplacement = await jsonOf(
      await bulk.POST(
        req("/api/agent-config/bulk-provider", "POST", {
          provider: "anthropic",
          api_key: replacement,
          model: "claude-sonnet-4-6",
          scope: "tenant",
          stage_only: true,
        }),
      ),
    );
    assert.equal(stagedReplacement.status, 200, JSON.stringify(stagedReplacement.body));
    assert.equal(typeof stagedReplacement.body.staged_key_receipt, "string");
    const replaceVersion = await store.readAgentEngineVersion(ALPHA);
    const replaced = await jsonOf(
      await engineRoute.PUT(
        req("/api/ai/engine", "PUT", {
          scope: "workspace",
          expected_version: replaceVersion,
          expected_saved_key_receipt: stagedReplacement.body.staged_key_receipt,
          engine: { mode: "api", provider: "anthropic" },
        }),
      ),
    );
    assert.equal(replaced.status, 200, JSON.stringify(replaced.body));
    const replacedAccount = await account.readWorkspaceAiAccount(ALPHA);
    assert.ok(account.hasUsableKey(replacedAccount) && decryptField(replacedAccount.encryptedApiKey) === replacement);
    const reset = await resetWorkspaceFixture("anthropic", KEY_ANTH, "claude-sonnet-4-6");
    assert.equal(reset.status, 200, JSON.stringify(reset.body));
    const noRevert = await jsonOf(
      await engineRoute.PUT(
        req("/api/ai/engine", "PUT", {
          scope: "workspace",
          expected_version: await store.readAgentEngineVersion(ALPHA),
          engine: { mode: "api", provider: "anthropic" },
        }),
      ),
    );
    assert.equal(noRevert.status, 200, JSON.stringify(noRevert.body));
    const stillReset = await account.readWorkspaceAiAccount(ALPHA);
    assert.ok(account.hasUsableKey(stillReset) && decryptField(stillReset.encryptedApiKey) === KEY_ANTH, "an older cached key replaced the newer active key");
    await store.saveAgentEngine(ALPHA, { kind: "api" });
  });

  await check("a slower same-provider Use cannot replace a newer staged key", async () => {
    await login(USERS.alphaRace);
    const engineRoute = await import("../app/api/ai/engine/route");
    const firstKey = "sk-ant-race-first-key-0005";
    const newerKey = "sk-ant-race-newer-key-0006";
    answer = () => anthropicOk("The current key works.");
    const reset = await resetWorkspaceFixture("anthropic", KEY_ANTH, "claude-sonnet-4-6");
    assert.equal(reset.status, 200, JSON.stringify(reset.body));
    await store.saveAgentEngine(ALPHA, { kind: "api" });
    await db.execute({
      sql: "UPDATE agent_model_config SET updated_at = '2000-01-01T00:00:00.000Z' WHERE tenant_id = ? AND user_id IS NULL AND agent_key = '__workspace__'",
      args: [ALPHA],
    });
    await store.keepSavedKey({ tenantId: ALPHA, provider: "anthropic", model: "claude-sonnet-4-6", encryptedApiKey: encryptField(firstKey) });
    const first = await store.readSavedKey(ALPHA, "anthropic");
    assert.ok(first?.source === "kept" && decryptField(first.encryptedApiKey) === firstKey);
    const versionBefore = await store.readAgentEngineVersion(ALPHA);

    let enteredResolve!: () => void;
    let releaseResolve!: () => void;
    const entered = new Promise<void>((resolve) => (enteredResolve = resolve));
    const release = new Promise<void>((resolve) => (releaseResolve = resolve));
    answer = async (sentRequest) => {
      if (keyOf(sentRequest) === firstKey) {
        enteredResolve();
        await release;
      }
      return anthropicOk("The staged key works.");
    };
    const pending = engineRoute.PUT(
      req("/api/ai/engine", "PUT", {
        scope: "workspace",
        expected_version: versionBefore,
        expected_saved_key_receipt: first.receipt,
        engine: { mode: "api", provider: "anthropic" },
      }),
    );
    await entered;
    await store.keepSavedKey({ tenantId: ALPHA, provider: "anthropic", model: "claude-sonnet-4-6", encryptedApiKey: encryptField(newerKey) });
    const newerBeforeResume = await store.readSavedKeySlot(ALPHA, "anthropic");
    const newer = await store.readSavedKey(ALPHA, "anthropic");
    assert.ok(newer?.source === "kept" && decryptField(newer.encryptedApiKey) === newerKey);
    releaseResolve();
    const stale = await jsonOf(await pending);
    assert.equal(stale.status, 409, JSON.stringify(stale.body));
    assert.equal(stale.body.error, "stale_provider_key");
    assert.equal(await store.readAgentEngineVersion(ALPHA), versionBefore, "the losing request changed the engine row");
    assert.deepEqual(await store.readSavedKeySlot(ALPHA, "anthropic"), newerBeforeResume, "the losing request rewrote the newer staged key");
    const unchanged = await account.readWorkspaceAiAccount(ALPHA);
    assert.ok(account.hasUsableKey(unchanged) && decryptField(unchanged.encryptedApiKey) === KEY_ANTH, "the losing request changed the active account");

    answer = () => anthropicOk("The newer key works.");
    const activated = await jsonOf(
      await engineRoute.PUT(
        req("/api/ai/engine", "PUT", {
          scope: "workspace",
          expected_version: versionBefore,
          expected_saved_key_receipt: newer.receipt,
          engine: { mode: "api", provider: "anthropic" },
        }),
      ),
    );
    assert.equal(activated.status, 200, JSON.stringify(activated.body));
    const activeNewer = await account.readWorkspaceAiAccount(ALPHA);
    assert.ok(account.hasUsableKey(activeNewer) && decryptField(activeNewer.encryptedApiKey) === newerKey);
  });

  await check("a losing engine CAS has zero cache effects, while a winning switch preserves a newer outgoing stage", async () => {
    await login(USERS.alphaRace);
    const engineRoute = await import("../app/api/ai/engine/route");
    const outgoingOne = "sk-ant-outgoing-stage-0007";
    const outgoingTwo = "sk-ant-outgoing-newer-0008";
    answer = (sentRequest) => (sentRequest.url.includes("openrouter.ai") ? openrouterOk("OpenRouter works.") : anthropicOk("Anthropic works."));
    const reset = await resetWorkspaceFixture("anthropic", KEY_ANTH, "claude-sonnet-4-6");
    assert.equal(reset.status, 200, JSON.stringify(reset.body));
    await store.saveAgentEngine(ALPHA, { kind: "api" });
    await store.keepSavedKey({ tenantId: ALPHA, provider: "openrouter", model: "anthropic/claude-sonnet-4.6", encryptedApiKey: encryptField(KEY_OR) });
    const openrouter = await store.readSavedKey(ALPHA, "openrouter");
    assert.ok(openrouter?.source === "kept");

    let enteredResolve!: () => void;
    let releaseResolve!: () => void;
    const entered = new Promise<void>((resolve) => (enteredResolve = resolve));
    const release = new Promise<void>((resolve) => (releaseResolve = resolve));
    answer = async (sentRequest) => {
      if (keyOf(sentRequest) === KEY_OR) {
        enteredResolve();
        await release;
        return openrouterOk("OpenRouter works.");
      }
      return anthropicOk("Anthropic works.");
    };
    const staleVersion = await store.readAgentEngineVersion(ALPHA);
    const losing = engineRoute.PUT(
      req("/api/ai/engine", "PUT", {
        scope: "workspace",
        expected_version: staleVersion,
        expected_saved_key_receipt: openrouter.receipt,
        engine: { mode: "api", provider: "openrouter" },
      }),
    );
    await entered;
    await store.saveAgentEngine(ALPHA, { kind: "cli", cli: "codex", pairingId: "pair-race", fallback: "none" });
    await store.keepSavedKey({ tenantId: ALPHA, provider: "anthropic", model: "claude-sonnet-4-6", encryptedApiKey: encryptField(outgoingOne) });
    const outgoingAfterConcurrentSave = await store.readSavedKeySlot(ALPHA, "anthropic");
    releaseResolve();
    const lost = await jsonOf(await losing);
    assert.equal(lost.status, 409, JSON.stringify(lost.body));
    assert.equal(lost.body.error, "stale_choice");
    assert.deepEqual(await store.readSavedKeySlot(ALPHA, "anthropic"), outgoingAfterConcurrentSave, "a losing engine CAS changed the outgoing cache");
    const accountAfterLoss = await account.readWorkspaceAiAccount(ALPHA);
    assert.ok(account.hasUsableKey(accountAfterLoss) && decryptField(accountAfterLoss.encryptedApiKey) === KEY_ANTH);
    assert.deepEqual(await store.readAgentEngine(ALPHA), { kind: "cli", cli: "codex", pairingId: "pair-race", fallback: "none" });

    answer = (sentRequest) => (sentRequest.url.includes("openrouter.ai") ? openrouterOk("OpenRouter works.") : anthropicOk("Anthropic works."));
    const accountRefresh = await resetWorkspaceFixture("anthropic", KEY_ANTH, "claude-sonnet-4-6");
    assert.equal(accountRefresh.status, 200, JSON.stringify(accountRefresh.body));
    await db.execute({
      sql: "UPDATE agent_model_config SET updated_at = '2099-01-01T00:00:00.000Z' WHERE tenant_id = ? AND user_id IS NULL AND agent_key = '__workspace__'",
      args: [ALPHA],
    });
    await store.saveAgentEngine(ALPHA, { kind: "api" });

    let winningEnteredResolve!: () => void;
    let winningReleaseResolve!: () => void;
    const winningEntered = new Promise<void>((resolve) => (winningEnteredResolve = resolve));
    const winningRelease = new Promise<void>((resolve) => (winningReleaseResolve = resolve));
    answer = async (sentRequest) => {
      if (keyOf(sentRequest) === KEY_OR) {
        winningEnteredResolve();
        await winningRelease;
        return openrouterOk("OpenRouter works.");
      }
      return anthropicOk("Anthropic works.");
    };
    const winning = engineRoute.PUT(
      req("/api/ai/engine", "PUT", {
        scope: "workspace",
        expected_version: await store.readAgentEngineVersion(ALPHA),
        expected_saved_key_receipt: openrouter.receipt,
        engine: { mode: "api", provider: "openrouter" },
      }),
    );
    await winningEntered;
    await store.keepSavedKey({ tenantId: ALPHA, provider: "anthropic", model: "claude-sonnet-4-6", encryptedApiKey: encryptField(outgoingTwo) });
    const newestOutgoing = await store.readSavedKey(ALPHA, "anthropic");
    const newestOutgoingSlot = await store.readSavedKeySlot(ALPHA, "anthropic");
    assert.ok(newestOutgoing?.source === "kept" && decryptField(newestOutgoing.encryptedApiKey) === outgoingTwo);
    winningReleaseResolve();
    const won = await jsonOf(await winning);
    assert.equal(won.status, 200, JSON.stringify(won.body));
    assert.deepEqual(await store.readSavedKeySlot(ALPHA, "anthropic"), newestOutgoingSlot, "the winning switch overwrote a newer outgoing stage");

    answer = () => anthropicOk("The newest outgoing key works.");
    const switchedBack = await jsonOf(
      await engineRoute.PUT(
        req("/api/ai/engine", "PUT", {
          scope: "workspace",
          expected_version: await store.readAgentEngineVersion(ALPHA),
          expected_saved_key_receipt: newestOutgoing.receipt,
          engine: { mode: "api", provider: "anthropic" },
        }),
      ),
    );
    assert.equal(switchedBack.status, 200, JSON.stringify(switchedBack.body));
    const finalAccount = await account.readWorkspaceAiAccount(ALPHA);
    assert.ok(account.hasUsableKey(finalAccount) && decryptField(finalAccount.encryptedApiKey) === outgoingTwo);

    answer = () => anthropicOk("The fixture key works.");
    const finalReset = await resetWorkspaceFixture("anthropic", KEY_ANTH, "claude-sonnet-4-6");
    assert.equal(finalReset.status, 200, JSON.stringify(finalReset.body));
    await store.saveAgentEngine(ALPHA, { kind: "api" });
  });

  await check("My setup cannot stage or activate a different workspace API provider", async () => {
    await login(USERS.alpha);
    const before = await account.readWorkspaceAiAccount(ALPHA);
    assert.ok(account.hasUsableKey(before) && before.provider === "anthropic");
    const invalidStage = await jsonOf(
      await bulk.POST(
        req("/api/agent-config/bulk-provider", "POST", {
          provider: "openrouter",
          api_key: KEY_OR,
          model: "anthropic/claude-sonnet-4.6",
          scope: "user",
          stage_only: true,
        }),
      ),
    );
    assert.equal(invalidStage.status, 400);
    assert.equal(invalidStage.body.error, "stage_requires_tenant_scope");
    const engineRoute = await import("../app/api/ai/engine/route");
    const personal = await jsonOf(
      await engineRoute.PUT(
        req("/api/ai/engine", "PUT", {
          scope: "person",
          expected_version: await store.readPersonAgentEngineVersion(ALPHA, USERS.alpha.id),
          engine: { mode: "api", provider: "openrouter" },
        }),
      ),
    );
    assert.equal(personal.status, 409);
    assert.equal(personal.body.error, "api_provider_workspace_scope_required");
    const after = await account.readWorkspaceAiAccount(ALPHA);
    assert.ok(account.hasUsableKey(after) && after.provider === "anthropic" && decryptField(after.encryptedApiKey) === KEY_ANTH);
    assert.equal(await store.readPersonAgentEngine(ALPHA, USERS.alpha.id), null, "a rejected personal switch left an engine override");
  });

  await check("a subscription selection is invalid until it names one exact paired computer", async () => {
    const client = await import("../components/settings/agent-engine-client");
    assert.equal(
      engineLib.parseEngineSelection({ mode: "subscription", provider: "claude", fallback: "none" }),
      null,
      "the canonical server payload cannot be unbound",
    );
    const selection = { mode: "subscription", provider: "claude", pairingId: "pair-alpha", fallback: "none" } as const;
    assert.deepEqual(engineLib.parseEngineSelection(selection), selection);
    const calls: Array<{ url: string; body: unknown }> = [];
    const queued = await client.queueEngineProbe(selection, "person", async (url, init) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ ok: true, job_id: "probe-alpha" }), { status: 202 });
    });
    assert.deepEqual(queued, { ok: true, jobId: "probe-alpha" });
    assert.deepEqual(calls, [{ url: "/api/ai/engine", body: { engine: selection, scope: "person" } }]);
    assert.deepEqual(await store.readAgentEngine(ALPHA), { kind: "api" }, "queueing a test does not save the candidate");
  });

  await check("Test, poll and Save keep the same pairing, runtime, probe receipt and engine version end to end", async () => {
    const client = await import("../components/settings/agent-engine-client");
    const selection = { mode: "subscription", provider: "codex", pairingId: "pair-ccpc", fallback: "none" } as const;
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    let reads = 0;
    const fetcher = async (url: string, init: RequestInit) => {
      calls.push({ url, method: String(init.method), body: init.body ? JSON.parse(String(init.body)) : null });
      if (url === "/api/ai/engine" && init.method === "POST") {
        return new Response(JSON.stringify({ ok: true, job_id: "probe-ccpc-codex" }), { status: 202 });
      }
      if (url === "/api/bridge/runtime-jobs/probe-ccpc-codex") {
        reads += 1;
        const status = reads === 1 ? "queued" : "completed";
        return new Response(
          JSON.stringify({
            ok: true,
            job: {
              id: "probe-ccpc-codex",
              status,
              action: "probe",
              engine: { kind: "cli", name: "codex" },
              result: status === "completed" ? { reply: "Ready when you are.", latency_ms: 420 } : null,
            },
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ ok: true, engine: selection }), { status: 200 });
    };
    const queued = await client.queueEngineProbe(selection, "workspace", fetcher);
    assert.equal(queued.ok, true);
    if (!queued.ok) return;
    const finished = await client.pollRuntimeJob(queued.jobId, fetcher, { intervalMs: 0 });
    assert.equal(finished.ok && finished.job.status, "done");
    const saved = await client.saveEngine(selection, "workspace-v7", fetcher, {
      scope: "workspace",
      probeJobId: queued.jobId,
    });
    assert.equal(saved.ok, true);
    assert.deepEqual(calls[0], {
      url: "/api/ai/engine",
      method: "POST",
      body: { engine: selection, scope: "workspace" },
    });
    assert.deepEqual(calls.at(-1), {
      url: "/api/ai/engine",
      method: "PUT",
      body: { engine: selection, scope: "workspace", expected_version: "workspace-v7", probe_job_id: "probe-ccpc-codex" },
    });
    assert.ok(
      calls.filter((call) => call.url === "/api/bridge/runtime-jobs/probe-ccpc-codex").every((call) => call.method === "GET"),
      "polling reads only the receipt for the queued exact-pairing probe",
    );
  });

  await check("ONLY THE LATEST CHOICE WINS: CAS rejects a stale exact-device row and a cancelled browser save commits nothing", async () => {
    const client = await import("../components/settings/agent-engine-client");
    const codex = { kind: "cli", cli: "codex", pairingId: "pair-ccpc", fallback: "none" } as const;
    const claude = { kind: "cli", cli: "claude", pairingId: "pair-mac", fallback: "none" } as const;
    await store.saveAgentEngine(OASIS, codex);
    const versionRow = await db.execute({
      sql: "SELECT updated_at FROM agent_model_config WHERE tenant_id = ? AND user_id IS NULL AND agent_key = '__engine__'",
      args: [OASIS],
    });
    const staleVersion = String(versionRow.rows[0].updated_at);
    await new Promise((resolve) => setTimeout(resolve, 2));
    await store.saveAgentEngine(OASIS, claude);
    assert.equal(
      await store.saveAgentEngineIfCurrent(OASIS, { ...codex, pairingId: "pair-late" }, staleVersion),
      false,
      "a late save cannot overwrite the newer exact pairing",
    );
    assert.deepEqual(await store.readAgentEngine(OASIS), claude);

    let seenSignal: AbortSignal | null = null;
    let sentBody: Record<string, unknown> | null = null;
    const waits = (_url: string, init: RequestInit) => {
      seenSignal = init.signal;
      sentBody = JSON.parse(String(init.body)) as Record<string, unknown>;
      return new Promise<Response>(() => undefined);
    };
    const ctl = new AbortController();
    const pending = client.saveEngine(
      { mode: "subscription", provider: "codex", pairingId: "pair-ccpc", fallback: "none" },
      "workspace-v8",
      waits,
      { scope: "workspace", probeJobId: "probe-8", signal: ctl.signal },
    );
    ctl.abort();
    const cancelled = await pending;
    assert.equal(cancelled.ok, false);
    assert.equal((cancelled as { stopped?: boolean }).stopped, true);
    assert.equal(seenSignal?.aborted, true, "Cancel aborts the in-flight save request");
    assert.deepEqual(sentBody, {
      engine: { mode: "subscription", provider: "codex", pairingId: "pair-ccpc", fallback: "none" },
      scope: "workspace",
      expected_version: "workspace-v8",
      probe_job_id: "probe-8",
    });
    assert.deepEqual(await store.readAgentEngine(OASIS), claude, "the cancelled browser call did not mutate the row");
    await store.saveAgentEngine(OASIS, { kind: "cli", cli: "codex" });
  });

  await check("Save rejects a successful probe that is older than the ten-minute pre-save window", async () => {
    await login(USERS.cc);
    await store.saveAgentEngine(OASIS, { kind: "api" });
    const version = await store.readAgentEngineVersion(OASIS);
    const pairingId = "pair-stale-probe";
    const jobId = "probe-stale-codex";
    const staleAt = new Date(Date.now() - 10 * 60_000 - 1_000).toISOString();
    await db.execute({
      sql: `INSERT INTO bridge_pairings
        (id, tenant_id, user_id, label, bridge_token_hash, last_seen_at, created_at, scope, paired_via,
         claim_enabled_at, claim_enabled_by, claim_state_at, claim_capacity, claim_protocols, claim_runtime_state)
        VALUES (?, ?, ?, 'CCPC', 'hash', ?, ?, 'connector', 'pair_code', ?, ?, ?, 1, ?, ?)`,
      args: [
        pairingId,
        OASIS,
        USERS.cc.id,
        new Date().toISOString(),
        stamp,
        stamp,
        USERS.cc.id,
        new Date().toISOString(),
        JSON.stringify(["runtime_action_v1", "department_task_v2", "coding_harness_task_v1"]),
        JSON.stringify({ codex: { installed: true, authenticated: true, state: "ready" } }),
      ],
    });
    await db.execute({
      sql: `INSERT INTO bridge_runtime_jobs
        (id, tenant_id, user_id, pairing_id, action, engine_kind, engine_name, prompt, status, idempotency_key,
         result_code, result_json, created_at, updated_at, finished_at)
        VALUES (?, ?, ?, ?, 'probe', 'cli', 'codex', 'test', 'completed', ?, 'probe_ok', ?, ?, ?, ?)`,
      args: [jobId, OASIS, USERS.cc.id, pairingId, `idem-${jobId}`, JSON.stringify({ answer: "OASIS_RUNTIME_READY" }), staleAt, staleAt, staleAt],
    });
    const engineRoute = await import("../app/api/ai/engine/route");
    const response = await jsonOf(
      await engineRoute.PUT(
        req("/api/ai/engine", "PUT", {
          scope: "workspace",
          expected_version: version,
          probe_job_id: jobId,
          engine: { mode: "subscription", provider: "codex", pairingId, fallback: "none" },
        }),
      ),
    );
    assert.equal(response.status, 409, JSON.stringify(response.body));
    assert.equal(response.body.error, "probe_mismatch");
    assert.deepEqual(await store.readAgentEngine(OASIS), { kind: "api" }, "a stale test changed the engine row");
    const freshAt = new Date().toISOString();
    await db.execute({
      sql: "UPDATE bridge_runtime_jobs SET created_at = ?, updated_at = ?, finished_at = ? WHERE id = ?",
      args: [freshAt, freshAt, freshAt, jobId],
    });
    const saved = await jsonOf(
      await engineRoute.PUT(
        req("/api/ai/engine", "PUT", {
          scope: "workspace",
          expected_version: version,
          probe_job_id: jobId,
          engine: { mode: "subscription", provider: "codex", pairingId, fallback: "none" },
        }),
      ),
    );
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const proved = await store.readEffectiveAgentEngineWithProof(OASIS, USERS.cc.id);
    assert.equal(proved.probeProof?.jobId, jobId, "the successful Save did not persist its exact probe proof");
    assert.equal(proved.probeProof?.engineVersion, proved.version, "the saved proof was not bound to the new engine version");
    await store.saveAgentEngine(OASIS, { kind: "cli", cli: "codex" });
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
    assert.deepEqual(events, [STEP, { type: "delta", text: "Pipeline is healthy." }, { type: "done", inputTokens: 0, outputTokens: 0 }]);
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

  await check("OASIS with the computer NOT reachable for someone entitled to it: the AI account answers, and the turn says it could not be reached", async () => {
    const prepared = await oasisTurn("sales", "sdr", async () => ({ unavailable: "not_set_up" as const }));
    assert.ok(prepared.ok, JSON.stringify(prepared));
    if (!prepared.ok) return;
    assert.equal(prepared.turn.engine.kind, "api");
    assert.equal(prepared.turn.engine.fellBackFrom, "Codex on your paired computer");
    assert.equal(prepared.turn.engine.notUsedFor, null);
    assert.equal(prepared.turn.engine.spend, "api_credits");
    // A gate that THROWS is the same: the person may use the computer and it did not answer.
    const threw = await oasisTurn("sales", "sdr", async () => {
      throw new Error("gate down");
    });
    assert.ok(threw.ok && threw.turn.engine.kind === "api" && threw.turn.engine.fellBackFrom === "Codex on your paired computer");
  });

  await check("Slack-style synchronous turns fail closed on a saved computer engine unless workspace_api fallback was explicitly saved", async () => {
    let bridgeAsked = 0;
    await store.saveAgentEngine(OASIS, { kind: "cli", cli: "codex", pairingId: "pair-ccpc", fallback: "none" });
    const refused = await prepareAgentTurn({
      tenantId: OASIS,
      tenantSlug: "oasis-ai-cc",
      agentSlug: "sdr",
      department: sales,
      operator: { name: "CC", email: USERS.cc.email },
      platformFallback: null,
      revealModel: false,
      userId: null,
      bridge: async () => {
        bridgeAsked += 1;
        return ccCaller;
      },
      failClosedWithoutComputerDispatch: true,
    });
    assert.ok(!refused.ok && refused.error === "engine_dispatch_unavailable", JSON.stringify(refused));
    assert.match(String(!refused.ok && refused.extra?.hint), /no API credits were used/i);
    assert.equal(bridgeAsked, 0, "the legacy shared bridge was never asked instead of the exact saved pairing");

    await store.saveAgentEngine(OASIS, { kind: "cli", cli: "codex", pairingId: "pair-ccpc", fallback: "workspace_api" });
    const fallback = await prepareAgentTurn({
      tenantId: OASIS,
      tenantSlug: "oasis-ai-cc",
      agentSlug: "sdr",
      department: sales,
      operator: { name: "CC", email: USERS.cc.email },
      platformFallback: null,
      revealModel: false,
      userId: null,
      failClosedWithoutComputerDispatch: true,
    });
    assert.ok(fallback.ok, JSON.stringify(fallback));
    if (!fallback.ok || fallback.turn.engine.kind !== "api") return assert.fail("not an explicit API fallback");
    assert.equal(fallback.turn.engine.fellBackFrom, "Codex on your paired computer");
    assert.equal(fallback.turn.engine.spend, "api_credits");
    await store.saveAgentEngine(OASIS, { kind: "cli", cli: "codex" });
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

  await check("the legacy agent chat route never bypasses an exact computer; explicit fallback is visible in reply metadata, reply text and audit", async () => {
    await login(USERS.alpha);
    await db.execute({
      sql: "INSERT INTO workspace_agents_owner (tenant_id, auth_user_id, set_by, set_at) VALUES (?, ?, 'test', ?)",
      args: [ALPHA, USERS.alpha.id, stamp],
    });
    await db.execute({
      sql: `INSERT INTO bridge_pairings
        (id, tenant_id, user_id, label, bridge_token_hash, last_seen_at, created_at, scope, paired_via,
         claim_enabled_at, claim_enabled_by, claim_state_at, claim_capacity, claim_protocols, claim_runtime_state)
        VALUES ('pair-alpha', ?, ?, 'Alpha laptop', 'hash-alpha', ?, ?, 'connector', 'pair_code', ?, ?, ?, 1, ?, ?)`,
      args: [
        ALPHA,
        USERS.alpha.id,
        stamp,
        stamp,
        stamp,
        USERS.alpha.id,
        stamp,
        JSON.stringify(["runtime_action_v1", "department_task_v2", "coding_harness_task_v1"]),
        JSON.stringify({ claude: { installed: true, authenticated: true, state: "ready" } }),
      ],
    });
    await store.saveAgentEngine(ALPHA, { kind: "cli", cli: "claude", pairingId: "pair-alpha", fallback: "none" });
    sent = [];
    const refused = await jsonOf(await chat.POST(req("/api/agents/chat", "POST", { agent_slug: "sdr", department: "sales", messages: [{ role: "user", content: "hi" }] })));
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal(refused.body.error, "computer_offline");
    assert.equal(sent.length, 0, "no paired computer and no hosted provider was contacted");

    await store.saveAgentEngine(ALPHA, { kind: "cli", cli: "claude", pairingId: "pair-alpha", fallback: "workspace_api" });
    await db.execute("DELETE FROM ai_usage_events");
    answer = (s) => (s.url.includes("anthropic.com") ? anthropicOk("Hi.") : new Response("x", { status: 599 }));
    sent = [];
    const res = await chat.POST(req("/api/agents/chat", "POST", { agent_slug: "sdr", department: "sales", messages: [{ role: "user", content: "hi" }] }));
    assert.equal(res.status, 200);
    const evs = parseSse(await res.text());
    const agentEv = evs.find((e) => e.event === "ev" && e.data.kind === "agent");
    assert.ok(agentEv, JSON.stringify(evs));
    const agentData = agentEv.data.data as Record<string, unknown>;
    assert.equal(agentData.spend, "api_credits");
    assert.match(String(agentData.runs_on), /\(API\)$/);
    assert.equal(agentData.fell_back_from, "Claude Code on your paired computer");
    assert.equal(agentData.engine_not_used, undefined);
    assert.equal(agentData.model, undefined, "the model id stays operator detail");
    const finalText = String(evs.find((event) => event.event === "end")?.data.final_text ?? "");
    assert.match(finalText, /^Workspace API fallback - Claude Code on your paired computer could not answer\./);
    assert.match(finalText, /This reply uses workspace API credits/);
    const usage = (await db.execute("SELECT fallback_reason FROM ai_usage_events ORDER BY occurred_at DESC LIMIT 1")).rows[0];
    assert.equal(usage?.fallback_reason, "engine_unreachable:claude");
    await store.saveAgentEngine(ALPHA, { kind: "api" });
    await db.execute("DELETE FROM bridge_pairings WHERE id = 'pair-alpha'");
    await db.execute({ sql: "DELETE FROM workspace_agents_owner WHERE tenant_id = ?", args: [ALPHA] });
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
    assert.equal(outcome.classifyStreamError((cliErr[0] as { message: string }).message), "cli_not_found");
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

  const apiAnswers = () => {
    answer = (s) => (s.url.includes("anthropic.com") ? anthropicOk("Answered by the API account.") : new Response("x", { status: 599 }));
  };

  await check("a turn that REALLY fell back (entitled, computer unavailable) records engine_unreachable:<app> on its API call", async () => {
    await db.execute("DELETE FROM ai_usage_events");
    const prepared = await oasisTurn("sales", "sdr", async () => ({ unavailable: "not_set_up" as const }));
    assert.ok(prepared.ok && prepared.turn.engine.kind === "api" && prepared.turn.engine.fellBackFrom !== null);
    if (!prepared.ok) return;
    apiAnswers();
    await drainTurn(prepared.turn);
    const rows = await usageRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].fallback_reason, "engine_unreachable:codex");
    assert.equal(rows[0].billing_mode, "byo_key", "the API account answered and is billed as before");
    assert.equal(rows[0].outcome, "ok");
    // A local engine says "local".
    await store.saveAgentEngine(OASIS, { kind: "local", model: "llama3.3" });
    const local = await oasisTurn("sales", "sdr", async () => ({ unavailable: "gate_error" as const }));
    assert.ok(local.ok);
    if (!local.ok) return;
    await db.execute("DELETE FROM ai_usage_events");
    apiAnswers();
    await drainTurn(local.turn);
    assert.equal((await usageRows())[0].fallback_reason, "engine_unreachable:local");
    await store.saveAgentEngine(OASIS, { kind: "cli", cli: "codex" });
  });

  await check("legacy bridge compatibility calls still distinguish by-design API turns from real fallback", async () => {
    await db.execute("DELETE FROM ai_usage_events");
    for (const bridge of [null, async () => null]) {
      const prepared = await oasisTurn("sales", "sdr", bridge);
      assert.ok(prepared.ok);
      if (!prepared.ok) return;
      apiAnswers();
      await drainTurn(prepared.turn);
    }
    await store.saveAgentEngine(ALPHA, { kind: "cli", cli: "claude" });
    const client = await clientTurn(async () => ({ ...ccCaller, tenantId: ALPHA }));
    assert.ok(client.ok);
    if (client.ok) {
      apiAnswers();
      await drainTurn(client.turn);
    }
    await store.saveAgentEngine(ALPHA, { kind: "api" });
    const rows = await usageRows();
    assert.equal(rows.length, 3, "one row per answered turn");
    assert.deepEqual(rows.map((r) => [r.outcome, r.fallback_reason]), [["ok", null], ["ok", null], ["ok", null]]);
  });

  await check("bridgeResolutionForSession: 'no' by design is null, an entitled person with no bridge is unavailable, a thrown gate is unavailable", async () => {
    const target = { baseUrl: BRIDGE, bearerToken: "t" };
    const via = (gate: () => Promise<unknown>) => bridgeTurn.bridgeResolutionForSession(OASIS, gate as never);
    assert.deepEqual(await via(async () => ({ ok: true, target, tenantId: OASIS, tenantSlug: "oasis-ai-cc", userId: "u", teamRole: "owner", isOperator: true })), { target, tenantId: OASIS, userId: "u", teamRole: "owner" });
    assert.equal(await via(async () => ({ ok: true, target, tenantId: ALPHA, tenantSlug: "alpha-co", userId: "u", teamRole: "owner", isOperator: false })), null, "another workspace's session");
    assert.equal(await via(async () => ({ ok: false, status: 403, error: "bridge_not_enabled_for_tenant" })), null, "a teammate the gate does not admit");
    assert.equal(await via(async () => ({ ok: false, status: 401, error: "unauthenticated" })), null);
    assert.deepEqual(await via(async () => ({ ok: false, status: 503, error: "bridge_not_configured", isOperator: true })), { unavailable: "not_set_up" });
    assert.deepEqual(await via(async () => { throw new Error("db down"); }), { unavailable: "gate_error" });
    // The caller-only resolver (the engine routes) keeps its meaning: anything but a caller is null.
    assert.equal(await bridgeTurn.bridgeCallerForSession(OASIS, (async () => ({ ok: false, status: 503, error: "bridge_not_configured", isOperator: true })) as never), null);
    assert.equal((await bridgeTurn.bridgeCallerForSession(OASIS, (async () => ({ ok: true, target, tenantId: OASIS, tenantSlug: "oasis-ai-cc", userId: "u", teamRole: "owner", isOperator: true })) as never))?.userId, "u");
  });

  await check("the reply footer says 'not used for this chat' by design and 'could not be reached' only for a real fallback", async () => {
    const { viaLine } = await import("../components/agents/AgentChat");
    const base = { runs_on: "anthropic (API)", spend: "api_credits" };
    assert.match(String(viaLine({ ...base, fell_back_from: "Codex on your paired computer" })), /Codex on your paired computer could not be reached$/);
    const byDesign = String(viaLine({ ...base, engine_not_used: "Codex on your paired computer" }));
    assert.match(byDesign, /Codex on your paired computer is not used for this chat$/);
    assert.ok(!/could not be reached/.test(byDesign));
  });

  await check("a department turn refused BEFORE any model is asked leaves a failed zero-cost row: no account, an unreadable key, unreadable settings", async () => {
    await db.execute("DELETE FROM ai_usage_events");
    // 1. App chosen, computer unavailable, and no AI account behind it: the whole outage.
    await db.execute({ sql: "UPDATE agent_model_config SET enabled = 0 WHERE tenant_id = ? AND agent_key = 'bravo'", args: [OASIS] });
    try {
      const down = await oasisTurn("sales", "sdr", async () => ({ unavailable: "not_set_up" as const }));
      assert.ok(!down.ok && down.status === 412 && down.error === "agent_not_configured", JSON.stringify(down));
      if (!down.ok) assert.match(String(down.extra?.hint), /can't be reached/);
      const byDesign = await oasisTurn("sales", "sdr", async () => null);
      assert.ok(!byDesign.ok && byDesign.status === 412);
      if (!byDesign.ok) assert.match(String(byDesign.extra?.hint), /isn't used for this chat/);
    } finally {
      await db.execute({ sql: "UPDATE agent_model_config SET enabled = 1 WHERE tenant_id = ? AND agent_key = 'bravo'", args: [OASIS] });
    }
    let rows = await usageRows();
    assert.equal(rows.length, 2);
    for (const r of rows) {
      assert.deepEqual(
        [r.provider, r.model, r.billing_mode, r.surface, r.department_key, r.outcome, r.error_code, r.cost_micro_usd, r.reserved_micro_usd],
        ["bridge", "codex", "subscription", "agents.chat", "sales", "error", "agent_not_configured", 0, null],
      );
    }
    // 2. A saved key that cannot be decrypted.
    await db.execute("DELETE FROM ai_usage_events");
    await db.execute({ sql: "UPDATE agent_model_config SET encrypted_api_key = 'not-a-cipher' WHERE tenant_id = ? AND agent_key = '__workspace__'", args: [ALPHA] });
    try {
      const bad = await clientTurn(null);
      assert.ok(!bad.ok && bad.error === "key_unreadable", JSON.stringify(bad));
      // A chat that is no department's writes nothing: only department turns are watched.
      const direct = await prepareAgentTurn({ tenantId: ALPHA, tenantSlug: "alpha-co", agentSlug: "sdr", department: null, operator: { name: "O", email: USERS.alpha.email }, platformFallback: null, revealModel: false, userId: USERS.alpha.id, bridge: null });
      assert.ok(!direct.ok && direct.error === "key_unreadable");
    } finally {
      await db.execute({ sql: "UPDATE agent_model_config SET encrypted_api_key = ? WHERE tenant_id = ? AND agent_key = '__workspace__'", args: [anthCipher, ALPHA] });
    }
    rows = await usageRows();
    assert.deepEqual(rows.map((r) => [r.error_code, r.department_key, r.provider, r.billing_mode, r.cost_micro_usd]), [["key_unreadable", "sales", "anthropic", "byo_key", 0]]);
    // 3. The workspace's AI settings cannot be read.
    await db.execute("DELETE FROM ai_usage_events");
    await db.execute("ALTER TABLE agent_model_config RENAME TO agent_model_config_hidden");
    try {
      const gone = await clientTurn(null);
      assert.ok(!gone.ok && gone.error === "config_unavailable", JSON.stringify(gone));
    } finally {
      await db.execute("ALTER TABLE agent_model_config_hidden RENAME TO agent_model_config");
    }
    assert.deepEqual((await usageRows()).map((r) => [r.error_code, r.department_key]), [["config_unavailable", "sales"]]);
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
    assert.deepEqual(events, [STEP, { type: "delta", text: "Pipeline is healthy." }, { type: "done", inputTokens: 0, outputTokens: 0 }], "the turn's events: the app's step (by kind, never its path), the answer, the end");
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

  await check("an automation's department turn writes its rows under automations.run with its job id: the answered turn and a refusal", async () => {
    await db.execute("DELETE FROM ai_usage_events");
    const prepared = await prepareAgentTurn({
      tenantId: OASIS,
      tenantSlug: "oasis-ai-cc",
      agentSlug: "sdr",
      department: dept("sales"),
      operator: { name: "CC", email: USERS.cc.email },
      platformFallback: null,
      revealModel: false,
      userId: USERS.cc.id,
      bridge: async () => ccCaller,
      surface: "automations.run",
      jobId: "auto-run-0042",
    });
    assert.ok(prepared.ok, JSON.stringify(prepared));
    if (!prepared.ok) return;
    answer = (s) => (s.url === `${BRIDGE}/chat` ? bridgeOk("Pipeline is healthy.") : new Response("no provider call expected", { status: 599 }));
    await drainTurn(prepared.turn);
    // A refusal before any model is asked is filed the same way.
    await db.execute({ sql: "UPDATE agent_model_config SET encrypted_api_key = 'not-a-cipher' WHERE tenant_id = ? AND agent_key = '__workspace__'", args: [ALPHA] });
    try {
      const refused = await prepareAgentTurn({
        tenantId: ALPHA,
        tenantSlug: "alpha-co",
        agentSlug: "sdr",
        department: sales,
        operator: { name: "Owner", email: USERS.alpha.email },
        platformFallback: null,
        revealModel: false,
        userId: USERS.alpha.id,
        bridge: null,
        surface: "automations.run",
        jobId: "auto-run-0043",
      });
      assert.ok(!refused.ok && refused.error === "key_unreadable", JSON.stringify(refused));
    } finally {
      await db.execute({ sql: "UPDATE agent_model_config SET encrypted_api_key = ? WHERE tenant_id = ? AND agent_key = '__workspace__'", args: [anthCipher, ALPHA] });
    }
    const rows = await usageRows();
    assert.deepEqual(
      rows.map((r) => [r.tenant_id, r.surface, r.job_id, r.outcome, r.error_code]),
      [
        [OASIS, "automations.run", "auto-run-0042", "ok", null],
        [ALPHA, "automations.run", "auto-run-0043", "error", "key_unreadable"],
      ],
    );
    // A chat turn (no surface) is still agents.chat.
    await db.execute("DELETE FROM ai_usage_events");
    await drainTurn(await bridgeTurnFor());
    assert.deepEqual((await usageRows()).map((r) => [r.surface, r.job_id]), [["agents.chat", null]]);
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
    // The bridge names why (cli_error:<code>); a code outcome.ts has a sentence for is kept as the row's code.
    assert.deepEqual([cli.outcome, cli.error_code], ["error", "cli_not_found"]);
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
      assert.deepEqual(events[0], STEP);
      assert.equal(events[1].type, "delta");
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

  await check("one rule identifies an unsafe app for a restricted role; the coding proxy refuses it instead of substituting Claude", () => {
    const member = policy.bridgeCliPolicy("closer", "codex");
    assert.equal(member.cliProvider, "claude");
    assert.ok(member.disallowedTools.length > 0);
    assert.deepEqual(policy.bridgeCliPolicy("owner", "opencode"), { cliProvider: "opencode", disallowedTools: [] });
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
    assert.match(proxy, /policy\.cliProvider !== savedRoute\.engineName\) return jsonError\(403, "engine_not_allowed_for_role"\)/);
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
    assert.match(String(fell.note), /^Codex on your paired computer could not answer, so your explicitly enabled workspace API fallback answers\.$/);
    assert.deepEqual(channelEngine({ kind: "api" }, false, brain).note, null);
  });

  await check("ONE setting: the coding harness's route comes from what powers your agents, and there is no second picker", () => {
    assert.deepEqual(engineLib.harnessRouteFor({ kind: "cli", cli: "codex", pairingId: "pair-ccpc", fallback: "none" }), {
      mode: "cli",
      runtime: "codex",
      pairingId: "pair-ccpc",
      engineKind: "subscription",
      engineName: "codex",
      fallback: "none",
      note: null,
    });
    assert.equal(engineLib.harnessRouteFor({ kind: "cli", cli: "codex" }).mode, "unavailable");
    assert.deepEqual(engineLib.harnessRouteFor({ kind: "api" }), {
      mode: "cloud_only",
      runtime: null,
      pairingId: null,
      engineKind: "api",
      engineName: null,
      fallback: "none",
      note: null,
    });
    assert.deepEqual(engineLib.harnessRouteFor({ kind: "local", model: "ollama/llama3.3", pairingId: "pair-ccpc", fallback: "none" }), {
      mode: "cli",
      runtime: null,
      pairingId: "pair-ccpc",
      engineKind: "local",
      engineName: "ollama/llama3.3",
      fallback: "none",
      note: null,
    });
    const widget = readFileSync(join(ROOT, "components/ChatWidget.tsx"), "utf8");
    assert.doesNotMatch(widget, /aria-label="Chat route"|renderCliOption|writeHarnessOverride/, "the harness's own route picker is gone");
    assert.match(widget, /const route = harnessRouteFor\(engine\);/);
    assert.match(widget, /setChatModeState\(route\.mode\);\s*if \(route\.runtime\) \{\s*setCliRuntimeState\(route\.runtime\);/);
    assert.match(widget, /target_pairing_id:\s*harnessRoute\?\.mode === "cli" \? harnessRoute\.pairingId/);
    const card = readFileSync(join(ROOT, "components/settings/LocalCliProvidersCard.tsx"), "utf8");
    assert.doesNotMatch(card, /role="radiogroup"|chooseCli|writeCliRuntime/, "the paired-computer card has no picker");
    // Nothing that powers a department reads the browser-local route.
    for (const rel of ["lib/os/department-agent.ts", "lib/ai/bridge-turn.ts", "app/api/agents/chat/route.ts"]) {
      assert.doesNotMatch(readFileSync(join(ROOT, rel), "utf8"), /cli-runtime|readCliRuntime|cliRuntime/, rel);
    }
  });

  await check("the chat header, readiness and /model command use only the canonical AI Brain response", () => {
    const widget = readFileSync(join(ROOT, "components/ChatWidget.tsx"), "utf8");
    assert.match(widget, /const \[engineAccount, setEngineAccount\] = useState<EngineAccountState \| null>\(null\)/);
    assert.match(widget, /agentsEngine\?\.kind === "api"[\s\S]{0,180}engineAccount\.provider === agentsEngine\.provider/);
    assert.match(widget, /engineAccount\.providerLabel[\s\S]{0,120}engineAccount\.modelLabel[\s\S]{0,80}workspace API/);
    assert.doesNotMatch(widget, /cfg\?\.has_key|cfg\?\.provider|cfg\?\.model|platformKey|modelPickerProvider/);
    assert.match(widget, /case "model": \{[\s\S]{0,300}router\.push\(ENGINE_SETTINGS_HREF\)/);
    assert.doesNotMatch(widget, /case "model": \{[\s\S]{0,1500}fetch\("\/api\/agent-config"/);
    assert.match(widget, /className=\{`hover:underline underline-offset-2 \$\{desktopBridgeActive/);
    const providerCard = readFileSync(join(ROOT, "components/settings/ProviderAccountsCard.tsx"), "utf8");
    assert.doesNotMatch(providerCard, /whenever the paired computer can(?:'|&apos;)t be reached|answers only when your paired/);
    assert.match(providerCard, /Workspace API fallback is explicitly enabled/);
  });

  await check("Connect / Reconnect: auth is queued on one exact pairing with the vendor's real command", async () => {
    assert.equal(cliStatus.CLI_SIGN_IN.claude.command, "claude");
    assert.match(cliStatus.CLI_SIGN_IN.claude.instructions, /then enter `\/login`/);
    assert.equal(cliStatus.CLI_SIGN_IN.codex.command, "codex login");
    assert.equal(cliStatus.CLI_SIGN_IN.opencode.command, "opencode auth login");
    assert.match(cliStatus.CLI_SIGN_IN.opencode.instructions, /Moonshot AI/);
    const calls: string[] = [];
    const { startCliSignIn } = await import("../components/settings/LocalCliProvidersCard");
    const res = await startCliSignIn("codex", "pair-ccpc", async (url, init) => {
      calls.push(`${init.method} ${url} ${String(init.body)}`);
      return new Response(JSON.stringify({ ok: true, job_id: "auth-codex-1", command: "codex login", message: "Started on CCPC." }), { status: 202 });
    });
    assert.deepEqual(res, { ok: true, text: "Started on CCPC.", jobId: "auth-codex-1", command: "codex login" });
    assert.deepEqual(calls, ['POST /api/bridge/cli-auth {"provider":"codex","pairing_id":"pair-ccpc"}']);
    // OpenCode's sign-in is a terminal command on that computer; the server queues it like the others.
    const opencode = await startCliSignIn("opencode", "pair-ccpc", async () =>
      new Response(JSON.stringify({ ok: false, message: "That computer is not paired to your account." }), { status: 404 }),
    );
    assert.equal(opencode.ok, false);
    assert.equal(opencode.command, "opencode auth login", "a refused start still names the command to run there");
  });

  await check("the coding harness never spins forever: each read has a time limit and says why it failed", async () => {
    const readiness = await import("../lib/admin/chat-readiness");
    const timeout = Object.assign(new Error("signal timed out"), { name: "TimeoutError" });
    assert.equal(readiness.agentConfigReadFailure(timeout), "Couldn't read your agent settings: the server didn't answer within 15 seconds. Refresh to try again.");
    const widget = readFileSync(join(ROOT, "components/ChatWidget.tsx"), "utf8");
    assert.match(widget, /fetch\("\/api\/ai\/engine", \{ cache: "no-store", signal: AbortSignal\.timeout\(15_000\) \}\)/);
    assert.match(widget, /if \(engineError\) \{/);
    assert.doesNotMatch(widget, /fetch\("\/api\/agent-config"/, "legacy per-agent rows must not gate canonical engine readiness");
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
  await check("CC's PC (heartbeat 2026-10-09 17:54Z): Claude ready, OpenCode's unfinished check is 'not confirmed', Codex 'not detected'", () => {
    const meta = {
      via: "paired_bridge_heartbeat",
      providers: {
        claude: { installed: true, authenticated: true, version: "2.1.270 (Claude Code)" },
        codex: { installed: false, authenticated: false, version: null },
        opencode: { installed: true, authenticated: false, version: null },
      },
    };
    const now = Date.parse("2026-10-09T17:55:00Z");
    const snap = cliStatus.normalizeCliSnapshot(meta, "2026-10-09T17:54:32.945Z", now);
    assert.ok(snap.ok);
    if (!snap.ok) return;
    const words = Object.fromEntries((["claude", "codex", "opencode"] as const).map((p) => [p, cliStatus.CLI_STATE_LABEL[cliStatus.cliStatusState(snap.data[p])]]));
    assert.deepEqual(words, { claude: "Ready", codex: "Not detected", opencode: "Sign-in not confirmed" });
    // A FINISHED check that said no is the only "Needs sign-in".
    const signedOut = cliStatus.normalizeCliSnapshot({ providers: { ...meta.providers, opencode: { installed: true, authenticated: false, version: "0.63.0" } } }, "2026-10-09T17:54:32.945Z", now);
    assert.ok(signedOut.ok && cliStatus.cliStatusState(signedOut.data.opencode) === "needs_sign_in");
    // A newer bridge that says its check timed out is unknown, whatever else it sent.
    const timedOut = cliStatus.normalizeCliSnapshot({ providers: { ...meta.providers, opencode: { installed: true, authenticated: false, version: "0.63.0", probe: "timeout" } } }, "2026-10-09T17:54:32.945Z", now);
    assert.ok(timedOut.ok && cliStatus.cliStatusState(timedOut.data.opencode) === "unknown");
  });

  await check("the consolidated panel distinguishes installed/sign-in evidence from a real agent-ready probe", async () => {
    const client = await import("../components/settings/agent-engine-client");
    const device = {
      label: "CCPC (Windows)",
      approved: true,
      online: true,
      busy: false,
      agentClaimEligible: true,
      protocols: ["department_task_v2", "runtime_action_v1", "coding_harness_task_v1"],
      runtimes: {
        claude: { installed: true, signedIn: true, executionReady: false, unsupported: false, version: "2.1.270", lastTestedAt: null, code: null },
        codex: { installed: true, signedIn: true, executionReady: true, unsupported: false, version: "0.146", lastTestedAt: stamp, code: null },
        opencode: { installed: true, signedIn: false, executionReady: false, unsupported: true, version: "0.63", lastTestedAt: null, code: "unsupported_personal_sign_in" },
      },
    };
    assert.equal(client.describeRuntime(device, "claude").label, "Needs test", "signed in is inventory evidence, not execution proof");
    assert.equal(client.describeRuntime(device, "codex").label, "Ready for agents");
    assert.equal(client.describeRuntime(device, "opencode").label, "Unsupported");
    const panel = readFileSync(join(ROOT, "components/settings/AgentEnginePanel.tsx"), "utf8");
    assert.match(panel, /describeRuntime\(selectedDevice, provider\)/, "the unified picker uses the truthful per-device state");
    assert.doesNotMatch(readFileSync(join(ROOT, "components/settings/LocalCliProvidersCard.tsx"), "utf8"), /fetch\("\/api\/bridge\/cli-status"/, "the retired separate card cannot publish a competing status");
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
