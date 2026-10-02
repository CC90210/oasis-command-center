/**
 * ai-workspace-account.test.ts - the AI account a workspace connects is the
 * one every department chat, Slack mention and status surface uses
 * (lib/ai/workspace-account.ts; AIP-01, AIP-02, AIP-05, AIP-07, AIP-10,
 * AIP-11, AIP-14).
 *
 * WHY. A client owner pasted a key in Settings > AI brain, the card turned
 * green, and every department chat and Slack mention still answered "No AI
 * account is connected": the connect stamped one row per teammate (a client's
 * teammates are neutral leads such as `sdr`), while every channel read only
 * the `bravo` row. "Connected" counted any keyed row, a personal one too. Keys
 * were saved without being tried, and any member could make the server call
 * any web address through the "local model" test.
 *
 * Everything runs for real against a local libSQL file: the real signed
 * session cookie, the real Turso adapter, the real route handlers (connect,
 * test, chat, builder, manifest editor, agent-config), the real channel
 * resolver, the Slack mention's own entry point (prepareAgentTurn, which
 * lib/slack/jobs.ts calls with the routed workspace and no session) and the
 * real Settings page body. next/headers, next/navigation and next/link are the
 * only stand-ins, and the AI provider is a stubbed global fetch that records
 * which key it was sent.
 *
 * TWO WORKSPACES. Alpha and Beta are client workspaces whose teammates are
 * neutral leads. A key saved for Alpha is the key every Alpha turn sends, and
 * never one of Beta's; Beta's own key is Beta's.
 *
 * Run: node --conditions=react-server --import tsx tests/ai-workspace-account.test.ts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as ReactNS from "react";
import { createClient } from "@libsql/client";

const dbFile = join(mkdtempSync(join(tmpdir(), "ai-workspace-account-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
process.env.EMPIRE_AUTH_BACKEND = "turso";
process.env.AUTH_SESSION_SECRET = "ai-workspace-account-secret-long-enough-0000001";
process.env.BRAVO_FIELD_ENCRYPTION_KEY = "ai-workspace-account-field-key-long-enough-001";
delete process.env.OPERATOR_EMAIL;
delete process.env.OPERATOR_EMAIL_FALLBACK_ENABLED;
process.env.ADMIN_EMAILS = "";
for (const k of [
  "PLATFORM_DEFAULT_OPENROUTER_API_KEY",
  "PLATFORM_DEFAULT_ANTHROPIC_API_KEY",
  "PLATFORM_DEFAULT_OPENAI_API_KEY",
  "PLATFORM_DEFAULT_GOOGLE_API_KEY",
]) {
  delete process.env[k];
}

// tsconfig.json sets jsx:"preserve", so tsx compiles JSX with the classic
// runtime, which expects a global React (as tests/os-channels-honest.test.ts).
(globalThis as unknown as { React: typeof ReactNS }).React = ReactNS;

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
  useRouter: () => ({ push: () => undefined, refresh: () => undefined }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
});
stub("next/link", {
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children?: unknown }) =>
    ReactNS.createElement("a", { href, ...rest }, children as ReactNS.ReactNode),
});
// The Settings page body imports client modules that create a context or
// extend Component at import time, which react-server's React does not export
// (the same inert stand-ins as tests/queries-fail-loud-callers.test.ts). This
// suite only reads the props the page hands its cards; it renders none.
// eslint-disable-next-line @typescript-eslint/no-require-imports -- the CJS export object tsx-compiled modules read
const reactCjs = require("react") as Record<string, unknown>;
if (typeof reactCjs.createContext !== "function") {
  reactCjs.createContext = (value: unknown) => ({
    _currentValue: value,
    Provider: ({ children }: { children?: unknown }) => children,
    Consumer: () => null,
  });
}
if (typeof reactCjs.Component !== "function") {
  class InertComponent {
    props: unknown;
    constructor(props: unknown) {
      this.props = props;
    }
  }
  (InertComponent.prototype as unknown as { isReactComponent: object }).isReactComponent = {};
  reactCjs.Component = InertComponent;
  reactCjs.PureComponent = InertComponent;
}

const OASIS = "ef8d389e-3f15-43f2-ae00-3660f69a1452";
const ALPHA = "a1a1a1a1-0000-4000-8000-0000000000a1";
const BETA = "b2b2b2b2-0000-4000-8000-0000000000b2";
// A workspace whose only key is its owner's personal one.
const SOLO = "c3c3c3c3-0000-4000-8000-0000000000c3";
// A workspace that saved a key before this change (a legacy `bravo` row) and
// then connects another account.
const LEGACY = "d4d4d4d4-0000-4000-8000-0000000000d4";
// A fresh workspace for the connect-dialog flow.
const FRESH = "e5e5e5e5-0000-4000-8000-0000000000e5";

type U = { id: string; email: string };
const u = (n: number, email: string): U => ({ id: `0f000000-0000-4000-8000-${String(n).padStart(12, "0")}`, email });
const USERS = {
  cc: u(1, "conaugh@oasisai.work"), // the operator alias + OASIS owner: the verified platform operator
  partner: u(2, "partner@oasisai.work"), // OASIS owner, not an alias
  alpha: u(3, "owner@alpha.test"),
  alphaRep: u(4, "rep@alpha.test"), // a closer in Alpha: not an owner or admin
  beta: u(5, "owner@beta.test"),
  solo: u(6, "owner@solo.test"),
  legacy: u(7, "owner@legacy.test"),
  fresh: u(8, "owner@fresh.test"),
} as const;

const KEY_ALPHA = "sk-ant-alpha-workspace-key-0001";
const KEY_BETA = "sk-or-v1-beta-workspace-key-0002";
const KEY_SOLO_PERSONAL = "sk-ant-solo-personal-key-0003";
const KEY_OASIS = "sk-ant-oasis-legacy-row-key-0004";
const KEY_LEGACY_OLD = "sk-or-v1-legacy-old-key-0005";
const KEY_LEGACY_NEW = "sk-ant-legacy-new-key-0006";
const KEY_FRESH = "sk-ant-fresh-key-0007";

async function login(user: U | null) {
  if (!user) {
    sessionCookie = undefined;
    return;
  }
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
    console.log(`  FAIL  ${name}\n        ${(e as Error).message.split("\n").slice(0, 8).join("\n        ")}`);
  }
}

// -- provider stub: records every call the server makes to an AI provider --
type Sent = { url: string; method: string; headers: Record<string, string>; body: Record<string, unknown> | null };
let sent: Sent[] = [];
let provider: (s: Sent) => Response | Promise<Response> = () => new Response("unset", { status: 599 });
const realFetch = globalThis.fetch;
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
  const s = { url, method: (init?.method || "GET").toUpperCase(), headers, body };
  sent.push(s);
  return provider(s);
}) as typeof fetch;
/** The key each provider call carried, whatever the provider. */
const keyOf = (s: Sent) => s.headers["x-api-key"] ?? s.headers["authorization"]?.replace(/^Bearer /, "") ?? s.headers["x-goog-api-key"] ?? null;

function anthropicOk(text: string) {
  const frames = [
    ["message_start", { message: { usage: { input_tokens: 12 } } }],
    ["content_block_delta", { delta: { type: "text_delta", text } }],
    ["message_delta", { usage: { output_tokens: 3 } }],
    ["message_stop", {}],
  ]
    .map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`)
    .join("");
  return new Response(frames, { status: 200, headers: { "content-type": "text/event-stream" } });
}
function openrouterOk(text: string) {
  const frames = [
    { choices: [{ delta: { content: text } }] },
    { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2 } },
  ]
    .map((d) => `data: ${JSON.stringify(d)}\n\n`)
    .join("");
  return new Response(`${frames}data: [DONE]\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
}
/** Any provider, any shape: a streamed reply, or a one-shot JSON for the probe. */
const answering = (text: string) => (s: Sent) =>
  s.url.includes("anthropic.com")
    ? s.body?.stream
      ? anthropicOk(text)
      : new Response(JSON.stringify({ usage: { input_tokens: 5, output_tokens: 1 } }), { status: 200 })
    : s.body?.stream
      ? openrouterOk(text)
      : new Response(JSON.stringify({ usage: { prompt_tokens: 5, completion_tokens: 1 } }), { status: 200 });

// console.error is captured (routes log refusals), and shown only on failure.
const logged: unknown[][] = [];
const realError = console.error;
console.error = (...args: unknown[]) => {
  logged.push(args);
};

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

/** Every string anywhere in a server element tree (props included). */
type El = { type?: unknown; props?: Record<string, unknown> & { children?: unknown } };
function findEl(node: unknown, type: unknown): El | null {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const n of node) {
      const hit = findEl(n, type);
      if (hit) return hit;
    }
    return null;
  }
  const el = node as El;
  if (el.type === type) return el;
  for (const v of Object.values(el.props ?? {})) {
    const hit = findEl(v, type);
    if (hit) return hit;
  }
  return null;
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
    CREATE TABLE bridge_pairings (id TEXT PRIMARY KEY, tenant_id TEXT, label TEXT, user_id TEXT,
      machine_fingerprint TEXT, last_seen_at TEXT, revoked_at TEXT, tool_capabilities TEXT, created_at TEXT);
    -- agent_model_config as production has it (BEA database/turso_migrations/
    -- bravo__000_master_schema.sql): the id default, and the partial unique
    -- indexes that keep ONE workspace row per (tenant, agent_key).
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
  // Every turn and every Test is a metered model call, and every channel turn
  // is recorded: the two migrations as the lead runs them.
  await db.executeMultiple(readFileSync(join(process.cwd(), "database/turso/bravo__192_ai_usage.sql"), "utf8"));
  await db.executeMultiple(readFileSync(join(process.cwd(), "database/turso/bravo__191_agent_turn_outcomes.sql"), "utf8"));

  const { encryptField, decryptField } = await import("../lib/field-encryption");
  const { SUGA_SEED } = await import("../lib/manifest/seeds");
  const { parseManifest } = await import("../lib/manifest/schema");
  const stamp = "2026-09-01T00:00:00Z";
  // Client workspaces run neutral leads (Sales lead = sdr, Client Success lead
  // = customer-support), as every client manifest does since W4a.
  // (A stored manifest is validated, and a stored page needs a path: the seed's
  // "" home page is a seed-only shape.)
  const clientManifest = (slug: string) =>
    JSON.stringify(parseManifest({ ...SUGA_SEED, tenant_slug: slug, pages: SUGA_SEED.pages.filter((p) => p.path) } as never));
  const profile = (id: string, user: U, tenant: string, role: string, owner: 0 | 1, agentsEnabled: string[] | null) => ({
    sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, onboarding_completed_at, full_name, agents_enabled, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'Test Person', ?, ?)`,
    args: [id, user.id, user.email, tenant, role, owner, stamp, agentsEnabled ? JSON.stringify(agentsEnabled) : null, stamp],
  });
  const workspace = (id: string, slug: string, name: string) => [
    { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, ?, ?)", args: [id, slug, name] },
    {
      sql: "INSERT INTO tenant_manifests (id, tenant_id, slug, manifest, version, schema_version, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1, ?, ?)",
      args: [`m-${slug}`, id, slug, clientManifest(slug), stamp, stamp],
    },
  ];
  const configRow = (tenant: string, userId: string | null, agentKey: string, prov: string, model: string, key: string) => ({
    sql: `INSERT INTO agent_model_config (tenant_id, user_id, agent_key, provider, model, encrypted_api_key, enabled, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
    args: [tenant, userId, agentKey, prov, model, encryptField(key), stamp],
  });
  await db.batch(
    [
      ...Object.values(USERS).map((x) => ({ sql: `INSERT INTO "_supabase_auth_users" (id, email) VALUES (?, ?)`, args: [x.id, x.email] })),
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'oasis-ai-cc', 'OASIS AI')", args: [OASIS] },
      ...workspace(ALPHA, "alpha-co", "Alpha Co"),
      ...workspace(BETA, "beta-co", "Beta Co"),
      ...workspace(SOLO, "solo-co", "Solo Co"),
      ...workspace(LEGACY, "legacy-co", "Legacy Co"),
      ...workspace(FRESH, "fresh-co", "Fresh Co"),
      profile("p-cc", USERS.cc, OASIS, "owner", 1, null),
      profile("p-partner", USERS.partner, OASIS, "owner", 1, null),
      // The owners' own teammate lists name only neutral leads: the shape that
      // left every department chat unconnected (AIP-01).
      profile("p-alpha", USERS.alpha, ALPHA, "owner", 1, ["sdr"]),
      profile("p-alpha-rep", USERS.alphaRep, ALPHA, "closer", 0, ["sdr"]),
      profile("p-beta", USERS.beta, BETA, "owner", 1, ["customer-support"]),
      profile("p-solo", USERS.solo, SOLO, "owner", 1, ["sdr"]),
      profile("p-legacy", USERS.legacy, LEGACY, "owner", 1, ["sdr"]),
      profile("p-fresh", USERS.fresh, FRESH, "owner", 1, ["sdr"]),
      // OASIS: its legacy `bravo` workspace row, as production has it (its
      // default key is decision D12, and nothing here may change it).
      configRow(OASIS, null, "bravo", "anthropic", "claude-sonnet-4-6", KEY_OASIS),
      // SOLO: its owner's PERSONAL key, and another agent's workspace row. The
      // old "Connected" counted both; neither is a key its chats use.
      configRow(SOLO, USERS.solo.id, "bravo", "anthropic", "claude-sonnet-4-6", KEY_SOLO_PERSONAL),
      // LEGACY: a key saved before this change, on the legacy row.
      configRow(LEGACY, null, "bravo", "openrouter", "anthropic/claude-sonnet-4.6", KEY_LEGACY_OLD),
    ],
    "write",
  );

  const bulk = await import("../app/api/agent-config/bulk-provider/route");
  const agentConfig = await import("../app/api/agent-config/route");
  const testConnection = await import("../app/api/agent-config/test-connection/route");
  const chat = await import("../app/api/agents/chat/route");
  const generate = await import("../app/api/agents/generate/route");
  const manifestChat = await import("../app/api/manifest/chat/route");
  const { NextRequest } = await import("next/server");
  const { resolveOsViewer } = await import("../components/os/department/viewer");
  const { resolveChannelState, workspaceChatReadiness } = await import("../components/os/department/channel");
  const { prepareAgentTurn } = await import("../lib/os/department-agent");
  const { departmentBySlug } = await import("../lib/os/departments");
  const q = await import("../lib/queries");
  const { loadReadinessReport } = await import("../lib/setup-readiness");
  const account = await import("../lib/ai/workspace-account");
  const legacyNames = await import("../lib/os/channel/workspace-key");
  const { connectProviderKey, ProviderAccountsCard } = await import("../components/settings/ProviderAccountsCard");
  const { SettingsContent } = await import("../components/settings/SettingsContent");

  const req = (url: string, method: string, body?: unknown) =>
    new NextRequest(`http://localhost${url}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const jsonOf = async (res: Response) => ({ status: res.status, body: (await res.json()) as Record<string, unknown> });
  const connect = async (body: Record<string, unknown>) => jsonOf(await bulk.POST(req("/api/agent-config/bulk-provider", "POST", body)));
  const testKey = async (body: Record<string, unknown>) =>
    jsonOf(await testConnection.POST(req("/api/agent-config/test-connection", "POST", body)));
  const say = (over: Record<string, unknown>) => ({ messages: [{ role: "user", content: "How is the pipeline today?" }], ...over });
  const chatTurn = async (body: Record<string, unknown>) => chat.POST(req("/api/agents/chat", "POST", say(body)));
  const dept = (slug: string) => {
    const d = departmentBySlug(slug);
    assert.ok(d, slug);
    return d!;
  };
  async function viewerFor(user: U) {
    await login(user);
    const v = await resolveOsViewer();
    assert.ok(v.ok, `viewer for ${user.email}`);
    return v as Extract<typeof v, { ok: true }>;
  }
  /** A Slack mention's turn: the routed workspace, no session, no platform key (lib/slack/jobs.ts). */
  const slackTurn = (tenantId: string, tenantSlug: string, deptSlug: string, agentSlug: string) =>
    prepareAgentTurn({
      tenantId,
      tenantSlug,
      agentSlug,
      department: dept(deptSlug),
      operator: { name: "Slack teammate", email: "" },
      platformFallback: null,
      revealModel: false,
      userId: null,
      jobId: `slack-${tenantSlug}`,
    });
  const rows = async (tenant: string) =>
    (
      await db.execute({
        sql: "SELECT agent_key, user_id, provider, model, encrypted_api_key, enabled FROM agent_model_config WHERE tenant_id = ? ORDER BY agent_key, user_id",
        args: [tenant],
      })
    ).rows.map((r) => ({
      agent_key: String(r.agent_key),
      user_id: r.user_id === null ? null : String(r.user_id),
      provider: String(r.provider),
      model: String(r.model),
      key: r.encrypted_api_key === null ? null : decryptField(String(r.encrypted_api_key)),
      enabled: Number(r.enabled),
    }));

  console.log("ai-workspace-account:");

  // -- 1. The blocker: a client owner connects, and every channel uses it ----
  await check("a client owner whose teammates are neutral leads connects a key: the workspace account is saved", async () => {
    await login(USERS.alpha);
    const res = await connect({ provider: "anthropic", api_key: KEY_ALPHA, model: "claude-sonnet-4-6" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.ok, true);
    assert.equal(res.body.workspace_account, true);
    const saved = await rows(ALPHA);
    const acct = saved.find((r) => r.agent_key === account.WORKSPACE_AI_AGENT_KEY);
    assert.ok(acct, `no workspace account row: ${JSON.stringify(saved.map((r) => r.agent_key))}`);
    assert.deepEqual(
      { user_id: acct.user_id, provider: acct.provider, model: acct.model, key: acct.key, enabled: acct.enabled },
      { user_id: null, provider: "anthropic", model: "claude-sonnet-4-6", key: KEY_ALPHA, enabled: 1 },
    );
    // The teammate rows are still stamped, as before.
    assert.ok(saved.some((r) => r.agent_key === "sdr" && r.key === KEY_ALPHA), "the sdr row was not stamped");
    assert.ok(!saved.some((r) => r.agent_key === "bravo"), "a client workspace got an OASIS persona row");
  });
  await check("every Alpha department channel reads ready, and the AI Team's readiness agrees", async () => {
    const viewer = await viewerFor(USERS.alpha);
    for (const slug of ["sales", "client-success"]) {
      const state = await resolveChannelState(dept(slug), viewer);
      assert.equal(state.kind, "ready", `${slug}: ${JSON.stringify(state)}`);
    }
    assert.equal((await workspaceChatReadiness(viewer)).provider, "ready");
  });
  await check("an Alpha department chat sends Alpha's key", async () => {
    await login(USERS.alpha);
    sent = [];
    provider = answering("Pipeline is healthy.");
    const events = parseSse(await (await chatTurn({ agent_slug: "sdr", department: "sales" })).text());
    assert.deepEqual(events.map((e) => e.event), ["agent", "delta", "usage", "done"], JSON.stringify(events));
    assert.equal(sent.length, 1);
    assert.equal(keyOf(sent[0]), KEY_ALPHA, "the chat sent another key");
  });
  await check("a Slack mention routed to Alpha answers on Alpha's key, with no session and no platform key", async () => {
    const turn = await slackTurn(ALPHA, "alpha-co", "client-success", "customer-support");
    assert.ok(turn.ok, JSON.stringify(turn));
    if (!turn.ok) return;
    assert.equal(turn.turn.apiKey, KEY_ALPHA);
    assert.equal(turn.turn.provider, "anthropic");
    assert.equal(turn.turn.keySource, "tenant");
  });
  await check("Beta, not connected yet, is not ready and never gets Alpha's key", async () => {
    const viewer = await viewerFor(USERS.beta);
    const state = await resolveChannelState(dept("client-success"), viewer);
    assert.equal(state.kind, "not_connected", JSON.stringify(state));
    const turn = await slackTurn(BETA, "beta-co", "client-success", "customer-support");
    assert.deepEqual(turn.ok ? { apiKey: turn.turn.apiKey } : { status: turn.status, error: turn.error }, { status: 412, error: "agent_not_configured" });
    assert.equal((await q.aiServicesWithKey(BETA)).size, 0);
  });
  await check("Beta connects its own account: Beta's turns send Beta's key, Alpha's still send Alpha's", async () => {
    await login(USERS.beta);
    const res = await connect({ provider: "openrouter", api_key: KEY_BETA });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const beta = await slackTurn(BETA, "beta-co", "client-success", "customer-support");
    assert.ok(beta.ok, JSON.stringify(beta));
    if (beta.ok) {
      assert.equal(beta.turn.apiKey, KEY_BETA);
      assert.equal(beta.turn.provider, "openrouter");
    }
    const alpha = await slackTurn(ALPHA, "alpha-co", "sales", "sdr");
    assert.ok(alpha.ok && alpha.turn.apiKey === KEY_ALPHA, "Alpha's turn moved off Alpha's key");
    // The web channel too, from Beta's session.
    sent = [];
    provider = answering("On it.");
    const events = parseSse(await (await chatTurn({ agent_slug: "customer-support", department: "client_success" })).text());
    assert.equal(events.at(-1)?.event, "done", JSON.stringify(events));
    assert.deepEqual(sent.map(keyOf), [KEY_BETA]);
    assert.deepEqual([...(await q.aiServicesWithKey(ALPHA))], ["anthropic"]);
    assert.deepEqual([...(await q.aiServicesWithKey(BETA))], ["openrouter"]);
  });
  await check("Test on the saved key tests the workspace account: Alpha's key, on its model", async () => {
    await login(USERS.alpha);
    sent = [];
    provider = answering("ok");
    const res = await testKey({ provider: "anthropic" });
    assert.equal(res.body.ok, true, JSON.stringify(res.body));
    assert.equal(sent.length, 1);
    assert.equal(keyOf(sent[0]), KEY_ALPHA);
    assert.equal(sent[0].body?.model, "claude-sonnet-4-6");
  });
  await check("a workspace whose teammate list is empty still saves its account (nothing to filter it by)", async () => {
    await db.execute({ sql: "UPDATE user_profiles SET agents_enabled = '[]' WHERE id = 'p-fresh'", args: [] });
    try {
      await login(USERS.fresh);
      const res = await connect({ provider: "anthropic", api_key: KEY_FRESH, agent_keys: [] });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.deepEqual(res.body.applied_to, [], "no teammate row was asked for");
      const acct = await account.readWorkspaceAiAccount(FRESH);
      assert.equal(acct?.source, "workspace");
      assert.ok(account.hasUsableKey(acct));
      // A personal connect with no teammate to save it on is still refused.
      const personal = await connect({ provider: "anthropic", api_key: KEY_FRESH, agent_keys: [], scope: "user" });
      assert.equal(personal.status, 400);
      assert.equal(personal.body.error, "no_target_agents");
    } finally {
      await db.execute({ sql: "DELETE FROM agent_model_config WHERE tenant_id = ?", args: [FRESH] });
      await db.execute({ sql: "UPDATE user_profiles SET agents_enabled = '[\"sdr\"]' WHERE id = 'p-fresh'", args: [] });
    }
  });
  await check("connecting twice updates the one account row (the unique index never sees a second)", async () => {
    await login(USERS.alpha);
    const again = await connect({ provider: "anthropic", api_key: KEY_ALPHA, model: "claude-opus-4-7" });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    const accounts = (await rows(ALPHA)).filter((r) => r.agent_key === account.WORKSPACE_AI_AGENT_KEY);
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0].model, "claude-opus-4-7");
    const turn = await slackTurn(ALPHA, "alpha-co", "sales", "sdr");
    assert.ok(turn.ok && turn.turn.model === "claude-opus-4-7", "the channel did not follow the account's model");
  });

  // -- 2. "Connected" means the key the chats use ---------------------------
  await check("a personal-only key: every status surface says not connected, and Settings shows it apart", async () => {
    // Signed in as the key's owner: the old "Connected" counted the VIEWER's
    // own personal rows, so this is the session that read green.
    await login(USERS.solo);
    // The card's provider set, the integrations page's dots and Health's dots.
    const workspaceSet = await q.aiServicesWithKey(SOLO);
    assert.equal(workspaceSet.size, 0, `a personal key read Connected: ${[...workspaceSet].join(",")}`);
    assert.equal(q.aiKeyOnFile(workspaceSet, "anthropic"), false);
    // The department channels.
    const viewer = await viewerFor(USERS.solo);
    const state = await resolveChannelState(dept("sales"), viewer);
    assert.equal(state.kind, "not_connected", JSON.stringify(state));
    if (state.kind === "not_connected") assert.match(state.reason, /No AI account is connected for this workspace yet/);
    // The turn itself (web and Slack).
    const turn = await slackTurn(SOLO, "solo-co", "sales", "sdr");
    assert.equal(turn.ok ? "ok" : turn.status, 412);
    // Test on the saved key: there is none the channels use; nothing is sent.
    sent = [];
    const tested = await testKey({ provider: "anthropic" });
    assert.equal(tested.status, 404, JSON.stringify(tested.body));
    assert.equal(tested.body.code, "no_key_on_file");
    assert.equal(sent.length, 0, "Test probed the personal key");
    // The setup checklist: not connected, and it says the personal key is not used.
    const report = await loadReadinessReport({ tenantId: SOLO, authUserId: USERS.solo.id, isOwnerOrAdmin: true });
    const ai = report.tenant?.find((i) => i.key === "tenant.ai_provider");
    assert.equal(ai?.status, "warn", JSON.stringify(ai));
    assert.match(String(ai?.detail), /Your personal key is saved, but department chats don't use it\./);
    // The personal key is reported, separately.
    assert.deepEqual([...(await q.personalAiServicesWithKey(SOLO))], ["anthropic"]);
  });
  await check("another agent's workspace row is not the workspace account either", async () => {
    await db.execute({
      sql: `INSERT INTO agent_model_config (id, tenant_id, user_id, agent_key, provider, model, encrypted_api_key, enabled, updated_at)
            VALUES ('solo-maven', ?, NULL, 'maven', 'openai', 'gpt-5.4', ?, 1, ?)`,
      args: [SOLO, encryptField("sk-proj-other-agent"), stamp],
    });
    try {
      assert.equal((await q.aiServicesWithKey(SOLO)).size, 0, "another agent's row read Connected");
      assert.equal(await account.readWorkspaceAiAccount(SOLO), null);
    } finally {
      await db.execute("DELETE FROM agent_model_config WHERE id = 'solo-maven'");
    }
  });
  await check("Settings > AI brain hands the card the workspace account and the viewer's personal keys apart", async () => {
    await login(USERS.solo);
    const tree = await SettingsContent({ section: "ai" });
    const card = findEl(tree, ProviderAccountsCard);
    assert.ok(card, "the provider card is not on the page");
    const props = card!.props as { connectedServices: Set<string> | null; personalServices: Set<string> | null };
    assert.ok(props.connectedServices instanceof Set, "the workspace set was not read");
    assert.deepEqual([...props.connectedServices!], [], "a personal key reached Connected");
    assert.deepEqual([...(props.personalServices ?? [])], ["anthropic"], "the personal key is not reported");
    // A connected workspace: its account is Connected.
    await login(USERS.alpha);
    const alphaCard = findEl(await SettingsContent({ section: "ai" }), ProviderAccountsCard);
    assert.deepEqual([...((alphaCard?.props as { connectedServices: Set<string> }).connectedServices ?? [])], ["anthropic"]);
  });
  // The provider card, drawn by real React in a child process (the suite runs
  // under react-server, where client components cannot render).
  let html: Record<string, string> = {};
  const plain = (s: string | undefined) => String(s ?? "").replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, " ");
  const count = (s: string, re: RegExp) => s.match(re)?.length ?? 0;
  await check("the provider card renders (tests/ai-workspace-account.render.ts)", () => {
    // The render needs whole React: drop the suite's react-server condition.
    const nodeOptions = (process.env.NODE_OPTIONS || "")
      .split(/\s+/)
      .filter((tok) => tok && !/^(--conditions|-C)(=|$)/.test(tok) && tok !== "react-server")
      .join(" ");
    const env = { ...process.env, NODE_OPTIONS: nodeOptions };
    if (!nodeOptions) delete env.NODE_OPTIONS;
    const r = spawnSync(process.execPath, ["--import", "tsx", "tests/ai-workspace-account.render.ts"], { encoding: "utf8", env, timeout: 120_000 });
    assert.equal(r.status, 0, `the render helper exited ${r.status}:\n${r.stderr}`);
    html = JSON.parse(r.stdout) as Record<string, string>;
  });
  await check("the card draws a personal key as the owner's own, never Connected", () => {
    const personal = plain(html.personalOnly);
    assert.match(personal, /Your personal key/);
    assert.match(personal, /This key is saved for you only\. Department chats and Slack mentions don't use it: connect it for the whole team so they can\./);
    assert.match(personal, /Remove my key/);
    assert.equal(count(personal, /Connected/g), 0, "a personal key read Connected");
    assert.match(personal, /Cloud: no provider connected/);
    assert.equal(count(personal, /Not connected/g), 3, "the other three providers");
    const both = plain(html.connectedAndPersonal);
    assert.match(both, /Every department chat and Slack mention uses this key\./);
    assert.doesNotMatch(both, /Your personal key/, "the workspace account is Connected, not the owner's own");
    assert.match(both, /Cloud: 1 provider connected/);
    for (const key of ["afterPersonalConnect", "afterPersonalConnectRefresh"]) {
      const after = plain(html[key]);
      assert.equal(count(after, /Your personal key/g), 1, `${key}: Google is the owner's own key`);
      assert.match(after, /Cloud: no provider connected/, `${key}: a "Just me" key turned the card Connected`);
    }
  });
  await check("a client owner's card names no vendor tool and promises no tools its chats lack", () => {
    // It says what the account does instead.
    for (const key of ["clientEmpty", "clientAnthropic"]) {
      const page = plain(html[key]);
      assert.match(page, /Paste a key once\. Your teammates answer every department chat and Slack mention with the team-wide account\./, key);
      assert.doesNotMatch(page, /Claude[- ]?Code/i, `${key}: a vendor tool name on a client's card`);
      assert.doesNotMatch(page, /tool_use|Claude-Code-class|http_get|record reads/i, `${key}: a tool promise on a client's card`);
    }
    assert.match(plain(html.clientEmpty), /No provider wired yet/, "the client's no-provider notice was drawn (and scanned)");
    assert.match(plain(html.clientAnthropic), /Connected/, "the client's connected card was drawn (and scanned)");
    // The operator's own chat runs the tool loop on an Anthropic key: his badge stays.
    assert.match(plain(html.operatorAnthropic), /tool_use/);
  });
  await check("a failed key read is Couldn't check everywhere, never not connected", async () => {
    await db.execute("ALTER TABLE agent_model_config RENAME TO agent_model_config_offline");
    try {
      await assert.rejects(account.readWorkspaceAiAccount(ALPHA), (err: Error) => {
        assert.match(err.message, /agent_model_config read failed/);
        assert.ok(!err.message.includes(ALPHA), "the tenant id leaked into the error");
        return true;
      });
      await assert.rejects(q.aiServicesWithKey(ALPHA), /agent_model_config read failed/);
      const viewer = await viewerFor(USERS.alpha);
      assert.equal((await resolveChannelState(dept("sales"), viewer)).kind, "unknown");
      const turn = await slackTurn(ALPHA, "alpha-co", "sales", "sdr");
      assert.deepEqual(turn.ok ? "ok" : { status: turn.status, error: turn.error }, { status: 503, error: "config_unavailable" });
      await login(USERS.alpha);
      const tested = await testKey({ provider: "anthropic" });
      assert.equal(tested.status, 503);
      assert.equal(tested.body.code, "config_unavailable");
      const gen = await jsonOf(await generate.POST(req("/api/agents/generate", "POST", { name: "Helper", category: "sales", description: "Drafts replies." })));
      assert.equal(gen.status, 503, JSON.stringify(gen.body));
      assert.equal(gen.body.error, "config_unavailable");
    } finally {
      await db.execute("ALTER TABLE agent_model_config_offline RENAME TO agent_model_config");
    }
  });

  // -- 3. OASIS keeps answering on its legacy row; the account row wins once saved
  await check("the legacy bravo workspace row still answers for OASIS, exactly as before", async () => {
    const acct = await account.readWorkspaceAiAccount(OASIS);
    assert.equal(acct?.source, "legacy");
    assert.deepEqual([...(await q.aiServicesWithKey(OASIS))], ["anthropic"]);
    const turn = await slackTurn(OASIS, "oasis-ai-cc", "chief-of-staff", "bravo");
    assert.ok(turn.ok, JSON.stringify(turn));
    if (turn.ok) assert.equal(turn.turn.apiKey, KEY_OASIS);
    const viewer = await viewerFor(USERS.partner);
    assert.equal((await resolveChannelState(dept("chief-of-staff"), viewer)).kind, "ready");
    // No account row was written for OASIS by anything above.
    assert.ok(!(await rows(OASIS)).some((r) => r.agent_key === account.WORKSPACE_AI_AGENT_KEY));
  });
  await check("a workspace with a legacy row that connects a new account answers on the new one", async () => {
    // Before: the legacy row answers.
    const before = await slackTurn(LEGACY, "legacy-co", "sales", "sdr");
    assert.ok(before.ok && before.turn.apiKey === KEY_LEGACY_OLD, "the legacy row did not answer");
    await login(USERS.legacy);
    const res = await connect({ provider: "anthropic", api_key: KEY_LEGACY_NEW });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    // The owner's teammate list is the neutral lead only: the legacy row is untouched...
    assert.ok((await rows(LEGACY)).some((r) => r.agent_key === "bravo" && r.key === KEY_LEGACY_OLD));
    // ...and every surface follows the account row, not the stale legacy key.
    const after = await slackTurn(LEGACY, "legacy-co", "sales", "sdr");
    assert.ok(after.ok, JSON.stringify(after));
    if (after.ok) assert.equal(after.turn.apiKey, KEY_LEGACY_NEW);
    assert.deepEqual([...(await q.aiServicesWithKey(LEGACY))], ["anthropic"]);
    sent = [];
    provider = answering("ok");
    assert.equal((await testKey({ provider: "anthropic" })).body.ok, true);
    assert.deepEqual(sent.map(keyOf), [KEY_LEGACY_NEW]);
  });
  await check("the old export names still answer (lib/os/channel/workspace-key.ts)", () => {
    assert.equal(legacyNames.CHANNEL_CONFIG_AGENT_KEY, "bravo");
    assert.equal(legacyNames.WORKSPACE_AI_AGENT_KEY, "__workspace__");
    assert.equal(legacyNames.readWorkspaceAiAccount, account.readWorkspaceAiAccount);
  });

  // -- 4. Keys are tried before they are saved --------------------------------
  // The dialog's own flow (connectProviderKey), against the real routes.
  const callsTo: string[] = [];
  const viaRoutes = async (url: string, init: RequestInit) => {
    callsTo.push(url);
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    if (url === "/api/agent-config/test-connection") return testConnection.POST(req(url, "POST", body));
    if (url === "/api/agent-config/bulk-provider") return bulk.POST(req(url, "POST", body));
    throw new Error(`unexpected route ${url}`);
  };
  const freshKeys = async () => (await rows(FRESH)).length;
  await check("a key the provider refuses is not saved, and the owner reads the test's plain sentence", async () => {
    await login(USERS.fresh);
    callsTo.length = 0;
    sent = [];
    provider = () => new Response(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }), { status: 401 });
    const result = await connectProviderKey({ provider: "anthropic", apiKey: "sk-ant-wrong", model: "claude-sonnet-4-6", scope: "tenant" }, viaRoutes);
    assert.equal(result.kind, "refused", JSON.stringify(result));
    if (result.kind === "refused") {
      assert.equal(result.message, "Your AI account refused the request. Check its billing or key.");
      assert.equal(result.canSaveAnyway, false, "a refused key may never be saved anyway");
    }
    assert.deepEqual(callsTo, ["/api/agent-config/test-connection"], "the save route was called after a refusal");
    assert.equal(await freshKeys(), 0, "a refused key was saved");
    // An empty-balance key is refused the same way.
    provider = () => new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low" } }), { status: 400 });
    const drained = await connectProviderKey({ provider: "anthropic", apiKey: "sk-ant-drained", model: "claude-sonnet-4-6", scope: "tenant" }, viaRoutes);
    assert.equal(drained.kind === "refused" && drained.canSaveAnyway, false);
    assert.equal(await freshKeys(), 0);
  });
  await check("a provider that is down or slow says nothing about the key: Save anyway is offered, and saves", async () => {
    await login(USERS.fresh);
    for (const [label, answer] of [
      ["provider down", () => new Response("upstream", { status: 503 })],
      [
        "provider slow",
        () => {
          const err = new Error("The operation was aborted.");
          err.name = "AbortError";
          throw err;
        },
      ],
    ] as Array<[string, () => Response]>) {
      callsTo.length = 0;
      provider = answer;
      const result = await connectProviderKey({ provider: "anthropic", apiKey: KEY_FRESH, model: "claude-sonnet-4-6", scope: "tenant" }, viaRoutes);
      assert.equal(result.kind, "refused", `${label}: ${JSON.stringify(result)}`);
      assert.equal(result.kind === "refused" && result.canSaveAnyway, true, `${label}: Save anyway was not offered`);
      assert.equal(await freshKeys(), 0, `${label}: saved before the owner chose to`);
    }
    callsTo.length = 0;
    const anyway = await connectProviderKey({ provider: "anthropic", apiKey: KEY_FRESH, model: "claude-sonnet-4-6", scope: "tenant", skipTest: true }, viaRoutes);
    assert.equal(anyway.kind, "saved", JSON.stringify(anyway));
    assert.deepEqual(callsTo, ["/api/agent-config/bulk-provider"]);
    const acct = await account.readWorkspaceAiAccount(FRESH);
    assert.equal(acct?.source, "workspace");
    await db.execute({ sql: "DELETE FROM agent_model_config WHERE tenant_id = ?", args: [FRESH] });
  });
  await check("a key the provider answers is saved as the workspace account, after exactly one test", async () => {
    await login(USERS.fresh);
    callsTo.length = 0;
    sent = [];
    provider = answering("ok");
    const result = await connectProviderKey({ provider: "anthropic", apiKey: KEY_FRESH, model: "claude-haiku-4-5", scope: "tenant" }, viaRoutes);
    assert.equal(result.kind, "saved", JSON.stringify(result));
    assert.deepEqual(callsTo, ["/api/agent-config/test-connection", "/api/agent-config/bulk-provider"]);
    assert.equal(sent.length, 1, "one test message, nothing else");
    assert.equal(sent[0].body?.model, "claude-haiku-4-5", "the key was tested on another model than it is saved with");
    const turn = await slackTurn(FRESH, "fresh-co", "sales", "sdr");
    assert.ok(turn.ok && turn.turn.apiKey === KEY_FRESH && turn.turn.model === "claude-haiku-4-5", JSON.stringify(turn));
  });
  await check("a save that does not go through is one sentence, never a teammate name or an error code", async () => {
    await login(USERS.alphaRep); // a closer: may test, may not connect for the team
    provider = answering("ok");
    const result = await connectProviderKey({ provider: "anthropic", apiKey: KEY_ALPHA, model: "claude-sonnet-4-6", scope: "tenant" }, viaRoutes);
    assert.equal(result.kind, "failed", JSON.stringify(result));
    if (result.kind === "failed") {
      assert.equal(result.message, "Only an owner or admin can connect an AI account for the whole team.");
      assert.doesNotMatch(result.message, /sdr|customer-support|bravo|admin_required|_/);
    }
    const src = readFileSync(join(process.cwd(), "components/settings/ProviderAccountsCard.tsx"), "utf8");
    assert.doesNotMatch(src, /f\.agent_key/, "the dialog lists teammate slugs again");
    assert.match(src, /connectProviderKey\(\{ provider, apiKey: apiKey\.trim\(\), model, scope, skipTest \}\)/, "the dialog does not use the tested connect");
  });

  // -- 5. A local model server is the verified operator's only ---------------
  await check("'ollama' is refused 403 for a member and a client owner, and nothing is fetched", async () => {
    const metadata = "http://169.254.169.254/latest/meta-data";
    for (const user of [USERS.alphaRep, USERS.alpha]) {
      await login(user);
      sent = [];
      const tested = await testKey({ provider: "ollama", api_key: metadata });
      assert.equal(tested.status, 403, `${user.email}: ${JSON.stringify(tested.body)}`);
      assert.equal(tested.body.code, "local_model_not_allowed");
      assert.equal(tested.body.message, account.LOCAL_MODEL_REFUSAL);
      const savedTest = await testKey({ provider: "ollama" });
      assert.equal(savedTest.status, 403, "the saved-key Test of a local model");
      assert.equal(sent.length, 0, `${user.email}: the server called ${sent.map((s) => s.url).join(", ")}`);
    }
    await login(USERS.alpha);
    const bulkRes = await connect({ provider: "ollama", api_key: metadata, model: "llama3.3" });
    assert.equal(bulkRes.status, 403, JSON.stringify(bulkRes.body));
    assert.equal(bulkRes.body.error, "local_model_not_allowed");
    const personal = await connect({ provider: "ollama", api_key: metadata, model: "llama3.3", scope: "user" });
    assert.equal(personal.status, 403);
    const perAgent = await jsonOf(
      await agentConfig.POST(req("/api/agent-config", "POST", { agent_key: "sdr", provider: "ollama", model: "llama3.3", api_key: metadata })),
    );
    assert.equal(perAgent.status, 403, JSON.stringify(perAgent.body));
    assert.equal(perAgent.body.error, "local_model_not_allowed");
    assert.ok(!(await rows(ALPHA)).some((r) => r.provider === "ollama"), "a local model was saved");
  });
  await check("the verified operator can still test a local model server", async () => {
    await login(USERS.cc);
    sent = [];
    provider = (s) =>
      s.method === "GET"
        ? new Response(JSON.stringify({ data: [{ id: "llama3.3" }] }), { status: 200 })
        : new Response(JSON.stringify({ usage: { prompt_tokens: 3, completion_tokens: 1 } }), { status: 200 });
    const tested = await testKey({ provider: "ollama", api_key: "http://localhost:11434" });
    assert.equal(tested.status, 200, JSON.stringify(tested.body));
    assert.equal(tested.body.ok, true);
    assert.ok(sent.some((s) => s.url.startsWith("http://localhost:11434/")), "the operator's local server was not asked");
  });

  // -- 6. The account row is not a teammate ------------------------------------
  await check("no agent-config list shows the account row, and it cannot be edited as a teammate", async () => {
    await login(USERS.alpha);
    for (const url of ["/api/agent-config", "/api/agent-config?scope=user"]) {
      const res = await jsonOf(await agentConfig.GET(req(url, "GET")));
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const keys = (res.body.configs as Array<{ agent_key: string }>).map((c) => c.agent_key);
      assert.ok(!keys.includes(account.WORKSPACE_AI_AGENT_KEY), `${url} lists the account row: ${keys.join(",")}`);
      if (url === "/api/agent-config") assert.ok(keys.includes("sdr"), "the teammate rows are still listed");
    }
    const edit = await jsonOf(
      await agentConfig.POST(req("/api/agent-config", "POST", { agent_key: account.WORKSPACE_AI_AGENT_KEY, provider: "anthropic", model: "claude-haiku-4-5" })),
    );
    assert.equal(edit.status, 400);
    assert.equal(edit.body.error, `invalid_agent:${account.WORKSPACE_AI_AGENT_KEY}`);
  });

  // -- 7. The builder and the manifest editor: the account, and plain words ----
  await check("the AI builder and the manifest editor answer on the workspace's account", async () => {
    await login(USERS.alpha);
    sent = [];
    provider = answering(
      JSON.stringify({
        base_prompt: "You help {{tenant.brand.name}} answer customer questions quickly and politely.",
        short_description: "Answers questions.",
        description: "Answers customer questions for the team.",
        required_tools: [],
        suggested_model: "claude-sonnet-4-6",
      }),
    );
    const gen = await jsonOf(await generate.POST(req("/api/agents/generate", "POST", { name: "Helper", category: "sales", description: "Answers customer questions." })));
    assert.equal(gen.status, 200, JSON.stringify(gen.body));
    assert.deepEqual(sent.map(keyOf), [KEY_ALPHA]);
    sent = [];
    provider = answering(JSON.stringify({ explanation: "Nothing to change.", mutations: [] }));
    await manifestChat.POST(req("/api/manifest/chat", "POST", { slug: "alpha-co", message: "Rename the Sales tab" }));
    assert.deepEqual(sent.map(keyOf), [KEY_ALPHA], "the manifest editor sent another key");
  });
  await check("with no account, they say where to connect one, in plain words, naming no persona", async () => {
    // A key the person saved for their own chats still answers their own tools,
    // as before (it is not a department chat).
    await login(USERS.solo);
    sent = [];
    provider = answering(JSON.stringify({ explanation: "ok", mutations: [] }));
    await manifestChat.POST(req("/api/manifest/chat", "POST", { slug: "solo-co", message: "hello" }));
    assert.deepEqual(sent.map(keyOf), [KEY_SOLO_PERSONAL], "a person's own key no longer answers their own tools");
    // A workspace with no account and no personal key: the plain sentence.
    await db.execute({ sql: "DELETE FROM agent_model_config WHERE tenant_id = ?", args: [BETA] });
    await login(USERS.beta);
    sent = [];
    for (const res of [
      await jsonOf(await generate.POST(req("/api/agents/generate", "POST", { name: "Helper", category: "sales", description: "Answers customer questions." }))),
      await jsonOf(await manifestChat.POST(req("/api/manifest/chat", "POST", { slug: "beta-co", message: "hello" }))),
    ]) {
      assert.equal(res.status, 412, JSON.stringify(res.body));
      assert.equal(res.body.message, "Connect an AI account in Settings > AI brain.");
      assert.equal(res.body.hint, "Connect an AI account in Settings > AI brain.");
      assert.doesNotMatch(JSON.stringify(res.body), /bravo|maven|atlas|aura|hermes|solara|helios/i);
    }
    assert.equal(sent.length, 0);
  });

  // -- 8. Disconnect removes the account ----------------------------------------
  await check("disconnecting the provider removes the workspace account, and the channels say so", async () => {
    await login(USERS.alpha);
    const res = await jsonOf(await bulk.DELETE(req("/api/agent-config/bulk-provider?provider=anthropic&scope=tenant", "DELETE")));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(!(await rows(ALPHA)).some((r) => r.agent_key === account.WORKSPACE_AI_AGENT_KEY), "the account row survived the disconnect");
    assert.equal(await account.readWorkspaceAiAccount(ALPHA), null);
    assert.equal((await q.aiServicesWithKey(ALPHA)).size, 0);
    const viewer = await viewerFor(USERS.alpha);
    assert.equal((await resolveChannelState(dept("sales"), viewer)).kind, "not_connected");
  });
  await check("disconnecting another provider leaves the account alone", async () => {
    await login(USERS.legacy);
    const res = await jsonOf(await bulk.DELETE(req("/api/agent-config/bulk-provider?provider=openrouter&scope=tenant", "DELETE")));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const acct = await account.readWorkspaceAiAccount(LEGACY);
    assert.equal(acct?.source, "workspace");
    assert.equal(acct?.provider, "anthropic");
  });

  console.log(`ai-workspace-account: ${failures === 0 ? "OK" : `${failures} FAILED`}`);
  if (failures) {
    console.log("captured console.error (last 15):");
    for (const line of logged.slice(-15)) console.log("   ", line.map((x) => (x instanceof Error ? x.message : typeof x === "string" ? x : JSON.stringify(x))).join(" ").slice(0, 400));
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error = realError;
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    console.error = realError;
    globalThis.fetch = realFetch;
  });
