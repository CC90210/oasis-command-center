/**
 * slack-own-app.test.ts - a client workspace connects Slack with its OWN Slack
 * app (CC, 2026-10-01: "the client is responsible for obtaining the API key";
 * OASIS's own workspace uses the OASIS app).
 *
 * WHY. A client's own app means a client-held signing secret. The failures that
 * matter are silent: a workspace's secret accepted for another workspace's
 * Request URL, or its URL accepting events that name another workspace's Slack
 * team (cross-tenant injection with a secret the client legitimately holds); an
 * install that quietly uses OASIS's app instead of the client's; a card that
 * says "connected" or "Available" when nothing can be installed; setup steps
 * that do not match the URLs the code serves.
 *
 * THE RULE (lib/slack/own-app.ts slackAppKindFor, 2026-10-02 review): OASIS's
 * own workspaces use OASIS's app and only it; a client uses its own app and
 * never OASIS's. So a client with nothing saved is refused at Add to Slack and
 * at the callback even where OASIS's app is set up; OASIS's workspace ignores a
 * Slack app it saved; OASIS's Request URLs act only for OASIS's workspaces; and
 * Disconnect switches the bot token off at Slack (auth.revoke) before deleting
 * anything, saying so when Slack does not confirm it.
 *
 * Real routes, real session, real encrypted key store, real install, state and
 * signature checks on a local libSQL file (migrations bravo__187 and
 * bravo__197). Slack's oauth.v2.access, auth.test and auth.revoke are mocked at
 * the fetch boundary (they check which app's client ID and secret were used,
 * and which token was switched off); any other host fails the test. OASIS's
 * own Slack app path keeps its own suites (tests/slack-oauth.test.ts,
 * tests/slack-events.test.ts).
 *
 * Run: node --conditions=react-server --import tsx tests/slack-own-app.test.ts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createClient } from "@libsql/client";

const dbFile = join(mkdtempSync(join(tmpdir(), "slack-own-app-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
process.env.EMPIRE_AUTH_BACKEND = "turso";
process.env.AUTH_SESSION_SECRET = "slack-own-app-test-session-secret-long-enough-0001";
process.env.BRAVO_FIELD_ENCRYPTION_KEY = "slack-own-app-test-field-encryption-passphrase";
process.env.PUBLIC_APP_URL = "https://oasisai.work";
// OASIS's own Slack app (the Worker secrets): off unless a check turns it on.
const OASIS_APP_ENV = {
  SLACK_CLIENT_ID: "9999999999.8888888888",
  SLACK_CLIENT_SECRET: "oasisappclientsecret000000000001",
  SLACK_SIGNING_SECRET: "oasisappsigningsecret00000000001",
} as const;
const STATE_SECRET = "slack-own-app-test-state-secret-long-enough-000001";
for (const k of [...Object.keys(OASIS_APP_ENV), "LIVE_SEND_SLACK"]) delete process.env[k];
// Every install's consent state is signed with OASIS's own secret, own apps included.
process.env.CONNECTIONS_OAUTH_STATE_SECRET = STATE_SECRET;
function withOasisApp<T>(fn: () => Promise<T>): Promise<T> {
  Object.assign(process.env, OASIS_APP_ENV);
  return fn().finally(() => {
    for (const k of Object.keys(OASIS_APP_ENV)) delete process.env[k];
  });
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
// next/server's after() needs a live request scope; the interactivity route's
// work is collected here so a check can see it was handed over, not run.
const laterTasks: Array<() => unknown> = [];
{
  const p = require.resolve("next/server");
  const real = require(p) as Record<string, unknown>;
  require.cache[p] = {
    id: p,
    filename: p,
    path: dirname(p),
    loaded: true,
    children: [],
    paths: [],
    exports: { ...real, after: (task: () => unknown) => void laterTasks.push(task) },
  } as unknown as NodeModule;
}

const CLIENT_A = "c1c1c1c1-0000-4000-8000-0000000000c1";
const CLIENT_B = "c2c2c2c2-0000-4000-8000-0000000000c2";
const OASIS = "ef8d389e-3f15-43f2-ae00-3660f69a1452"; // OASIS's own workspace (an env-credential tenant)
type U = { id: string; email: string };
const USERS: Record<"ownerA" | "memberA" | "ownerB" | "oasisOwner", U> = {
  ownerA: { id: "0e100000-0000-4000-8000-000000000001", email: "owner@client-a.test" },
  memberA: { id: "0e100000-0000-4000-8000-000000000002", email: "member@client-a.test" },
  ownerB: { id: "0e100000-0000-4000-8000-000000000003", email: "owner@client-b.test" },
  oasisOwner: { id: "0e100000-0000-4000-8000-000000000004", email: "founder@oasisai.work" },
};
async function login(user: U | null) {
  if (!user) {
    sessionCookie = undefined;
    return;
  }
  const { signSession } = await import("../lib/turso-auth");
  sessionCookie = signSession({ sub: user.id, email: user.email, exp: Math.floor(Date.now() / 1000) + 3600, ver: 0 });
}

// Each workspace's own Slack app, as its admin created it in its own Slack.
const APP_A = { client_id: "1111111111.2222222222", client_secret: "clientasecret0000000000000000000a", signing_secret: "clientasigning000000000000000000a" };
const APP_B = { client_id: "3333333333.4444444444", client_secret: "clientbsecret0000000000000000000b", signing_secret: "clientbsigning000000000000000000b" };

// Slack at the fetch boundary. A code was issued by ONE app: the exchange only
// works with that app's own client ID and secret.
const APPS: Record<string, string> = {
  [APP_A.client_id]: APP_A.client_secret,
  [APP_B.client_id]: APP_B.client_secret,
  [OASIS_APP_ENV.SLACK_CLIENT_ID]: OASIS_APP_ENV.SLACK_CLIENT_SECRET,
};
const CODES: Record<string, { app: string; team: string; name: string; token: string }> = {
  "code-a": { app: APP_A.client_id, team: "T0CLIENTA", name: "Client A Slack", token: "xoxb-client-a-own-app" },
  "code-b": { app: APP_B.client_id, team: "T0CLIENTB", name: "Client B Slack", token: "xoxb-client-b-own-app" },
  "code-oasis": { app: OASIS_APP_ENV.SLACK_CLIENT_ID, team: "T0OASIS", name: "OASIS Slack", token: "xoxb-oasis-app" },
  // OASIS's app installed in CLIENT B's Slack: a code OASIS's app really issues.
  "code-b-oasis": { app: OASIS_APP_ENV.SLACK_CLIENT_ID, team: "T0CLIENTB", name: "Client B Slack", token: "xoxb-client-b-oasis-app" },
};
const exchanges: Array<Record<string, string>> = [];
// auth.revoke: every token a disconnect sent, in order; the tokens Slack has
// switched off; and how the next revoke fails (null: Slack answers normally).
const revocations: string[] = [];
const revokedAtSlack = new Set<string>();
let revokeFails: null | "fatal_error" | "not_revoked" | "rate_limited" | "network" = null;
// Every host + path the code called, so a check can prove a call never happened.
const calls: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(href);
  calls.push(`${url.hostname}${url.pathname}`);
  if (url.hostname !== "slack.com") throw new Error(`unexpected network call in test: ${href}`);
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  if (url.pathname === "/api/oauth.v2.access") {
    const form = Object.fromEntries(new URLSearchParams(String(init?.body ?? "")));
    exchanges.push(form);
    if (APPS[form.client_id] === undefined || APPS[form.client_id] !== form.client_secret) return json({ ok: false, error: "invalid_client" });
    const c = CODES[form.code];
    if (!c || c.app !== form.client_id) return json({ ok: false, error: "invalid_code" });
    return json({ ok: true, access_token: c.token, token_type: "bot", scope: "app_mentions:read,chat:write", bot_user_id: "UBOT", team: { id: c.team, name: c.name } });
  }
  if (url.pathname === "/api/auth.test") {
    const token = (new Headers(init?.headers).get("authorization") || "").replace(/^Bearer /, "");
    const c = Object.values(CODES).find((x) => x.token === token);
    if (c && revokedAtSlack.has(token)) return json({ ok: false, error: "token_revoked" });
    return json(c ? { ok: true, team_id: c.team, team: c.name } : { ok: false, error: "invalid_auth" });
  }
  if (url.pathname === "/api/auth.revoke") {
    const token = (new Headers(init?.headers).get("authorization") || "").replace(/^Bearer /, "");
    revocations.push(token);
    if (revokeFails === "network") throw new TypeError("fetch failed");
    if (revokeFails === "rate_limited") {
      return new Response(JSON.stringify({ ok: false, error: "ratelimited" }), { status: 429, headers: { "content-type": "application/json", "retry-after": "30" } });
    }
    if (revokeFails === "fatal_error") return json({ ok: false, error: "fatal_error" });
    if (revokeFails === "not_revoked") return json({ ok: true, revoked: false });
    if (!Object.values(CODES).some((x) => x.token === token)) return json({ ok: false, error: "invalid_auth" });
    if (revokedAtSlack.has(token)) return json({ ok: false, error: "token_revoked" });
    revokedAtSlack.add(token);
    return json({ ok: true, revoked: true });
  }
  return json({ ok: false, error: "unknown_method" });
}) as typeof fetch;

/** Slack's v0 signature, from Slack's published algorithm (not the app's code). */
function slackSigned(secret: string, body: string, at = Math.floor(Date.now() / 1000)): { timestamp: string; signature: string } {
  const timestamp = String(at);
  return { timestamp, signature: `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}` };
}

let failures = 0;
let passed = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${(e as Error).stack?.split("\n").slice(0, 8).join("\n        ")}`);
  }
}

const root = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

async function main() {
  const db = createClient({ url: `file:${dbFile}` });
  await db.executeMultiple(`
    CREATE TABLE "_supabase_auth_users" (id TEXT PRIMARY KEY, email TEXT NOT NULL,
      session_version INTEGER NOT NULL DEFAULT 0, banned_until TEXT, deleted_at TEXT);
    CREATE TABLE user_profiles (id TEXT PRIMARY KEY, auth_user_id TEXT, email TEXT, tenant_id TEXT,
      team_role TEXT, is_owner INTEGER DEFAULT 0, admin_access INTEGER DEFAULT 0,
      onboarding_completed_at TEXT, updated_at TEXT, deactivated_at TEXT);
    CREATE TABLE tenants (id TEXT PRIMARY KEY, slug TEXT, name TEXT);
    CREATE TABLE tenant_manifests (id TEXT PRIMARY KEY, tenant_id TEXT, slug TEXT UNIQUE, manifest TEXT,
      version INTEGER, schema_version INTEGER, created_at TEXT, updated_at TEXT);
    CREATE TABLE "tenant_integration_credentials" (
      "id" TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))),
      "tenant_id" TEXT NOT NULL, "service" TEXT NOT NULL, "field_key" TEXT NOT NULL,
      "encrypted_value" TEXT NOT NULL, "last_tested_at" TEXT, "last_test_ok" INTEGER, "last_test_error" TEXT,
      "created_by" TEXT,
      "created_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      "updated_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      PRIMARY KEY ("id"));
    CREATE UNIQUE INDEX "tic_key" ON "tenant_integration_credentials" (tenant_id, service, field_key);
    CREATE TABLE "tenant_audit_log" (
      "id" TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))),
      "tenant_id" TEXT NOT NULL, "actor_user_id" TEXT, "actor_email" TEXT, "action_type" TEXT NOT NULL,
      "target_table" TEXT, "target_id" TEXT, "before" TEXT, "after" TEXT, "ip_hash" TEXT, "user_agent" TEXT,
      "metadata" TEXT NOT NULL DEFAULT '{}',
      "created_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), PRIMARY KEY ("id"));
    CREATE TABLE agent_events (id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), event_type TEXT, publisher_agent TEXT,
      target_agent TEXT, severity TEXT, payload TEXT, correlation_id TEXT, status TEXT, published_at TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
    CREATE TABLE integrations_health (tenant_id TEXT, service TEXT, status TEXT, last_ping_at TEXT);
    CREATE TABLE user_integration_credentials (id TEXT PRIMARY KEY, tenant_id TEXT, user_id TEXT, service TEXT,
      field_key TEXT, encrypted_value TEXT, last_tested_at TEXT, last_test_ok INTEGER, last_test_error TEXT, updated_at TEXT);
  `);
  await db.executeMultiple(read("database/turso/bravo__187_os_connections.sql"));
  await db.executeMultiple(read("database/turso/bravo__197_slack_jev.sql"));
  const stamp = "2026-09-01T00:00:00Z";
  const profile = (user: U, tenant: string, role: string, owner: 0 | 1 = 0) => ({
    sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, onboarding_completed_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [`p-${user.id}`, user.id, user.email, tenant, role, owner, stamp, stamp],
  });
  await db.batch(
    [
      ...Object.values(USERS).map((x) => ({ sql: `INSERT INTO "_supabase_auth_users" (id, email) VALUES (?, ?)`, args: [x.id, x.email] })),
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'client-a', 'Client A')", args: [CLIENT_A] },
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'client-b', 'Client B')", args: [CLIENT_B] },
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'oasis-ai-cc', 'OASIS AI')", args: [OASIS] },
      profile(USERS.ownerA, CLIENT_A, "owner", 1),
      profile(USERS.memberA, CLIENT_A, "member"),
      profile(USERS.ownerB, CLIENT_B, "owner", 1),
      profile(USERS.oasisOwner, OASIS, "owner", 1),
    ],
    "write",
  );

  const { NextRequest } = await import("next/server");
  const keysRoute = await import("../app/api/integrations/keys/route");
  const appRoute = await import("../app/api/integrations/slack/app/route");
  const authorizeRoute = await import("../app/api/connections/[provider]/authorize/route");
  const callbackRoute = await import("../app/api/connections/[provider]/callback/route");
  const eventsRoute = await import("../app/api/webhooks/slack/events/route");
  const interactivityRoute = await import("../app/api/webhooks/slack/interactivity/route");
  const disconnectRoute = await import("../app/api/connections/[provider]/disconnect/route");
  const interactivity = await import("../lib/slack/interactivity");
  const ownApp = await import("../lib/slack/own-app");
  const registry = await import("../lib/connections/registry");
  const oauthLib = await import("../lib/connections/oauth");
  const { credentialServiceFor } = await import("../lib/connections/rules");
  const { loadConnectorStatuses, loadConnectorFacts } = await import("../components/os/connections/connector-facts");
  const { loadSlackSettings } = await import("../lib/slack/settings");
  const { decryptField } = await import("../lib/field-encryption");
  const { APPROVE_ACTION_ID } = await import("../lib/slack/send");

  type Json = Record<string, unknown>;
  const toJson = async (r: Response) => ({ status: r.status, body: (await r.json().catch(() => ({}))) as Json });
  const jsonReq = (url: string, method: string, body?: unknown) =>
    new NextRequest(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const saveApp = async (field_key: string, value: string) =>
    toJson(await keysRoute.POST(jsonReq("https://oasisai.work/api/integrations/keys", "POST", { service: "slack_app", field_key, value })));
  const removeApp = async (field_key: string) =>
    toJson(await keysRoute.DELETE(jsonReq("https://oasisai.work/api/integrations/keys", "DELETE", { service: "slack_app", field_key })));
  const ctx = (provider: string) => ({ params: Promise.resolve({ provider }) });
  const authorize = () => authorizeRoute.GET(new NextRequest("https://oasisai.work/api/connections/slack/authorize"), ctx("slack"));
  const callback = (q: Record<string, string>) =>
    callbackRoute.GET(new NextRequest(`https://oasisai.work/api/connections/slack/callback?${new URLSearchParams(q)}`), ctx("slack"));
  const landed = (r: Response) => new URL(r.headers.get("location") ?? "https://x.invalid/");
  const count = async (sql: string, args: unknown[] = []) => Number((await db.execute({ sql, args: args as never })).rows[0].n);
  const slackStatus = async (tenantId: string, userId: string) => (await loadConnectorStatuses({ tenantId, userId })).slack;
  const post = (route: { POST: (r: InstanceType<typeof NextRequest>) => Promise<Response> }, url: string, body: string, secret: string | null, type = "application/json") => {
    const s = secret ? slackSigned(secret, body) : null;
    return route.POST(
      new NextRequest(url, {
        method: "POST",
        body,
        headers: { "content-type": type, ...(s ? { "x-slack-request-timestamp": s.timestamp, "x-slack-signature": s.signature } : {}) },
      }),
    );
  };
  const eventsUrl = (workspace?: string) => `https://oasisai.work/api/webhooks/slack/events${workspace === undefined ? "" : `?workspace=${encodeURIComponent(workspace)}`}`;
  const verification = JSON.stringify({ type: "url_verification", challenge: "challenge-own-app", token: "legacy" });
  const messageEvent = (team: string, id: string) =>
    JSON.stringify({
      type: "event_callback",
      team_id: team,
      event_id: id,
      event: { type: "message", channel_type: "channel", channel: "C0GENERAL", user: "U0PERSON", ts: "1727712000.000100", text: "hello" },
    });

  console.log("slack-own-app:");

  // -- 1. The workspace's own app, saved -------------------------------------------

  await check("a client owner saves its own Slack app (client ID, client secret, signing secret) encrypted; malformed values and a member are refused", async () => {
    await login(USERS.ownerA);
    assert.equal((await saveApp("client_id", "not-a-client-id")).status, 422);
    assert.equal((await saveApp("signing_secret", "has spaces in it 0000")).status, 422);
    for (const [k, v] of Object.entries(APP_A)) {
      const r = await saveApp(k, v);
      assert.equal(r.status, 200, `${k}: ${JSON.stringify(r.body)}`);
    }
    const rows = (await db.execute({ sql: "SELECT field_key, encrypted_value FROM tenant_integration_credentials WHERE tenant_id = ? AND service = 'slack_app'", args: [CLIENT_A] })).rows;
    assert.equal(rows.length, 3);
    for (const r of rows) {
      const plain = APP_A[String(r.field_key) as keyof typeof APP_A];
      assert.notEqual(String(r.encrypted_value), plain, "never stored in plain text");
      assert.equal(decryptField(String(r.encrypted_value)), plain);
    }
    await login(USERS.memberA);
    assert.equal((await saveApp("client_id", APP_B.client_id)).status, 403);
    assert.deepEqual(await ownApp.readSlackOwnApp(CLIENT_A), {
      state: "saved",
      app: { clientId: APP_A.client_id, clientSecret: APP_A.client_secret, signingSecret: APP_A.signing_secret },
    });
  });

  let setup: Json = {};
  await check("the drawer's setup is generated from the code that receives it: this workspace's Request URLs, the install's redirect URL and scopes, one manifest", async () => {
    await login(USERS.memberA);
    assert.equal((await appRoute.GET()).status, 403, "owners and admins only");
    await login(USERS.ownerA);
    const r = await toJson(await appRoute.GET());
    assert.equal(r.status, 200, JSON.stringify(r.body));
    setup = r.body;
    assert.equal(setup.redirect_url, "https://oasisai.work/api/connections/slack/callback");
    assert.equal(setup.events_url, `https://oasisai.work/api/webhooks/slack/events?workspace=${CLIENT_A}`);
    assert.equal(setup.interactivity_url, `https://oasisai.work/api/webhooks/slack/interactivity?workspace=${CLIENT_A}`);
    assert.deepEqual(setup.bot_scopes, [...registry.providerById("slack")!.scopes.base]);
    assert.deepEqual(setup.bot_events, ["app_mention", "message.channels"]);
    const m = setup.manifest as { oauth_config: { redirect_urls: string[]; scopes: { bot: string[] } }; settings: { event_subscriptions: { request_url: string; bot_events: string[] }; interactivity: { is_enabled: boolean; request_url: string } } };
    assert.deepEqual(m.oauth_config.redirect_urls, [setup.redirect_url]);
    assert.deepEqual(m.oauth_config.scopes.bot, setup.bot_scopes);
    assert.equal(m.settings.event_subscriptions.request_url, setup.events_url);
    assert.deepEqual(m.settings.event_subscriptions.bot_events, setup.bot_events);
    assert.deepEqual([m.settings.interactivity.is_enabled, m.settings.interactivity.request_url], [true, setup.interactivity_url]);
    assert.deepEqual([setup.app, setup.installs_possible], ["saved", true]);
    assert.ok(!JSON.stringify(setup).includes(APP_A.client_secret) && !JSON.stringify(setup).includes(APP_A.signing_secret), "no secret in the response");
  });

  // -- 2. The card and Chat apps: a saved own app is configured ---------------------

  await check("with OASIS's app absent, a client's card is Not connected (its own app to set up), and a saved own app counts as configured", async () => {
    const b = await slackStatus(CLIENT_B, USERS.ownerB.id);
    assert.deepEqual([b.kind, b.label], ["not_connected", "Not connected"]);
    assert.match(String(b.detail), /Create your Slack app from the steps here/);
    assert.deepEqual(b.paths?.map((p) => [p.title, p.state, p.requestable, p.setup]), [["Your own Slack app", "Not set up yet", false, "slack_own_app"]]);
    const a = await slackStatus(CLIENT_A, USERS.ownerA.id);
    assert.deepEqual([a.kind, a.paths?.[0].state], ["not_connected", "Saved"]);
    assert.match(String(a.detail), /Your Slack app is saved\. Press Add to Slack under Chat apps/);
    // appNotConfigured: OASIS's app is missing here, but A has its own app.
    assert.deepEqual((await loadConnectorFacts({ tenantId: CLIENT_A, userId: USERS.ownerA.id })).appNotConfigured, []);
    assert.deepEqual((await loadConnectorFacts({ tenantId: CLIENT_B, userId: USERS.ownerB.id })).appNotConfigured, ["slack"]);
    const sa = await loadSlackSettings(db, CLIENT_A, { nowMs: Date.now() });
    assert.deepEqual([sa.appConfigured, sa.installApp, sa.ownApp, sa.oasisWorkspace], [true, "own", "saved", false]);
    const sb = await loadSlackSettings(db, CLIENT_B, { nowMs: Date.now() });
    assert.deepEqual([sb.appConfigured, sb.installApp, sb.ownApp], [false, null, "none"]);
    // Even with OASIS's app on the deployment, a client is offered its own app, never OASIS's.
    const sbWithOasis = await withOasisApp(() => loadSlackSettings(db, CLIENT_B, { nowMs: Date.now() }));
    assert.deepEqual([sbWithOasis.appConfigured, sbWithOasis.installApp], [false, null]);
  });

  // -- 3. Add to Slack with the workspace's own app ---------------------------------

  await check("Add to Slack sends the client's OWN client ID with a signed single-use state; the callback finishes with its OWN secret and connects that team to that workspace", async () => {
    await login(USERS.ownerA);
    const res = await authorize();
    assert.equal(res.status, 303);
    const loc = landed(res);
    assert.equal(loc.origin + loc.pathname, "https://slack.com/oauth/v2/authorize");
    assert.equal(loc.searchParams.get("client_id"), APP_A.client_id, "the client's app, not OASIS's");
    assert.equal(loc.searchParams.get("redirect_uri"), setup.redirect_url, "the redirect URL the setup told the client to add");
    assert.equal(loc.searchParams.get("scope"), (setup.bot_scopes as string[]).join(","));
    const state = loc.searchParams.get("state") ?? "";
    const done = await callback({ code: "code-a", state });
    assert.equal(landed(done).searchParams.get("slack"), "connected", landed(done).search);
    const exchange = exchanges.at(-1)!;
    assert.deepEqual([exchange.client_id, exchange.client_secret], [APP_A.client_id, APP_A.client_secret]);
    const route = (await db.execute("SELECT tenant_id FROM provider_webhook_routes WHERE provider = 'slack' AND external_key = 'T0CLIENTA'")).rows;
    assert.deepEqual(route.map((r) => String(r.tenant_id)), [CLIENT_A]);
    const a = await slackStatus(CLIENT_A, USERS.ownerA.id);
    assert.equal(a.kind, "connected", JSON.stringify(a));
    assert.equal(a.account, "Client A Slack");
    // The state was single-use, as for OASIS's app.
    assert.equal(landed(await callback({ code: "code-a", state })).searchParams.get("reason"), "state_invalid");
  });

  await check("a client with no Slack app of its own is never given OASIS's app, even where OASIS's app is set up: Add to Slack refuses and nothing starts", async () => {
    await login(USERS.ownerB);
    assert.equal((await ownApp.readSlackOwnApp(CLIENT_B)).state, "none");
    const before = await count("SELECT COUNT(*) AS n FROM oauth_states");
    await withOasisApp(async () => {
      const to = landed(await authorize());
      assert.equal(to.origin + to.pathname, "https://oasisai.work/settings/chat-apps", "never sent to Slack with OASIS's client ID");
      assert.equal(to.searchParams.get("reason"), "own_app_missing");
      assert.deepEqual(await ownApp.slackInstallEnv(CLIENT_B), { ok: false, reason: "own_app_missing" });
    });
    assert.equal(await count("SELECT COUNT(*) AS n FROM oauth_states"), before, "no consent started");
  });

  await check("the callback refuses a client with no Slack app of its own, even with a valid state and OASIS's app set up: no code exchanged, nothing connected", async () => {
    // A signed, stored, unexpired state naming OASIS's app for this client:
    // exactly what Add to Slack issued a client with nothing saved before the
    // rule. With it, a code OASIS's app really issued for the client's Slack.
    const oasisEnv = { ...process.env, ...OASIS_APP_ENV };
    const started = await oauthLib.startAuthorize(db, {
      provider: registry.providerForEnv("slack", oasisEnv)!,
      tenantId: CLIENT_B,
      userId: USERS.ownerB.id,
      scopes: [...registry.providerById("slack")!.scopes.base],
      redirectUri: "https://oasisai.work/api/connections/slack/callback",
      now: new Date(),
      env: oasisEnv,
    });
    await login(USERS.ownerB);
    const exchangesBefore = exchanges.length;
    await withOasisApp(async () => {
      const done = landed(await callback({ code: "code-b-oasis", state: started.state }));
      assert.equal(done.searchParams.get("slack"), "error", done.search);
      assert.equal(done.searchParams.get("reason"), "own_app_missing");
    });
    assert.equal(exchanges.length, exchangesBefore, "OASIS's client secret never met the client's code");
    assert.equal(await count("SELECT COUNT(*) AS n FROM tenant_connections WHERE tenant_id = ? AND provider = 'slack'", [CLIENT_B]), 0);
    assert.equal(await count("SELECT COUNT(*) AS n FROM provider_webhook_routes WHERE external_key = 'T0CLIENTB'"), 0);
  });

  await check("a half-saved app is refused, never swapped for OASIS's app, even where OASIS's app is set up; nothing starts", async () => {
    await login(USERS.ownerB);
    assert.equal((await saveApp("client_id", APP_B.client_id)).status, 200);
    const before = await count("SELECT COUNT(*) AS n FROM oauth_states");
    await withOasisApp(async () => {
      const res = await authorize();
      assert.equal(landed(res).searchParams.get("reason"), "own_app_incomplete");
    });
    assert.equal(await count("SELECT COUNT(*) AS n FROM oauth_states"), before);
    assert.deepEqual((await slackStatus(CLIENT_B, USERS.ownerB.id)).paths?.map((p) => p.state), ["Some details missing"]);
  });

  await check("OASIS's own workspace (no app of its own saved) still installs the OASIS app from the Worker secrets", async () => {
    await withOasisApp(async () => {
      await login(USERS.oasisOwner);
      const loc = landed(await authorize());
      assert.equal(loc.searchParams.get("client_id"), OASIS_APP_ENV.SLACK_CLIENT_ID);
      const done = await callback({ code: "code-oasis", state: loc.searchParams.get("state") ?? "" });
      assert.equal(landed(done).searchParams.get("slack"), "connected", landed(done).search);
      assert.deepEqual([exchanges.at(-1)!.client_id, exchanges.at(-1)!.client_secret], [OASIS_APP_ENV.SLACK_CLIENT_ID, OASIS_APP_ENV.SLACK_CLIENT_SECRET]);
      const status = await slackStatus(OASIS, USERS.oasisOwner.id);
      assert.equal(status.kind, "connected");
      assert.deepEqual(status.paths?.map((p) => [p.title, p.state]), [["The OASIS Slack app", "Available"]]);
    });
  });

  // A Slack app OASIS's own workspace saved anyway: well formed, and inert. It
  // stays saved to the end, so the later checks also prove it is never read
  // as OASIS's workspace's app (presence, the hourly pass).
  const APP_O = { client_id: "5555555555.6666666666", client_secret: "oasissavedclientsecret0000000000", signing_secret: "oasissavedsigningsecret000000000" };

  await check("OASIS's own workspace installs OASIS's app even with a Slack app saved: the saved one plays no part and has no Request URL", async () => {
    await login(USERS.oasisOwner);
    for (const [k, v] of Object.entries(APP_O)) assert.equal((await saveApp(k, v)).status, 200, k);
    assert.equal((await ownApp.readSlackOwnApp(OASIS)).state, "saved");
    await withOasisApp(async () => {
      const loc = landed(await authorize());
      assert.equal(loc.searchParams.get("client_id"), OASIS_APP_ENV.SLACK_CLIENT_ID, "OASIS's app, not the saved one");
      const done = await callback({ code: "code-oasis", state: loc.searchParams.get("state") ?? "" });
      assert.equal(landed(done).searchParams.get("slack"), "connected", landed(done).search);
      assert.deepEqual([exchanges.at(-1)!.client_id, exchanges.at(-1)!.client_secret], [OASIS_APP_ENV.SLACK_CLIENT_ID, OASIS_APP_ENV.SLACK_CLIENT_SECRET]);
      const s = await loadSlackSettings(db, OASIS, { nowMs: Date.now() });
      assert.deepEqual([s.installApp, s.ownApp, s.oasisWorkspace], ["oasis", "none", true]);
    });
    // Where OASIS's app is not set up, the saved app does not stand in for it.
    const off = await loadSlackSettings(db, OASIS, { nowMs: Date.now() });
    assert.deepEqual([off.appConfigured, off.installApp], [false, null]);
    assert.deepEqual((await loadConnectorFacts({ tenantId: OASIS, userId: USERS.oasisOwner.id })).appNotConfigured, ["slack"]);
    // And a request signed with the saved app's secret has no URL to arrive at,
    // so none is handed out: the own-app setup is a client's only.
    const r = await toJson(await post(eventsRoute, eventsUrl(OASIS), verification, APP_O.signing_secret));
    assert.deepEqual([r.status, r.body.error], [404, "workspace_app_not_found"]);
    const setupForOasis = await toJson(await appRoute.GET());
    assert.deepEqual([setupForOasis.status, setupForOasis.body.error], [409, "oasis_workspace_uses_oasis_app"]);
    assert.equal(setupForOasis.body.events_url, undefined, "no Request URL handed out");
  });

  // -- 4. The workspace's own Request URLs ------------------------------------------

  await check("events at a workspace's own Request URL are checked with THAT workspace's signing secret only", async () => {
    const ok = await toJson(await post(eventsRoute, String(setup.events_url), verification, APP_A.signing_secret));
    assert.deepEqual([ok.status, ok.body.challenge], [200, "challenge-own-app"]);
    for (const [who, secret] of [["OASIS's app", OASIS_APP_ENV.SLACK_SIGNING_SECRET], ["another workspace's app", APP_B.signing_secret], ["nobody", null]] as const) {
      const r = await post(eventsRoute, String(setup.events_url), verification, secret);
      assert.equal(r.status, 401, who);
    }
    // And the workspace's secret is not OASIS's: OASIS's own URL refuses it.
    await withOasisApp(async () => {
      assert.equal((await post(eventsRoute, eventsUrl(), verification, APP_A.signing_secret)).status, 401);
      assert.equal((await post(eventsRoute, eventsUrl(), verification, OASIS_APP_ENV.SLACK_SIGNING_SECRET)).status, 200, "OASIS's URL, unchanged");
    });
  });

  await check("a workspace's own app speaks only for the Slack team routed to it: an event naming another workspace's team is dropped and nothing is written", async () => {
    const receipts = async () => count("SELECT COUNT(*) AS n FROM slack_event_receipts");
    const before = await receipts();
    const forged = await toJson(await post(eventsRoute, String(setup.events_url), messageEvent("T0OASIS", "EvFORGED0001"), APP_A.signing_secret));
    assert.deepEqual([forged.status, forged.body.dropped], [200, "team_not_this_workspace"]);
    // Its own team gets through the check (an unmapped channel is then ignored).
    const own = await toJson(await post(eventsRoute, String(setup.events_url), messageEvent("T0CLIENTA", "EvOWNTEAM0001"), APP_A.signing_secret));
    assert.deepEqual([own.status, own.body.ignored], [200, "channel_not_mapped"]);
    assert.equal(await receipts(), before);
  });

  await check("OASIS's Request URL acts only for OASIS's own workspaces: an OASIS-signed event naming a client's Slack team is dropped; OASIS's own team still gets through", async () => {
    const receipts = async () => count("SELECT COUNT(*) AS n FROM slack_event_receipts");
    const before = await receipts();
    await withOasisApp(async () => {
      const forged = await toJson(await post(eventsRoute, eventsUrl(), messageEvent("T0CLIENTA", "EvOASISFORGE1"), OASIS_APP_ENV.SLACK_SIGNING_SECRET));
      assert.deepEqual([forged.status, forged.body.dropped], [200, "team_not_this_workspace"], JSON.stringify(forged.body));
      const own = await toJson(await post(eventsRoute, eventsUrl(), messageEvent("T0OASIS", "EvOASISOWN001"), OASIS_APP_ENV.SLACK_SIGNING_SECRET));
      assert.deepEqual([own.status, own.body.ignored], [200, "channel_not_mapped"], "OASIS's own team passes the app check");
    });
    assert.equal(await receipts(), before);
    // The rule both ways round: an app speaks only for the workspaces that use it.
    assert.equal(ownApp.slackAppMaySpeakFor({ kind: "oasis" }, OASIS), true);
    assert.equal(ownApp.slackAppMaySpeakFor({ kind: "oasis" }, CLIENT_A), false);
    assert.equal(ownApp.slackAppMaySpeakFor({ kind: "own", tenantId: CLIENT_A }, CLIENT_A), true);
    assert.equal(ownApp.slackAppMaySpeakFor({ kind: "own", tenantId: CLIENT_A }, CLIENT_B), false);
    assert.equal(ownApp.slackAppMaySpeakFor({ kind: "own", tenantId: OASIS }, OASIS), false, "an OASIS workspace has no app of its own");
  });

  await check("OASIS's Interactivity URL acts only for OASIS's own workspaces: an OASIS-signed press for a client's Slack team decides nothing and calls nothing", async () => {
    const payload = {
      type: "block_actions",
      team: { id: "T0CLIENTA" },
      user: { id: "U0PERSON" },
      response_url: "https://hooks.slack.com/actions/T0CLIENTA/1/x",
      actions: [{ action_id: APPROVE_ACTION_ID, value: `${randomUUID()}|${"a".repeat(64)}` }],
    };
    const body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
    await withOasisApp(async () => {
      laterTasks.length = 0;
      const res = await post(interactivityRoute, "https://oasisai.work/api/webhooks/slack/interactivity", body, OASIS_APP_ENV.SLACK_SIGNING_SECRET, "application/x-www-form-urlencoded");
      assert.equal(res.status, 200, "Slack is answered");
      assert.equal(laterTasks.length, 1);
      const callsBefore = calls.length;
      await laterTasks[0]();
      assert.deepEqual(calls.slice(callsBefore), [], "no users.info lookup and no card update for a client's team");
      // The handler itself, as any caller that names no app gets it: OASIS's.
      const s = slackSigned(OASIS_APP_ENV.SLACK_SIGNING_SECRET, body);
      const outcome = await interactivity.handleSlackInteractivity({ rawBody: body, timestamp: s.timestamp, signature: s.signature }, { db, now: () => new Date() });
      assert.equal(outcome.body.ignored, "team_not_this_workspace");
    });
  });

  await check("an unknown workspace, a malformed one, or one with no complete saved app has no Request URL: 404, nothing processed", async () => {
    for (const w of ["not-a-workspace", randomUUID(), CLIENT_B]) {
      const r = await toJson(await post(eventsRoute, eventsUrl(w), verification, APP_A.signing_secret));
      assert.deepEqual([r.status, r.body.error], [404, "workspace_app_not_found"], w);
    }
  });

  await check("button presses at a workspace's own Interactivity URL: checked with its secret; a press for another workspace's team decides nothing", async () => {
    const payload = {
      type: "block_actions",
      team: { id: "T0OASIS" },
      user: { id: "U0PERSON" },
      response_url: "https://hooks.slack.com/actions/T0OASIS/1/x",
      actions: [{ action_id: APPROVE_ACTION_ID, value: `${randomUUID()}|${"a".repeat(64)}` }],
    };
    const body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
    const form = "application/x-www-form-urlencoded";
    laterTasks.length = 0;
    assert.equal((await post(interactivityRoute, String(setup.interactivity_url), body, APP_B.signing_secret, form)).status, 401);
    assert.equal(laterTasks.length, 0, "a forged press leaves no work");
    assert.equal((await post(interactivityRoute, String(setup.interactivity_url), body, APP_A.signing_secret, form)).status, 200);
    assert.equal(laterTasks.length, 1, "the press is answered, its work handed over");
    // The work itself, as the route runs it, under A's own app.
    const scope = await ownApp.slackRequestScope(CLIENT_A);
    assert.ok(scope.ok);
    const s = slackSigned(APP_A.signing_secret, body);
    const outcome = await interactivity.handleSlackInteractivity(
      { rawBody: body, timestamp: s.timestamp, signature: s.signature },
      { db, now: () => new Date(), env: scope.ok ? scope.env : undefined, app: scope.ok ? scope.app : undefined },
    );
    assert.equal(outcome.body.ignored, "team_not_this_workspace");
  });

  await check("removing the saved app takes the workspace's Request URL down with it", async () => {
    await login(USERS.ownerA);
    assert.equal((await removeApp("signing_secret")).status, 200);
    try {
      const r = await toJson(await post(eventsRoute, String(setup.events_url), verification, APP_A.signing_secret));
      assert.deepEqual([r.status, r.body.error], [404, "workspace_app_not_found"]);
    } finally {
      assert.equal((await saveApp("signing_secret", APP_A.signing_secret)).status, 200);
    }
    assert.equal((await post(eventsRoute, String(setup.events_url), verification, APP_A.signing_secret)).status, 200);
  });

  await check("where OASIS's app is not set up, a client's own-app Slack connection stays checkable (Test again, the hourly pass) and present on its AI Team; one with no app here is neither", async () => {
    const health = await import("../lib/connections/health");
    const status = await import("../lib/slack/status");
    const testRoute = await import("../app/api/connections/[provider]/test/route");
    assert.equal(process.env.SLACK_SIGNING_SECRET, undefined, "OASIS's app is not set up in this check");
    await login(USERS.ownerA);
    const tested = await toJson(await testRoute.POST(new Request("https://oasisai.work/api/connections/slack/test", { method: "POST" }), ctx("slack")));
    assert.equal(tested.status, 200, JSON.stringify(tested.body));
    // The hourly pass: both Slack connections are due; only A's (its own app) is checkable here.
    const old = "2026-01-01T00:00:00.000Z";
    await db.execute({ sql: "UPDATE tenant_connections SET last_health_at = ? WHERE provider = 'slack' AND revoked_at IS NULL", args: [old] });
    const pass = await health.runConnectionHealthPass({ db, now: () => new Date() });
    assert.deepEqual([pass.checked, pass.errors], [1, []], JSON.stringify(pass));
    const lastCheck = async (tenantId: string) =>
      String((await db.execute({ sql: "SELECT last_health_at FROM tenant_connections WHERE tenant_id = ? AND provider = 'slack' AND revoked_at IS NULL", args: [tenantId] })).rows[0].last_health_at);
    assert.notEqual(await lastCheck(CLIENT_A), old, "A's own-app connection was re-checked");
    assert.equal(await lastCheck(OASIS), old, "OASIS's connection (no app set up here) was not picked, and raised no error");
    assert.equal((await slackStatus(CLIENT_A, USERS.ownerA.id)).kind, "connected");
    // Where each department lives in Slack (AI Team, department tab).
    assert.equal((await status.loadSlackPresence(db, CLIENT_A)).kind, "connected");
    assert.equal((await status.loadSlackPresence(db, OASIS)).kind, "not_configured");
  });

  // -- 5. Where installs cannot run, and what the drawer shows ----------------------

  await check("no consent-state secret on the deployment: a saved app says installs are not switched on, and Add to Slack says why", async () => {
    await login(USERS.ownerB);
    for (const [k, v] of Object.entries(APP_B)) assert.equal((await saveApp(k, v)).status, 200, k);
    delete process.env.CONNECTIONS_OAUTH_STATE_SECRET;
    try {
      const b = await slackStatus(CLIENT_B, USERS.ownerB.id);
      assert.deepEqual([b.kind, b.label], ["coming_soon", "Slack installs not switched on yet"]);
      assert.deepEqual(b.paths?.map((p) => p.state), ["Saved · installs not switched on here yet"]);
      assert.deepEqual((await loadConnectorFacts({ tenantId: CLIENT_B, userId: USERS.ownerB.id })).appNotConfigured, ["slack"]);
      const sb = await loadSlackSettings(db, CLIENT_B, { nowMs: Date.now() });
      assert.deepEqual([sb.appConfigured, sb.installApp, sb.installsUnavailable], [false, null, true]);
      const res = await authorize();
      assert.equal(landed(res).searchParams.get("reason"), "installs_unavailable");
    } finally {
      process.env.CONNECTIONS_OAUTH_STATE_SECRET = STATE_SECRET;
    }
    assert.deepEqual((await slackStatus(CLIENT_B, USERS.ownerB.id)).paths?.map((p) => p.state), ["Saved"]);
  });

  await check("a client's own app signs only at its own Request URL and only for its own team: A's or OASIS's secret at B's URL is refused; B's app naming A's team is dropped", async () => {
    const bUrl = eventsUrl(CLIENT_B);
    assert.equal((await post(eventsRoute, bUrl, verification, APP_A.signing_secret)).status, 401, "A's secret at B's URL");
    assert.equal((await post(eventsRoute, bUrl, verification, OASIS_APP_ENV.SLACK_SIGNING_SECRET)).status, 401, "OASIS's secret at B's URL");
    const ok = await toJson(await post(eventsRoute, bUrl, verification, APP_B.signing_secret));
    assert.deepEqual([ok.status, ok.body.challenge], [200, "challenge-own-app"], "B's own URL works for B");
    const forged = await toJson(await post(eventsRoute, bUrl, messageEvent("T0CLIENTA", "EvBFORGED0001"), APP_B.signing_secret));
    assert.deepEqual([forged.status, forged.body.dropped], [200, "team_not_this_workspace"]);
  });

  await check("the Slack drawer shows a client the setup steps and its app's form under its own path; OASIS's workspace never sees them", async () => {
    const client = await slackStatus(CLIENT_B, USERS.ownerB.id);
    const oasis = await slackStatus(OASIS, USERS.oasisOwner.id);
    const r = spawnSync(process.execPath, ["--import", "tsx", "tests/connections-everywhere.render.ts"], {
      cwd: root,
      input: JSON.stringify({
        cases: [
          { id: "client", kind: "drawer", slug: "slack", status: client },
          { id: "oasis", kind: "drawer", slug: "slack", status: oasis },
        ],
        clicks: [],
      }),
      encoding: "utf8",
      env: { ...process.env, NODE_OPTIONS: "" },
      maxBuffer: 32 * 1024 * 1024,
    });
    assert.equal(r.status, 0, r.stderr);
    const { markup } = JSON.parse(r.stdout) as { markup: Record<string, string> };
    const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
    assert.match(text(markup.client), /Your own Slack app Saved/);
    assert.match(text(markup.client), /Set up your Slack app/);
    assert.match(markup.client, /href="https:\/\/api\.slack\.com\/apps"/);
    assert.doesNotMatch(text(markup.client), /Ask OASIS for Slack/, "a built path offers no request");
    assert.doesNotMatch(text(markup.oasis), /Set up your Slack app|Your own Slack app/);
  });

  // -- 6. Disconnect switches the bot token off AT SLACK first --------------------

  const liveSlack = async (tenantId: string) =>
    (await db.execute({ sql: "SELECT id FROM tenant_connections WHERE tenant_id = ? AND provider = 'slack' AND revoked_at IS NULL", args: [tenantId] })).rows.map((r) => String(r.id));
  const disconnect = async () =>
    toJson(await disconnectRoute.POST(new Request("https://oasisai.work/api/connections/slack/disconnect", { method: "POST" }), ctx("slack")));
  const stillConnected = async (tenantId: string, team: string, why: string) => {
    const [id] = await liveSlack(tenantId);
    assert.ok(id, `${why}: the connection is still live`);
    const token = "SELECT COUNT(*) AS n FROM tenant_integration_credentials WHERE tenant_id = ? AND service = ? AND field_key = 'bot_token'";
    assert.equal(await count(token, [tenantId, credentialServiceFor(id)]), 1, `${why}: its token is still stored`);
    assert.equal(await count("SELECT COUNT(*) AS n FROM provider_webhook_routes WHERE tenant_id = ? AND external_key = ?", [tenantId, team]), 1, `${why}: its team still routes here`);
  };
  const A_TOKEN = CODES["code-a"].token;

  await check("Disconnect asks Slack to switch the bot token off before deleting anything; when Slack does not confirm it, nothing is deleted and the owner is told Slack is still connected", async () => {
    await login(USERS.ownerA);
    for (const mode of ["fatal_error", "not_revoked", "rate_limited", "network"] as const) {
      revokeFails = mode;
      const before = revocations.length;
      let r: Awaited<ReturnType<typeof disconnect>>;
      try {
        r = await disconnect();
      } finally {
        revokeFails = null;
      }
      assert.deepEqual(revocations.slice(before), [A_TOKEN], `${mode}: the switch-off was asked for, with A's own token`);
      assert.equal(r.status, 502, `${mode}: ${JSON.stringify(r.body)}`);
      assert.deepEqual([r.body.ok, r.body.error, r.body.disconnected], [false, "slack_revoke_failed", undefined], mode);
      assert.match(String(r.body.message), /Slack is still connected and nothing was deleted\. Try Disconnect again/);
      await stillConnected(CLIENT_A, "T0CLIENTA", mode);
    }
    // A stored token that cannot be read is never assumed off: nothing is sent, nothing deleted.
    const [id] = await liveSlack(CLIENT_A);
    const at = "WHERE tenant_id = ? AND service = ? AND field_key = 'bot_token'";
    const args = [CLIENT_A, credentialServiceFor(id)];
    const saved = String((await db.execute({ sql: `SELECT encrypted_value FROM tenant_integration_credentials ${at}`, args })).rows[0].encrypted_value);
    await db.execute({ sql: `UPDATE tenant_integration_credentials SET encrypted_value = 'not-a-ciphertext' ${at}`, args });
    try {
      const before = revocations.length;
      const r = await disconnect();
      assert.deepEqual([r.status, r.body.error, r.body.disconnected], [500, "slack_token_unreadable", undefined], JSON.stringify(r.body));
      assert.equal(revocations.length, before, "nothing sent to Slack");
    } finally {
      await db.execute({ sql: `UPDATE tenant_integration_credentials SET encrypted_value = ? ${at}`, args: [saved, ...args] });
    }
    await stillConnected(CLIENT_A, "T0CLIENTA", "unreadable token");
  });

  await check("with Slack's confirmation a client's own-app connection is removed, even where OASIS's app is not set up: token switched off at Slack, then deleted with its route; pressed again, nothing is sent", async () => {
    assert.equal(process.env.SLACK_CLIENT_ID, undefined, "OASIS's app is not set up in this check");
    await login(USERS.ownerA);
    const [id] = await liveSlack(CLIENT_A);
    const before = revocations.length;
    const r = await disconnect();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.disconnected, r.body.slack_token], [true, "revoked"]);
    assert.deepEqual(revocations.slice(before), [A_TOKEN], "switched off at Slack with A's own token");
    assert.ok(revokedAtSlack.has(A_TOKEN), "Slack holds it switched off");
    assert.deepEqual(await liveSlack(CLIENT_A), []);
    assert.equal(await count("SELECT COUNT(*) AS n FROM tenant_integration_credentials WHERE tenant_id = ? AND service = ?", [CLIENT_A, credentialServiceFor(id)]), 0, "the token is deleted");
    assert.equal(await count("SELECT COUNT(*) AS n FROM provider_webhook_routes WHERE tenant_id = ? AND provider = 'slack'", [CLIENT_A]), 0);
    const again = await disconnect();
    assert.deepEqual([again.status, again.body.already_disconnected], [200, true]);
    assert.equal(revocations.length, before + 1, "nothing connected, nothing sent");
  });

  await check("OASIS's own connection (OASIS's app) goes through the same switch-off; a token Slack already refuses counts as switched off", async () => {
    await login(USERS.oasisOwner);
    const OASIS_TOKEN = CODES["code-oasis"].token;
    // OASIS's app was removed in Slack, so Slack already refuses its token.
    revokedAtSlack.add(OASIS_TOKEN);
    const before = revocations.length;
    const r = await disconnect();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.disconnected, r.body.slack_token], [true, "already_invalid"]);
    assert.deepEqual(revocations.slice(before), [OASIS_TOKEN], "asked with OASIS's connection's own token");
    assert.deepEqual(await liveSlack(OASIS), []);
    assert.equal(await count("SELECT COUNT(*) AS n FROM provider_webhook_routes WHERE tenant_id = ? AND provider = 'slack'", [OASIS]), 0);
  });

  globalThis.fetch = realFetch;
  console.log(`\n${passed} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
