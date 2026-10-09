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
// Two workspaces that saved an OpenRouter key on the legacy row, then connect
// Anthropic and disconnect it (Codex review, PR #535).
const RELIC = "f6f6f6f6-0000-4000-8000-0000000000f6";
const RELIC2 = "f7f7f7f7-0000-4000-8000-0000000000f7";
// A workspace with local-model rows saved before the save-time rule: its
// workspace row and its owner's personal row both point at an address.
const LOCALCO = "f8f8f8f8-0000-4000-8000-0000000000f8";
const LOCAL_TEMPLATE = "f8f8f8f8-0000-4000-8000-00000000aaaa";
// Interleavings (Codex review, round 3): an owner's two tabs; the one-time
// backfill landing inside a disconnect, and inside a connect, of a workspace
// whose only key is on the legacy row; a member and an owner at once.
const RACE = "a9a9a9a9-0000-4000-8000-0000000000a9";
const BACKFILL_ONE = "b8b8b8b8-0000-4000-8000-0000000000b8";
const BACKFILL_TWO = "b9b9b9b9-0000-4000-8000-0000000000b9";
const TEAMCO = "c9c9c9c9-0000-4000-8000-0000000000c9";
// Round 4 (PR #535 review): a workspace whose Sales lead has its own prompt,
// for two tabs connecting at once; one whose look-back read fails; one whose
// disconnect fails every way it can.
const PROMPTCO = "d9d9d9d9-0000-4000-8000-0000000000d9";
const LOOKCO = "e9e9e9e9-0000-4000-8000-0000000000e9";
const CODECO = "f9f9f9f9-0000-4000-8000-0000000000f9";
const FRENCH = "Always greet in French.";

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
  relic: u(9, "owner@relic.test"),
  relic2: u(10, "owner@relic2.test"),
  local: u(11, "owner@local.test"),
  race: u(12, "owner@race.test"),
  backfillOne: u(13, "owner@backfill-one.test"),
  backfillTwo: u(14, "owner@backfill-two.test"),
  team: u(15, "owner@team.test"),
  teamRep: u(16, "rep@team.test"), // a closer: saves keys for their own chats only
  prompt: u(17, "owner@prompt.test"),
  look: u(18, "owner@look.test"),
  code: u(19, "owner@code.test"),
  codeRep: u(20, "rep@code.test"), // a closer: may not disconnect the team's account
} as const;

const KEY_ALPHA = "sk-ant-alpha-workspace-key-0001";
const KEY_BETA = "sk-or-v1-beta-workspace-key-0002";
const KEY_SOLO_PERSONAL = "sk-ant-solo-personal-key-0003";
const KEY_OASIS = "sk-ant-oasis-legacy-row-key-0004";
const KEY_LEGACY_OLD = "sk-or-v1-legacy-old-key-0005";
const KEY_LEGACY_NEW = "sk-ant-legacy-new-key-0006";
const KEY_FRESH = "sk-ant-fresh-key-0007";
const KEY_RELIC_OLD = "sk-or-v1-relic-old-key-0008";
const KEY_RELIC_NEW = "sk-ant-relic-new-key-0009";
const KEY_RELIC_LATER = "sk-or-v1-relic-saved-later-0010";
const KEY_RELIC2_OLD = "sk-or-v1-relic2-old-key-0011";
const KEY_RELIC2_NEW = "sk-ant-relic2-new-key-0012";
// Local model "keys": addresses this server must never call for a client.
const LOCAL_WORKSPACE_URL = "http://169.254.169.254/latest/meta-data";
const LOCAL_PERSONAL_URL = "http://10.0.0.5:11434/v1";
const KEY_RACE = ["sk-ant-race-key-0101", "sk-ant-race-key-0102", "sk-ant-race-key-0103", "sk-ant-race-key-0104"] as const;
const KEY_BACKFILL_ONE = "sk-ant-backfill-one-legacy-0105";
const KEY_BACKFILL_TWO_OLD = "sk-or-v1-backfill-two-legacy-0106";
const KEY_BACKFILL_TWO_NEW = "sk-ant-backfill-two-new-0107";
const KEY_TEAM = "sk-ant-team-key-0108";
const KEY_TEAM_REP_OWN = "sk-ant-team-rep-own-key-0109";
const KEY_TEAM_AGAIN = "sk-ant-team-key-again-0110";
const KEY_TEAM_REP_NEW = "sk-ant-team-rep-own-key-0111";
const KEY_RACE_OWN = "sk-or-v1-race-client-success-own-0112";
const KEY_PROMPT = [
  "sk-ant-prompt-first-0200",
  "sk-ant-prompt-second-tab-0201",
  "sk-ant-prompt-first-tab-0202",
  "sk-ant-prompt-same-0203",
  "sk-ant-prompt-all-0204",
  "sk-ant-prompt-sales-only-0205",
  "sk-ant-prompt-failed-0206",
  "sk-ant-prompt-switched-off-0207",
] as const;
const KEY_LOOK = ["sk-ant-look-first-0300", "sk-ant-look-second-0301"] as const;
const KEY_CODE = ["sk-ant-code-key-0400", "sk-ant-code-other-window-0401"] as const;

/** Who is signed in (the session cookie's person), for the test's own key-test proofs. */
let currentUser: U | null = null;
async function login(user: U | null) {
  currentUser = user;
  if (!user) {
    sessionCookie = undefined;
    return;
  }
  const { signSession } = await import("../lib/turso-auth");
  sessionCookie = signSession({ sub: user.id, email: user.email, exp: Math.floor(Date.now() / 1000) + 3600, ver: 0 });
}

let failures = 0;
// A request that never settles empties Node's event loop, and Node then exits
// with code 0 halfway through the suite: a hang would read as a pass. The
// suite says it finished, and an exit before that is a failure.
let finished = false;
process.on("exit", () => {
  if (finished) return;
  console.log("ai-workspace-account: STOPPED before the end (something never settled)");
  process.exitCode = 1;
});
/** `work`, or a failure after `ms`: a call that never settles fails its check instead of stopping the suite. */
async function settlesWithin<T>(ms: number, what: string, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`${what} never settled`)), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}
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
    -- The SunBiz template-variant route reads one template before it asks a model.
    CREATE TABLE gmail_templates (id TEXT PRIMARY KEY, tenant_id TEXT, name TEXT, stage TEXT, subject TEXT,
      body TEXT, variants TEXT, created_at TEXT, updated_at TEXT);
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
      // RELIC and RELIC2: an OpenRouter key on the legacy row (Codex review).
      ...workspace(RELIC, "relic-co", "Relic Co"),
      ...workspace(RELIC2, "relic2-co", "Relic Two"),
      profile("p-relic", USERS.relic, RELIC, "owner", 1, ["sdr"]),
      profile("p-relic2", USERS.relic2, RELIC2, "owner", 1, ["sdr"]),
      configRow(RELIC, null, "bravo", "openrouter", "anthropic/claude-sonnet-4.6", KEY_RELIC_OLD),
      configRow(RELIC2, null, "bravo", "openrouter", "anthropic/claude-sonnet-4.6", KEY_RELIC2_OLD),
      // LOCALCO: local-model rows written before the save-time rule (or by any
      // other path): the workspace row, and its owner's personal row.
      ...workspace(LOCALCO, "local-co", "Local Co"),
      profile("p-local", USERS.local, LOCALCO, "owner", 1, ["sdr"]),
      configRow(LOCALCO, null, "bravo", "ollama", "llama3.3", LOCAL_WORKSPACE_URL),
      configRow(LOCALCO, USERS.local.id, "bravo", "ollama", "llama3.3", LOCAL_PERSONAL_URL),
      {
        sql: "INSERT INTO gmail_templates (id, tenant_id, name, stage, subject, body, variants, created_at, updated_at) VALUES (?, ?, 'Welcome', 'new', 'Hello', 'Hi {{first_name}}, thanks for reaching out.', '[]', ?, ?)",
        args: [LOCAL_TEMPLATE, LOCALCO, stamp, stamp],
      },
      // The interleavings' workspaces. The two backfill ones saved their key on
      // the legacy row before this change, as cj2hassler's workspace did.
      ...workspace(RACE, "race-co", "Race Co"),
      ...workspace(BACKFILL_ONE, "backfill-one", "Backfill One"),
      ...workspace(BACKFILL_TWO, "backfill-two", "Backfill Two"),
      ...workspace(TEAMCO, "team-co", "Team Co"),
      profile("p-race", USERS.race, RACE, "owner", 1, ["sdr", "customer-support"]),
      profile("p-backfill-one", USERS.backfillOne, BACKFILL_ONE, "owner", 1, ["sdr"]),
      profile("p-backfill-two", USERS.backfillTwo, BACKFILL_TWO, "owner", 1, ["sdr"]),
      profile("p-team", USERS.team, TEAMCO, "owner", 1, ["sdr"]),
      profile("p-team-rep", USERS.teamRep, TEAMCO, "closer", 0, ["sdr"]),
      configRow(BACKFILL_ONE, null, "bravo", "anthropic", "claude-sonnet-4-6", KEY_BACKFILL_ONE),
      configRow(BACKFILL_TWO, null, "bravo", "openrouter", "anthropic/claude-sonnet-4.6", KEY_BACKFILL_TWO_OLD),
      ...workspace(PROMPTCO, "prompt-co", "Prompt Co"),
      ...workspace(LOOKCO, "look-co", "Look Co"),
      ...workspace(CODECO, "code-co", "Code Co"),
      profile("p-prompt", USERS.prompt, PROMPTCO, "owner", 1, ["sdr", "customer-support"]),
      profile("p-look", USERS.look, LOOKCO, "owner", 1, ["sdr"]),
      profile("p-code", USERS.code, CODECO, "owner", 1, ["sdr"]),
      profile("p-code-rep", USERS.codeRep, CODECO, "closer", 0, ["sdr"]),
    ],
    "write",
  );

  const bulk = await import("../app/api/agent-config/bulk-provider/route");
  const agentConfig = await import("../app/api/agent-config/route");
  const testConnection = await import("../app/api/agent-config/test-connection/route");
  const chat = await import("../app/api/agents/chat/route");
  const generate = await import("../app/api/agents/generate/route");
  const manifestChat = await import("../app/api/manifest/chat/route");
  const solara = await import("../app/api/gmail-templates/[id]/solara/route");
  const { resolveChatContext } = await import("../lib/chat-auth");
  const { streamChat } = await import("../lib/providers");
  const { modelCallMeter } = await import("../lib/ai/usage");
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
  // The save route tests every key itself unless the request carries
  // test-connection's proof of that test (lib/ai/connect-test-proof.ts, R5-L3).
  // `connect` stands for the dialog AFTER its test passed: it carries the proof
  // test-connection would have signed, so the suite's saves are not each
  // tested again. `connectUntested` is a request with no proof at all.
  const { signConnectTest } = await import("../lib/ai/connect-test-proof");
  const registry = await import("../lib/ai/model-registry");
  async function proven(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!currentUser || typeof body.api_key !== "string" || "tested" in body || body.verify === true) return body;
    const seat = await db.execute({ sql: "SELECT tenant_id FROM user_profiles WHERE auth_user_id = ? LIMIT 1", args: [currentUser.id] });
    const tenantId = seat.rows[0]?.tenant_id;
    if (!tenantId) return body;
    const prov = String(body.provider || "");
    const model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : registry.isRegistryProvider(prov) ? registry.defaultModelFor(prov) : "";
    const proof = signConnectTest({ tenantId: String(tenantId), userId: currentUser.id, provider: prov, model, apiKey: body.api_key.trim() }, "passed");
    return proof ? { ...body, tested: proof } : body;
  }
  const connect = async (body: Record<string, unknown>) => jsonOf(await bulk.POST(req("/api/agent-config/bulk-provider", "POST", await proven(body))));
  const connectUntested = async (body: Record<string, unknown>) => jsonOf(await bulk.POST(req("/api/agent-config/bulk-provider", "POST", body)));
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
  /** Run the render helper (with `extra` in its environment) and read what it printed. */
  const renderHelper = (extra: Record<string, string> = {}): unknown => {
    // The render needs whole React: drop the suite's react-server condition.
    const nodeOptions = (process.env.NODE_OPTIONS || "")
      .split(/\s+/)
      .filter((tok) => tok && !/^(--conditions|-C)(=|$)/.test(tok) && tok !== "react-server")
      .join(" ");
    const env: NodeJS.ProcessEnv = { ...process.env, ...extra, NODE_OPTIONS: nodeOptions };
    if (!nodeOptions) delete env.NODE_OPTIONS;
    const r = spawnSync(process.execPath, ["--import", "tsx", "tests/ai-workspace-account.render.ts"], { encoding: "utf8", env, timeout: 120_000 });
    assert.equal(r.status, 0, `the render helper exited ${r.status}:\n${r.stderr}`);
    return JSON.parse(r.stdout);
  };
  await check("the provider card renders (tests/ai-workspace-account.render.ts)", () => {
    html = renderHelper() as Record<string, string>;
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
  await check("Save anyway is only for the exact key and model that timed out: any edit takes it away, and it saves exactly that", () => {
    const steps = JSON.parse(html.saveAnyway ?? "{}") as Record<string, unknown>;
    assert.equal(steps.afterTimeout, true, "a timeout did not offer Save anyway");
    assert.equal(steps.afterKeyEdit, false, "Save anyway stayed after the key was edited");
    assert.equal(steps.afterKeyBack, false, "an edit away and back brought Save anyway back without a new test");
    assert.equal(steps.afterSecondTimeout, true);
    assert.equal(steps.afterModelEdit, false, "Save anyway stayed after the model was changed");
    assert.equal(steps.afterModelTimeout, true);
    assert.equal(steps.afterScopeEdit, false, "Save anyway stayed after the scope was changed");
    assert.equal(steps.afterRefusal, false, "a refused key was offered Save anyway");
    assert.equal(steps.beforeSave, true);
    assert.deepEqual(
      steps.saveCalls,
      [
        {
          url: "/api/agent-config/bulk-provider",
          // save_anyway: the route itself now tests every key (R5-L3), and saves
          // an untested one only when the owner chose this.
          body: { provider: "anthropic", api_key: "sk-ant-tested-key-A", model: "claude-opus-4-7", scope: "tenant", save_anyway: true },
        },
      ],
      "Save anyway saved something other than the timed-out key and model, or tested again",
    );
    assert.deepEqual(steps.connected, [{ provider: "anthropic", scope: "tenant" }]);
  });
  // An answer that lands late (Codex review of PR #535, round 3). The render
  // helper's steps edit the form while a test is out by calling its handlers
  // directly (a browser could not: the form is locked), so each guard is
  // proven on its own.
  const late = () => JSON.parse(html.lateAnswers ?? "{}") as Record<string, Record<string, unknown>>;
  const open = { key: false, model: false, wholeTeam: false, justMe: false };
  const shut = { key: true, model: true, wholeTeam: true, justMe: true };
  await check("the connect form is locked while a key is being tested, and unlocks on every answer", () => {
    const steps = late();
    assert.deepEqual(steps.lockedWhileTesting, shut, "the key, model or scope could be changed while the test ran");
    assert.deepEqual(steps.lockedAgain, shut);
    assert.deepEqual(steps.olderRunLate?.locked, shut, "an older run's late answer unlocked the form while a newer run was out");
    for (const name of ["timeoutAfterKeyEdit", "passAfterKeyEdit", "timeoutAfterScopeEdit", "timeoutAfterModelEdit", "timeoutAfterProviderChange", "timeoutOnTime", "newerRunAnswer"]) {
      assert.deepEqual(steps[name]?.locked, open, `${name}: the form stayed locked after the answer`);
    }
  });
  await check("an answer that lands after the form moved on is dropped: no Save anyway for a key no longer on screen, and nothing is saved", () => {
    const steps = late();
    // The key changed while its test was out, then the old test timed out.
    assert.deepEqual(
      { saveAnyway: steps.timeoutAfterKeyEdit?.saveAnyway, alert: steps.timeoutAfterKeyEdit?.alert, saves: steps.timeoutAfterKeyEdit?.saves },
      { saveAnyway: false, alert: null, saves: 0 },
      "a late timeout spoke for a key no longer on screen",
    );
    // The key changed, then the old test PASSED: the old key is not saved.
    assert.deepEqual(
      { saveAnyway: steps.passAfterKeyEdit?.saveAnyway, alert: steps.passAfterKeyEdit?.alert, saves: steps.passAfterKeyEdit?.saves, connected: steps.passAfterKeyEdit?.connected },
      { saveAnyway: false, alert: null, saves: 0, connected: 0 },
      "a late pass saved a key no longer on screen",
    );
    for (const [name, what] of [
      ["timeoutAfterScopeEdit", "the scope"],
      ["timeoutAfterModelEdit", "the model"],
      ["timeoutAfterProviderChange", "the provider"],
    ] as const) {
      assert.deepEqual({ saveAnyway: steps[name]?.saveAnyway, alert: steps[name]?.alert }, { saveAnyway: false, alert: null }, `a late timeout spoke after ${what} changed`);
    }
    // Nothing moved: the same timeout, on time, still offers Save anyway.
    assert.deepEqual(
      { saveAnyway: steps.timeoutOnTime?.saveAnyway, alert: steps.timeoutOnTime?.alert },
      { saveAnyway: true, alert: "The AI provider did not answer within 15 seconds. Try again in a minute." },
    );
  });
  await check("an older test's late answer never speaks over a newer one", () => {
    const steps = late();
    assert.deepEqual(
      { saveAnyway: steps.olderRunLate?.saveAnyway, alert: steps.olderRunLate?.alert },
      { saveAnyway: false, alert: null },
      "the older run's timeout offered Save anyway while the newer run was out",
    );
    assert.deepEqual(
      { saveAnyway: steps.newerRunAnswer?.saveAnyway, alert: steps.newerRunAnswer?.alert },
      { saveAnyway: false, alert: "Your AI account refused the request. Check its billing or key." },
    );
    assert.equal(steps.heldLeft, 0 as unknown, "a held test answer never landed");
  });
  await check("the dialog cannot be closed while a key is being tried, and one that went away anyway saves and applies nothing", () => {
    const closing = JSON.parse(html.closing ?? "{}") as Record<string, unknown>;
    assert.equal(closing.closeLocked, true, "the close button worked while the key was being tried");
    assert.equal(closing.backdropCloses, 0, "a click on the backdrop closed the dialog while the key was being tried");
    // Closed anyway, then the test passed: nothing saved team-wide, nothing marked connected.
    assert.deepEqual(closing.closedThenPassed, { closes: 1, saves: 0, connected: 0 });
    // Gone while the save was out: the save had already left; nothing is applied after it.
    assert.equal(closing.saveWasOut, true, "the save never went out: the step proved nothing");
    assert.deepEqual(closing.goneDuringSave, { saves: 1, connected: 0 });
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
    // The owner's teammate list is the neutral lead only, yet the old team key
    // moved with the team: the legacy row now holds the new key, and the old
    // key is on no row at all (it cannot be spent unseen later).
    const after1 = await rows(LEGACY);
    assert.ok(after1.some((r) => r.agent_key === "bravo" && r.key === KEY_LEGACY_NEW && r.provider === "anthropic"), JSON.stringify(after1.map((r) => [r.agent_key, r.provider])));
    assert.ok(!after1.some((r) => r.key === KEY_LEGACY_OLD), "the old key is still stored");
    // Every surface follows the account row.
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
    // What the dialog itself sends and shows, driven in the render helper (it
    // used to be read off the dialog's source text).
    const dialogSent = JSON.parse(html.plainConnect ?? "{}") as Record<string, unknown>;
    // The dialog's default model is the registry's (lib/ai/model-registry.ts):
    // on Anthropic, Claude Sonnet 4.6 until a 5.x model has run through this app.
    assert.equal(registry.defaultModelFor("anthropic"), "claude-sonnet-4-6");
    assert.deepEqual(
      dialogSent.calls,
      [
        { url: "/api/agent-config/test-connection", body: { provider: "anthropic", api_key: "sk-ant-plain-key-P", model: "claude-sonnet-4-6" } },
        { url: "/api/agent-config/bulk-provider", body: { provider: "anthropic", api_key: "sk-ant-plain-key-P", model: "claude-sonnet-4-6", scope: "tenant" } },
      ],
      "the dialog does not test the pasted key once, on its model, before it saves it",
    );
    assert.equal(dialogSent.connected, 1);
    assert.equal(dialogSent.refusedSave, "Only an owner or admin can connect an AI account for the whole team.", "a refused save named a teammate or a code");
    assert.deepEqual(dialogSent.partialSave, { connected: 1, alert: null }, "a teammate row that did not update reached the screen");
  });
  await check("a request that hangs gives up, so the dialog unlocks with a plain sentence", async () => {
    const signals: AbortSignal[] = [];
    const hangs = (_url: string, init: RequestInit) => {
      if (init.signal) signals.push(init.signal);
      return new Promise<Response>(() => undefined);
    };
    const passesThenHangs = (url: string, init: RequestInit) =>
      url.endsWith("/test-connection") ? Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })) : hangs(url, init);
    // A hung call must not hang this suite either: it fails the check instead.
    const within = <T>(work: Promise<T>) => settlesWithin(3000, "connectProviderKey", work);
    const key = { provider: "anthropic" as const, apiKey: KEY_FRESH, model: "claude-sonnet-4-6", scope: "tenant" as const, timeoutMs: 25 };
    assert.deepEqual(await within(connectProviderKey(key, hangs)), {
      kind: "refused",
      message: "The key couldn't be tested just now, so it was not saved. Try again in a moment.",
      canSaveAnyway: false,
    });
    // The save hangs, and so does the read that asks whether it landed: the
    // dialog says it could not tell, never that the key was not saved.
    assert.deepEqual(await within(connectProviderKey(key, passesThenHangs)), {
      kind: "failed",
      message: "We couldn't check whether the key was saved. Close this and look at the card in a moment.",
    });
    assert.equal(signals.length, 3);
    assert.ok(signals.every((s) => s.aborted), "a request that gave up was not aborted");
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

  // -- 8. Disconnect retires the account: its key is wiped, the row stays ------
  await check("disconnecting the provider retires the workspace account (key wiped, switched off), and the channels say so", async () => {
    await login(USERS.alpha);
    const res = await jsonOf(await bulk.DELETE(req("/api/agent-config/bulk-provider?provider=anthropic&scope=tenant", "DELETE")));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const left = await rows(ALPHA);
    const retired = left.filter((r) => r.agent_key === account.WORKSPACE_AI_AGENT_KEY);
    assert.deepEqual(retired.map((r) => [r.key, r.enabled]), [[null, 0]], "the account row is kept, with no key, switched off");
    assert.ok(!left.some((r) => r.key === KEY_ALPHA), "the disconnected key is still stored somewhere");
    const acct = await account.readWorkspaceAiAccount(ALPHA);
    assert.equal(acct?.source, "workspace");
    assert.equal(account.hasUsableKey(acct), false);
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
    assert.ok(account.hasUsableKey(acct), "a disconnect of another provider retired the account");
  });

  // -- 9. A disconnected account never brings an older key back (Codex review) --
  /** No surface may answer, test or show Connected for this workspace, and nothing is sent. */
  const assertNothingAnswers = async (tenant: string, slug: string, owner: U) => {
    const acct = await account.readWorkspaceAiAccount(tenant);
    assert.equal(acct?.source, "workspace", "the retired account row is the answer, never the legacy row");
    assert.equal(account.hasUsableKey(acct), false, "a usable account after the disconnect");
    assert.equal((await q.aiServicesWithKey(tenant)).size, 0, "Connected after the disconnect");
    const viewer = await viewerFor(owner);
    assert.equal((await resolveChannelState(dept("sales"), viewer)).kind, "not_connected", "the channel reads ready");
    sent = [];
    provider = answering("must not be asked");
    const slack = await slackTurn(tenant, slug, "sales", "sdr");
    assert.deepEqual(slack.ok ? { apiKey: slack.turn.apiKey } : { status: slack.status, error: slack.error }, { status: 412, error: "agent_not_configured" });
    await login(owner);
    const web = await chatTurn({ agent_slug: "sdr", department: "sales" });
    assert.equal(web.status, 412, "the web chat answered");
    const tested = await testKey({ provider: "anthropic" });
    assert.equal(tested.status, 404, JSON.stringify(tested.body));
    assert.equal(tested.body.code, "no_key_on_file");
    const gen = await jsonOf(await generate.POST(req("/api/agents/generate", "POST", { name: "Helper", category: "sales", description: "Answers customer questions." })));
    assert.equal(gen.status, 412, JSON.stringify(gen.body));
    assert.equal(sent.length, 0, `a request was made: ${sent.map((s) => `${s.url} ${keyOf(s)}`).join(", ")}`);
  };
  await check("legacy OpenRouter key, connect Anthropic, disconnect Anthropic: no usable account, not Connected, no request, and the old key is gone", async () => {
    // Before: the legacy row answers.
    const before = await slackTurn(RELIC2, "relic2-co", "sales", "sdr");
    assert.ok(before.ok && before.turn.apiKey === KEY_RELIC2_OLD, "the legacy row did not answer");
    await login(USERS.relic2);
    assert.equal((await connect({ provider: "anthropic", api_key: KEY_RELIC2_NEW })).status, 200);
    const res = await jsonOf(await bulk.DELETE(req("/api/agent-config/bulk-provider?provider=anthropic&scope=tenant", "DELETE")));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    await assertNothingAnswers(RELIC2, "relic2-co", USERS.relic2);
    // The old key moved with the team on connect, so the disconnect took it
    // too: no row still holds either key, and the per-agent chat has none.
    const left = await rows(RELIC2);
    assert.ok(!left.some((r) => r.key === KEY_RELIC2_OLD || r.key === KEY_RELIC2_NEW), JSON.stringify(left.map((r) => [r.agent_key, r.provider, r.enabled])));
    const perAgent = await resolveChatContext({ id: USERS.relic2.id, email: USERS.relic2.email }, "bravo");
    assert.deepEqual(perAgent.ok ? "ok" : { status: perAgent.status, code: perAgent.code }, { status: 412, code: "agent_not_configured" });
  });
  await check("a key on the legacy row that survives the disconnect still never answers: the retired account row stands in for it", async () => {
    await login(USERS.relic);
    assert.equal((await connect({ provider: "anthropic", api_key: KEY_RELIC_NEW })).status, 200);
    // After the connect, an OpenRouter key is saved on the legacy row again
    // (the per-agent route accepts it): two workspace keys, two providers.
    const saved = await jsonOf(
      await agentConfig.POST(req("/api/agent-config", "POST", { agent_key: "bravo", provider: "openrouter", model: "anthropic/claude-sonnet-4.6", api_key: KEY_RELIC_LATER })),
    );
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    // While connected, the account answers, never the legacy row.
    const live = await slackTurn(RELIC, "relic-co", "sales", "sdr");
    assert.ok(live.ok && live.turn.apiKey === KEY_RELIC_NEW, "the legacy row answered over the account");
    const res = await jsonOf(await bulk.DELETE(req("/api/agent-config/bulk-provider?provider=anthropic&scope=tenant", "DELETE")));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    // The OpenRouter row survived (another provider)...
    assert.ok((await rows(RELIC)).some((r) => r.agent_key === "bravo" && r.key === KEY_RELIC_LATER), "the setup did not leave a legacy key behind");
    // ...and still nothing answers on it, says Connected, or sends it.
    await assertNothingAnswers(RELIC, "relic-co", USERS.relic);
  });
  await check("connecting again after a disconnect fills in the same account row", async () => {
    await login(USERS.relic2);
    assert.equal((await connect({ provider: "openrouter", api_key: KEY_RELIC2_OLD })).status, 200);
    const accounts = (await rows(RELIC2)).filter((r) => r.agent_key === account.WORKSPACE_AI_AGENT_KEY);
    assert.deepEqual(accounts.map((r) => [r.provider, r.key, r.enabled]), [["openrouter", KEY_RELIC2_OLD, 1]]);
    const turn = await slackTurn(RELIC2, "relic2-co", "sales", "sdr");
    assert.ok(turn.ok && turn.turn.apiKey === KEY_RELIC2_OLD, JSON.stringify(turn));
  });
  await check("OASIS, which has no account row, disconnects exactly as before: no account row appears, its key still answers", async () => {
    await db.execute({
      sql: "INSERT INTO agent_model_config (id, tenant_id, user_id, agent_key, provider, model, encrypted_api_key, enabled, updated_at) VALUES ('oasis-maven', ?, NULL, 'maven', 'openrouter', 'anthropic/claude-sonnet-4.6', ?, 1, ?)",
      args: [OASIS, encryptField("sk-or-v1-oasis-maven"), stamp],
    });
    await login(USERS.partner);
    const res = await jsonOf(await bulk.DELETE(req("/api/agent-config/bulk-provider?provider=openrouter&scope=tenant", "DELETE")));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.count, 1, "the disconnect's count is not the number of rows it removed");
    const left = await rows(OASIS);
    assert.ok(!left.some((r) => r.agent_key === "maven" && r.user_id === null), "the disconnected row is still there");
    assert.ok(!left.some((r) => r.agent_key === account.WORKSPACE_AI_AGENT_KEY), "a disconnect created an account row for OASIS");
    assert.equal((await account.readWorkspaceAiAccount(OASIS))?.source, "legacy");
    const turn = await slackTurn(OASIS, "oasis-ai-cc", "chief-of-staff", "bravo");
    assert.ok(turn.ok && turn.turn.apiKey === KEY_OASIS, JSON.stringify(turn));
  });

  // -- 10. A saved local model answers for the verified operator only ---------
  // Rows saved before the save-time 403 (or by any other path): LOCALCO's
  // workspace row and its owner's personal row both point at an address.
  // Nothing may call it: the provider stub records any request, and every
  // check below asserts there was none.
  const noLocalCalls = () => {
    sent = [];
    provider = () => new Response("this server must not call a saved local model address", { status: 599 });
  };
  await check("a saved local model never answers a department chat or a Slack mention, and the channel is not ready", async () => {
    noLocalCalls();
    await login(USERS.local);
    const web = await chatTurn({ agent_slug: "sdr", department: "sales" });
    assert.equal(web.status, 412, "the department chat used a saved local model");
    const slack = await slackTurn(LOCALCO, "local-co", "sales", "sdr");
    assert.deepEqual(slack.ok ? "ok" : { status: slack.status, error: slack.error }, { status: 412, error: "agent_not_configured" });
    const viewer = await viewerFor(USERS.local);
    assert.equal((await resolveChannelState(dept("sales"), viewer)).kind, "not_connected");
    assert.equal((await q.aiServicesWithKey(LOCALCO)).size, 0);
    assert.equal(sent.length, 0, `the server called ${sent.map((s) => s.url).join(", ")}`);
  });
  await check("a saved local model is refused 403 on the chat, builder, workspace editor and template-variant paths, before any request", async () => {
    noLocalCalls();
    // /api/chat, /api/chat/resume and /api/chat/compact: their shared resolver.
    const personal = await resolveChatContext({ id: USERS.local.id, email: USERS.local.email }, "bravo");
    assert.deepEqual(personal.ok ? "ok" : { status: personal.status, code: personal.code }, { status: 403, code: "local_model_not_allowed" });
    await login(USERS.local);
    for (const [label, res] of [
      ["builder", await jsonOf(await generate.POST(req("/api/agents/generate", "POST", { name: "Helper", category: "sales", description: "Answers customer questions." })))],
      ["workspace editor", await jsonOf(await manifestChat.POST(req("/api/manifest/chat", "POST", { slug: "local-co", message: "Rename the Sales tab" })))],
      [
        "template variant",
        await jsonOf(
          await solara.POST(req(`/api/gmail-templates/${LOCAL_TEMPLATE}/solara`, "POST", { guidance: "shorter" }), {
            params: Promise.resolve({ id: LOCAL_TEMPLATE }),
          }),
        ),
      ],
    ] as const) {
      assert.equal(res.status, 403, `${label}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.error, "local_model_not_allowed", label);
      assert.equal(res.body.message, account.LOCAL_MODEL_REFUSAL, label);
    }
    // Without the personal row, the workspace row is refused the same way.
    const parked = `parked-${USERS.local.id}`;
    await db.execute({ sql: "UPDATE agent_model_config SET user_id = ? WHERE tenant_id = ? AND user_id = ?", args: [parked, LOCALCO, USERS.local.id] });
    try {
      const workspaceRow = await resolveChatContext({ id: USERS.local.id, email: USERS.local.email }, "bravo");
      assert.deepEqual(workspaceRow.ok ? "ok" : { status: workspaceRow.status, code: workspaceRow.code }, { status: 403, code: "local_model_not_allowed" });
    } finally {
      await db.execute({ sql: "UPDATE agent_model_config SET user_id = ? WHERE tenant_id = ? AND user_id = ?", args: [USERS.local.id, LOCALCO, parked] });
    }
    assert.equal(sent.length, 0, `the server called ${sent.map((s) => s.url).join(", ")}`);
  });
  await check("the model call itself refuses a local model without the operator's verdict (lib/providers.ts)", async () => {
    noLocalCalls();
    const meter = modelCallMeter({ tenantId: LOCALCO, surface: "agents.chat", authKind: "local", billingMode: "local" });
    const events: Array<{ type: string; message?: string }> = [];
    for await (const ev of streamChat({ provider: "ollama", model: "llama3.3", apiKey: "", baseUrl: LOCAL_WORKSPACE_URL, messages: [{ role: "user", content: "hi" }], meter })) {
      events.push(ev as { type: string; message?: string });
    }
    assert.deepEqual(events, [{ type: "error", message: "local_model_not_allowed" }]);
    assert.equal(sent.length, 0, "the model call reached the address");
    // With the verdict, the same call is made: the flag is what decides.
    for await (const ev of streamChat({ provider: "ollama", model: "llama3.3", apiKey: "", baseUrl: "http://127.0.0.1:11434/v1", allowLocalModel: true, messages: [{ role: "user", content: "hi" }], meter })) {
      void ev;
    }
    assert.ok(sent.some((s) => s.url.startsWith("http://127.0.0.1:11434")), "the operator's local model was not called");
  });
  await check("the verified operator's verdict still lets a local model answer", async () => {
    const turn = await prepareAgentTurn({
      tenantId: LOCALCO,
      tenantSlug: "local-co",
      agentSlug: "sdr",
      department: dept("sales"),
      operator: { name: "Operator", email: USERS.cc.email },
      platformFallback: null,
      revealModel: true,
      userId: USERS.cc.id,
      localModelAllowed: true,
    });
    assert.ok(turn.ok, JSON.stringify(turn));
    if (turn.ok) {
      assert.equal(turn.turn.provider, "ollama");
      assert.equal(turn.turn.localModelAllowed, true);
    }
    // The chat resolver: the operator's own local model row answers for him.
    await db.execute({
      sql: "INSERT INTO agent_model_config (id, tenant_id, user_id, agent_key, provider, model, encrypted_api_key, enabled, updated_at) VALUES ('cc-local', ?, ?, 'bravo', 'ollama', 'llama3.3', ?, 1, ?)",
      args: [OASIS, USERS.cc.id, encryptField("http://127.0.0.1:11434/v1"), stamp],
    });
    try {
      const ctx = await resolveChatContext({ id: USERS.cc.id, email: USERS.cc.email }, "bravo");
      assert.ok(ctx.ok && ctx.provider === "ollama" && ctx.isOperator, JSON.stringify(ctx));
    } finally {
      await db.execute("DELETE FROM agent_model_config WHERE id = 'cc-local'");
    }
  });

  // -- 11. One step (PR #535, round 5) -----------------------------------------
  // A team-wide connect and a disconnect are each ONE batch: one transaction,
  // guarded on the account as the request read it (lib/ai/workspace-account.ts,
  // ONE STEP). A hook can hold the app's next write (a single statement, or a
  // whole batch) until another request, or the backfill, has run from start
  // to end: the exact moment a second tab lands. A hook can also make one
  // statement fail as it runs, the way a database that drops a write does.
  // After every case, all three places that spend a key are asked: a
  // per-agent chat, a department chat on the web and a Slack mention.
  const { getTursoClient } = await import("../lib/turso");
  type Stmt = string | { sql: string; args?: unknown[] };
  type Hook = { at: (sql: string, args: unknown[]) => boolean; times: number; run?: () => Promise<void> | void; breakIt?: boolean };
  let hooks: Hook[] = [];
  let insideHook = false;
  /** A statement that fails when it runs (an integer overflow), so the batch it is in rolls back. */
  const FAILS_WHEN_RUN = { sql: "SELECT abs(-9223372036854775807 - 1)", args: [] as unknown[] };
  const sqlOf = (s: Stmt) => (typeof s === "string" ? s : s.sql);
  const argsOf = (s: Stmt) => (typeof s === "string" ? [] : (s.args ?? []));
  async function applyHooks(list: Stmt[]): Promise<Stmt[]> {
    if (insideHook) return list;
    let out = list;
    for (const hook of hooks) {
      if (hook.times <= 0) continue;
      const hit = out.findIndex((s) => hook.at(sqlOf(s), argsOf(s)));
      if (hit < 0) continue;
      hook.times -= 1;
      if (hook.breakIt) {
        out = out.map((s, i) => (i === hit ? FAILS_WHEN_RUN : s));
        continue;
      }
      insideHook = true;
      try {
        await hook.run?.();
      } finally {
        insideHook = false;
      }
    }
    return out;
  }
  // The app's client is the cached libSQL client behind a timing proxy that
  // looks `execute` and `batch` up on the client at call time: own ones set on
  // it see every statement and batch the app runs, then hand them on to the
  // client's own. What a hook runs itself (the other tab) is not matched.
  const appClient = getTursoClient() as unknown as {
    execute: (stmt: Stmt) => Promise<unknown>;
    batch: (stmts: Stmt[], mode?: string) => Promise<unknown>;
  };
  appClient.execute = async function (this: object, stmt: Stmt) {
    const [s] = await applyHooks([stmt]);
    return (Object.getPrototypeOf(this) as { execute: (s: Stmt) => Promise<unknown> }).execute.call(this, s);
  };
  appClient.batch = async function (this: object, stmts: Stmt[], mode?: string) {
    const list = await applyHooks(stmts);
    const result = await (Object.getPrototypeOf(this) as { batch: (s: Stmt[], m?: string) => Promise<unknown> }).batch.call(this, list, mode);
    // A batch that COMMITTED and whose answer was then lost (R5-M1): the
    // write is in the database, and the caller gets an error anyway.
    const lost = lostAnswers.find((h) => h.times > 0 && list.some((s) => h.at(sqlOf(s), argsOf(s))));
    if (lost && !insideHook) {
      lost.times -= 1;
      throw new Error("the connection dropped after the commit (stand-in)");
    }
    return result;
  };
  /** Batches whose answer is lost after they commit (once each). */
  let lostAnswers: Array<{ at: Hook["at"]; times: number }> = [];
  async function withHooks<T>(added: Hook[], request: () => Promise<T>): Promise<T> {
    hooks.push(...added);
    try {
      return await request();
    } finally {
      hooks = hooks.filter((h) => !added.includes(h));
    }
  }
  /** The other request, run from start to end just before the held write (once). */
  const hold = (at: Hook["at"], other: () => Promise<void>): Hook => ({ at, times: 1, run: other });
  /** The matching statement fails as it runs (once). */
  const breakAt = (at: Hook["at"]): Hook => ({ at, times: 1, breakIt: true });
  async function interleaved<T>(request: () => Promise<T>, at: Hook["at"], other: () => Promise<void>): Promise<T> {
    let landed = false;
    const out = await withHooks(
      [
        hold(at, async () => {
          landed = true;
          await other();
        }),
      ],
      request,
    );
    assert.ok(landed, "the other request never landed inside this one");
    return out;
  }
  /** `who`'s request, run while another person's request is held (their own session). */
  const as = async <T>(who: U, request: () => Promise<T>): Promise<T> => {
    const held = sessionCookie;
    const heldUser = currentUser;
    await login(who);
    try {
      return await request();
    } finally {
      sessionCookie = held;
      currentUser = heldUser;
    }
  };
  const has = (args: unknown[], ...values: string[]) => values.every((v) => args.includes(v));
  /** A team-wide connect's one step (its teammate rows, or its account row). */
  const connectStep = (tenant: string) => (sql: string, args: unknown[]) =>
    has(args, tenant) && (sql.includes("ON CONFLICT (tenant_id, agent_key)") || sql.includes("enabled = 1, updated_at") || sql.includes("SELECT ?, NULL, ?, ?, ?, ?, 1, ?"));
  /** The account row's own write in a connect's one step (an account already on file). */
  const accountWrite = (tenant: string) => (sql: string, args: unknown[]) => has(args, tenant) && sql.includes("enabled = 1, updated_at");
  /** A team-wide disconnect's one step, and the retire inside it. */
  const disconnectStep = (tenant: string) => (sql: string, args: unknown[]) => has(args, tenant) && sql.startsWith("SELECT 1 AS held");
  const retireWrite = (tenant: string) => (sql: string, args: unknown[]) => has(args, tenant) && sql.startsWith("UPDATE agent_model_config SET enabled = 0");
  /** The read of the account a connect or disconnect is guarded on. */
  const stampRead = (tenant: string) => (sql: string, args: unknown[]) =>
    has(args, tenant) && sql.startsWith("SELECT provider, model, encrypted_api_key, enabled FROM agent_model_config");
  /** A person's own save ("Just me"), one step. */
  const personalStep = (tenant: string, userId: string) => (sql: string, args: unknown[]) =>
    has(args, tenant, userId) && sql.includes("ON CONFLICT (tenant_id, user_id, agent_key)");
  const disconnect = async (prov: string, scope: "tenant" | "user" = "tenant") =>
    jsonOf(await bulk.DELETE(req(`/api/agent-config/bulk-provider?provider=${prov}&scope=${scope}`, "DELETE")));
  /** The backfill's insert-only statement exactly as Bravo runs it, held to one workspace here. */
  const backfill = (tenant: string) =>
    db.execute({
      sql: `INSERT INTO agent_model_config (tenant_id, user_id, agent_key, provider, model, encrypted_api_key, enabled)
            SELECT b.tenant_id, NULL, '__workspace__', b.provider, b.model, b.encrypted_api_key, b.enabled
            FROM agent_model_config b
            WHERE b.agent_key = 'bravo' AND b.user_id IS NULL AND b.encrypted_api_key IS NOT NULL
              AND b.tenant_id NOT IN ('ef8d389e-3f15-43f2-ae00-3660f69a1452', '42423fde-be8b-454f-932a-750e8c9b743d')
              AND NOT EXISTS (SELECT 1 FROM agent_model_config w
                              WHERE w.tenant_id = b.tenant_id AND w.agent_key = '__workspace__' AND w.user_id IS NULL)
              AND b.tenant_id = ?`,
      args: [tenant],
    });
  const keysOn = async (tenant: string) => (await rows(tenant)).filter((r) => r.key !== null).map((r) => `${r.agent_key}/${r.user_id === null ? "team" : "own"}:${r.key}`);
  /** One teammate's team row, with its own prompt (null: no such row). */
  const teamRow = async (tenant: string, agentKey: string) => {
    const found = await db.execute({
      sql: "SELECT provider, encrypted_api_key, system_prompt_override, enabled FROM agent_model_config WHERE tenant_id = ? AND agent_key = ? AND user_id IS NULL",
      args: [tenant, agentKey],
    });
    const r = found.rows[0];
    return r
      ? {
          provider: String(r.provider),
          key: r.encrypted_api_key === null ? null : decryptField(String(r.encrypted_api_key)),
          prompt: r.system_prompt_override === null ? null : String(r.system_prompt_override),
          enabled: Number(r.enabled),
        }
      : null;
  };
  /** What a per-agent chat with this teammate would do (/api/chat's resolver). */
  const perAgentChat = async (who: U, agentKey: string) => {
    const ctx = await resolveChatContext({ id: who.id, email: who.email }, agentKey);
    return ctx.ok ? `answers with ${ctx.apiKey}` : { status: ctx.status, code: ctx.code };
  };
  /** All three places that spend the key: a per-agent chat, a department chat (web) and a Slack mention. */
  const spending = async (tenant: string, slug: string, owner: U, agentKey = "sdr") => {
    const perAgent = await perAgentChat(owner, agentKey);
    await login(owner);
    sent = [];
    provider = answering("ok");
    const web = await chatTurn({ agent_slug: "sdr", department: "sales" });
    await web.text();
    const department = web.status === 200 && sent[0] ? `answers with ${keyOf(sent[0])}` : web.status;
    const slack = await slackTurn(tenant, slug, "sales", "sdr");
    return { perAgent, department, slack: slack.ok ? `answers with ${slack.turn.apiKey}` : slack.status };
  };
  const answersWith = (key: string) => ({ perAgent: `answers with ${key}`, department: `answers with ${key}`, slack: `answers with ${key}` });
  const nothingAnswers = { perAgent: { status: 412, code: "agent_not_configured" }, department: 412, slack: 412 };
  const PLAIN = /^[A-Z][^_]*[.]$/;

  await check("a disconnect in another tab lands before a connect's one step: the connect changes nothing, says so, and nothing answers", async () => {
    await login(USERS.race);
    assert.equal((await connect({ provider: "anthropic", api_key: KEY_RACE[0] })).status, 200);
    // The owner had moved Client Success onto its own OpenRouter key, with a
    // prompt of its own.
    await db.execute({
      sql: "UPDATE agent_model_config SET provider = 'openrouter', model = 'anthropic/claude-sonnet-4.6', encrypted_api_key = ?, system_prompt_override = ? WHERE tenant_id = ? AND agent_key = 'customer-support' AND user_id IS NULL",
      args: [encryptField(KEY_RACE_OWN), FRENCH, RACE],
    });
    let other = null as Awaited<ReturnType<typeof disconnect>> | null;
    const res = await interleaved(
      () => connect({ provider: "anthropic", api_key: KEY_RACE[1] }),
      connectStep(RACE),
      async () => {
        other = await disconnect("anthropic");
      },
    );
    assert.equal(other!.status, 200, JSON.stringify(other!.body));
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.error, "conflict");
    assert.match(String(res.body.message), PLAIN);
    // Nothing of the connect landed. The disconnect took every Anthropic row;
    // Client Success, on its own OpenRouter key, is untouched by either.
    assert.deepEqual(await keysOn(RACE), [`customer-support/team:${KEY_RACE_OWN}`]);
    assert.deepEqual(await teamRow(RACE, "customer-support"), { provider: "openrouter", key: KEY_RACE_OWN, prompt: FRENCH, enabled: 1 });
    assert.deepEqual(await spending(RACE, "race-co", USERS.race), nothingAnswers);
    // Its own key is KEPT, and spends nothing: since 2026-10-09 a per-agent
    // chat answers on the workspace AI account only (lib/chat-auth.ts), and
    // with no account nothing answers.
    assert.deepEqual(await perAgentChat(USERS.race, "customer-support"), { status: 412, code: "agent_not_configured" });
  });
  await check("a connect in another tab lands before a disconnect's one step: the disconnect changes nothing, says so, and the new key answers everywhere", async () => {
    await login(USERS.race);
    assert.equal((await connect({ provider: "anthropic", api_key: KEY_RACE[2] })).status, 200);
    let other = null as Awaited<ReturnType<typeof connect>> | null;
    const res = await interleaved(
      () => disconnect("anthropic"),
      disconnectStep(RACE),
      async () => {
        other = await connect({ provider: "anthropic", api_key: KEY_RACE[3] });
      },
    );
    assert.equal(other!.status, 200, JSON.stringify(other!.body));
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.error, "conflict");
    assert.match(String(res.body.message), PLAIN);
    assert.deepEqual(await spending(RACE, "race-co", USERS.race), answersWith(KEY_RACE[3]));
    assert.deepEqual(await teamRow(RACE, "customer-support"), { provider: "anthropic", key: KEY_RACE[3], prompt: FRENCH, enabled: 1 });
  });
  await check("two tabs connect different keys at once: the first one's key is saved whole, the second changes nothing and says so", async () => {
    await login(USERS.prompt);
    assert.equal((await connect({ provider: "anthropic", api_key: KEY_PROMPT[0] })).status, 200);
    await db.execute({
      sql: "UPDATE agent_model_config SET system_prompt_override = ? WHERE tenant_id = ? AND agent_key = 'sdr' AND user_id IS NULL",
      args: [FRENCH, PROMPTCO],
    });
    let first = null as Awaited<ReturnType<typeof connect>> | null;
    const second = await interleaved(
      () => connect({ provider: "anthropic", api_key: KEY_PROMPT[1] }),
      connectStep(PROMPTCO),
      async () => {
        first = await connect({ provider: "anthropic", api_key: KEY_PROMPT[2] });
      },
    );
    assert.equal(first!.status, 200, JSON.stringify(first!.body));
    assert.deepEqual(first!.body.applied_to, ["sdr", "customer-support"]);
    assert.equal(second.status, 409, JSON.stringify(second.body));
    assert.equal(second.body.error, "conflict");
    assert.match(String(second.body.message), PLAIN);
    assert.deepEqual(await keysOn(PROMPTCO), [
      `__workspace__/team:${KEY_PROMPT[2]}`,
      `customer-support/team:${KEY_PROMPT[2]}`,
      `sdr/team:${KEY_PROMPT[2]}`,
    ]);
    assert.equal((await teamRow(PROMPTCO, "sdr"))?.prompt, FRENCH, "the owner's custom prompt was lost");
    assert.deepEqual(await spending(PROMPTCO, "prompt-co", USERS.prompt), answersWith(KEY_PROMPT[2]));
  });
  await check("the same key in two tabs at once: both are saved, nothing is lost, and it answers everywhere", async () => {
    await login(USERS.prompt);
    let first = null as Awaited<ReturnType<typeof connect>> | null;
    const second = await interleaved(
      () => connect({ provider: "anthropic", api_key: KEY_PROMPT[3] }),
      connectStep(PROMPTCO),
      async () => {
        first = await connect({ provider: "anthropic", api_key: KEY_PROMPT[3] });
      },
    );
    assert.equal(first!.status, 200, JSON.stringify(first!.body));
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.deepEqual(await keysOn(PROMPTCO), [
      `__workspace__/team:${KEY_PROMPT[3]}`,
      `customer-support/team:${KEY_PROMPT[3]}`,
      `sdr/team:${KEY_PROMPT[3]}`,
    ]);
    assert.equal((await teamRow(PROMPTCO, "sdr"))?.prompt, FRENCH, "the owner's custom prompt was lost");
    assert.deepEqual(await spending(PROMPTCO, "prompt-co", USERS.prompt), answersWith(KEY_PROMPT[3]));
  });
  await check("a connect for some teammates only lands inside another tab's connect: the first one's key stands whole", async () => {
    await login(USERS.prompt);
    let some = null as Awaited<ReturnType<typeof connect>> | null;
    const all = await interleaved(
      () => connect({ provider: "anthropic", api_key: KEY_PROMPT[4] }),
      connectStep(PROMPTCO),
      async () => {
        some = await connect({ provider: "anthropic", api_key: KEY_PROMPT[5], agent_keys: ["sdr"] });
      },
    );
    assert.equal(some!.status, 200, JSON.stringify(some!.body));
    // It named the Sales lead; Client Success moved with the team's key (R5-M3, below).
    assert.deepEqual(some!.body.applied_to, ["sdr", "customer-support"]);
    assert.equal(all.status, 409, JSON.stringify(all.body));
    // The Sales-lead-only connect is the account; nothing of the other landed.
    // Client Success held the team's PREVIOUS key (the account's), so it moved
    // with the team even though that connect named only the Sales lead (PR
    // #535 review, R5-M3: it used to keep the old key, unseen on any card).
    assert.deepEqual(await keysOn(PROMPTCO), [
      `__workspace__/team:${KEY_PROMPT[5]}`,
      `customer-support/team:${KEY_PROMPT[5]}`,
      `sdr/team:${KEY_PROMPT[5]}`,
    ]);
    assert.deepEqual(await spending(PROMPTCO, "prompt-co", USERS.prompt), answersWith(KEY_PROMPT[5]));
  });
  await check("a connect whose one step fails part way changes nothing at all", async () => {
    await login(USERS.prompt);
    const before = await keysOn(PROMPTCO);
    // The account row, the last write of the step, fails as it runs.
    const res = await withHooks([breakAt(accountWrite(PROMPTCO))], () => connect({ provider: "anthropic", api_key: KEY_PROMPT[6] }));
    assert.equal(res.status, 500, JSON.stringify(res.body));
    assert.equal(res.body.message, "The key couldn't be saved just now. Nothing was changed. Try again in a moment.");
    assert.deepEqual(await keysOn(PROMPTCO), before, "part of the failed connect was saved");
    assert.deepEqual(await spending(PROMPTCO, "prompt-co", USERS.prompt), answersWith(KEY_PROMPT[5]));
  });
  await check("a disconnect whose one step fails part way changes nothing at all", async () => {
    await login(USERS.prompt);
    const before = await keysOn(PROMPTCO);
    const res = await withHooks([breakAt(retireWrite(PROMPTCO))], () => disconnect("anthropic"));
    assert.equal(res.status, 500, JSON.stringify(res.body));
    assert.equal(res.body.message, "The AI account couldn't be disconnected just now. Nothing was changed. Try again in a moment.");
    assert.deepEqual(await keysOn(PROMPTCO), before, "part of the failed disconnect was applied");
    assert.deepEqual(await spending(PROMPTCO, "prompt-co", USERS.prompt), answersWith(KEY_PROMPT[5]));
  });
  await check("a teammate the owner switched off stays off after a connect, and only its key changes", async () => {
    await login(USERS.prompt);
    await db.execute({
      sql: "UPDATE agent_model_config SET enabled = 0 WHERE tenant_id = ? AND agent_key = 'customer-support' AND user_id IS NULL",
      args: [PROMPTCO],
    });
    assert.equal((await connect({ provider: "anthropic", api_key: KEY_PROMPT[7] })).status, 200);
    assert.deepEqual(await teamRow(PROMPTCO, "customer-support"), { provider: "anthropic", key: KEY_PROMPT[7], prompt: null, enabled: 0 });
    assert.deepEqual(await perAgentChat(USERS.prompt, "customer-support"), { status: 403, code: "agent_disabled" });
    assert.deepEqual(await spending(PROMPTCO, "prompt-co", USERS.prompt), answersWith(KEY_PROMPT[7]));
  });
  await check("a save whose answer never came back: the card asks the server, and says exactly what was saved", async () => {
    await login(USERS.look);
    // The save lands on the server, but its answer never reaches the browser.
    // (The read that follows arrives after the save finished, as a later
    // request does.)
    let saving: Promise<unknown> = Promise.resolve();
    const answerLost = async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      if (url === "/api/agent-config/test-connection") return testConnection.POST(req(url, "POST", body));
      if (body.verify === true) {
        await saving;
        return bulk.POST(req(url, "POST", body));
      }
      saving = bulk.POST(req(url, "POST", body));
      await saving;
      return new Promise<Response>(() => undefined);
    };
    provider = answering("ok");
    const landed = await settlesWithin(
      8000,
      "the connect after a lost answer",
      connectProviderKey({ provider: "anthropic", apiKey: KEY_LOOK[0], model: "claude-sonnet-4-6", scope: "tenant", timeoutMs: 1500 }, answerLost),
    );
    assert.deepEqual(landed, { kind: "saved" }, "a save that landed was reported as failed");
    assert.deepEqual(await spending(LOOKCO, "look-co", USERS.look), answersWith(KEY_LOOK[0]));
    // This time the save never reaches the server at all.
    const neverArrived = async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      if (url === "/api/agent-config/test-connection") return testConnection.POST(req(url, "POST", body));
      if (body.verify === true) return bulk.POST(req(url, "POST", body));
      return new Promise<Response>(() => undefined);
    };
    const lost = await settlesWithin(
      8000,
      "the connect whose save never arrived",
      connectProviderKey({ provider: "anthropic", apiKey: KEY_LOOK[1], model: "claude-sonnet-4-6", scope: "tenant", timeoutMs: 1500 }, neverArrived),
    );
    // Not saved when asked; the abandoned save could still land, so the
    // dialog says what it saw and where to look, never that it failed.
    assert.deepEqual(lost, {
      kind: "failed",
      message: "The key wasn't saved when we checked. Close this, look at the card in a moment, and connect again if it doesn't show it.",
    });
    assert.deepEqual(await spending(LOOKCO, "look-co", USERS.look), answersWith(KEY_LOOK[0]));
    // Sending the same connect again is harmless: the same key, saved again.
    assert.equal((await connect({ provider: "anthropic", api_key: KEY_LOOK[0] })).status, 200);
    assert.equal((await connect({ provider: "anthropic", api_key: KEY_LOOK[0] })).status, 200);
    assert.deepEqual(await keysOn(LOOKCO), [`__workspace__/team:${KEY_LOOK[0]}`, `sdr/team:${KEY_LOOK[0]}`]);
  });
  await check("the backfill landing before a disconnect's one step: the disconnect changes nothing, and done again, nothing answers", async () => {
    // Before: the legacy row answers (no account row yet).
    const before = await slackTurn(BACKFILL_ONE, "backfill-one", "sales", "sdr");
    assert.ok(before.ok && before.turn.apiKey === KEY_BACKFILL_ONE, "the legacy row did not answer");
    await login(USERS.backfillOne);
    let copied = -1;
    const res = await interleaved(
      () => disconnect("anthropic"),
      disconnectStep(BACKFILL_ONE),
      async () => {
        copied = (await backfill(BACKFILL_ONE)).rowsAffected;
      },
    );
    assert.equal(copied, 1, "the backfill did not copy the legacy row: the case was not exercised");
    assert.equal(res.status, 409, JSON.stringify(res.body));
    // The disconnect again, now that the account row is there: nothing answers.
    assert.equal((await disconnect("anthropic")).status, 200);
    assert.deepEqual(await keysOn(BACKFILL_ONE), [], "the legacy key survived the disconnect");
    assert.deepEqual(await spending(BACKFILL_ONE, "backfill-one", USERS.backfillOne), nothingAnswers);
    await assertNothingAnswers(BACKFILL_ONE, "backfill-one", USERS.backfillOne);
  });
  await check("the backfill landing before a connect's one step: the connect changes nothing, and done again, the new key is the account", async () => {
    await login(USERS.backfillTwo);
    let copied = -1;
    const res = await interleaved(
      () => connect({ provider: "anthropic", api_key: KEY_BACKFILL_TWO_NEW }),
      connectStep(BACKFILL_TWO),
      async () => {
        copied = (await backfill(BACKFILL_TWO)).rowsAffected;
      },
    );
    assert.equal(copied, 1, "the backfill did not copy the legacy row: the case was not exercised");
    assert.equal(res.status, 409, JSON.stringify(res.body));
    // The backfill's copy of the legacy key is the account until the connect runs again.
    assert.equal((await slackTurn(BACKFILL_TWO, "backfill-two", "sales", "sdr")).ok, true);
    assert.equal((await connect({ provider: "anthropic", api_key: KEY_BACKFILL_TWO_NEW })).status, 200);
    const acct = await account.readWorkspaceAiAccount(BACKFILL_TWO);
    assert.deepEqual([acct?.source, acct?.provider], ["workspace", "anthropic"]);
    assert.ok(!(await keysOn(BACKFILL_TWO)).some((k) => k.endsWith(KEY_BACKFILL_TWO_OLD)), "the old key is still on a row");
    assert.deepEqual(await spending(BACKFILL_TWO, "backfill-two", USERS.backfillTwo), answersWith(KEY_BACKFILL_TWO_NEW));
    assert.equal((await backfill(BACKFILL_TWO)).rowsAffected, 0, "a second backfill copied the legacy row over the account");
  });
  await check("a member's own key and the owner's team account never touch each other, each landing inside the other's step", async () => {
    await login(USERS.team);
    assert.equal((await connect({ provider: "anthropic", api_key: KEY_TEAM })).status, 200);
    // The member has a key for their own chats and replaces it; the owner's
    // disconnect lands just before the member's one step.
    await login(USERS.teamRep);
    assert.equal((await connect({ provider: "anthropic", api_key: KEY_TEAM_REP_OWN, scope: "user" })).status, 200);
    let ownerOff = null as Awaited<ReturnType<typeof disconnect>> | null;
    const mine = await interleaved(
      () => connect({ provider: "anthropic", api_key: KEY_TEAM_REP_NEW, scope: "user" }),
      personalStep(TEAMCO, USERS.teamRep.id),
      async () => {
        ownerOff = await as(USERS.team, () => disconnect("anthropic"));
      },
    );
    assert.equal(ownerOff!.status, 200, JSON.stringify(ownerOff!.body));
    assert.equal(mine.status, 200, JSON.stringify(mine.body));
    assert.deepEqual(await keysOn(TEAMCO), [`sdr/own:${KEY_TEAM_REP_NEW}`], "the owner's disconnect took the member's own key, or left the team's");
    // And an owner's disconnect with the member's own key already on file
    // leaves it alone (the save above would put back a row it had taken).
    assert.equal((await as(USERS.team, () => disconnect("anthropic"))).status, 200);
    assert.deepEqual(await keysOn(TEAMCO), [`sdr/own:${KEY_TEAM_REP_NEW}`], "the owner's disconnect took the member's own key");
    assert.equal(await perAgentChat(USERS.teamRep, "sdr"), `answers with ${KEY_TEAM_REP_NEW}`, "the member's own chat lost their key");
    assert.deepEqual(await spending(TEAMCO, "team-co", USERS.team), nothingAnswers);
    // The owner connects again; the member's removal of their own key lands
    // just before the owner's one step.
    let removed = null as Awaited<ReturnType<typeof disconnect>> | null;
    const ownerOn = await as(USERS.team, () =>
      interleaved(
        () => connect({ provider: "anthropic", api_key: KEY_TEAM_AGAIN }),
        connectStep(TEAMCO),
        async () => {
          removed = await as(USERS.teamRep, () => disconnect("anthropic", "user"));
        },
      ),
    );
    assert.equal(removed!.status, 200, JSON.stringify(removed!.body));
    assert.equal(ownerOn.status, 200, JSON.stringify(ownerOn.body));
    assert.deepEqual(await keysOn(TEAMCO), [`__workspace__/team:${KEY_TEAM_AGAIN}`, `sdr/team:${KEY_TEAM_AGAIN}`], "the member's removal took the team's key, or kept their own");
    assert.deepEqual(await spending(TEAMCO, "team-co", USERS.team), answersWith(KEY_TEAM_AGAIN));
  });
  // Every way a disconnect can fail, collected from the real route, then
  // pressed on the real card (the render helper, second run).
  const disconnectReplies: Array<{ label: string; status: number; body: Record<string, unknown> | null }> = [];
  await check("every way a disconnect can fail answers one plain sentence, never a code or the database's words", async () => {
    await login(USERS.code);
    assert.equal((await connect({ provider: "anthropic", api_key: KEY_CODE[0] })).status, 200);
    const collect = async (label: string, request: () => Promise<{ status: number; body: Record<string, unknown> }>) => {
      const r = await request();
      disconnectReplies.push({ label, status: r.status, body: r.body });
    };
    const before = await keysOn(CODECO);
    await collect("its one step fails", () => withHooks([breakAt(retireWrite(CODECO))], () => disconnect("anthropic")));
    await collect("the account cannot be read", () => withHooks([breakAt(stampRead(CODECO))], () => disconnect("anthropic")));
    assert.deepEqual(await keysOn(CODECO), before, "a failed disconnect changed something");
    await collect("another window changed the account", () =>
      withHooks(
        [
          hold(disconnectStep(CODECO), async () => {
            await connect({ provider: "anthropic", api_key: KEY_CODE[1] });
          }),
        ],
        () => disconnect("anthropic"),
      ),
    );
    assert.deepEqual(await spending(CODECO, "code-co", USERS.code), answersWith(KEY_CODE[1]));
    await login(USERS.codeRep);
    await collect("not an owner", () => disconnect("anthropic"));
    await login(null);
    await collect("signed out", () => disconnect("anthropic"));
    assert.deepEqual(
      disconnectReplies.map((r) => [r.label, r.status]),
      [
        ["its one step fails", 500],
        ["the account cannot be read", 500],
        ["another window changed the account", 409],
        ["not an owner", 403],
        ["signed out", 401],
      ],
    );
    for (const r of disconnectReplies) {
      assert.equal(r.body?.ok, false, r.label);
      const message = String(r.body?.message ?? "");
      assert.match(message, PLAIN, `${r.label}: not one plain sentence: ${message}`);
      assert.doesNotMatch(message, /SQLITE|overflow|database|http/i, `${r.label}: ${message}`);
    }
    // And a request that never reached the server, for the card's own sentence.
    disconnectReplies.push({ label: "never reached the server", status: 0, body: null });
  });
  await check("outside the Turso data backend the readers use, a one-step write fails closed before writing anything", async () => {
    const before = await keysOn(PROMPTCO);
    const backend = process.env.EMPIRE_DATA_BACKEND;
    process.env.EMPIRE_DATA_BACKEND = "supabase_legacy";
    try {
      await assert.rejects(account.readAccountStamp(PROMPTCO), /Turso data backend/);
      await assert.rejects(
        account.connectWorkspaceAccountInOneStep({
          tenantId: PROMPTCO,
          stamp: { present: false },
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          encryptedApiKey: encryptField("sk-ant-never-written-0500"),
          agentKeys: ["sdr"],
        }),
        /Turso data backend/,
      );
      await assert.rejects(account.disconnectWorkspaceAccountInOneStep({ tenantId: PROMPTCO, stamp: { present: false }, provider: "anthropic" }), /Turso data backend/);
    } finally {
      process.env.EMPIRE_DATA_BACKEND = backend;
    }
    assert.deepEqual(await keysOn(PROMPTCO), before, "a write went through outside the Turso data backend");
  });
  await check("closing the connect dialog has the cards read the server again", () => {
    assert.equal(html.closeRefreshes, "1", "the card did not read the server again when the dialog closed");
  });
  await check("R5-M2: the card's own changes last only until the server's next answer, so it never contradicts the server", () => {
    assert.deepEqual(JSON.parse(html.overlay ?? "{}"), {
      anthropicBeforeAnswer: true, // flipped at once, before the refresh lands
      anthropicAnswered: true,
      bothBeforeAnswer: [true, true],
      afterOpenRouterAnswer: [false, true], // the server says OpenRouter only: Anthropic is Not connected
      header: true, // "Cloud: 1 provider connected"
      disconnectedBeforeAnswer: false,
      newerAnswerSaysConnected: true, // a stale "disconnected" never covers a live key
      afterDiscardedRender: true, // a render React threw away never takes a click's change with it
    });
  });
  await check("Settings says what each saved model is doing, from the same registry the calls use", () => {
    const notes = Object.fromEntries(
      Object.entries(JSON.parse(html.notes ?? "{}") as Record<string, string>).map(([k, v]) => [k, v.replace(/&#x27;|&#39;/g, "'")]),
    );
    assert.equal(notes.gone, "Google no longer offers Gemini 2.5 Pro to new accounts; this agent now uses Gemini 3.8 Flash.");
    assert.equal(notes.current, "", "a current model got a note");
    assert.match(notes.unknown, /^anthropic\/claude-sonnet-4 is not on our list of OpenRouter models, so we can't say whether OpenRouter still offers it\./);
    assert.equal(
      notes.account,
      "Saved model: Gemini 2.5 Pro . Google no longer offers Gemini 2.5 Pro to new accounts; your departments now use Gemini 3.8 Flash.",
    );
    assert.equal(notes.accountCurrent, "Your departments use Gemini 3.8 Flash .");
    assert.equal(notes.accountUnread, "", "a model line was drawn from an account nobody read");
    assert.equal(notes.accountOff, "", "a model line was drawn for an account that is not connected");
  });
  await check("the card shows only that sentence, and draws itself again from the server after a failed disconnect", () => {
    assert.ok(disconnectReplies.length > 1, "no replies were collected");
    const testReplies = [
      { label: "refused without a sentence", status: 403, body: { ok: false, error: "forbidden" } },
      { label: "never reached the server", status: 0, body: null },
      { label: "refused with a sentence", status: 400, body: { ok: false, status: "error", code: "provider_401", message: "Your AI account refused the request. Check its billing or key." } },
    ];
    const pressed = renderHelper({ DRIVE_FAILURES: JSON.stringify({ disconnects: disconnectReplies, tests: testReplies }) }) as {
      disconnects: Array<Record<string, unknown>>;
      tests: Array<Record<string, unknown>>;
    };
    assert.equal(pressed.disconnects.length, disconnectReplies.length);
    for (const d of pressed.disconnects) {
      const reply = disconnectReplies.find((r) => r.label === d.label);
      const expected = reply?.body ? reply.body.message : "The AI account couldn't be disconnected just now. Try again in a moment.";
      assert.equal(d.connectedFirst, true, `${d.label}: the card was not Connected before the disconnect`);
      assert.equal(d.shown, expected, `${d.label}: the card showed something else`);
      assert.equal(d.title, null, `${d.label}: the error carries a tooltip`);
      assert.equal(d.refreshed, 1, `${d.label}: the card did not read the server again`);
      assert.equal(d.connectedAfter, false, `${d.label}: the card kept its own Connected over the server's answer`);
    }
    assert.deepEqual(
      pressed.tests.map((t) => [t.label, t.title]),
      [
        ["refused without a sentence", "The key couldn't be tested just now. Try again in a moment."],
        ["never reached the server", "The key couldn't be tested just now. Try again in a moment."],
        ["refused with a sentence", "Your AI account refused the request. Check its billing or key."],
      ],
    );
  });

  // -- 12. The model registry, and the #535 follow-ups --------------------------
  // lib/ai/model-registry.ts on every channel; the PR #535 review's R5-M1
  // (a failed answer after a commit), R5-M3 (a teammate left on the old key)
  // and R5-L3 (the route tests the key itself). R5-M2 is the render below.
  const GONECO = "d2d2d2d2-0000-4000-8000-0000000000d2";
  const MOVECO = "d3d3d3d3-0000-4000-8000-0000000000d3";
  const LOSTCO = "d5d5d5d5-0000-4000-8000-0000000000d5";
  const PROVECO = "d6d6d6d6-0000-4000-8000-0000000000d6";
  const MORE = {
    gone: u(21, "owner@gone.test"),
    move: u(22, "owner@move.test"),
    moveAdmin: u(23, "admin@move.test"),
    lost: u(24, "owner@lost.test"),
    prove: u(25, "owner@prove.test"),
    proveRep: u(26, "rep@prove.test"),
    goneRep: u(28, "rep@gone.test"),
  } as const;
  const KEY_GONE = "AIza-gone-workspace-key-0600";
  const KEY_MOVE_ANT = "sk-ant-move-team-key-0601";
  const KEY_MOVE_OR = "sk-or-v1-move-team-key-0602";
  const KEY_MOVE_OWN = "sk-ant-move-outreach-own-0603";
  const KEY_LOST = ["sk-ant-lost-first-0604", "sk-ant-lost-second-0605", "sk-ant-lost-third-0606", "sk-ant-lost-own-0607"] as const;
  const KEY_PROVE = ["sk-ant-prove-refused-0608", "sk-ant-prove-down-0609", "sk-ant-prove-good-0610"] as const;
  await db.batch(
    [
      ...Object.values(MORE).map((x) => ({ sql: `INSERT INTO "_supabase_auth_users" (id, email) VALUES (?, ?)`, args: [x.id, x.email] })),
      ...workspace(GONECO, "gone-co", "Gone Co"),
      ...workspace(MOVECO, "move-co", "Move Co"),
      ...workspace(LOSTCO, "lost-co", "Lost Co"),
      ...workspace(PROVECO, "prove-co", "Prove Co"),
      profile("p-gone", MORE.gone, GONECO, "owner", 1, ["sdr"]),
      // A sales rep of the same workspace: not an owner or admin, so not one who can pick another model.
      profile("p-gone-rep", MORE.goneRep, GONECO, "closer", 0, ["sdr"]),
      // R5-M3's two admins: their teammate lists differ (agents_enabled is per person).
      profile("p-move", MORE.move, MOVECO, "owner", 1, ["sdr", "customer-support"]),
      { ...profile("p-move-admin", MORE.moveAdmin, MOVECO, "admin", 0, ["sdr"]) },
      profile("p-lost", MORE.lost, LOSTCO, "owner", 1, ["sdr"]),
      profile("p-prove", MORE.prove, PROVECO, "owner", 1, ["sdr"]),
      profile("p-prove-rep", MORE.proveRep, PROVECO, "closer", 0, ["sdr"]),
      // GONECO's account was saved on Google's gemini-2.5-pro, the model
      // Google now serves only to projects that used it before.
      configRow(GONECO, null, account.WORKSPACE_AI_AGENT_KEY, "google", "gemini-2.5-pro", KEY_GONE),
    ],
    "write",
  );
  await db.execute({ sql: "UPDATE user_profiles SET admin_access = 1 WHERE id = 'p-move-admin'", args: [] });
  const googleOk = (text: string) =>
    new Response(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }], usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 2 } })}\n\n`, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });

  await check("a department turn on a saved model Google no longer offers to new accounts sends Gemini 3.8 Flash, same key, and the ledger says why", async () => {
    const slack = await slackTurn(GONECO, "gone-co", "sales", "sdr");
    assert.ok(slack.ok, JSON.stringify(slack));
    if (!slack.ok) return;
    assert.deepEqual([slack.turn.provider, slack.turn.model, slack.turn.apiKey], ["google", "gemini-3.8-flash", KEY_GONE]);
    assert.equal(slack.turn.swap?.savedModel, "gemini-2.5-pro");
    await login(MORE.gone);
    sent = [];
    provider = () => googleOk("Pipeline is moving.");
    const events = parseSse(await (await chatTurn({ agent_slug: "sdr", department: "sales" })).text());
    assert.deepEqual(events.map((e) => e.event), ["agent", "delta", "usage", "done"], JSON.stringify(events));
    assert.equal(sent.length, 1);
    assert.match(sent[0].url, /\/models\/gemini-3\.8-flash:streamGenerateContent/, "the gone model was sent");
    assert.equal(keyOf(sent[0]), KEY_GONE, "another key was sent");
    const usageRows = await db.execute({
      sql: "SELECT provider, model, fallback_reason, outcome FROM ai_usage_events WHERE tenant_id = ? AND surface = 'agents.chat' ORDER BY id",
      args: [GONECO],
    });
    assert.deepEqual(
      usageRows.rows.map((r) => [r.provider, r.model, r.fallback_reason, r.outcome]),
      [["google", "gemini-3.8-flash", "model_access_limited:gemini-2.5-pro", "ok"]],
    );
    // What Settings tells the owner, from the same registry the call used.
    const listed = await jsonOf(await agentConfig.GET(req("/api/agent-config", "GET")));
    assert.deepEqual(listed.body.account, { provider: "google", model: "gemini-2.5-pro", connected: true });
    assert.equal(
      registry.modelNote("google", String((listed.body.account as { model: string }).model), { audience: "departments" })?.sentence,
      "Google no longer offers Gemini 2.5 Pro to new accounts; your departments now use Gemini 3.8 Flash.",
    );
  });
  await check("a model the provider says was not found is named to whoever can pick another (an owner or admin), and to nobody else", async () => {
    await db.execute({ sql: "UPDATE agent_model_config SET model = 'gemini-9-nope' WHERE tenant_id = ? AND agent_key = ?", args: [GONECO, account.WORKSPACE_AI_AGENT_KEY] });
    try {
      await login(MORE.gone);
      sent = [];
      provider = () => new Response('{"error":{"code":404,"message":"models/gemini-9-nope is not found for API version v1beta","status":"NOT_FOUND"}}', { status: 404 });
      const events = parseSse(await (await chatTurn({ agent_slug: "sdr", department: "sales" })).text());
      const err = events.find((e) => e.event === "error");
      assert.equal(err?.data.code, "provider_404", JSON.stringify(events));
      assert.equal(
        err?.data.message,
        "The AI model gemini-9-nope was not found: Google has retired it or does not offer it to this AI account. Pick another model in AI settings, such as Gemini 3.8 Flash. An owner or admin can fix this in Settings.",
      );
      assert.deepEqual(err?.data.model, { label: "gemini-9-nope", vendor: "Google", suggestion: "Gemini 3.8 Flash" });
      assert.doesNotMatch(JSON.stringify(err?.data), /NOT_FOUND|v1beta/, "the provider's own words reached the channel");
      // A sales rep of the same workspace cannot change the model: the plain
      // sentence, and no model id anywhere in the event (PR #555 review: the
      // route keeps the model id from anyone it is not for).
      await login(MORE.goneRep);
      sent = [];
      const repEvents = parseSse(await (await chatTurn({ agent_slug: "sdr", department: "sales" })).text());
      const repErr = repEvents.find((e) => e.event === "error");
      assert.equal(sent.length, 1, "the rep's turn never reached the provider");
      assert.equal(repErr?.data.code, "provider_404", JSON.stringify(repEvents));
      assert.equal(
        repErr?.data.message,
        "The AI model this channel uses was not found: the provider has retired it or does not offer it to this AI account. Pick another model in AI settings. An owner or admin can fix this in Settings.",
      );
      assert.equal(repErr?.data.model, undefined, "the model was named to a rep");
      assert.doesNotMatch(JSON.stringify(repEvents), /gemini-9-nope/, "the model id reached a rep");
    } finally {
      await db.execute({ sql: "UPDATE agent_model_config SET model = 'gemini-2.5-pro' WHERE tenant_id = ? AND agent_key = ?", args: [GONECO, account.WORKSPACE_AI_AGENT_KEY] });
    }
  });
  await check("Settings can never save a model the registry knows is gone, and lists a saved value as itself", async () => {
    await login(MORE.gone);
    const before = await keysOn(GONECO);
    const refused = await jsonOf(await agentConfig.POST(req("/api/agent-config", "POST", { agent_key: "sdr", provider: "google", model: "gemini-2.5-pro", api_key: "AIza-new-row-key-0611" })));
    assert.equal(refused.status, 400, JSON.stringify(refused.body));
    assert.deepEqual(refused.body, {
      ok: false,
      error: "model_not_offered",
      message: "Google no longer offers Gemini 2.5 Pro to new accounts. Pick Gemini 3.8 Flash or another listed model.",
    });
    const ending = await jsonOf(await agentConfig.POST(req("/api/agent-config", "POST", { agent_key: "sdr", provider: "openrouter", model: "google/gemini-2.5-pro", api_key: "sk-or-v1-new-row-0612" })));
    assert.equal(ending.status, 400, "a model OpenRouter removes in 12 days was saved");
    assert.deepEqual(await keysOn(GONECO), before, "a refused save wrote a row");
    // A model the registry does not know is the owner's call (OpenRouter has hundreds).
    const unknownModel = await jsonOf(await agentConfig.POST(req("/api/agent-config", "POST", { agent_key: "sdr", provider: "openrouter", model: "some-vendor/new-model", api_key: "sk-or-v1-new-row-0613" })));
    assert.equal(unknownModel.status, 200, JSON.stringify(unknownModel.body));
    await db.execute({ sql: "DELETE FROM agent_model_config WHERE tenant_id = ? AND agent_key = 'sdr'", args: [GONECO] });
    // A row ALREADY on a gone model keeps it through an edit that does not
    // change it (CodeRabbit on #555): nothing is put back, and its calls
    // already send the replacement. Changing to another gone model is refused.
    await db.execute({
      sql: "INSERT INTO agent_model_config (tenant_id, user_id, agent_key, provider, model, encrypted_api_key, enabled, updated_at) VALUES (?, NULL, 'sdr', 'google', 'gemini-2.5-pro', ?, 1, ?)",
      args: [GONECO, encryptField("AIza-sdr-row-0620"), stamp],
    });
    try {
      const switchedOff = await jsonOf(await agentConfig.POST(req("/api/agent-config", "POST", { agent_key: "sdr", provider: "google", model: "gemini-2.5-pro", enabled: false })));
      assert.equal(switchedOff.status, 200, `an edit of a row on a gone model was refused: ${JSON.stringify(switchedOff.body)}`);
      const rekeyed = await jsonOf(await agentConfig.POST(req("/api/agent-config", "POST", { agent_key: "sdr", provider: "google", model: "gemini-2.5-pro", api_key: "AIza-sdr-new-0621" })));
      assert.equal(rekeyed.status, 200, JSON.stringify(rekeyed.body));
      const toAnotherGone = await jsonOf(await agentConfig.POST(req("/api/agent-config", "POST", { agent_key: "sdr", provider: "google", model: "gemini-2.5-flash" })));
      assert.equal(toAnotherGone.status, 400, "a change to another gone model was saved");
      const saved = (await rows(GONECO)).find((r) => r.agent_key === "sdr");
      assert.deepEqual([saved?.model, saved?.key, saved?.enabled], ["gemini-2.5-pro", "AIza-sdr-new-0621", 1]);
    } finally {
      await db.execute({ sql: "DELETE FROM agent_model_config WHERE tenant_id = ? AND agent_key = 'sdr'", args: [GONECO] });
    }
    // The connect route too: a gone model is refused before any key is tested.
    sent = [];
    const connectGone = await connect({ provider: "google", api_key: "AIza-connect-0614", model: "gemini-2.5-flash" });
    assert.equal(connectGone.status, 400);
    assert.equal(connectGone.body.message, "Google no longer offers Gemini 2.5 Flash to new accounts. Pick Gemini 3.5 Flash-Lite or another listed model.");
    assert.equal(sent.length, 0);
    // And a model whose tool calls do not work through this app (OpenAI's GPT-6
    // on Chat Completions), by a hand-built request: it would pass a key test
    // and then fail every tool-using chat (PR #555 review).
    const beforeGpt6 = await keysOn(GONECO);
    const connectGpt6 = await connect({ provider: "openai", api_key: "sk-proj-connect-0622", model: "gpt-6.1-sol" });
    assert.equal(connectGpt6.status, 400, JSON.stringify(connectGpt6.body));
    assert.equal(connectGpt6.body.error, "model_not_offered");
    const rowGpt6 = await jsonOf(await agentConfig.POST(req("/api/agent-config", "POST", { agent_key: "sdr", provider: "openai", model: "gpt-6-luna", api_key: "sk-proj-row-0623" })));
    assert.equal(rowGpt6.status, 400, JSON.stringify(rowGpt6.body));
    assert.equal(rowGpt6.body.error, "model_not_offered");
    assert.equal(sent.length, 0, "a key was tested on a model that cannot be saved");
    assert.deepEqual(await keysOn(GONECO), beforeGpt6, "a refused save wrote a row");
    // The per-agent picker lists the saved value as itself, first, then the offered models.
    const { rowModelOptions } = await import("../components/settings/AgentConfigEditor");
    const options = rowModelOptions("google", "gemini-2.5-pro");
    assert.deepEqual(options[0], { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro (saved, no longer offered)", offered: false });
    assert.ok(options.slice(1).every((o) => registry.modelInfo("google", o.id)?.offered), "a gone model is offered");
    assert.equal(rowModelOptions("google", "gemini-3.8-flash").filter((o) => o.id === "gemini-3.8-flash").length, 1);
    assert.deepEqual(rowModelOptions("ollama", "qwen3:8b")[0], { id: "qwen3:8b", label: "qwen3:8b (saved)" });
  });

  await check("R5-M3: a connect moves every teammate still on the account's previous key; a teammate's own key stays", async () => {
    await login(MORE.move);
    assert.equal((await connect({ provider: "anthropic", api_key: KEY_MOVE_ANT })).status, 200);
    // A teammate the owner gave its OWN key (a per-agent override).
    await db.execute({
      sql: `INSERT INTO agent_model_config (tenant_id, user_id, agent_key, provider, model, encrypted_api_key, enabled, updated_at)
            VALUES (?, NULL, 'outreach', 'anthropic', 'claude-sonnet-4-6', ?, 1, ?)`,
      args: [MOVECO, encryptField(KEY_MOVE_OWN), stamp],
    });
    assert.deepEqual((await keysOn(MOVECO)).sort(), [
      `${account.WORKSPACE_AI_AGENT_KEY}/team:${KEY_MOVE_ANT}`,
      `customer-support/team:${KEY_MOVE_ANT}`,
      `outreach/team:${KEY_MOVE_OWN}`,
      `sdr/team:${KEY_MOVE_ANT}`,
    ]);
    // The second admin's own teammate list is only the Sales lead.
    await login(MORE.moveAdmin);
    const moved = await connect({ provider: "openrouter", api_key: KEY_MOVE_OR });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.deepEqual((moved.body.applied_to as string[]).sort(), ["customer-support", "sdr"], "the moved teammate is not reported");
    const after = await rows(MOVECO);
    assert.deepEqual(
      after.filter((r) => r.key !== null).map((r) => `${r.agent_key}:${r.provider}:${r.key}`).sort(),
      [
        `${account.WORKSPACE_AI_AGENT_KEY}:openrouter:${KEY_MOVE_OR}`,
        `customer-support:openrouter:${KEY_MOVE_OR}`,
        `outreach:anthropic:${KEY_MOVE_OWN}`,
        `sdr:openrouter:${KEY_MOVE_OR}`,
      ],
    );
    assert.ok(!after.some((r) => r.key === KEY_MOVE_ANT), "the replaced Anthropic key is still stored on a teammate");
    // The teammate's per-agent chat answers on the team's account now, not a key no card shows.
    assert.equal(await perAgentChat(MORE.move, "customer-support"), `answers with ${KEY_MOVE_OR}`);
    // The teammate's own key stays stored, and no longer spends: its chat
    // answers on the team's account like every other (2026-10-09, one source).
    assert.equal(await perAgentChat(MORE.move, "outreach"), `answers with ${KEY_MOVE_OR}`);
  });
  await check("R5-M3 on a workspace with only the legacy row: teammates on the legacy row's key move with it", async () => {
    const LEGACY2 = "d7d7d7d7-0000-4000-8000-0000000000d7";
    const owner = u(27, "owner@legacy2.test");
    const oldCipher = encryptField("sk-or-v1-legacy2-old-0615");
    await db.batch(
      [
        { sql: `INSERT INTO "_supabase_auth_users" (id, email) VALUES (?, ?)`, args: [owner.id, owner.email] },
        ...workspace(LEGACY2, "legacy2-co", "Legacy Two"),
        profile("p-legacy2", owner, LEGACY2, "owner", 1, ["sdr"]),
        // One old connect wrote ONE ciphertext to the legacy row and a teammate.
        { sql: "INSERT INTO agent_model_config (tenant_id, user_id, agent_key, provider, model, encrypted_api_key, enabled, updated_at) VALUES (?, NULL, 'bravo', 'openrouter', 'anthropic/claude-sonnet-4.6', ?, 1, ?)", args: [LEGACY2, oldCipher, stamp] },
        { sql: "INSERT INTO agent_model_config (tenant_id, user_id, agent_key, provider, model, encrypted_api_key, enabled, updated_at) VALUES (?, NULL, 'customer-support', 'openrouter', 'anthropic/claude-sonnet-4.6', ?, 1, ?)", args: [LEGACY2, oldCipher, stamp] },
      ],
      "write",
    );
    await login(owner);
    const res = await connect({ provider: "anthropic", api_key: "sk-ant-legacy2-new-0616" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(
      (await rows(LEGACY2)).map((r) => `${r.agent_key}:${r.provider}:${r.key}`).sort(),
      [
        `${account.WORKSPACE_AI_AGENT_KEY}:anthropic:sk-ant-legacy2-new-0616`,
        "bravo:anthropic:sk-ant-legacy2-new-0616",
        "customer-support:anthropic:sk-ant-legacy2-new-0616",
        "sdr:anthropic:sk-ant-legacy2-new-0616",
      ],
    );
  });
  await check("a connect whose account changed after it was read moves nothing: not a teammate still on the old key, not the legacy row", async () => {
    // The race (PR #555 review; #535 review R5-L2): the one-time model update
    // (scripts/update-saved-models.ts --apply) moves the account, a teammate
    // and the legacy row off a gone model, KEEPING their keys, after a connect
    // read the account and before its one step runs. The connect's read is
    // stale, so none of it may land. The teammate still holds the account's
    // previous key, so only the account guard stops the team move from putting
    // it on the new key while the account stays on the old one.
    const GUARDCO = "d8d8d8d8-0000-4000-8000-0000000000d8";
    const owner = u(29, "owner@guard.test");
    const teamCipher = encryptField("AIza-guard-team-0630");
    const legacyCipher = encryptField("AIza-guard-legacy-0631");
    const row = (agentKey: string, cipher: string) => ({
      sql: "INSERT INTO agent_model_config (tenant_id, user_id, agent_key, provider, model, encrypted_api_key, enabled, updated_at) VALUES (?, NULL, ?, 'google', 'gemini-2.5-pro', ?, 1, ?)",
      args: [GUARDCO, agentKey, cipher, stamp],
    });
    await db.batch(
      [
        { sql: `INSERT INTO "_supabase_auth_users" (id, email) VALUES (?, ?)`, args: [owner.id, owner.email] },
        ...workspace(GUARDCO, "guard-co", "Guard Co"),
        profile("p-guard", owner, GUARDCO, "owner", 1, ["sdr"]),
        row(account.WORKSPACE_AI_AGENT_KEY, teamCipher),
        row("customer-support", teamCipher),
        row("bravo", legacyCipher),
      ],
      "write",
    );
    await login(owner);
    const res = await interleaved(
      () => connect({ provider: "anthropic", api_key: "sk-ant-guard-new-0632" }),
      connectStep(GUARDCO),
      async () => {
        await db.execute({
          sql: "UPDATE agent_model_config SET model = 'gemini-3.8-flash', updated_at = ? WHERE tenant_id = ? AND user_id IS NULL AND provider = 'google' AND model = 'gemini-2.5-pro'",
          args: [new Date().toISOString(), GUARDCO],
        });
      },
    );
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.deepEqual(
      (await rows(GUARDCO)).map((r) => `${r.agent_key}:${r.provider}:${r.model}:${r.key}`).sort(),
      [
        `${account.WORKSPACE_AI_AGENT_KEY}:google:gemini-3.8-flash:AIza-guard-team-0630`,
        "bravo:google:gemini-3.8-flash:AIza-guard-legacy-0631",
        "customer-support:google:gemini-3.8-flash:AIza-guard-team-0630",
      ],
      "a statement of the stale connect landed",
    );
  });

  await check("R5-M1: a connect whose batch commits and then loses its answer is told as saved, never 'Nothing was changed'", async () => {
    await login(MORE.lost);
    const lose = { at: connectStep(LOSTCO), times: 1 };
    lostAnswers = [lose];
    let res: Awaited<ReturnType<typeof connect>>;
    try {
      res = await connect({ provider: "anthropic", api_key: KEY_LOST[0] });
    } finally {
      lostAnswers = [];
    }
    assert.equal(lose.times, 0, "the batch's answer was never lost: the step proved nothing");
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.ok, true);
    assert.deepEqual(await spending(LOSTCO, "lost-co", MORE.lost), answersWith(KEY_LOST[0]));
    // A batch that really failed (rolled back): "Nothing was changed" is true, and said.
    await login(MORE.lost);
    const failedRes = await withHooks([breakAt(accountWrite(LOSTCO))], () => connect({ provider: "anthropic", api_key: KEY_LOST[1] }));
    assert.equal(failedRes.status, 500);
    assert.equal(failedRes.body.message, "The key couldn't be saved just now. Nothing was changed. Try again in a moment.");
    assert.deepEqual(await spending(LOSTCO, "lost-co", MORE.lost), answersWith(KEY_LOST[0]));
    // The answer is lost AND the read-back fails: it says it could not tell.
    await login(MORE.lost);
    let reads = 0;
    lostAnswers = [{ at: connectStep(LOSTCO), times: 1 }];
    let unknown: Awaited<ReturnType<typeof connect>>;
    try {
      unknown = await withHooks(
        [{ at: (sql, args) => stampRead(LOSTCO)(sql, args) && ++reads === 2, times: 1, breakIt: true }],
        () => connect({ provider: "anthropic", api_key: KEY_LOST[2] }),
      );
    } finally {
      lostAnswers = [];
    }
    assert.equal(unknown.status, 503, JSON.stringify(unknown.body));
    assert.equal(unknown.body.message, "We couldn't check whether the key was saved. Close this and look at the card in a moment.");
    // A personal save whose answer is lost, read back the same way.
    await login(MORE.lost);
    lostAnswers = [{ at: personalStep(LOSTCO, MORE.lost.id), times: 1 }];
    let personal: Awaited<ReturnType<typeof connect>>;
    try {
      personal = await connect({ provider: "anthropic", api_key: KEY_LOST[3], scope: "user" });
    } finally {
      lostAnswers = [];
    }
    assert.equal(personal.status, 200, JSON.stringify(personal.body));
  });
  await check("R5-M1: the dialog reads back after a server failure or a page that is not the route's answer, not only after a throw", async () => {
    const ok = new Response(JSON.stringify({ ok: true, tested: "v1.passed.1.x" }), { status: 200 });
    const run = async (saveAnswer: () => Response, verifyAnswer: Record<string, unknown> | null) => {
      const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
      const result = await connectProviderKey({ provider: "anthropic", apiKey: "sk-ant-dialog-0617", model: "claude-sonnet-5-5", scope: "tenant" }, async (url, init) => {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        calls.push({ url, body });
        if (url.endsWith("/test-connection")) return ok.clone();
        if (body.verify === true) {
          if (!verifyAnswer) throw new Error("the read never arrived");
          return new Response(JSON.stringify(verifyAnswer), { status: 200 });
        }
        return saveAnswer();
      });
      return { result, verified: calls.filter((c) => c.body.verify === true).length, saveBody: calls.find((c) => c.url.endsWith("/bulk-provider"))?.body };
    };
    // The Worker stopped after the commit: the platform answered with an HTML page.
    const html502 = await run(() => new Response("<html>502 Bad Gateway</html>", { status: 502 }), { ok: true, saved: true });
    assert.deepEqual([html502.result, html502.verified], [{ kind: "saved" }, 1]);
    // The route's own 500 after it read back "not saved".
    const json500 = await run(() => new Response(JSON.stringify({ ok: false, message: "The key couldn't be saved just now. Nothing was changed. Try again in a moment." }), { status: 500 }), { ok: true, saved: false });
    assert.deepEqual([json500.result, json500.verified], [{ kind: "failed", message: "The key wasn't saved when we checked. Close this, look at the card in a moment, and connect again if it doesn't show it." }, 1]);
    // The read itself fails: it says it could not tell.
    const noRead = await run(() => new Response("", { status: 503 }), null);
    assert.deepEqual(noRead.result, { kind: "failed", message: "We couldn't check whether the key was saved. Close this and look at the card in a moment." });
    // A refusal the route ANSWERED (a 409, a 403) is not read back: it is the answer.
    const conflict = await run(() => new Response(JSON.stringify({ ok: false, error: "conflict", message: "The AI account was changed in another window while this key saved, so nothing was changed. Check the card, then connect again if you still want this key." }), { status: 409 }), { ok: true, saved: true });
    assert.equal(conflict.verified, 0);
    assert.equal(conflict.result.kind, "failed");
    // The test's proof goes with the save (R5-L3: the route does not test it twice).
    assert.equal(html502.saveBody?.tested, "v1.passed.1.x");
  });

  await check("R5-L3: the save route tests the key itself; a refused key is never saved, and 'Save anyway' needs a down provider", async () => {
    await login(MORE.prove);
    // No proof, and the provider refuses the key: nothing saved, the test's own sentence.
    sent = [];
    provider = () => new Response(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }), { status: 401 });
    const refused = await connectUntested({ provider: "anthropic", api_key: KEY_PROVE[0] });
    assert.equal(refused.status, 422, JSON.stringify(refused.body));
    assert.deepEqual([refused.body.error, refused.body.code, refused.body.message, refused.body.can_save_anyway], [
      "key_refused",
      "provider_401",
      "Your AI account refused the request. Check its billing or key.",
      false,
    ]);
    assert.equal(sent.length, 1, "the route did not test the key");
    assert.equal(keyOf(sent[0]), KEY_PROVE[0]);
    assert.equal(sent[0].body?.model, registry.defaultModelFor("anthropic"), "the key was tested on another model than it would be saved with");
    assert.deepEqual(await keysOn(PROVECO), [], "a refused key was saved");
    // The provider is down: not saved unless the request says save_anyway.
    provider = () => new Response("upstream", { status: 503 });
    const down = await connectUntested({ provider: "anthropic", api_key: KEY_PROVE[1] });
    assert.equal(down.status, 422);
    assert.equal(down.body.can_save_anyway, true);
    assert.equal(typeof down.body.tested, "string", "no proof came back for Save anyway");
    assert.deepEqual(await keysOn(PROVECO), []);
    // Save anyway with the proof the down test returned: saved without testing again.
    sent = [];
    const anyway = await connectUntested({ provider: "anthropic", api_key: KEY_PROVE[1], tested: down.body.tested, save_anyway: true });
    assert.equal(anyway.status, 200, JSON.stringify(anyway.body));
    assert.equal(sent.length, 0, "a down provider's proof was tested again");
    // A "down" proof without save_anyway is not enough.
    sent = [];
    provider = () => new Response(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }), { status: 401 });
    const notAnyway = await connectUntested({ provider: "anthropic", api_key: KEY_PROVE[1], tested: down.body.tested });
    assert.equal(notAnyway.status, 422);
    assert.equal(sent.length, 1);
    // A proof only speaks for exactly what was tested: another key, model or person is tested again.
    const { signConnectTest: sign } = await import("../lib/ai/connect-test-proof");
    const subject = { tenantId: PROVECO, userId: MORE.prove.id, provider: "anthropic", model: registry.defaultModelFor("anthropic"), apiKey: KEY_PROVE[2] };
    for (const [label, proof] of [
      ["another key", sign({ ...subject, apiKey: "sk-ant-someone-else-0618" }, "passed")],
      ["another model", sign({ ...subject, model: "claude-opus-5-5" }, "passed")],
      ["another person", sign({ ...subject, userId: MORE.proveRep.id }, "passed")],
      ["another workspace", sign({ ...subject, tenantId: LOSTCO }, "passed")],
      ["an expired test", sign(subject, "passed", Date.now() - 11 * 60_000)],
      ["a forged one", `v1.passed.${Date.now() + 60_000}.AAAA`],
    ] as const) {
      sent = [];
      const r = await connectUntested({ provider: "anthropic", api_key: KEY_PROVE[2], tested: proof });
      assert.equal(r.status, 422, `${label}: saved untested`);
      assert.equal(sent.length, 1, `${label}: the route did not test the key`);
    }
    // The real proof for exactly this test: saved, with no second test.
    sent = [];
    const good = await connectUntested({ provider: "anthropic", api_key: KEY_PROVE[2], tested: sign(subject, "passed") });
    assert.equal(good.status, 200, JSON.stringify(good.body));
    assert.equal(sent.length, 0, "a key with a proof of its test was tested again");
    assert.deepEqual(await spending(PROVECO, "prove-co", MORE.prove), answersWith(KEY_PROVE[2]));
    // And test-connection is what signs it, for the pasted key and its model only.
    await login(MORE.prove);
    provider = answering("ok");
    const tested = await testKey({ provider: "anthropic", api_key: "sk-ant-pasted-0619", model: "claude-haiku-5-5" });
    assert.equal(tested.body.ok, true);
    assert.equal(typeof tested.body.tested, "string");
    const unnamed = await testKey({ provider: "anthropic", api_key: "sk-ant-pasted-0619" });
    assert.equal(unnamed.body.tested, undefined, "a key tested on no named model got a proof for one");
  });

  console.log(`ai-workspace-account: ${failures === 0 ? "OK" : `${failures} FAILED`}`);
  finished = true;
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
