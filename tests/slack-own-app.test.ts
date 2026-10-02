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
  "code-a-oasis": { app: OASIS_APP_ENV.SLACK_CLIENT_ID, team: "T0CLIENTA", name: "Client A Slack", token: "xoxb-client-a-oasis-app" },
  // Client A installing its own app again, once per check that needs a fresh token.
  "code-a2": { app: APP_A.client_id, team: "T0CLIENTA", name: "Client A Slack", token: "xoxb-client-a-own-app-2" },
  "code-a3": { app: APP_A.client_id, team: "T0CLIENTA", name: "Client A Slack", token: "xoxb-client-a-own-app-3" },
  "code-a4": { app: APP_A.client_id, team: "T0CLIENTA", name: "Client A Slack", token: "xoxb-client-a-own-app-4" },
  "code-a5": { app: APP_A.client_id, team: "T0CLIENTA", name: "Client A Slack", token: "xoxb-client-a-own-app-5" },
  "code-a6": { app: APP_A.client_id, team: "T0CLIENTA", name: "Client A Slack", token: "xoxb-client-a-own-app-6" },
  "code-a7": { app: APP_A.client_id, team: "T0CLIENTA", name: "Client A Slack", token: "xoxb-client-a-own-app-7" },
  "code-a8": { app: APP_A.client_id, team: "T0CLIENTA", name: "Client A Slack", token: "xoxb-client-a-own-app-8" },
  "code-a-loser-1": { app: APP_A.client_id, team: "T0CLIENTA", name: "Client A Slack", token: "xoxb-client-a-loser-1" },
  "code-a-loser-2": { app: APP_A.client_id, team: "T0CLIENTA", name: "Client A Slack", token: "xoxb-client-a-loser-2" },
  "code-a-loser-3": { app: APP_A.client_id, team: "T0CLIENTA", name: "Client A Slack", token: "xoxb-client-a-loser-3" },
  "code-a-loser-4": { app: APP_A.client_id, team: "T0CLIENTA", name: "Client A Slack", token: "xoxb-client-a-loser-4" },
  "code-a9": { app: APP_A.client_id, team: "T0CLIENTA", name: "Client A Slack", token: "xoxb-client-a-own-app-9" },
  "code-a10": { app: APP_A.client_id, team: "T0CLIENTA", name: "Client A Slack", token: "xoxb-client-a-own-app-10" },
  "code-a11": { app: APP_A.client_id, team: "T0CLIENTA", name: "Client A Slack", token: "xoxb-client-a-own-app-11" },
  "code-a-race-save": { app: APP_A.client_id, team: "T0CLIENTA", name: "Client A Slack", token: "xoxb-client-a-race-save" },
  "code-a-race-route": { app: APP_A.client_id, team: "T0CLIENTA", name: "Client A Slack", token: "xoxb-client-a-race-route" },
  "code-a-race-probe": { app: APP_A.client_id, team: "T0CLIENTA", name: "Client A Slack", token: "xoxb-client-a-race-probe" },
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
  const installLib = await import("../lib/slack/install");
  const service = await import("../lib/connections/service");
  const connStore = await import("../lib/connections/store");
  const credStore = await import("../lib/tenant-integration-store");
  const tokensLib = await import("../lib/connections/token-store");
  const health = await import("../lib/connections/health");
  const slackStatusLib = await import("../lib/slack/status");
  const testRoute = await import("../app/api/connections/[provider]/test/route");
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

  await check("with OASIS's app LIVE, a client whose own app is removed is never served by it: its Request URLs 404, OASIS-signed requests cannot act for it, installs refuse, status and health never pick OASIS's app", async () => {
    await login(USERS.ownerA);
    for (const k of Object.keys(APP_A)) assert.equal((await removeApp(k)).status, 200, k);
    const lastCheck = async (tenantId: string) =>
      String((await db.execute({ sql: "SELECT last_health_at FROM tenant_connections WHERE tenant_id = ? AND provider = 'slack' AND revoked_at IS NULL", args: [tenantId] })).rows[0].last_health_at);
    try {
      await withOasisApp(async () => {
        assert.equal(registry.providerAvailability(registry.providerById("slack")!, process.env), "live", "OASIS's app is live here");
        const form = "application/x-www-form-urlencoded";
        const press = new URLSearchParams({
          payload: JSON.stringify({
            type: "block_actions",
            team: { id: "T0CLIENTA" },
            user: { id: "U0PERSON" },
            response_url: "https://hooks.slack.com/actions/T0CLIENTA/2/x",
            actions: [{ action_id: APPROVE_ACTION_ID, value: `${randomUUID()}|${"b".repeat(64)}` }],
          }),
        }).toString();
        // 1. The client's own Request URLs are gone, whatever OASIS's app does.
        assert.equal((await post(eventsRoute, eventsUrl(CLIENT_A), verification, APP_A.signing_secret)).status, 404);
        assert.equal((await post(interactivityRoute, `https://oasisai.work/api/webhooks/slack/interactivity?workspace=${CLIENT_A}`, press, APP_A.signing_secret, form)).status, 404);
        // 2. OASIS-signed requests cannot act for the client.
        const forged = await toJson(await post(eventsRoute, eventsUrl(), messageEvent("T0CLIENTA", "EvREMOVED0001"), OASIS_APP_ENV.SLACK_SIGNING_SECRET));
        assert.deepEqual([forged.status, forged.body.dropped], [200, "team_not_this_workspace"]);
        laterTasks.length = 0;
        assert.equal((await post(interactivityRoute, "https://oasisai.work/api/webhooks/slack/interactivity", press, OASIS_APP_ENV.SLACK_SIGNING_SECRET, form)).status, 200);
        const callsBefore = calls.length;
        for (const task of laterTasks.splice(0)) await task();
        assert.deepEqual(calls.slice(callsBefore), [], "the press did nothing for the client");
        // 3. Installs refuse, at Add to Slack and at the callback (a valid state, a code OASIS's app issued).
        assert.equal(landed(await authorize()).searchParams.get("reason"), "own_app_missing");
        const started = await oauthLib.startAuthorize(db, {
          provider: registry.providerForEnv("slack", process.env)!,
          tenantId: CLIENT_A,
          userId: USERS.ownerA.id,
          scopes: [...registry.providerById("slack")!.scopes.base],
          redirectUri: "https://oasisai.work/api/connections/slack/callback",
          now: new Date(),
          env: process.env,
        });
        const exchangesBefore = exchanges.length;
        assert.equal(landed(await callback({ code: "code-a-oasis", state: started.state })).searchParams.get("reason"), "own_app_missing");
        assert.equal(exchanges.length, exchangesBefore, "OASIS's app never exchanged a code for the client");
        // 4. Status and health never pick OASIS's app for the client.
        assert.equal(await ownApp.slackAppFor(CLIENT_A), "none");
        assert.equal((await slackStatusLib.loadSlackPresence(db, CLIENT_A)).kind, "not_configured");
        const settings = await loadSlackSettings(db, CLIENT_A, { nowMs: Date.now() });
        assert.deepEqual([settings.installApp, settings.appConfigured], [null, false]);
        assert.deepEqual((await slackStatus(CLIENT_A, USERS.ownerA.id)).paths?.map((p) => [p.title, p.state]), [["Your own Slack app", "Not set up yet"]]);
        const tested = await toJson(await testRoute.POST(new Request("https://oasisai.work/api/connections/slack/test", { method: "POST" }), ctx("slack")));
        assert.deepEqual([tested.status, tested.body.error], [409, "slack_app_not_set_up"], "Test again does not check it through OASIS's app");
        const old = "2026-01-01T00:00:00.000Z";
        await db.execute({ sql: "UPDATE tenant_connections SET last_health_at = ? WHERE provider = 'slack' AND revoked_at IS NULL", args: [old] });
        const pass = await health.runConnectionHealthPass({ db, now: () => new Date() });
        assert.deepEqual(pass.errors, [], JSON.stringify(pass));
        assert.equal(await lastCheck(CLIENT_A), old, "the hourly pass did not check the client through OASIS's app");
        assert.notEqual(await lastCheck(OASIS), old, "it did check OASIS's own connection, on OASIS's app");
      });
    } finally {
      for (const [k, v] of Object.entries(APP_A)) assert.equal((await saveApp(k, v)).status, 200, k);
    }
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
  const connRow = async (tenantId: string) =>
    (await db.execute({ sql: "SELECT id, status, token_version FROM tenant_connections WHERE tenant_id = ? AND provider = 'slack' AND revoked_at IS NULL", args: [tenantId] })).rows.map((r) => ({
      id: String(r.id),
      status: String(r.status),
      generation: Number(r.token_version),
    }));
  /** A disconnect that began and did not finish: held disconnecting, durably, with nothing deleted yet. */
  const unfinishedDisconnect = async (tenantId: string, team: string, why: string) => {
    const rows = await connRow(tenantId);
    assert.deepEqual(rows.map((r) => r.status), ["disconnecting"], `${why}: held disconnecting (not connected, not revoked)`);
    const token = "SELECT COUNT(*) AS n FROM tenant_integration_credentials WHERE tenant_id = ? AND service = ? AND field_key = 'bot_token'";
    assert.equal(await count(token, [tenantId, credentialServiceFor(rows[0].id)]), 1, `${why}: nothing deleted: the token is kept to be switched off`);
    assert.equal(await count("SELECT COUNT(*) AS n FROM provider_webhook_routes WHERE tenant_id = ? AND external_key = ?", [tenantId, team]), 1, `${why}: the route is kept for the disconnect to remove`);
  };
  const A_TOKEN = CODES["code-a"].token;

  await check("Disconnect claims the connection's next generation, then asks Slack to switch the token off; when Slack does not confirm it, nothing is deleted, the connection is held disconnecting (unused), and the owner is told it did not finish", async () => {
    await login(USERS.ownerA);
    const startGeneration = (await connRow(CLIENT_A))[0].generation;
    let presses = 0;
    for (const mode of ["fatal_error", "not_revoked", "rate_limited", "network"] as const) {
      revokeFails = mode;
      const before = revocations.length;
      let r: Awaited<ReturnType<typeof disconnect>>;
      try {
        r = await disconnect();
      } finally {
        revokeFails = null;
      }
      presses += 1;
      assert.deepEqual(revocations.slice(before), [A_TOKEN], `${mode}: the switch-off was asked for, with A's own token`);
      assert.equal(r.status, 502, `${mode}: ${JSON.stringify(r.body)}`);
      assert.deepEqual([r.body.ok, r.body.error, r.body.disconnected, r.body.disconnecting], [false, "slack_revoke_failed", undefined, true], mode);
      assert.match(String(r.body.message), /OASIS has stopped using this Slack workspace, but the disconnect is not finished\. Press Disconnect again/);
      await unfinishedDisconnect(CLIENT_A, "T0CLIENTA", mode);
      assert.equal((await connRow(CLIENT_A))[0].generation, startGeneration + presses, `${mode}: each press claimed the next generation`);
    }
    // Held disconnecting, the connection is not used: its events find no workspace, its card says so.
    const event = await toJson(await post(eventsRoute, String(setup.events_url), messageEvent("T0CLIENTA", "EvDISCONNECT1"), APP_A.signing_secret));
    assert.deepEqual([event.status, event.body.dropped], [200, "unknown_team"]);
    const card = await slackStatus(CLIENT_A, USERS.ownerA.id);
    assert.deepEqual([card.kind, card.label], ["attention", "Disconnect not finished"], JSON.stringify(card));
    assert.equal((await loadSlackSettings(db, CLIENT_A, { nowMs: Date.now() })).connection?.status, "disconnecting");
    assert.equal((await slackStatusLib.loadSlackPresence(db, CLIENT_A)).kind, "not_connected");
    // Test again on it records no health over the disconnect (and never turns it back to connected).
    const historyBefore = await count("SELECT COUNT(*) AS n FROM connection_health_checks WHERE tenant_id = ?", [CLIENT_A]);
    const tested = await toJson(await testRoute.POST(new Request("https://oasisai.work/api/connections/slack/test", { method: "POST" }), ctx("slack")));
    assert.equal(tested.status, 200, JSON.stringify(tested.body));
    assert.equal((tested.body.connection as { status?: string }).status, "disconnecting");
    assert.equal(await count("SELECT COUNT(*) AS n FROM connection_health_checks WHERE tenant_id = ?", [CLIENT_A]), historyBefore, "no health written over a disconnect");
    // A stored token that cannot be read is never assumed off: nothing is sent, nothing deleted.
    const [{ id }] = await connRow(CLIENT_A);
    const at = "WHERE tenant_id = ? AND service = ? AND field_key = 'bot_token'";
    const args = [CLIENT_A, credentialServiceFor(id)];
    const saved = String((await db.execute({ sql: `SELECT encrypted_value FROM tenant_integration_credentials ${at}`, args })).rows[0].encrypted_value);
    await db.execute({ sql: `UPDATE tenant_integration_credentials SET encrypted_value = 'not-a-ciphertext' ${at}`, args });
    try {
      const before = revocations.length;
      const r = await disconnect();
      assert.deepEqual([r.status, r.body.error, r.body.disconnected, r.body.disconnecting], [500, "slack_token_unreadable", undefined, true], JSON.stringify(r.body));
      assert.equal(revocations.length, before, "nothing sent to Slack");
    } finally {
      await db.execute({ sql: `UPDATE tenant_integration_credentials SET encrypted_value = ? ${at}`, args: [saved, ...args] });
    }
    await unfinishedDisconnect(CLIENT_A, "T0CLIENTA", "unreadable token");
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

  // -- 7. Disconnect against an install of the same connection ----------------------

  const storedToken = async (connectionId: string) => {
    const r = (await db.execute({ sql: "SELECT encrypted_value FROM tenant_integration_credentials WHERE tenant_id = ? AND service = ? AND field_key = 'bot_token'", args: [CLIENT_A, credentialServiceFor(connectionId)] })).rows[0];
    return r ? decryptField(String(r.encrypted_value)) : null;
  };
  /** Client A installs its own app with `code` through the real routes. */
  const installA = async (code: string) => {
    await login(USERS.ownerA);
    const state = landed(await authorize()).searchParams.get("state") ?? "";
    return landed(await callback({ code, state }));
  };
  /** Nothing of A's Slack is left: no live row, no stored credential, no route. */
  const nothingLeft = async (connectionId: string, why: string) => {
    assert.deepEqual(await liveSlack(CLIENT_A), [], `${why}: no live connection`);
    assert.equal(await count("SELECT COUNT(*) AS n FROM tenant_integration_credentials WHERE tenant_id = ? AND service = ?", [CLIENT_A, credentialServiceFor(connectionId)]), 0, `${why}: no stored credential`);
    assert.equal(await count("SELECT COUNT(*) AS n FROM provider_webhook_routes WHERE provider = 'slack' AND external_key = 'T0CLIENTA'"), 0, `${why}: no route`);
  };

  await check("an install that arrives while a disconnect is unfinished is refused: nothing is stored over it, its own token is switched off at Slack, and the next Disconnect finishes", async () => {
    assert.equal((await installA("code-a2")).searchParams.get("slack"), "connected");
    const [{ id }] = await connRow(CLIENT_A);
    const T2 = CODES["code-a2"].token;
    revokeFails = "fatal_error";
    try {
      assert.equal((await disconnect()).status, 502);
    } finally {
      revokeFails = null;
    }
    await unfinishedDisconnect(CLIENT_A, "T0CLIENTA", "after the failed switch-off");
    // The callback for another install of the same Slack team.
    const done = await installA("code-a3");
    assert.deepEqual([done.searchParams.get("slack"), done.searchParams.get("reason")], ["error", "connection_busy"], done.search);
    const T3 = CODES["code-a3"].token;
    assert.ok(revokedAtSlack.has(T3), "the refused install's own token was switched off at Slack");
    assert.equal(await storedToken(id), T2, "nothing was stored over the disconnecting connection");
    await unfinishedDisconnect(CLIENT_A, "T0CLIENTA", "after the refused install");
    // The next press finishes, switching off the token the connection really holds.
    const before = revocations.length;
    const r = await disconnect();
    assert.deepEqual([r.status, r.body.disconnected, r.body.slack_token], [200, true, "revoked"], JSON.stringify(r.body));
    assert.deepEqual(revocations.slice(before), [T2]);
    await nothingLeft(id, "finished");
  });

  await check("an install already in flight when a disconnect runs loses at whichever step it is on (token save, route, first probe): it writes nothing more, its token is switched off, nothing is left behind", async () => {
    const slackDef = registry.providerById("slack")!;
    const actorA = { tenantId: CLIENT_A, userId: USERS.ownerA.id, profileId: `p-${USERS.ownerA.id}`, email: USERS.ownerA.email };
    for (const [step, pattern, code] of [
      ["token save", /INSERT INTO tenant_integration_credentials/, "code-a-race-save"],
      ["route", /INSERT INTO provider_webhook_routes/, "code-a-race-route"],
      ["first probe", /consecutive_failures = \?/, "code-a-race-probe"],
    ] as const) {
      await login(USERS.ownerA);
      const state = landed(await authorize()).searchParams.get("state") ?? "";
      const installEnv = await ownApp.slackInstallEnv(CLIENT_A);
      assert.ok(installEnv.ok);
      // The owner's Disconnect runs to the end at the moment the install reaches `step`.
      let raced: Awaited<ReturnType<typeof service.disconnectConnection>> | null = null;
      const racing = new Proxy(db, {
        get(target, prop) {
          const hook = async (sqls: string[]) => {
            if (raced === null && sqls.some((s) => pattern.test(s))) raced = await service.disconnectConnection({ db, now: () => new Date() }, actorA, slackDef);
          };
          if (prop === "execute") {
            return async (stmt: Parameters<typeof db.execute>[0]) => {
              await hook([typeof stmt === "string" ? stmt : stmt.sql]);
              return target.execute(stmt);
            };
          }
          if (prop === "batch") {
            return async (stmts: Parameters<typeof db.batch>[0], mode?: Parameters<typeof db.batch>[1]) => {
              await hook(stmts.map((s) => (typeof s === "string" ? s : s.sql)));
              return target.batch(stmts, mode);
            };
          }
          const v = Reflect.get(target, prop) as unknown;
          return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
        },
      });
      const done = await installLib.completeSlackInstall(
        { db: racing as unknown as typeof db, now: () => new Date() },
        {
          provider: registry.providerForEnv("slack", installEnv.ok ? installEnv.env : {})!,
          state,
          code,
          redirectUri: "https://oasisai.work/api/connections/slack/callback",
          session: { tenantId: CLIENT_A, userId: USERS.ownerA.id, email: USERS.ownerA.email },
          env: installEnv.ok ? installEnv.env : {},
        },
      );
      assert.ok(raced, `${step}: the disconnect ran mid-install`);
      assert.deepEqual([raced!.status, raced!.body.disconnected], [200, true], `${step}: ${JSON.stringify(raced!.body)}`);
      assert.deepEqual(done, { ok: false, failure: "connection_busy" }, step);
      assert.ok(revokedAtSlack.has(CODES[code].token), `${step}: the install's token was switched off at Slack`);
      const id = String((await db.execute({ sql: "SELECT id FROM tenant_connections WHERE tenant_id = ? AND provider = 'slack'", args: [CLIENT_A] })).rows[0].id);
      await nothingLeft(id, step);
    }
  });

  await check("the disconnect's last step is one batch: a failure inside it changes nothing (still disconnecting, never 'connected' with a dead token), and the next Disconnect finishes", async () => {
    assert.equal((await installA("code-a4")).searchParams.get("slack"), "connected");
    const [{ id }] = await connRow(CLIENT_A);
    const T4 = CODES["code-a4"].token;
    // The credential delete, the batch's third statement, aborts: the whole batch rolls back.
    await db.execute("CREATE TRIGGER test_block_cred_delete BEFORE DELETE ON tenant_integration_credentials BEGIN SELECT RAISE(ABORT, 'forced delete failure'); END");
    let r: Awaited<ReturnType<typeof disconnect>>;
    try {
      r = await disconnect();
    } finally {
      await db.execute("DROP TRIGGER IF EXISTS test_block_cred_delete");
    }
    assert.deepEqual([r.status, r.body.error, r.body.disconnecting], [500, "disconnect_unfinished", true], JSON.stringify(r.body));
    assert.match(String(r.body.message), /Slack's access is switched off, but OASIS could not finish removing the connection here\. Press Disconnect again/);
    assert.ok(revokedAtSlack.has(T4), "Slack switched the token off before the batch");
    await unfinishedDisconnect(CLIENT_A, "T0CLIENTA", "after the failed batch");
    const card = await slackStatus(CLIENT_A, USERS.ownerA.id);
    assert.deepEqual([card.kind, card.label], ["attention", "Disconnect not finished"], "the card never says connected for a dead token");
    // The next press: Slack already refuses the token, which counts as off; the batch finishes.
    const again = await disconnect();
    assert.deepEqual([again.status, again.body.disconnected, again.body.slack_token], [200, true, "already_invalid"], JSON.stringify(again.body));
    await nothingLeft(id, "finished");
  });

  await check("a Disconnect that lost its generation to a newer press finishes nothing: the row, its credential and its route stay for the newer one", async () => {
    assert.equal((await installA("code-a5")).searchParams.get("slack"), "connected");
    const [{ id, generation }] = await connRow(CLIENT_A);
    const now = () => new Date();
    const first = await connStore.beginDisconnect(db, { tenantId: CLIENT_A, connectionId: id, generation, now: now() });
    assert.equal(first, generation + 1);
    // A second press takes the next generation before the first finishes.
    assert.equal(await connStore.beginDisconnect(db, { tenantId: CLIENT_A, connectionId: id, generation: first!, now: now() }), generation + 2);
    assert.equal(await connStore.beginDisconnect(db, { tenantId: CLIENT_A, connectionId: id, generation: first!, now: now() }), null, "a stale generation claims nothing");
    const late = await connStore.finishDisconnect(db, {
      tenantId: CLIENT_A,
      connectionId: id,
      generation: first!,
      revokedBy: USERS.ownerA.id,
      now: now(),
      alsoDelete: (revoked) => [credStore.deleteTenantIntegrationServiceWhile({ tenantId: CLIENT_A, service: credentialServiceFor(id), guard: revoked })],
    });
    assert.deepEqual(late, { revoked: false, deleted: [0] });
    await unfinishedDisconnect(CLIENT_A, "T0CLIENTA", "after the stale finish");
    // The press that holds the generation finishes it.
    const r = await disconnect();
    assert.deepEqual([r.status, r.body.disconnected, r.body.slack_token], [200, true, "revoked"], JSON.stringify(r.body));
    assert.ok(revokedAtSlack.has(CODES["code-a5"].token));
    await nothingLeft(id, "finished");
  });

  await check("a Disconnect whose read raced an install's claim refuses (the claim moved the generation), never taking the install over or reaching Slack", async () => {
    assert.equal((await installA("code-a6")).searchParams.get("slack"), "connected");
    const [{ id, generation }] = await connRow(CLIENT_A);
    const T6 = CODES["code-a6"].token;
    const slackDef = registry.providerById("slack")!;
    const actorA = { tenantId: CLIENT_A, userId: USERS.ownerA.id, profileId: `p-${USERS.ownerA.id}`, email: USERS.ownerA.email };
    // The Disconnect has read the row; an install of the same team claims it just before the Disconnect claims the next generation.
    let claimed = false;
    const racing = new Proxy(db, {
      get(target, prop) {
        if (prop === "execute") {
          return async (stmt: Parameters<typeof db.execute>[0]) => {
            if (!claimed && /SET status = 'disconnecting'/.test(typeof stmt === "string" ? stmt : stmt.sql)) {
              claimed = true;
              const claim = await connStore.claimConnection(db, {
                tenantId: CLIENT_A,
                provider: "slack",
                authKind: "app_install",
                scopeKind: "tenant",
                userId: null,
                externalAccountId: "T0CLIENTA",
                externalAccountLabel: "Client A Slack",
                environment: null,
                grantedScopes: [],
                scopeSetVersion: 1,
                connectedBy: USERS.ownerA.id,
                now: new Date(),
              });
              assert.ok(claim.ok && claim.connection.token_version === generation + 1, "the install's claim is the next generation");
            }
            return target.execute(stmt);
          };
        }
        const v = Reflect.get(target, prop) as unknown;
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    const before = revocations.length;
    const r = await service.disconnectConnection({ db: racing as unknown as typeof db, now: () => new Date() }, actorA, slackDef);
    assert.ok(claimed, "the claim landed between the read and the Disconnect's claim");
    assert.deepEqual([r.status, r.body.error], [409, "connection_busy"], JSON.stringify(r.body));
    assert.equal(revocations.length, before, "Slack was never asked");
    assert.deepEqual(await connRow(CLIENT_A), [{ id, status: "pending", generation: generation + 1 }], "the install's claim stands");
    // Pressed again, the Disconnect takes the install's generation and finishes.
    const again = await disconnect();
    assert.deepEqual([again.status, again.body.disconnected], [200, true], JSON.stringify(again.body));
    assert.ok(revokedAtSlack.has(T6));
    await nothingLeft(id, "finished");
  });

  // -- 8. A health check, and a lost install's token, against a reinstall --------------

  /** A's own-app install with `code`, through the library with `db` (a racing proxy, or the real one). */
  const installThrough = async (code: string, through: typeof db) => {
    await login(USERS.ownerA);
    const state = landed(await authorize()).searchParams.get("state") ?? "";
    const installEnv = await ownApp.slackInstallEnv(CLIENT_A);
    assert.ok(installEnv.ok);
    return installLib.completeSlackInstall(
      { db: through, now: () => new Date() },
      {
        provider: registry.providerForEnv("slack", installEnv.ok ? installEnv.env : {})!,
        state,
        code,
        redirectUri: "https://oasisai.work/api/connections/slack/callback",
        session: { tenantId: CLIENT_A, userId: USERS.ownerA.id, email: USERS.ownerA.email },
        env: installEnv.ok ? installEnv.env : {},
      },
    );
  };
  /** `db`, with `hook` run once, just before the first statement matching `pattern`. */
  const racingOn = (pattern: RegExp, hook: () => Promise<void>) => {
    let fired = false;
    const proxy = new Proxy(db, {
      get(target, prop) {
        const fire = async (sqls: string[]) => {
          if (!fired && sqls.some((s) => pattern.test(s))) {
            fired = true;
            await hook();
          }
        };
        if (prop === "execute") {
          return async (stmt: Parameters<typeof db.execute>[0]) => {
            await fire([typeof stmt === "string" ? stmt : stmt.sql]);
            return target.execute(stmt);
          };
        }
        if (prop === "batch") {
          return async (stmts: Parameters<typeof db.batch>[0], mode?: Parameters<typeof db.batch>[1]) => {
            await fire(stmts.map((s) => (typeof s === "string" ? s : s.sql)));
            return target.batch(stmts, mode);
          };
        }
        const v = Reflect.get(target, prop) as unknown;
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    return { db: proxy as unknown as typeof db, fired: () => fired };
  };
  const cleanupRecords = () => count("SELECT COUNT(*) AS n FROM tenant_integration_credentials WHERE tenant_id = ? AND service LIKE 'slack-token-cleanup:%' AND field_key = 'bot_token'", [CLIENT_A]);

  const historyOf = (connectionId: string) =>
    count("SELECT COUNT(*) AS n FROM connection_health_checks WHERE tenant_id = ? AND connection_id = ?", [CLIENT_A, connectionId]);

  await check("a health check that started before a reinstall and finishes between the new token save and the route records nothing over it: the reinstall connects normally", async () => {
    assert.equal((await installA("code-a7")).searchParams.get("slack"), "connected");
    const stale = (await connStore.findActiveConnection(db, CLIENT_A, "slack"))!;
    const historyBefore = await historyOf(stale.id);
    // The check reads the row and its token and asks Slack; its write then waits for the reinstall.
    let atWrite!: () => void;
    const reachedWrite = new Promise<void>((resolve) => (atWrite = resolve));
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    const checkDb = racingOn(/INSERT INTO connection_health_checks/, async () => {
      atWrite();
      await released;
    });
    const checking = health.probeStoredConnection({ db: checkDb.db, now: () => new Date() }, stale, "cron", { userId: null, email: null });
    await Promise.race([reachedWrite, checking]);
    assert.ok(checkDb.fired(), "the check holds a result for the old install");
    let probed: Awaited<typeof checking> | null = null;
    const reinstall = racingOn(/INSERT INTO provider_webhook_routes/, async () => {
      release();
      probed = await checking;
    });
    const done = await installThrough("code-a8", reinstall.db);
    assert.ok(reinstall.fired() && probed, "the old check's write landed between the new token save and the route");
    assert.equal(probed!.recorded, false, "it recorded nothing over the reinstall");
    assert.ok(done.ok, JSON.stringify(done));
    const [row] = await connRow(CLIENT_A);
    assert.deepEqual([row.status, row.generation], ["connected", stale.token_version + 1]);
    assert.equal(await storedToken(row.id), CODES["code-a8"].token);
    assert.ok(!revokedAtSlack.has(CODES["code-a8"].token), "the reinstall's token is live");
    assert.equal(await historyOf(stale.id), historyBefore + 1, "only the reinstall's own first check was written");
    assert.deepEqual([(await disconnect()).status, revokedAtSlack.has(CODES["code-a8"].token)], [200, true]);
  });

  await check("a health check that starts from a row read before a reinstall never uses the reinstall's token; a pending claim is neither checked nor due", async () => {
    assert.equal((await installA("code-a10")).searchParams.get("slack"), "connected");
    const stale = (await connStore.findActiveConnection(db, CLIENT_A, "slack"))!;
    const historyBefore = await historyOf(stale.id);
    let probed: Awaited<ReturnType<typeof health.probeStoredConnection>> | null = null;
    let slackCalls: string[] = [];
    const reinstall = racingOn(/INSERT INTO provider_webhook_routes/, async () => {
      const callsBefore = calls.length;
      probed = await health.probeStoredConnection({ db, now: () => new Date() }, stale, "cron", { userId: null, email: null });
      slackCalls = calls.slice(callsBefore);
    });
    const done = await installThrough("code-a11", reinstall.db);
    assert.ok(reinstall.fired() && probed, "the check ran between the new token save and the route");
    assert.deepEqual([probed!.recorded, slackCalls], [false, []], "it never asked Slack with the reinstall's token");
    assert.ok(done.ok, JSON.stringify(done));
    const [row] = await connRow(CLIENT_A);
    assert.deepEqual([row.status, row.generation], ["connected", stale.token_version + 1]);
    assert.equal(await historyOf(stale.id), historyBefore + 1, "only the reinstall's own first check was written");
    // A pending claim (an install in flight records its own first check): not probed, not listed for the cron.
    const due = async () =>
      (await connStore.listConnectionsDueForHealth(db, { providers: [], alsoForTenants: { provider: "slack", tenantIds: [CLIENT_A] }, staleBefore: new Date(Date.now() + 3_600_000), limit: 50 })).map((c) => c.id);
    assert.ok((await due()).includes(row.id), "a connected row is due once its last check is old enough");
    await db.execute({ sql: "UPDATE tenant_connections SET status = 'pending' WHERE id = ?", args: [row.id] });
    try {
      assert.ok(!(await due()).includes(row.id), "a pending claim is never due");
      const callsBefore = calls.length;
      const pending = await health.probeStoredConnection({ db, now: () => new Date() }, (await connStore.getConnection(db, CLIENT_A, row.id))!, "manual", { userId: null, email: null });
      assert.deepEqual([pending.recorded, calls.slice(callsBefore)], [false, []]);
    } finally {
      await db.execute({ sql: "UPDATE tenant_connections SET status = 'connected' WHERE id = ?", args: [row.id] });
    }
    assert.deepEqual([(await disconnect()).status, revokedAtSlack.has(CODES["code-a11"].token)], [200, true]);
  });

  await check("an install that loses its Slack team to another workspace's route switches its own token off at Slack before forgetting it, unless that workspace holds the very same token (or its token cannot be read, then it is kept for the cron)", async () => {
    for (const [variant, code, bHolds] of [
      ["another app's token", "code-a-loser-1", "nothing"],
      ["the same token (one Slack app shared by both workspaces)", "code-a-loser-2", "same"],
      ["a token of B's that cannot be read", "code-a-loser-4", "unreadable"],
    ] as const) {
      const T = CODES[code].token;
      let bConnection: string | null = null;
      // Client B routes the same Slack team just before A's install does.
      const race = racingOn(/INSERT INTO provider_webhook_routes/, async () => {
        const claimB = await connStore.claimConnection(db, {
          tenantId: CLIENT_B,
          provider: "slack",
          authKind: "app_install",
          scopeKind: "tenant",
          userId: null,
          externalAccountId: "T0CLIENTA",
          externalAccountLabel: "Client A Slack",
          environment: null,
          grantedScopes: [],
          scopeSetVersion: 1,
          connectedBy: USERS.ownerB.id,
          now: new Date(),
        });
        assert.ok(claimB.ok, JSON.stringify(claimB));
        bConnection = claimB.connection.id;
        if (bHolds !== "nothing") await tokensLib.saveBotToken(CLIENT_B, bConnection, { bot_token: bHolds === "same" ? T : "xoxb-client-b-other", bot_user_id: "UBOT" });
        if (bHolds === "unreadable") {
          await db.execute({
            sql: "UPDATE tenant_integration_credentials SET encrypted_value = 'not-a-ciphertext' WHERE tenant_id = ? AND service = ? AND field_key = 'bot_token'",
            args: [CLIENT_B, credentialServiceFor(bConnection)],
          });
        }
        assert.deepEqual(await connStore.registerWebhookRoute(db, { tenantId: CLIENT_B, provider: "slack", externalKey: "T0CLIENTA", connectionId: bConnection, now: new Date() }), { ok: true });
      });
      const before = revocations.length;
      try {
        const done = await installThrough(code, race.db);
        assert.ok(race.fired(), variant);
        assert.deepEqual(done, { ok: false, failure: "team_connected_elsewhere" }, `${variant}: ${JSON.stringify(done)}`);
        if (bHolds === "nothing") {
          assert.deepEqual(revocations.slice(before), [T], `${variant}: switched off at Slack`);
          assert.ok(revokedAtSlack.has(T));
        } else {
          assert.deepEqual(revocations.slice(before), [], `${variant}: a token workspace B may be using is left alone`);
        }
        assert.deepEqual(await liveSlack(CLIENT_A), [], `${variant}: nothing of A's install stays`);
        assert.equal(await cleanupRecords(), bHolds === "unreadable" ? 1 : 0, `${variant}: kept for the cron only while it cannot be settled`);
        assert.equal(await count("SELECT COUNT(*) AS n FROM provider_webhook_routes WHERE tenant_id = ? AND external_key = 'T0CLIENTA'", [CLIENT_B]), 1, `${variant}: B's route stands`);
      } finally {
        await db.execute({ sql: "DELETE FROM tenant_integration_credentials WHERE tenant_id = ? AND service LIKE 'slack-token-cleanup:%'", args: [CLIENT_A] });
        if (bConnection) {
          await db.execute({ sql: "DELETE FROM provider_webhook_routes WHERE tenant_id = ? AND connection_id = ?", args: [CLIENT_B, bConnection] });
          await db.execute({ sql: "DELETE FROM tenant_integration_credentials WHERE tenant_id = ? AND service = ?", args: [CLIENT_B, credentialServiceFor(bConnection)] });
          await db.execute({ sql: "DELETE FROM tenant_connections WHERE id = ? AND tenant_id = ?", args: [bConnection, CLIENT_B] });
        }
      }
    }
  });

  await check("a given-up token Slack does not confirm switching off is kept, unusable, and the connection-health cron switches it off on a later run; one a live connection holds again is dropped untouched", async () => {
    const T3 = CODES["code-a-loser-3"].token;
    let bConnection: string | null = null;
    const race = racingOn(/INSERT INTO provider_webhook_routes/, async () => {
      const claimB = await connStore.claimConnection(db, {
        tenantId: CLIENT_B,
        provider: "slack",
        authKind: "app_install",
        scopeKind: "tenant",
        userId: null,
        externalAccountId: "T0CLIENTA",
        externalAccountLabel: "Client A Slack",
        environment: null,
        grantedScopes: [],
        scopeSetVersion: 1,
        connectedBy: USERS.ownerB.id,
        now: new Date(),
      });
      assert.ok(claimB.ok);
      bConnection = claimB.connection.id;
      await connStore.registerWebhookRoute(db, { tenantId: CLIENT_B, provider: "slack", externalKey: "T0CLIENTA", connectionId: bConnection, now: new Date() });
    });
    try {
      revokeFails = "network";
      let done: Awaited<ReturnType<typeof installThrough>>;
      try {
        done = await installThrough("code-a-loser-3", race.db);
      } finally {
        revokeFails = null;
      }
      assert.deepEqual(done, { ok: false, failure: "team_connected_elsewhere" });
      assert.ok(!revokedAtSlack.has(T3), "Slack did not switch it off");
      // Kept: encrypted, under a service no connection reads.
      assert.equal(await cleanupRecords(), 1);
      const [kept] = (await credStore.listTenantIntegrationServicesByPrefix(db, { prefix: installLib.SLACK_TOKEN_CLEANUP_PREFIX, limit: 10 })).filter((r) => r.tenantId === CLIENT_A);
      assert.deepEqual([kept?.values.bot_token, kept?.values.team_id], [T3, "T0CLIENTA"]);
      assert.notEqual(String((await db.execute({ sql: "SELECT encrypted_value FROM tenant_integration_credentials WHERE tenant_id = ? AND service = ? AND field_key = 'bot_token'", args: [CLIENT_A, kept.service] })).rows[0].encrypted_value), T3, "never stored in plain text");
      assert.deepEqual(await liveSlack(CLIENT_A), [], "no connection uses it");
    } finally {
      if (bConnection) {
        await db.execute({ sql: "DELETE FROM provider_webhook_routes WHERE tenant_id = ? AND connection_id = ?", args: [CLIENT_B, bConnection] });
        await db.execute({ sql: "DELETE FROM tenant_connections WHERE id = ? AND tenant_id = ?", args: [bConnection, CLIENT_B] });
      }
    }
    // The cron: Slack still failing keeps it; the next run switches it off and deletes it.
    revokeFails = "network";
    let first: Awaited<ReturnType<typeof installLib.retrySlackTokenCleanups>>;
    try {
      first = await installLib.retrySlackTokenCleanups({ db, now: () => new Date() });
    } finally {
      revokeFails = null;
    }
    assert.deepEqual([first.retried, first.kept, first.switched_off], [1, 1, 0], JSON.stringify(first));
    const second = await installLib.retrySlackTokenCleanups({ db, now: () => new Date() });
    assert.deepEqual([second.retried, second.switched_off, second.kept], [1, 1, 0], JSON.stringify(second));
    assert.ok(revokedAtSlack.has(T3));
    assert.equal(await cleanupRecords(), 0);
    assert.match(read("app/api/cron/connection-health/route.ts"), /await retrySlackTokenCleanups\(\{ db, now/, "the connection-health cron runs it");
    // A token a live connection holds again (the same app installed again) is dropped, never switched off.
    assert.equal((await installA("code-a9")).searchParams.get("slack"), "connected");
    const T9 = CODES["code-a9"].token;
    assert.ok((await credStore.setTenantIntegrationBundle({ tenantId: CLIENT_A, service: `${installLib.SLACK_TOKEN_CLEANUP_PREFIX}held-again`, bundle: { bot_token: T9, team_id: "T0CLIENTA" } })).ok);
    const held = await installLib.retrySlackTokenCleanups({ db, now: () => new Date() });
    assert.deepEqual([held.retried, held.held, held.switched_off], [1, 1, 0], JSON.stringify(held));
    assert.ok(!revokedAtSlack.has(T9), "the live connection's token is untouched");
    assert.equal(await cleanupRecords(), 0);
    assert.equal((await disconnect()).status, 200);
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
