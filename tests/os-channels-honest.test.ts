/**
 * os-channels-honest.test.ts — a department channel tells the truth about
 * itself (OASIS OS plan v2 §F1.2).
 *
 * WHY. /team/<dept> renders a channel (components/agents/AgentChat.tsx ->
 * POST /api/agents/chat). Before this:
 *   - READINESS lied. The verified operator read "ready" with no key at all,
 *     anyone else only needed a row with ciphertext, and a teammate's PERSONAL
 *     key counted as the workspace's. A key the provider refused (drained
 *     balance: 400; no OpenRouter credits: 402) still read Working, forever.
 *   - The Settings "Test" button listed models, which spends nothing, so it
 *     proved nothing: OpenRouter answers GET /models with 200 for a bad key.
 *   - Errors were raw provider JSON under an empty reply bubble, the model id
 *     was shown to clients, Enter made a newline, and nothing was logged.
 *   - NAMES: the stream's `agent` event, the identity lock, the 412 hint and
 *     the AI Team roster carried the house agents' personal names.
 *   - SECURITY: the route took `tenant_slug` from the request body, checked
 *     only that it existed, and loaded THAT workspace's manifest into the
 *     caller's prompt. Its `.maybeSingle()` profile read also broke for anyone
 *     seated in two workspaces.
 *
 * Everything below runs for real against a local libSQL file: the real signed
 * session cookie, the real Turso adapter, the real route handlers, the real
 * channel resolver and roster. next/headers and next/navigation are the only
 * stand-ins (as in tests/admin-surfaces-operator-only.test.ts), and the
 * provider is a stubbed global fetch that records what it was sent.
 *
 * Run: node --conditions=react-server --import tsx tests/os-channels-honest.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as ReactNS from "react";
import { createClient } from "@libsql/client";

const dbFile = join(mkdtempSync(join(tmpdir(), "os-channels-honest-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
process.env.EMPIRE_AUTH_BACKEND = "turso";
process.env.AUTH_SESSION_SECRET = "os-channels-honest-secret-long-enough-000000001";
process.env.BRAVO_FIELD_ENCRYPTION_KEY = "os-channels-honest-field-key-long-enough-00001";
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

// tsconfig.json sets jsx:"preserve", so tsx compiles page JSX with the classic
// runtime, which expects a global React (same as tests/delivery-pages.test.ts).
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
// next/link loads the browser router context; the page only needs an anchor.
stub("next/link", {
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children?: unknown }) =>
    ReactNS.createElement("a", { href, ...rest }, children as ReactNS.ReactNode),
});

const OASIS ="ef8d389e-3f15-43f2-ae00-3660f69a1452";
const CLIENT = "6b6b6b6b-0000-4000-8000-00000000006b";
type U = { id: string; email: string };
const u = (n: number, email: string): U => ({ id: `0f000000-0000-4000-8000-${String(n).padStart(12, "0")}`, email });
const USERS = {
  cc: u(1, "conaugh@oasisai.work"), // the hardcoded operator alias + OASIS owner: the verified operator
  partner: u(2, "partner@oasisai.work"), // OASIS owner, NOT an alias: a founder, not the operator
  client: u(3, "owner@client.test"), // owner of a client workspace
  multi: u(4, "multi@client.test"), // seated in two workspaces: an old OASIS rep seat, a current client owner seat
} as const;

const WORKSPACE_KEY = "sk-ant-workspace-key-0001";
const PERSONAL_KEY = "sk-ant-personal-key-0002";
const USER_TEXT = "PRIVATE-QUESTION-DO-NOT-LOG about the Hendricks renewal";

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
    console.log(`  FAIL  ${name}\n        ${(e as Error).message.split("\n").slice(0, 6).join("\n        ")}`);
  }
}

// ── provider stub ────────────────────────────────────────────────────────
type Sent = { url: string; method: string; headers: Record<string, string>; body: Record<string, unknown> | null };
let sent: Sent[] = [];
let provider: (s: Sent) => Response = () => new Response("unset", { status: 599 });
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

const ANTHROPIC_CREDIT = JSON.stringify({
  type: "error",
  error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." },
});
const anthropicCredit = () => new Response(ANTHROPIC_CREDIT, { status: 400, headers: { "content-type": "application/json" } });
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

// ── console.error capture (the route's failure log) ──────────────────────
const logged: unknown[][] = [];
const realError = console.error;
console.error = (...args: unknown[]) => {
  logged.push(args);
};
const failureLogs = () => logged.filter((a) => a[0] === "[agents.chat.failure]").map((a) => a[1] as Record<string, unknown>);

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
      onboarding_completed_at TEXT, full_name TEXT, display_name TEXT, agents_enabled TEXT, updated_at TEXT,
      deactivated_at TEXT);
    CREATE TABLE tenants (id TEXT PRIMARY KEY, slug TEXT, name TEXT, custom_fields TEXT);
    CREATE TABLE tenant_manifests (id TEXT PRIMARY KEY, tenant_id TEXT, slug TEXT, manifest TEXT,
      version INTEGER, schema_version INTEGER, created_at TEXT, updated_at TEXT);
    CREATE TABLE agents (slug TEXT PRIMARY KEY, name TEXT, category TEXT, short_description TEXT, description TEXT,
      base_prompt TEXT, required_tools TEXT, suggested_model TEXT, pricing TEXT, is_public INTEGER,
      is_oasis_managed INTEGER, created_by TEXT, tenant_id TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE agent_model_config (id TEXT PRIMARY KEY, tenant_id TEXT, user_id TEXT, agent_key TEXT,
      provider TEXT, model TEXT, encrypted_api_key TEXT, enabled INTEGER, updated_at TEXT);
  `);
  const { encryptField } = await import("../lib/field-encryption");
  const stamp = "2026-09-01T00:00:00Z";
  const profile = (id: string, user: U, tenant: string, role: string, owner: 0 | 1, updated: string) => ({
    sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, onboarding_completed_at, full_name, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'Test Person', ?)`,
    args: [id, user.id, user.email, tenant, role, owner, stamp, updated],
  });
  await db.batch(
    [
      ...Object.values(USERS).map((x) => ({ sql: `INSERT INTO "_supabase_auth_users" (id, email) VALUES (?, ?)`, args: [x.id, x.email] })),
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'oasis-ai-cc', 'OASIS AI')", args: [OASIS] },
      // "suga" is a seed manifest slug, so the client workspace needs no stored manifest row.
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'suga', 'Client Co')", args: [CLIENT] },
      profile("p-cc", USERS.cc, OASIS, "owner", 1, stamp),
      profile("p-partner", USERS.partner, OASIS, "owner", 1, stamp),
      profile("p-client", USERS.client, CLIENT, "owner", 1, stamp),
      // Two seats: the newer owner seat in the client workspace is the active one.
      profile("p-multi-oasis", USERS.multi, OASIS, "opener", 0, "2026-08-01T00:00:00Z"),
      profile("p-multi-client", USERS.multi, CLIENT, "owner", 1, "2026-09-20T00:00:00Z"),
      // OASIS: the workspace key, and a teammate's PERSONAL key for the same agent.
      {
        sql: `INSERT INTO agent_model_config (id, tenant_id, user_id, agent_key, provider, model, encrypted_api_key, enabled, updated_at)
              VALUES ('c-oasis', ?, NULL, 'bravo', 'anthropic', 'claude-sonnet-4-6', ?, 1, ?)`,
        args: [OASIS, encryptField(WORKSPACE_KEY), stamp],
      },
      {
        sql: `INSERT INTO agent_model_config (id, tenant_id, user_id, agent_key, provider, model, encrypted_api_key, enabled, updated_at)
              VALUES ('c-oasis-personal', ?, ?, 'bravo', 'anthropic', 'claude-sonnet-4-6', ?, 1, ?)`,
        args: [OASIS, USERS.partner.id, encryptField(PERSONAL_KEY), stamp],
      },
      // The client has ONLY a teammate's personal key: not a workspace key.
      {
        sql: `INSERT INTO agent_model_config (id, tenant_id, user_id, agent_key, provider, model, encrypted_api_key, enabled, updated_at)
              VALUES ('c-client-personal', ?, ?, 'bravo', 'anthropic', 'claude-sonnet-4-6', ?, 1, ?)`,
        args: [CLIENT, USERS.client.id, encryptField(PERSONAL_KEY), stamp],
      },
    ],
    "write",
  );

  const chat = await import("../app/api/agents/chat/route");
  const testConnection = await import("../app/api/agent-config/test-connection/route");
  const { NextRequest } = await import("next/server");
  const { resolveOsViewer } = await import("../components/os/department/viewer");
  const { resolveChannelState } = await import("../components/os/department/channel");
  const { statusFor, withLastTurn } = await import("../components/os/department/StatusPill");
  const { loadAiTeam } = await import("../components/os/aiteam/roster");
  const { departmentBySlug, OS_DEPARTMENTS } = await import("../lib/os/departments");
  const { departmentChannelFor, suggestedAsksFor } = await import("../components/os/department/config");
  const outcome = await import("../lib/os/channel/outcome");
  const identity = await import("../lib/os/channel/identity");
  const { probeProvider } = await import("../lib/agents/provider-probe");
  const { getSeedAgent } = await import("../lib/agents/library");

  const post = (body: Record<string, unknown>) =>
    chat.POST(
      new NextRequest("http://localhost/api/agents/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  const say = (over: Record<string, unknown>) => ({ messages: [{ role: "user", content: USER_TEXT }], ...over });
  const outcomes = async (tenant: string) =>
    (await db.execute({ sql: "SELECT channel_key, outcome, code FROM agent_turn_outcomes WHERE tenant_id = ? ORDER BY channel_key", args: [tenant] })).rows.map(
      (r) => `${r.channel_key}=${r.outcome}${r.code ? `:${r.code}` : ""}`,
    );
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
  // Every client-rendered string this suite sees, for the name scan at the end.
  const rendered: string[] = [];

  console.log("os-channels-honest:");

  // ── 0. One code per failure, read the way the providers write them ──────
  await check("every provider error shape reduces to one code", () => {
    const cases: Array<[string, string]> = [
      [`anthropic_400:${ANTHROPIC_CREDIT}`, "provider_400_credit"],
      ['openrouter_402:{"error":{"message":"Insufficient credits"}}', "provider_402"],
      ['openai_401:{"error":{"message":"Incorrect API key provided"}}', "provider_401"],
      ['google_400:{"error":{"message":"API key not valid. Please pass a valid API key."}}', "provider_401"],
      ['anthropic_404:{"error":{"message":"model: claude-nope"}}', "provider_404"],
      ['openai_400:{"error":{"message":"Unsupported parameter"}}', "provider_400"],
      ["provider_temporarily_unavailable:openai_429", "provider_429"],
      ["provider_temporarily_unavailable:anthropic_529", "provider_5xx"],
      ["local_model_temporarily_unavailable:503", "provider_5xx"],
      ["missing_api_key", "agent_not_configured"],
      ["something nobody wrote down", "provider_error"],
    ];
    for (const [msg, want] of cases) assert.equal(outcome.classifyStreamError(msg), want, msg);
  });
  await check("the last turn: the account's newest verdict speaks for every channel; a channel's own failure is its own", () => {
    const t = (channelKey: string, ok: boolean, code: string | null, at: string) => ({ channelKey, ok, code, at });
    const f = outcome.channelFailure;
    // Billing refused in Sales: Marketing (which never tried) fails the same way.
    assert.deepEqual(f([t("dept:sales", false, "provider_402", "2026-09-29T10:00:00Z")], "dept:marketing"), { code: "provider_402" });
    // ...until a newer success anywhere on the account.
    assert.equal(f([t("dept:sales", false, "provider_402", "2026-09-29T10:00:00Z"), t("dept:marketing", true, null, "2026-09-29T11:00:00Z")], "dept:sales"), null);
    // An older success does not clear a newer refusal.
    assert.deepEqual(f([t("dept:marketing", true, null, "2026-09-29T09:00:00Z"), t("dept:sales", false, "provider_401", "2026-09-29T10:00:00Z")], "dept:marketing"), { code: "provider_401" });
    // A channel's own failure (a model the provider does not know) is not cleared by another channel.
    assert.deepEqual(f([t("dept:sales", false, "provider_404", "2026-09-29T10:00:00Z"), t("dept:marketing", true, null, "2026-09-29T11:00:00Z")], "dept:sales"), { code: "provider_404" });
    assert.equal(f([t("dept:sales", false, "provider_404", "2026-09-29T10:00:00Z")], "dept:marketing"), null);
    // An unknown code is a failure, never "Working".
    assert.deepEqual(f([t("dept:sales", false, "from_a_newer_build", "2026-09-29T10:00:00Z")], "dept:sales"), { code: "from_a_newer_build" });
    assert.equal(f([], "dept:sales"), null);
  });
  await check("a turn older than the one on record does not overwrite it", async () => {
    await db.executeMultiple(readFileSync(join(process.cwd(), "database/turso/bravo__190_agent_turn_outcomes.sql"), "utf8"));
    const { recordTurnOutcome } = await import("../lib/os/channel/turns");
    const base = { tenantId: "t-race", channelKey: "dept:sales", agentSlug: "sdr" };
    await recordTurnOutcome(db, { ...base, ok: true, code: null, at: "2026-09-29T12:00:00Z" });
    await recordTurnOutcome(db, { ...base, ok: false, code: "provider_402", at: "2026-09-29T11:00:00Z" });
    assert.deepEqual(await outcomes("t-race"), ["dept:sales=ok"]);
    await recordTurnOutcome(db, { ...base, ok: false, code: "provider_402", at: "2026-09-29T13:00:00Z" });
    assert.deepEqual(await outcomes("t-race"), ["dept:sales=failed:provider_402"]);
    await db.executeMultiple("DROP TRIGGER agent_turn_outcomes_tenant_immutable; DROP TABLE agent_turn_outcomes;");
  });

  // ── 1. The workspace comes from the session ─────────────────────────────
  await check("a body slug the caller does not own is refused 403 before anything loads", async () => {
    await login(USERS.client);
    sent = [];
    for (const slug of ["oasis-ai-cc", "sun"]) {
      const res = await post(say({ tenant_slug: slug, agent_slug: "sdr", department: "sales" }));
      assert.equal(res.status, 403, slug);
      assert.equal(((await res.json()) as { error: string }).error, "slug_not_owned");
    }
    assert.equal(sent.length, 0, "no provider call for a refused workspace");
  });
  await check("no body slug: the workspace is the session's own (and the table's absence is tolerated)", async () => {
    await login(USERS.client);
    const res = await post(say({ agent_slug: "sdr", department: "sales" }));
    // The client has only a PERSONAL key, which never answers a shared channel.
    assert.equal(res.status, 412);
    const body = (await res.json()) as { error: string; hint: string };
    assert.equal(body.error, "agent_not_configured");
    rendered.push(body.hint);
    assert.ok(
      logged.some((a) => String(a[0]).includes("agent_turn_outcomes is missing")),
      "a missing outcomes table is logged, not thrown",
    );
  });
  // The migration, applied as written (it is what the lead will run).
  await db.executeMultiple(readFileSync(join(process.cwd(), "database/turso/bravo__190_agent_turn_outcomes.sql"), "utf8"));
  await check("a person seated in two workspaces chats in their ACTIVE one", async () => {
    await login(USERS.multi);
    const res = await post(say({ agent_slug: "sdr", department: "sales" }));
    // Not 403 no_tenant (what .maybeSingle() over two seats produced).
    assert.equal(res.status, 412);
    assert.deepEqual(await outcomes(CLIENT), ["dept:sales=failed:agent_not_configured"], "recorded in the active workspace");
    assert.deepEqual(await outcomes(OASIS), [], "never in the other seat's workspace");
  });
  await check("a department label is only pinned on the agent that workspace binds to it", async () => {
    await login(USERS.client);
    for (const [department, agent, want] of [
      ["sales", "bravo", "department_agent_mismatch"],
      ["chief_of_staff", "bravo", "department_agent_mismatch"],
      ["legal", "sdr", "unknown_department"],
    ] as const) {
      const res = await post(say({ agent_slug: agent, department }));
      assert.equal(res.status, 400, `${department}/${agent}`);
      assert.equal(((await res.json()) as { error: string }).error, want);
    }
  });

  // ── 2. A refused key: plain words, recorded, logged, no JSON ────────────
  await check("a provider refusal streams a code and one plain sentence, never the provider's JSON", async () => {
    await login(USERS.partner);
    sent = [];
    logged.length = 0;
    provider = () => anthropicCredit();
    const res = await post(say({ agent_slug: "bravo", department: "chief_of_staff" }));
    assert.equal(res.status, 200);
    const events = parseSse(await res.text());
    const agentEv = events.find((e) => e.event === "agent")!;
    assert.equal(agentEv.data.display_name, "Chief of Staff");
    assert.equal(agentEv.data.department, "chief_of_staff");
    assert.ok(!("model" in agentEv.data), "the model id is operator detail");
    assert.ok(!("agent_slug" in agentEv.data), "a department event does not name the agent behind it");
    rendered.push(JSON.stringify(agentEv.data));
    const err = events.find((e) => e.event === "error")!;
    assert.equal(err.data.code, "provider_400_credit");
    assert.equal(err.data.message, "Your AI account refused the request. Check its billing or key. An owner or admin can fix this in Settings.");
    assert.doesNotMatch(JSON.stringify(err.data), /credit balance|invalid_request_error|\{"type"/);
    assert.equal(events.at(-1)!.event, "done");
    // The workspace key answered, never the teammate's personal key.
    assert.equal(sent.length, 1);
    assert.equal(sent[0].headers["x-api-key"], WORKSPACE_KEY);
    assert.deepEqual(await outcomes(OASIS), ["dept:chief_of_staff=failed:provider_400_credit"]);
  });
  await check("the failure is logged with tenant, department, agent and code — not the message or the key", async () => {
    const lines = failureLogs();
    assert.equal(lines.length, 1);
    assert.deepEqual(
      { stage: lines[0].stage, tenantId: lines[0].tenantId, department: lines[0].department, agentSlug: lines[0].agentSlug, code: lines[0].code },
      { stage: "stream", tenantId: OASIS, department: "chief_of_staff", agentSlug: "bravo", code: "provider_400_credit" },
    );
    const all = JSON.stringify(logged);
    assert.ok(!all.includes("PRIVATE-QUESTION"), "message content was logged");
    assert.ok(!all.includes(WORKSPACE_KEY), "the key was logged");
  });
  await check("pre-stream refusals are logged too", async () => {
    logged.length = 0;
    await login(USERS.client);
    await post(say({ agent_slug: "sdr", department: "sales" }));
    const line = failureLogs()[0];
    assert.equal(line.stage, "pre_stream");
    assert.equal(line.tenantId, CLIENT);
    assert.equal(line.department, "sales");
    assert.equal(line.code, "agent_not_configured");
  });
  await check("a department prompt speaks as the department, with a lock that names no persona", async () => {
    const system = String(sent[0].body?.system ?? "");
    assert.match(system, /^You are the Chief of Staff department, /);
    assert.ok(system.includes(identity.departmentIdentityLock("Chief of Staff")), "the department's identity lock");
    assert.ok(!system.includes("the answer is the agent name above"), "the persona lock is not used in a department channel");
    assert.ok(!identity.namesPersona(system.split("TENANT OVERLAY:")[0]), "the role prompt still names a persona");
  });

  // ── 3. The header tells the truth about the last turn ──────────────────
  await check("the header reads Not working: <why>, for this channel and every channel on that account", async () => {
    const viewer = await viewerFor(USERS.partner);
    for (const slug of ["chief-of-staff", "marketing"]) {
      const state = await resolveChannelState(dept(slug), viewer);
      assert.equal(state.kind, "ready", slug);
      if (state.kind !== "ready") return;
      assert.deepEqual(state.lastTurn, { kind: "failed", code: "provider_400_credit" }, slug);
      const header = withLastTurn(statusFor(true, 0), state.lastTurn);
      assert.deepEqual(header, { kind: "not_working", reason: "AI account refused the request (check billing)" }, slug);
      rendered.push(JSON.stringify(header));
    }
  });
  await check("a successful turn anywhere on the account clears it", async () => {
    await login(USERS.partner);
    provider = () => anthropicOk("Here is the plan.");
    const events = parseSse(await (await post(say({ agent_slug: "maven", department: "marketing" }))).text());
    assert.deepEqual(events.map((e) => e.event), ["agent", "delta", "usage", "done"]);
    assert.equal(events[0].data.display_name, "Marketing");
    rendered.push(JSON.stringify(events[0].data));
    const viewer = await viewerFor(USERS.partner);
    const state = await resolveChannelState(dept("chief-of-staff"), viewer);
    assert.ok(state.kind === "ready" && state.lastTurn.kind === "ok", JSON.stringify(state));
    assert.deepEqual(withLastTurn(statusFor(true, 0), state.kind === "ready" ? state.lastTurn : null), { kind: "working" });
  });
  await check("an unreadable record is Couldn't check, never Working", async () => {
    assert.deepEqual(withLastTurn(statusFor(true, 0), { kind: "unknown" }), { kind: "unknown" });
    assert.deepEqual(withLastTurn(statusFor(false, 0), { kind: "failed", code: "provider_402" }), { kind: "not_connected" });
  });

  // ── 4. Readiness is a usable key, not a row and not a title ─────────────
  await check("a teammate's personal key does not make a workspace channel ready", async () => {
    const viewer = await viewerFor(USERS.client);
    const state = await resolveChannelState(dept("sales"), viewer);
    assert.equal(state.kind, "not_connected");
    if (state.kind === "not_connected") {
      assert.deepEqual(state.action, { href: "/settings/ai", label: "Connect an AI account" });
      rendered.push(state.reason);
    }
  });
  await check("a disabled workspace row is not ready", async () => {
    await db.execute({ sql: "INSERT INTO agent_model_config (id, tenant_id, user_id, agent_key, provider, model, encrypted_api_key, enabled, updated_at) VALUES ('c-client', ?, NULL, 'bravo', 'anthropic', 'claude-sonnet-4-6', ?, 0, ?)", args: [CLIENT, encryptField(WORKSPACE_KEY), stamp] });
    const viewer = await viewerFor(USERS.client);
    assert.equal((await resolveChannelState(dept("sales"), viewer)).kind, "not_connected");
  });
  await check("the operator is ready only when a platform key exists to fall back to", async () => {
    await db.execute({ sql: "UPDATE agent_model_config SET enabled = 0 WHERE id = 'c-oasis'", args: [] });
    try {
      const cc = await viewerFor(USERS.cc);
      assert.equal((await resolveChannelState(dept("sales"), cc)).kind, "not_connected", "operator, no platform key");
      process.env.PLATFORM_DEFAULT_ANTHROPIC_API_KEY = "sk-ant-platform-0003";
      assert.equal((await resolveChannelState(dept("sales"), cc)).kind, "ready", "operator with a platform key");
      const partner = await viewerFor(USERS.partner);
      assert.equal((await resolveChannelState(dept("sales"), partner)).kind, "not_connected", "a non-operator never gets the platform key");
    } finally {
      delete process.env.PLATFORM_DEFAULT_ANTHROPIC_API_KEY;
      await db.execute({ sql: "UPDATE agent_model_config SET enabled = 1 WHERE id = 'c-oasis'", args: [] });
    }
  });
  await check("the model id reaches the verified operator only", async () => {
    await login(USERS.cc);
    provider = () => anthropicOk("ok");
    const events = parseSse(await (await post(say({ agent_slug: "atlas", department: "finance" }))).text());
    assert.equal(events[0].data.model, "claude-sonnet-4-6");
    assert.equal(events[0].data.display_name, "Finance");
  });

  // ── 5. Test connection is a real one-token completion ──────────────────
  await check("a key OpenRouter refuses on a completion is red, even though GET /models says 200", async () => {
    await login(USERS.client);
    sent = [];
    provider = (s) =>
      s.method === "GET"
        ? new Response(JSON.stringify({ data: [] }), { status: 200 })
        : new Response(JSON.stringify({ error: { message: "Insufficient credits", code: 402 } }), { status: 402 });
    const res = await testConnection.POST(
      new NextRequest("http://localhost/api/agent-config/test-connection", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "openrouter", api_key: "sk-or-v1-drained" }),
      }),
    );
    const body = (await res.json()) as { ok: boolean; code: string; message: string };
    assert.equal(body.ok, false);
    assert.equal(body.code, "provider_402");
    assert.equal(body.message, "Your AI account refused the request. Check its billing or key.");
    assert.equal(sent.length, 1);
    assert.equal(sent[0].method, "POST");
    assert.equal(sent[0].url, "https://openrouter.ai/api/v1/chat/completions");
    assert.equal(sent[0].body?.max_tokens, 1);
  });
  await check("every hosted provider gets a POST completion capped at one token", async () => {
    for (const [p, url, cap] of [
      ["anthropic", "https://api.anthropic.com/v1/messages", (b: Record<string, unknown>) => b.max_tokens],
      ["openai", "https://api.openai.com/v1/chat/completions", (b: Record<string, unknown>) => b.max_completion_tokens],
      ["openrouter", "https://openrouter.ai/api/v1/chat/completions", (b: Record<string, unknown>) => b.max_tokens],
      [
        "google",
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
        (b: Record<string, unknown>) => (b.generationConfig as { maxOutputTokens?: number }).maxOutputTokens,
      ],
    ] as const) {
      const seen: Sent[] = [];
      const r = await probeProvider(p, "k", async (url2, init) => {
        seen.push({ url: url2, method: String(init.method), headers: {}, body: JSON.parse(String(init.body)) });
        return new Response("{}", { status: 200 });
      });
      assert.equal(r.ok, true, p);
      assert.equal(seen.length, 1, p);
      assert.equal(seen[0].method, "POST", p);
      assert.equal(seen[0].url, url, p);
      assert.equal(cap(seen[0].body!), 1, p);
    }
    // Anthropic's drained balance (400) and a Google bad key (400) are not the same failure.
    const credit = await probeProvider("anthropic", "k", async () => anthropicCredit());
    assert.equal(credit.ok === false && credit.code, "provider_400_credit");
    const badKey = await probeProvider("google", "k", async () => new Response('{"error":{"message":"API key not valid. Please pass a valid API key."}}', { status: 400 }));
    assert.equal(badKey.ok === false && badKey.code, "provider_401");
  });
  await check("the route source no longer lists models to decide a key works", () => {
    const src = readFileSync(join(process.cwd(), "app/api/agent-config/test-connection/route.ts"), "utf8");
    assert.doesNotMatch(src, /\/v1\/models|\/v1beta\/models\?|api\/tags/, "a model-list probe is back");
    assert.match(src, /probeProvider\(provider, proposedKey\)/);
    assert.match(src, /probeProvider\(provider, plain\)/);
  });

  // ── 6. Names: departments only, everywhere a client (or CC) looks ───────
  await check("the AI Team roster names department leads for their departments", async () => {
    const viewer = await viewerFor(USERS.cc);
    const team = await loadAiTeam(viewer, []);
    const byId = new Map(team.leads.map((l) => [l.id, l]));
    assert.equal(byId.get("bravo")?.name, "Chief of Staff · Operations");
    assert.equal(byId.get("maven")?.name, "Marketing");
    assert.equal(byId.get("atlas")?.name, "Finance");
    for (const lead of team.leads) rendered.push(lead.name, lead.summary, ...lead.departments.map((d) => d.label));
  });
  await check("every OASIS department channel's stream names its department", async () => {
    await login(USERS.partner);
    provider = () => anthropicOk("ok");
    for (const d of OS_DEPARTMENTS) {
      const binding = departmentChannelFor(d.key, { oasis: true });
      if (binding.kind !== "agent") continue;
      const events = parseSse(await (await post(say({ agent_slug: binding.agentSlug, department: d.key }))).text());
      assert.equal(events[0].data.display_name, d.label, d.slug);
      rendered.push(JSON.stringify(events[0].data));
    }
  });
  await check("no client-rendered string or stream event names Bravo, Maven, Atlas or Conaugh", async () => {
    for (const oasis of [true, false]) {
      for (const d of OS_DEPARTMENTS) {
        const binding = departmentChannelFor(d.key, { oasis });
        rendered.push(binding.kind === "agent" ? binding.greeting : binding.reason);
        for (const a of suggestedAsksFor(d.key, { oasis })) rendered.push(a.title, a.prompt);
        rendered.push(identity.departmentIdentityLock(d.label));
      }
    }
    for (const code of [...outcome.TURN_FAILURE_CODES, "slug_not_owned", "unauthorized", "config_unavailable", "network", "empty_reply", "???"]) {
      for (const canManageAi of [true, false]) {
        const c = outcome.failureCopy(code, { canManageAi });
        rendered.push(c.sentence, c.short, c.fix?.label ?? "");
      }
    }
    const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
    // The client component's own literal copy (slash-command replies, help, hint).
    rendered.push(...(src("components/agents/AgentChat.tsx").match(/"[^"\n]*"|`[^`\n]*`/g) ?? []));
    assert.ok(rendered.length > 80, `only ${rendered.length} strings scanned: the scan is not reaching the surfaces`);
    const hits = rendered.filter((s) => identity.namesPersona(s));
    assert.deepEqual(hits, [], `persona names reached a client surface: ${hits.join(" | ")}`);
    // Anti-vacuity: the pattern does catch what it is for.
    assert.ok(identity.namesPersona(getSeedAgent("bravo")!.base_prompt));
    assert.ok(identity.namesPersona("ask Conaugh") && identity.namesPersona("MAVEN") && !identity.namesPersona("Atlassian"));
  });

  // ── 6b. The /t/<slug>/agent preview never offers a chat the route refuses ─
  await check("the agent preview renders the chat only in a workspace the viewer owns", async () => {
    const { AgentChat } = await import("../components/agents/AgentChat");
    const page = (await import("../app/t/[slug]/agent/[agent]/page")).default;
    const hasChat = (node: unknown): boolean => {
      if (!node || typeof node !== "object") return false;
      if (Array.isArray(node)) return node.some(hasChat);
      const el = node as { type?: unknown; props?: { children?: unknown } };
      return el.type === AgentChat || hasChat(el.props?.children);
    };
    await login(USERS.multi); // two seats: the maybeSingle read found no workspace for them at all
    assert.equal(hasChat(await page({ params: Promise.resolve({ slug: "suga", agent: "sdr" }) })), true, "own workspace");
    assert.equal(hasChat(await page({ params: Promise.resolve({ slug: "oasis-ai-cc", agent: "sdr" }) })), false, "a seat that is not the active one");
    await login(USERS.client);
    assert.equal(hasChat(await page({ params: Promise.resolve({ slug: "oasis-ai-cc", agent: "sdr" }) })), false, "someone else's workspace");
  });

  // ── 7. The channel UI: plain errors, no empty bubble, Enter sends ───────
  await check("AgentChat renders failures through failureCopy, drops the empty bubble, sends on Enter", () => {
    const src = readFileSync(join(process.cwd(), "components/agents/AgentChat.tsx"), "utf8");
    assert.match(src, /failureCopy\(failure, \{ canManageAi \}\)/, "errors go through the plain-sentence table");
    assert.doesNotMatch(src, /setError\(detail\)|\(payload as \{ message\?: string \}\)\.message/, "raw error text reaches the screen");
    assert.match(src, /if \(!assistantText\) \{\s*dropEmptyPlaceholder\(\);/, "an empty reply bubble stays on screen");
    assert.match(src, /e\.key === "Enter" && !e\.shiftKey && !e\.nativeEvent\.isComposing/, "Enter sends, Shift+Enter is a newline");
    assert.doesNotMatch(src, /metaKey|ctrlKey|Cmd\/Ctrl/, "the old Cmd/Ctrl+Enter-only send is back");
    // Copy, not comments: every string literal the component can render.
    const literals = (src.match(/"[^"\n]*"|`[^`\n]*`/g) ?? []).join("\n");
    assert.doesNotMatch(literals, /marketplace|(?<!\/api)\/agents\b/i, "slash-command copy points at the marketplace or /agents");
    assert.doesNotMatch(src, /renderHelp\(\)/, "/help lists /agent (with a persona example) in a department channel");
    const channel = readFileSync(join(process.cwd(), "components/os/department/DepartmentChannel.tsx"), "utf8");
    assert.doesNotMatch(channel, /tenantSlug=/, "a department channel sends no tenant slug; the route reads the session");
    assert.match(channel, /department=\{state\.department\}/);
  });

  console.log(`os-channels-honest: ${failures === 0 ? "OK" : `${failures} FAILED`}`);
  if (failures) process.exitCode = 1;
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
