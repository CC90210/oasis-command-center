/**
 * admin-harness.test.ts — the Coding harness and the bridge calls behind the
 * Admin pages (2026-09-30, OASIS OS S2 T3), against a real local libSQL file.
 *
 * WHY. Since the bridge bearer went on (BEA 38139ede, 2026-09-29) the bridge
 * answers 401 to any request without the token, loopback included. Every
 * browser-direct call on /operations and /automations then failed, and the UI
 * blamed "offline": worker Start/Stop/Restart, the CLI panel, the warm pool.
 * The token must never reach a browser, so each now goes through the server.
 * Separately, /agent was a persona chat any workspace could open, it claimed a
 * "platform default" key while /api/usage answered 412, a hidden instance
 * swallowed other pages' ?prompt=, and its <dashboard-action> markers were
 * never applied, so /runs stayed empty. What this pins:
 *
 *   - POST /api/automations/background-workers/control drives the OASIS fleet
 *     for the verified operator only, through the bridge's fleet_control tool
 *     with the server's bearer; a 401 from the bridge is bridge_refused_token;
 *   - lib/automations/worker-control.ts always posts that route and words a
 *     401 as "the bridge refused the request (token)";
 *   - GET /api/bridge/warm-status: operator only, bearer on, session ids dropped;
 *   - /api/usage names its key source, and the platform key only for the
 *     operator; the chat is Ready only on a real key or a reachable bridge;
 *   - the persistent chat reads ?agent/?prompt only on /agent;
 *   - lib/chat-shell-props.ts: operator-only, no no-tenant fallback, the three
 *     harness targets instead of personas;
 *   - bridge replies' markers are applied and logged once; logAction logs its
 *     own failures;
 *   - the fleet's Running comes from process pings, "Last task" from the tick;
 *   - ManifestDashboard's "Chat" opens the department channel.
 *
 * Run: node --conditions=react-server --import tsx tests/admin-harness.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createClient } from "@libsql/client";

const ROOT = join(__dirname, "..");
const dbFile = join(mkdtempSync(join(tmpdir(), "admin-harness-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
delete process.env.TURSO_AUTH_TOKEN;
process.env.EMPIRE_AUTH_BACKEND = "turso";
process.env.AUTH_SESSION_SECRET = "admin-harness-secret-long-enough-000000000001";
delete process.env.OPERATOR_EMAIL;
delete process.env.OPERATOR_EMAIL_FALLBACK_ENABLED;
process.env.ADMIN_EMAILS = "adon@oasisai.work";
// The OASIS workspace's bridge, as production resolves it: a per-tenant
// https URL plus BRIDGE_BEARER_TOKEN_<SLUG>. A fake value, never a real one.
process.env.BRIDGE_BEARER_TOKEN_OASIS_AI_CC = "test-bearer-not-real";
delete process.env.PLATFORM_DEFAULT_OPENROUTER_API_KEY;
delete process.env.PLATFORM_DEFAULT_OPENAI_API_KEY;
delete process.env.PLATFORM_DEFAULT_GOOGLE_API_KEY;
delete process.env.PLATFORM_DEFAULT_ANTHROPIC_API_KEY;

// Every outbound call is scripted and recorded.
type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };
let calls: Call[] = [];
let answer: (url: string) => Response = () => new Response("{}", { status: 500 });
globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  const url = String(input);
  const headers: Record<string, string> = {};
  new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
  let body: unknown = init?.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      /* raw string body kept as-is for the assertion */
    }
  }
  calls.push({ url, method: init?.method || "GET", headers, body });
  return answer(url);
}) as typeof fetch;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

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
// The real next/navigation loads the client router context, which does not
// exist under react-server.
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
stub("next/link", { __esModule: true, default: () => null });

const OASIS = "ef8d389e-3f15-43f2-ae00-3660f69a1452";
const CLIENT = "6b6b6b6b-0000-4000-8000-00000000006b";
const u = (n: number, email: string) => ({ id: `0e000000-0000-4000-8000-${String(n).padStart(12, "0")}`, email });
const CC = u(1, "conaugh@oasisai.work");
const CLIENT_OWNER = u(2, "owner@client.test");
const CLOSER = u(3, "closer@oasisai.work");

async function login(user: { id: string; email: string } | null) {
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
    console.log(`  FAIL  ${name}\n        ${(e as Error).stack?.split("\n").slice(0, 5).join("\n        ")}`);
  }
}

async function main() {
  const db = createClient({ url: `file:${dbFile}` });
  const stamp = "2026-09-01T00:00:00Z";
  await db.executeMultiple(`
    CREATE TABLE "_supabase_auth_users" (id TEXT PRIMARY KEY, email TEXT NOT NULL,
      session_version INTEGER NOT NULL DEFAULT 0, banned_until TEXT, deleted_at TEXT);
    CREATE TABLE user_profiles (id TEXT PRIMARY KEY, auth_user_id TEXT, email TEXT, tenant_id TEXT,
      team_role TEXT, is_owner INTEGER DEFAULT 0, admin_access INTEGER DEFAULT 0,
      onboarding_completed_at TEXT, full_name TEXT, display_name TEXT, agents_enabled TEXT,
      primary_agent TEXT, updated_at TEXT, deactivated_at TEXT);
    CREATE TABLE tenants (id TEXT PRIMARY KEY, slug TEXT, name TEXT, custom_fields TEXT, lifecycle TEXT);
    CREATE TABLE tenant_audit_log (id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), tenant_id TEXT,
      actor_email TEXT, actor_user_id TEXT, action_type TEXT, target_table TEXT, target_id TEXT, after TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
    CREATE TABLE bridge_pairings (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, label TEXT NOT NULL,
      last_seen_at TEXT, revoked_at TEXT);
    CREATE TABLE agent_model_config (id TEXT PRIMARY KEY, tenant_id TEXT, user_id TEXT, agent_key TEXT,
      provider TEXT, model TEXT, encrypted_api_key TEXT, system_prompt_override TEXT, enabled INTEGER, last_used_at TEXT);
    CREATE TABLE agent_events (id TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))) PRIMARY KEY, event_type TEXT NOT NULL,
      publisher_agent TEXT NOT NULL, severity TEXT NOT NULL DEFAULT 'info', payload TEXT NOT NULL DEFAULT '{}',
      correlation_id TEXT, published_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
  `);
  const profile = (user: { id: string; email: string }, tenant: string, role: string, owner = 0) => ({
    sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, onboarding_completed_at, agents_enabled, primary_agent, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, '["bravo","atlas","maven","aura"]', 'aura', ?)`,
    args: [`p-${user.id}`, user.id, user.email, tenant, role, owner, stamp, stamp],
  });
  await db.batch(
    [
      ...[CC, CLIENT_OWNER, CLOSER].map((x) => ({ sql: `INSERT INTO "_supabase_auth_users" (id, email) VALUES (?, ?)`, args: [x.id, x.email] })),
      { sql: "INSERT INTO tenants (id, slug, name, custom_fields) VALUES (?, 'oasis-ai-cc', 'OASIS AI', ?)", args: [OASIS, JSON.stringify({ bridge_url: "https://bridge.test" })] },
      { sql: "INSERT INTO tenants (id, slug, name, custom_fields) VALUES (?, 'client-co', 'Client Co', '{}')", args: [CLIENT] },
      profile(CC, OASIS, "owner", 1),
      profile(CLIENT_OWNER, CLIENT, "owner", 1),
      profile(CLOSER, OASIS, "closer"),
      { sql: "INSERT INTO bridge_pairings (id, tenant_id, label, last_seen_at) VALUES ('bp-1', ?, 'CCPC (Windows)', ?)", args: [OASIS, new Date(Date.now() - 30_000).toISOString()] },
    ],
    "write",
  );

  console.log("admin-harness:");

  // ── Worker control through the server ──────────────────────────────────
  const control = await import("../app/api/automations/background-workers/control/route");
  const post = (body: unknown) =>
    control.POST(new Request("http://localhost/api/automations/background-workers/control", { method: "POST", body: JSON.stringify(body) }));

  for (const surface of ["oasis", ""] as const) {
    const label = surface ? "OASIS deployment" : "unclassified deployment";
    await check(`control (${label}): the operator restarts an OASIS worker through fleet_control with the server's bearer`, async () => {
      if (surface) process.env.DEPLOY_SURFACE = surface;
      else delete process.env.DEPLOY_SURFACE;
      await login(CC);
      calls = [];
      answer = () => json(200, { ok: true, output: "restarted bravo-ig-dm" });
      const res = await post({ service: "pm2.bravo-ig-dm", action: "restart" });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true, output: "restarted bravo-ig-dm" });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, "https://bridge.test/exec-tool");
      assert.equal(calls[0].headers.authorization, "Bearer test-bearer-not-real");
      assert.deepEqual(calls[0].body, { tool_name: "fleet_control", input: { action: "restart", name: "bravo-ig-dm" } });
    });
  }
  process.env.DEPLOY_SURFACE = "oasis";
  await check("control: a 401 from the bridge is bridge_refused_token, never offline", async () => {
    await login(CC);
    answer = () => json(401, { ok: false, error: "unauthorized" });
    const res = await post({ service: "pm2.bravo-ig-dm", action: "stop" });
    assert.equal(res.status, 502);
    const body = (await res.json()) as { error: string; message: string };
    assert.equal(body.error, "bridge_refused_token");
    assert.equal(body.message, "The bridge refused the request (token).");
  });
  await check("control: every attempt leaves an audit row", async () => {
    const rows = await db.execute("SELECT action_type, target_id, tenant_id FROM tenant_audit_log");
    assert.ok(rows.rows.length >= 2);
    assert.ok(rows.rows.every((r) => r.action_type === "background_worker_control" && r.tenant_id === OASIS));
  });
  await check("control: a retired or unknown worker is refused before the bridge", async () => {
    await login(CC);
    calls = [];
    for (const service of ["skool_engine", "pm2.sunbiz-sequence-runner", "pm2.not-a-worker"]) {
      const res = await post({ service, action: "start" });
      assert.equal(res.status, 400, service);
      assert.equal(((await res.json()) as { error: string }).error, "unknown_worker");
    }
    assert.equal(calls.length, 0);
  });
  await check("control: a client owner and an OASIS closer get a 404, signed out a 401, and no bridge call", async () => {
    calls = [];
    for (const who of [CLIENT_OWNER, CLOSER]) {
      await login(who);
      assert.equal((await post({ service: "pm2.bravo-ig-dm", action: "restart" })).status, 404);
    }
    await login(null);
    assert.equal((await post({ service: "pm2.bravo-ig-dm", action: "restart" })).status, 401);
    assert.equal(calls.length, 0);
  });

  await check("worker-control: always the server route; a 401 reads as the token", async () => {
    const wc = await import("../lib/automations/worker-control");
    calls = [];
    answer = () => json(502, { ok: false, error: "bridge_refused_token" });
    const r = await wc.runWorkerAction("pm2.bravo-ig-dm", "restart");
    assert.deepEqual(r, { ok: false, output: "the bridge refused the request (token)" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "/api/automations/background-workers/control");
    assert.equal(calls[0].method, "POST");
    assert.deepEqual(calls[0].body, { service: "pm2.bravo-ig-dm", action: "restart" });
    answer = () => json(200, { ok: true, output: "started" });
    assert.deepEqual(await wc.runWorkerAction("pm2.bravo-ig-dm", "start"), { ok: true, output: "started" });
    assert.ok(calls.every((c) => !/127\.0\.0\.1|localhost:9100/.test(c.url)), "never the loopback bridge");
  });

  // ── Warm pool through the server ───────────────────────────────────────
  const warm = await import("../app/api/bridge/warm-status/route");
  await check("warm-status: the operator gets the pool with the bearer, session ids dropped, and the computer's check-in", async () => {
    await login(CC);
    calls = [];
    answer = () =>
      json(200, { ok: true, size: 1, max_size: 4, idle_timeout_s: 900, processes: [{ key: "bravo:tab", agent: "bravo", alive: true, busy: false, age_s: 12, idle_s: 3, session_id: "SESSION-DO-NOT-FORWARD" }] });
    const res = await warm.GET();
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(!text.includes("SESSION-DO-NOT-FORWARD"), "the session id is dropped");
    const body = JSON.parse(text) as { ok: boolean; pool: { size: number; processes: Array<{ agent: string }> }; machine: { label: string; state: string } };
    assert.equal(body.ok, true);
    assert.equal(body.pool.size, 1);
    assert.equal(body.machine.label, "CCPC (Windows)");
    assert.equal(body.machine.state, "online");
    assert.equal(calls[0].url, "https://bridge.test/warm-status");
    assert.equal(calls[0].headers.authorization, "Bearer test-bearer-not-real");
  });
  await check("warm-status: a 401 from the bridge is bridge_refused_token, with the check-in still shown", async () => {
    await login(CC);
    answer = () => json(401, { ok: false });
    const body = (await (await warm.GET()).json()) as { ok: boolean; reason: string; machine: { label: string } };
    assert.equal(body.ok, false);
    assert.equal(body.reason, "bridge_refused_token");
    assert.equal(body.machine.label, "CCPC (Windows)");
  });
  await check("warm-status: with no bridge token set, the computer's check-in still shows (read before the bridge)", async () => {
    await login(CC);
    const saved = process.env.BRIDGE_BEARER_TOKEN_OASIS_AI_CC;
    delete process.env.BRIDGE_BEARER_TOKEN_OASIS_AI_CC;
    calls = [];
    try {
      const body = (await (await warm.GET()).json()) as { ok: boolean; reason: string; machine: { label: string; state: string } };
      assert.equal(body.reason, "bridge_not_configured");
      assert.equal(body.machine.label, "CCPC (Windows)");
      assert.equal(calls.length, 0, "no bridge call without a target");
    } finally {
      process.env.BRIDGE_BEARER_TOKEN_OASIS_AI_CC = saved;
    }
  });
  await check("warm-status: a client owner gets a 404, signed out a 401, no bridge call", async () => {
    calls = [];
    await login(CLIENT_OWNER);
    assert.equal((await warm.GET()).status, 404);
    await login(null);
    assert.equal((await warm.GET()).status, 401);
    assert.equal(calls.length, 0);
  });

  // ── The CLI panel and runner header say what they know ─────────────────
  await check("CLI panel and runner header: plain words for each state", async () => {
    const { describeCliPanel } = await import("../components/BridgeCliPanel");
    const missing = { kind: "body" as const, status: 200, body: { ok: false as const, reason: "missing" } };
    assert.match(describeCliPanel(null, missing).detail, /Couldn't check whether your computer is checking in/);
    assert.match(describeCliPanel(false, missing).detail, /isn't checking in/);
    assert.equal(describeCliPanel(true, { kind: "body", status: 401, body: { ok: false, reason: "unauthorized" } }).title, "You're signed out");
    const { describeRunner } = await import("../components/admin/RunnerStatusHeader");
    const view = describeRunner({
      warm: { status: 200, body: { ok: false, reason: "bridge_refused_token", machine: { label: "CCPC (Windows)", last_seen_at: new Date().toISOString(), state: "online" } } },
      cli: { status: 200, body: { ok: true, data: { claude: { installed: true, authenticated: true }, codex: { installed: true, authenticated: false }, gemini: { installed: false, authenticated: false } } } },
    });
    assert.match(view.computer, /^CCPC \(Windows\): online, checked in/);
    assert.equal(view.pool, "The bridge refused the request (token).");
    assert.equal(view.tools, "Signed in: Claude Code. Installed, not signed in: Codex");
    const unread = describeRunner({ warm: { error: "fetch failed" }, cli: { error: "fetch failed" } });
    assert.equal(unread.computer, "Couldn't check your computer just now.");
    const notRead = describeRunner({ warm: { status: 200, body: { ok: false, reason: "bridge_not_configured" } }, cli: null });
    assert.equal(notRead.computer, "Couldn't check your computer.", "pairings the route never read are not 'none paired'");
  });

  // ── The chat's honesty ──────────────────────────────────────────────────
  await check("Ready needs a reachable bridge or a real key; being the operator is not a key", async () => {
    const { chatReadiness, harnessOwnsUrlParams } = await import("../lib/admin/chat-readiness");
    const base = { bridgeReady: false, configsLoaded: true, hasOwnKey: false, isAdmin: true, providerIsLocalOnly: false };
    assert.deepEqual(chatReadiness({ ...base, platformKey: "absent" }), { ready: false, viaPlatformKey: false });
    assert.deepEqual(chatReadiness({ ...base, platformKey: "unknown" }), { ready: false, viaPlatformKey: false });
    assert.deepEqual(chatReadiness({ ...base, platformKey: "present" }), { ready: true, viaPlatformKey: true });
    assert.deepEqual(chatReadiness({ ...base, isAdmin: false, platformKey: "present" }), { ready: false, viaPlatformKey: false });
    assert.deepEqual(chatReadiness({ ...base, platformKey: "absent", bridgeReady: true }), { ready: true, viaPlatformKey: false });
    assert.deepEqual(chatReadiness({ ...base, platformKey: "absent", hasOwnKey: true }), { ready: true, viaPlatformKey: false });
    assert.equal(harnessOwnsUrlParams(true, "/agent"), true);
    assert.equal(harnessOwnsUrlParams(false, "/agent"), false, "the hidden instance never reads the URL");
    assert.equal(harnessOwnsUrlParams(true, "/team/chief-of-staff"), false);
    const widget = readFileSync(join(ROOT, "components", "ChatWidget.tsx"), "utf8");
    assert.match(widget, /const ownsUrl = harnessOwnsUrlParams\(active, pathname\);\s*const urlAgent = ownsUrl \? searchParams\?\.get\("agent"\) : null;\s*const urlPrompt = ownsUrl \? searchParams\?\.get\("prompt"\) : null;/);
    assert.doesNotMatch(widget, /OASIS platform default|via the platform default key/, "no platform-default claim");
    assert.match(widget, /const cloud = chatReadiness\(\{/);
    assert.doesNotMatch(widget, /cloudReady \|\| isAdmin/, "the retry offer is readiness too: being the operator is not a key");
  });
  const usage = await import("../app/api/usage/route");
  const { NextRequest } = await import("next/server");
  const usageGet = () => usage.GET(new NextRequest("http://localhost/api/usage?agent=bravo"));
  await check("/api/usage: no key is 412; the platform key is the operator's only, and named", async () => {
    await login(CC);
    const none = await usageGet();
    assert.equal(none.status, 412);
    process.env.PLATFORM_DEFAULT_ANTHROPIC_API_KEY = "sk-test-not-real";
    try {
      const op = (await (await usageGet()).json()) as { ok: boolean; key_source: string; supported: boolean };
      assert.deepEqual([op.ok, op.key_source, op.supported], [true, "platform", false]);
      await login(CLOSER);
      const closer = await usageGet();
      assert.equal(closer.status, 412, "a non-operator never reads the platform key");
    } finally {
      delete process.env.PLATFORM_DEFAULT_ANTHROPIC_API_KEY;
    }
  });

  // ── The harness's props ─────────────────────────────────────────────────
  await check("chat-shell-props: operator only, no no-tenant fallback, the three harness targets", async () => {
    const { resolveChatShellProps } = await import("../lib/chat-shell-props");
    const ccProfile = { tenant_id: OASIS, agents_enabled: ["bravo", "atlas", "maven", "aura"], primary_agent: "aura", email: CC.email };
    assert.equal(await resolveChatShellProps({ profile: ccProfile, userEmail: CC.email, isPlatformOperator: false }), null);
    assert.equal(await resolveChatShellProps({ profile: { tenant_id: null }, userEmail: CC.email, isPlatformOperator: true }), null);
    assert.equal(await resolveChatShellProps({ profile: { ...ccProfile, tenant_id: CLIENT }, userEmail: CC.email, isPlatformOperator: true }), null, "no bridge in a client workspace");
    const props = await resolveChatShellProps({ profile: ccProfile, userEmail: CC.email, isPlatformOperator: true });
    assert.ok(props);
    assert.deepEqual(props.agentKeys, ["bravo", "maven", "atlas"]);
    assert.equal(props.defaultAgent, "bravo", "a primary outside the targets (aura) is not the default");
    assert.deepEqual(props.targetLabels, {
      bravo: "Chief of Staff & Operations · Business-Empire-Agent",
      maven: "Marketing · CMO-Agent",
      atlas: "Finance · CFO-Agent",
    });
  });

  // ── Markers in a bridge reply ───────────────────────────────────────────
  await check("bridge replies: markers applied once with the server's tenant, logged, sent to the widget before done", async () => {
    const { teeBridgeDashboardActions, applyBridgeMarkers } = await import("../lib/admin/bridge-dashboard-actions");
    const ran: Array<{ type: string; tenantId: string }> = [];
    const logged: Array<{ type: string; ok: boolean; tenant_id: string }> = [];
    const deps = {
      run: (async (spec: { type: string }, ctx: { tenantId: string }) => {
        ran.push({ type: spec.type, tenantId: ctx.tenantId });
        return { ok: true as const, type: spec.type, summary: "done" };
      }) as never,
      log: (async (a: { type: string; ok: boolean; tenant_id: string }) => {
        logged.push({ type: a.type, ok: a.ok, tenant_id: a.tenant_id });
        return true;
      }) as never,
    };
    const ctx = { tenantId: OASIS, userId: CC.id, agent: "bravo", teamRole: "owner" };
    const enc = new TextEncoder();
    const frames = [
      `event: delta\ndata: ${JSON.stringify({ text: 'Updating. <dashboard-action type="update_profile">{"full_name":"CC"}' })}\n\n`,
      `event: delta\ndata: ${JSON.stringify({ text: "</dashboard-action> Done." })}\n\nevent: done\ndata: {}\n\n`,
    ];
    const upstream = new ReadableStream<Uint8Array>({
      start(c) {
        for (const f of frames) c.enqueue(enc.encode(f));
        c.close();
      },
    });
    const text = await new Response(teeBridgeDashboardActions(upstream, ctx, deps)).text();
    assert.deepEqual(ran, [{ type: "update_profile", tenantId: OASIS }]);
    assert.deepEqual(logged, [{ type: "update_profile", ok: true, tenant_id: OASIS }]);
    assert.ok(text.indexOf("event: action") > -1 && text.indexOf("event: action") < text.indexOf("event: done"), "the action frame precedes done");
    assert.equal(text.split("event: action").length - 1, 1, "applied once, not again at flush");
    assert.ok(text.includes(frames[0]) && text.includes("</dashboard-action> Done."), "the relayed bytes pass through");
    const denied = await applyBridgeMarkers('<dashboard-action type="create_record">{"entity":"lead","data":{}}</dashboard-action>', { ...ctx, teamRole: "read_only" }, deps);
    assert.deepEqual(denied, [{ ok: false, type: "create_record", error: "forbidden_role" }]);
    assert.equal(logged.at(-1)?.ok, false, "a refusal is logged too");
    const route = readFileSync(join(ROOT, "app", "api", "bridge", "chat", "route.ts"), "utf8");
    assert.match(route, /teeBridgeDashboardActions\(persistedBody, \{\s*tenantId: auth\.tenantId,\s*userId: auth\.userId,/);
  });
  await check("POST /api/bridge/chat: the harness reply's marker is applied to the operator's own row, logged for /runs, and shown", async () => {
    await login(CC);
    const bridgeChat = await import("../app/api/bridge/chat/route");
    const { NextRequest: Req } = await import("next/server");
    const enc = new TextEncoder();
    calls = [];
    answer = (url) => {
      if (!url.endsWith("/chat")) return json(404, {});
      const sse = [
        `event: delta\ndata: ${JSON.stringify({ text: 'Saving. <dashboard-action type="update_profile">{"display_name":"CC-FROM-HARNESS"}</dashboard-action>' })}\n\n`,
        "event: done\ndata: {}\n\n",
      ];
      return new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            for (const f of sse) c.enqueue(enc.encode(f));
            c.close();
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    };
    const originalError = console.error;
    console.error = () => undefined; // the history tee has no chat tables here; that is not this check
    let text = "";
    try {
      const res = await bridgeChat.POST(
        new Req("http://localhost/api/bridge/chat", {
          method: "POST",
          body: JSON.stringify({ agent: "bravo", messages: [{ role: "user", content: "set my display name" }], tab_id: "11111111-1111-4111-8111-111111111111", tenant_id: CLIENT }),
        }),
      );
      assert.equal(res.status, 200);
      text = await res.text();
    } finally {
      console.error = originalError;
    }
    assert.equal(calls[0]?.url, "https://bridge.test/chat");
    assert.match(text, /event: action\ndata: \{"ok":true,"type":"update_profile"/, "the widget gets the result");
    const profile = await db.execute({ sql: "SELECT display_name FROM user_profiles WHERE auth_user_id = ?", args: [CC.id] });
    assert.equal(profile.rows[0]?.display_name, "CC-FROM-HARNESS", "applied to the operator's own profile");
    const logged = await db.execute({
      sql: "SELECT correlation_id FROM agent_events WHERE event_type = 'dashboard_action' AND payload LIKE '%update_profile%' AND payload LIKE '%display_name updated%'",
      args: [],
    });
    assert.equal(logged.rows.length, 1, "logged once for /runs");
    assert.equal(logged.rows[0]?.correlation_id, OASIS, "under the session's tenant, not the body's tenant_id");
  });
  await check("logAction writes the row, and logs its own failure instead of swallowing it", async () => {
    const { logAction } = await import("../lib/action-log");
    assert.equal(await logAction({ agent_key: "bravo", tenant_id: OASIS, user_id: CC.id, type: "update_profile", ok: true, summary: "x" }), true);
    const row = await db.execute("SELECT event_type, correlation_id FROM agent_events WHERE event_type = 'dashboard_action'");
    assert.equal(row.rows[0]?.correlation_id, OASIS);
    await db.execute("ALTER TABLE agent_events RENAME TO agent_events_parked");
    const originalError = console.error;
    const seen: string[] = [];
    console.error = (...a: unknown[]) => void seen.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
    try {
      assert.equal(await logAction({ agent_key: "bravo", tenant_id: OASIS, user_id: CC.id, type: "update_profile", ok: false, error: "x" }), false);
    } finally {
      console.error = originalError;
      await db.execute("ALTER TABLE agent_events_parked RENAME TO agent_events");
    }
    assert.ok(seen.some((l) => l.includes("[action-log]")), "the failure is logged");
  });

  // ── Fleet, agents, links ────────────────────────────────────────────────
  await check("fleet: Running comes from the agent's process pings; the tick is Last task", async () => {
    const { fleetSignals } = await import("../components/os/landings/fleet-data");
    const now = Date.parse("2026-09-30T12:00:00Z");
    const iso = (ms: number) => new Date(now - ms).toISOString();
    const signals = fleetSignals(
      ["bravo", "atlas", "maven"],
      [{ agent_name: "atlas", last_tick_at: iso(60_000), tick_count: 9 }],
      [
        { service: "pm2.bravo-scheduler", last_ping_at: iso(30_000) },
        { service: "pm2.bravo-scheduler", last_ping_at: iso(40 * 24 * 3_600_000) },
        { service: "pm2.bravo-telegram", last_ping_at: iso(2 * 3_600_000) },
        { service: "pm2.atlas-telegram", last_ping_at: iso(20 * 60_000) },
        { service: "bravo", last_ping_at: iso(1_000) },
      ],
      now,
    );
    assert.deepEqual(
      [signals.get("bravo")?.live, signals.get("bravo")?.runningCount, signals.get("bravo")?.processCount],
      [true, 1, 2],
    );
    assert.equal(signals.get("atlas")?.live, false, "a fresh tick is not a running process");
    assert.equal(signals.get("atlas")?.lastTaskAt, iso(60_000));
    assert.equal(signals.get("maven")?.live, false);
    assert.equal(signals.get("maven")?.lastSignalAt, null);
    // A fresh check-in about a stopped process is not Running.
    const stopped = fleetSignals(
      ["atlas", "maven"],
      [],
      [
        { service: "pm2.atlas-telegram", last_ping_at: iso(20_000), status: "degraded", metadata: JSON.stringify({ pm2_status: "disabled by operator" }) },
        { service: "pm2.maven-telegram", last_ping_at: iso(20_000), status: "down", metadata: {} },
      ],
      now,
    );
    assert.equal(stopped.get("atlas")?.live, false, "stopped by the operator");
    assert.equal(stopped.get("maven")?.live, false, "reports itself down");
    assert.ok(stopped.get("atlas")?.lastSignalAt, "the check-in time is still shown");
    const { prettifyMeta } = await import("../components/os/landings/AgentFleet");
    assert.equal(prettifyMeta("supabase"), "", "no '· supabase' host");
    assert.equal(prettifyMeta("vercel"), "cloud");
  });
  await check("agents: no named prospect, no revenue figure, no MRR-target question", async () => {
    const { AGENT_REGISTRY } = await import("../lib/agents");
    const bravo = AGENT_REGISTRY.bravo;
    assert.doesNotMatch(bravo.askMeAbout ?? "", /Jonathan|\$\d/);
    assert.ok(!(bravo.setup_questions ?? []).some((q) => q.id === "mrr_target_usd"));
  });
  await check("the tenant dashboard's Chat opens the department channel, never /agent", async () => {
    const { departmentHrefForAgent } = await import("../components/manifest/ManifestDashboard");
    assert.equal(departmentHrefForAgent("bravo"), "/team/chief-of-staff");
    assert.equal(departmentHrefForAgent("maven"), "/team/marketing");
    assert.equal(departmentHrefForAgent("atlas"), "/team/finance");
    assert.equal(departmentHrefForAgent("sdr"), "/team/sales");
    assert.equal(departmentHrefForAgent("customer-support"), "/team/client-success");
    assert.equal(departmentHrefForAgent("hermes"), "/team/chief-of-staff");
    const src = readFileSync(join(ROOT, "components", "manifest", "ManifestDashboard.tsx"), "utf8");
    assert.doesNotMatch(src, /\/agent\?agent=/);
  });
  await check("the agent inbox read fails loud (no agent_messages table here), so /inbox says Couldn't check", async () => {
    const inboxDb = await import("../lib/agent-inbox-db");
    await assert.rejects(() => inboxDb.listUnreadDb(OASIS), /agent_messages unread read failed/);
    await assert.rejects(() => inboxDb.listReadDb(OASIS), /agent_messages read-archive read failed/);
  });
  await check("copy: /runs has no invented goal, /inbox reads only the database and says Turso", () => {
    const runs = readFileSync(join(ROOT, "app", "runs", "page.tsx"), "utf8");
    assert.doesNotMatch(runs, /\$7000|MRR target/);
    const inbox = readFileSync(join(ROOT, "app", "inbox", "page.tsx"), "utf8");
    assert.doesNotMatch(inbox, /from "@\/lib\/agent-inbox-fs"/, "the page no longer imports the filesystem inbox");
    assert.doesNotMatch(inbox, /Supabase|tmp\/agent_inbox|\$5K/);
    assert.match(inbox, /Turso/);
  });

  if (failures > 0) {
    console.error(`admin-harness: ${failures} failed`);
    process.exit(1);
  }
  console.log("admin-harness: all passed");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
