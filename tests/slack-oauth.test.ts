/**
 * slack-oauth.test.ts - "Add to Slack": the generic authorize/callback routes,
 * the single-use signed consent state, and the registry switch that keeps
 * Slack "coming soon" until OASIS's Slack app exists on the deployment.
 *
 * WHY. An install hands OASIS a bot token for a company's Slack. The failures
 * that matter are silent: a consent finished into the wrong workspace (OAuth
 * CSRF), a state replayed or forged, a Slack team attached to two OASIS
 * workspaces, a token saved with no connection (or a connection with no
 * token), and an Install button on a deployment that cannot finish it.
 *
 * Real routes, real session, real store and token encryption on a local libSQL
 * file (migrations bravo__187 and bravo__197). Slack's oauth.v2.access and
 * auth.test are mocked at the fetch boundary; any other host fails the test.
 *
 * Run: node --conditions=react-server --import tsx tests/slack-oauth.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createClient } from "@libsql/client";

const dbFile = join(mkdtempSync(join(tmpdir(), "slack-oauth-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
process.env.EMPIRE_AUTH_BACKEND = "turso";
process.env.AUTH_SESSION_SECRET = "slack-oauth-test-session-secret-long-enough-0001";
process.env.BRAVO_FIELD_ENCRYPTION_KEY = "slack-oauth-test-field-encryption-passphrase";
process.env.PUBLIC_APP_URL = "https://oasisai.work";
const SLACK_ENV = {
  SLACK_CLIENT_ID: "1234.5678",
  SLACK_CLIENT_SECRET: "slack-oauth-test-client-secret",
  SLACK_SIGNING_SECRET: "slack-oauth-test-signing-secret",
  CONNECTIONS_OAUTH_STATE_SECRET: "slack-oauth-test-state-secret-long-enough-000001",
} as const;
function setSlackEnv(on: boolean, except: readonly string[] = []) {
  for (const [k, v] of Object.entries(SLACK_ENV)) {
    if (on && !except.includes(k)) process.env[k] = v;
    else delete process.env[k];
  }
}
setSlackEnv(false);

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

const ALPHA = "a1a1a1a1-0000-4000-8000-0000000000a1";
const BRAVO_CO = "b2b2b2b2-0000-4000-8000-0000000000b2";
type U = { id: string; email: string };
const USERS: Record<"ownerA" | "adminA" | "ownerB" | "memberA", U> = {
  ownerA: { id: "0d000000-0000-4000-8000-000000000001", email: "owner@alpha.test" },
  adminA: { id: "0d000000-0000-4000-8000-000000000002", email: "admin@alpha.test" },
  ownerB: { id: "0d000000-0000-4000-8000-000000000003", email: "owner@bravo.test" },
  memberA: { id: "0d000000-0000-4000-8000-000000000004", email: "member@alpha.test" },
};
async function login(user: U | null) {
  if (!user) {
    sessionCookie = undefined;
    return;
  }
  const { signSession } = await import("../lib/turso-auth");
  sessionCookie = signSession({ sub: user.id, email: user.email, exp: Math.floor(Date.now() / 1000) + 3600, ver: 0 });
}

// Slack's install endpoints, at the fetch boundary. Each code maps to a team.
// `enterprise`: an Enterprise Grid org-wide install (Slack sends no team).
// `authTeam`: the team auth.test answers for, when it is not the installed one.
const CODES: Record<string, { team: string; name: string; token: string; enterprise?: boolean; authTeam?: string }> = {
  "code-alpha": { team: "T0ALPHA", name: "Alpha Slack", token: "xoxb-alpha-install-token" },
  "code-alpha-2": { team: "T0ALPHA", name: "Alpha Slack", token: "xoxb-alpha-install-token-2" },
  "code-bravo-same-team": { team: "T0ALPHA", name: "Alpha Slack", token: "xoxb-bravo-attempt" },
  "code-alpha-other-team": { team: "T0SECOND", name: "Second Slack", token: "xoxb-second-token" },
  "code-enterprise": { team: "T0ENTERPRISE", name: "Org Slack", token: "xoxb-enterprise-token", enterprise: true },
  "code-user-token": { team: "T0USERTOK", name: "User Token Slack", token: "xoxp-user-token-not-a-bot" },
  "code-race": { team: "T0RACE", name: "Race Slack", token: "xoxb-race-token" },
  "code-mismatch": { team: "T0MISMATCH", name: "Mismatch Slack", token: "xoxb-mismatch-token", authTeam: "T0ELSEWHERE" },
};
// The team's channels, as conversations.info reports them.
const CHANNELS: Record<string, { name: string; is_member: boolean; is_archived: boolean; is_ext_shared: boolean }> = {
  C0CLIENTS: { name: "clients", is_member: true, is_archived: false, is_ext_shared: false },
  C0MARKETING: { name: "marketing", is_member: true, is_archived: false, is_ext_shared: false },
  C0PARTNERS: { name: "partners", is_member: true, is_archived: false, is_ext_shared: true },
};
const exchanges: Array<Record<string, string>> = [];
// conversations.list: "complete" ends after one page; "endless" always hands back a cursor,
// so listPublicChannels gives up at its page cap and reports the list as truncated.
let listMode: "complete" | "endless" = "complete";
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(href);
  if (url.hostname !== "slack.com") throw new Error(`unexpected network call in test: ${href}`);
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  if (url.pathname === "/api/oauth.v2.access") {
    const form = Object.fromEntries(new URLSearchParams(String(init?.body ?? "")));
    exchanges.push(form);
    const c = CODES[form.code];
    if (!c || form.client_secret !== SLACK_ENV.SLACK_CLIENT_SECRET) return json({ ok: false, error: "invalid_code" });
    return json({
      ok: true,
      access_token: c.token,
      token_type: "bot",
      scope: "app_mentions:read,chat:write",
      bot_user_id: "UBOT",
      team: c.enterprise ? null : { id: c.team, name: c.name },
      ...(c.enterprise ? { is_enterprise_install: true, enterprise: { id: "E0ORG", name: c.name } } : {}),
    });
  }
  if (url.pathname === "/api/auth.test") {
    const token = (new Headers(init?.headers).get("authorization") || "").replace(/^Bearer /, "");
    const c = Object.values(CODES).find((x) => x.token === token);
    return json(c ? { ok: true, team_id: c.authTeam ?? c.team, team: c.name } : { ok: false, error: "invalid_auth" });
  }
  if (url.pathname === "/api/conversations.info") {
    const token = (new Headers(init?.headers).get("authorization") || "").replace(/^Bearer /, "");
    if (!Object.values(CODES).some((x) => x.token === token)) return json({ ok: false, error: "invalid_auth" });
    const id = new URLSearchParams(String(init?.body ?? "")).get("channel") ?? "";
    const c = CHANNELS[id];
    return json(c ? { ok: true, channel: { id, ...c } } : { ok: false, error: "channel_not_found" });
  }
  if (url.pathname === "/api/conversations.list") {
    const token = (new Headers(init?.headers).get("authorization") || "").replace(/^Bearer /, "");
    if (!Object.values(CODES).some((x) => x.token === token)) return json({ ok: false, error: "invalid_auth" });
    return json({
      ok: true,
      channels: Object.entries(CHANNELS).map(([id, c]) => ({ id, ...c })),
      response_metadata: { next_cursor: listMode === "endless" ? "more" : "" },
    });
  }
  return json({ ok: false, error: "unknown_method" });
}) as typeof fetch;

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
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'alpha-co', 'Alpha Co')", args: [ALPHA] },
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'bravo-co', 'Bravo Co')", args: [BRAVO_CO] },
      profile(USERS.ownerA, ALPHA, "owner", 1),
      profile(USERS.adminA, ALPHA, "admin"),
      profile(USERS.memberA, ALPHA, "member"),
      profile(USERS.ownerB, BRAVO_CO, "owner", 1),
    ],
    "write",
  );

  const { NextRequest } = await import("next/server");
  const registry = await import("../lib/connections/registry");
  const oauth = await import("../lib/connections/oauth");
  const { appNotConfiguredProviders } = await import("../components/os/connections/connector-facts");
  const connectors = await import("../lib/os/connectors");
  const authorizeRoute = await import("../app/api/connections/[provider]/authorize/route");
  const callbackRoute = await import("../app/api/connections/[provider]/callback/route");
  const { decryptField } = await import("../lib/field-encryption");
  const { slackInstallBanner } = await import("../lib/slack/copy");

  const ctx = (provider: string) => ({ params: Promise.resolve({ provider }) });
  const authorize = async (provider = "slack") =>
    authorizeRoute.GET(new NextRequest(`https://oasisai.work/api/connections/${provider}/authorize`), ctx(provider));
  const callback = async (q: Record<string, string>, provider = "slack") =>
    callbackRoute.GET(new NextRequest(`https://oasisai.work/api/connections/${provider}/callback?${new URLSearchParams(q)}`), ctx(provider));
  const stateFrom = (res: Response) => {
    const loc = new URL(res.headers.get("location") ?? "");
    return { loc, state: loc.searchParams.get("state") ?? "" };
  };
  const landed = (res: Response) => new URL(res.headers.get("location") ?? "https://x.invalid/");
  const count = async (sql: string, args: unknown[] = []) => Number((await db.execute({ sql, args: args as never })).rows[0].n);

  console.log("slack-oauth:");

  // ── 1. The registry switch ─────────────────────────────────────────────

  await check("the registry keeps Slack coming soon with the secrets absent, and with any one of them missing", () => {
    const slack = registry.providerById("slack")!;
    assert.equal(slack.availability, "coming_soon", "the static row never claims live");
    assert.equal(registry.providerAvailability(slack, {}), "coming_soon");
    for (const name of Object.keys(SLACK_ENV)) {
      const env: Record<string, string> = { ...SLACK_ENV };
      delete env[name];
      assert.equal(registry.providerAvailability(slack, env), "coming_soon", `missing ${name} must keep Slack coming soon`);
      env[name] = "   ";
      assert.equal(registry.providerAvailability(slack, env), "coming_soon", `a blank ${name} is not set`);
    }
    assert.equal(registry.providerAvailability(slack, SLACK_ENV), "live");
    assert.deepEqual(registry.missingProviderEnv(slack, { SLACK_CLIENT_ID: "x" }), ["SLACK_CLIENT_SECRET", "SLACK_SIGNING_SECRET", "CONNECTIONS_OAUTH_STATE_SECRET"]);
    // Every other coming-soon OAuth provider stays coming soon whatever the env holds.
    for (const id of ["quickbooks", "xero", "gohighlevel", "meta", "zoom", "plaid"]) {
      assert.equal(registry.providerAvailability(registry.providerById(id)!, { ...SLACK_ENV, INTUIT_CLIENT_ID: "x", INTUIT_CLIENT_SECRET: "y" }), "coming_soon", id);
    }
    assert.deepEqual([...registry.providerById("slack")!.scopes.base].sort(), [
      "app_mentions:read", "channels:history", "channels:read", "chat:write", "commands", "team:read", "users:read", "users:read.email",
    ]);
  });

  await check("with the secrets absent, the Slack card says 'app not configured yet' and offers no connect", () => {
    assert.deepEqual(appNotConfiguredProviders({}), ["slack"]);
    const status = connectors.resolveConnectorStatus(
      connectors.connectorBySlug("slack")!,
      { keyRows: [], heartbeats: [], personalGoogleLinked: null, connections: [], appNotConfigured: appNotConfiguredProviders({}) },
      Date.now(),
    );
    assert.equal(status.kind, "coming_soon");
    assert.equal(status.label, "Slack app not configured yet");
    assert.deepEqual(appNotConfiguredProviders(SLACK_ENV), []);
  });

  await check("authorize refuses when the app is not configured: nothing is written, the browser is told why", async () => {
    await login(USERS.ownerA);
    const res = await authorize();
    assert.equal(res.status, 303);
    const to = landed(res);
    assert.equal(to.pathname, "/settings/chat-apps");
    assert.equal(to.searchParams.get("slack"), "error");
    assert.equal(to.searchParams.get("reason"), "not_configured");
    assert.equal(await count("SELECT COUNT(*) AS n FROM oauth_states"), 0);
  });

  await check("no fallback secret: without CONNECTIONS_OAUTH_STATE_SECRET nothing starts, though the encryption key is set", async () => {
    setSlackEnv(true, ["CONNECTIONS_OAUTH_STATE_SECRET"]);
    try {
      const res = await authorize();
      assert.equal(landed(res).searchParams.get("reason"), "not_configured");
      assert.throws(() => oauth.oauthStateSecret(process.env), /no fallback/);
      assert.equal(await count("SELECT COUNT(*) AS n FROM oauth_states"), 0);
    } finally {
      setSlackEnv(false);
    }
  });

  setSlackEnv(true);

  await check("only an owner or admin may start an install", async () => {
    await login(USERS.memberA);
    const res = await authorize();
    assert.equal(res.status, 403);
    await login(null);
    assert.equal((await authorize()).status, 401);
  });

  await check("authorize sends the owner to Slack with the bot scopes and a signed, stored, single-use state", async () => {
    await login(USERS.ownerA);
    const res = await authorize();
    assert.equal(res.status, 303);
    const { loc, state } = stateFrom(res);
    assert.equal(loc.origin + loc.pathname, "https://slack.com/oauth/v2/authorize");
    assert.equal(loc.searchParams.get("client_id"), SLACK_ENV.SLACK_CLIENT_ID);
    assert.equal(loc.searchParams.get("redirect_uri"), "https://oasisai.work/api/connections/slack/callback");
    assert.equal(loc.searchParams.get("scope"), registry.providerById("slack")!.scopes.base.join(","));
    assert.ok(state.includes("."), "body.signature");
    const rows = (await db.execute("SELECT tenant_id, user_id, provider, consumed_at FROM oauth_states")).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].tenant_id, ALPHA);
    assert.equal(rows[0].user_id, USERS.ownerA.id);
    assert.equal(rows[0].provider, "slack");
    assert.equal(rows[0].consumed_at, null);
  });

  await check("a provider with no finish step never starts a consent", async () => {
    const res = await authorize("stripe");
    assert.equal(landed(res).searchParams.get("reason"), "no_install_flow");
  });

  // ── 2. The callback ───────────────────────────────────────────────────────

  let firstState = "";
  await check("the callback connects the team, routes it to this workspace and stores the token encrypted", async () => {
    await login(USERS.ownerA);
    firstState = stateFrom(await authorize()).state;
    const res = await callback({ code: "code-alpha", state: firstState });
    const to = landed(res);
    assert.equal(to.pathname, "/settings/chat-apps");
    assert.equal(to.searchParams.get("slack"), "connected", to.search);
    const conn = (await db.execute("SELECT id, tenant_id, external_account_id, external_account_label, status, last_health_verdict FROM tenant_connections WHERE provider = 'slack'")).rows;
    assert.equal(conn.length, 1);
    assert.equal(conn[0].tenant_id, ALPHA);
    assert.equal(conn[0].external_account_id, "T0ALPHA");
    assert.equal(conn[0].status, "connected", "a live auth.test proved it");
    assert.equal(conn[0].last_health_verdict, "healthy");
    const route = (await db.execute("SELECT tenant_id, connection_id FROM provider_webhook_routes WHERE provider = 'slack' AND external_key = 'T0ALPHA'")).rows;
    assert.equal(route.length, 1);
    assert.equal(route[0].tenant_id, ALPHA);
    const cred = (await db.execute({ sql: "SELECT field_key, encrypted_value FROM tenant_integration_credentials WHERE service = ?", args: [`connection:${conn[0].id}`] })).rows;
    const token = cred.find((r) => r.field_key === "bot_token");
    assert.ok(token, "the bot token is stored");
    assert.notEqual(String(token!.encrypted_value), "xoxb-alpha-install-token", "never in plain text");
    assert.equal(decryptField(String(token!.encrypted_value)), "xoxb-alpha-install-token");
    assert.equal(exchanges[exchanges.length - 1].redirect_uri, "https://oasisai.work/api/connections/slack/callback");
  });

  await check("end to end: after the install, Settings > Connections reads Slack as connected for that workspace only, and each kind of workspace is shown its own path", async () => {
    const { loadConnectorStatuses } = await import("../components/os/connections/connector-facts");
    const alpha = (await loadConnectorStatuses({ tenantId: ALPHA, userId: USERS.ownerA.id })).slack;
    assert.equal(alpha.kind, "connected", JSON.stringify(alpha));
    assert.match(alpha.label, /^Connected · verified/);
    assert.equal(alpha.account, "Alpha Slack");
    const bravo = (await loadConnectorStatuses({ tenantId: BRAVO_CO, userId: USERS.ownerB.id })).slack;
    assert.notEqual(bravo.kind, "connected", "another workspace's card is untouched");
    // CC's model (W10a R1): a client connects its own Slack app, which is not
    // built yet; OASIS's own workspace uses the OASIS app.
    assert.deepEqual([bravo.kind, bravo.label], ["coming_soon", "Not built yet"]);
    assert.deepEqual(bravo.paths?.map((p) => [p.title, p.state]), [["Your own Slack app", "Not built yet"]]);
    const paths = connectors.connectorBySlug("slack")!.paths ?? [];
    assert.deepEqual(paths.map((p) => [p.audience, p.title, p.built]), [["oasis", "The OASIS Slack app", true], ["client", "Your own Slack app", false]]);
    assert.ok(paths.every((p) => !/OASIS's own included|every workspace/i.test(p.body)), "no path claims to be every workspace's way in");
  });

  await check("the state is single-use: the same state again is refused and nothing changes", async () => {
    const before = await count("SELECT COUNT(*) AS n FROM tenant_connections");
    const exchangesBefore = exchanges.length;
    const res = await callback({ code: "code-alpha-2", state: firstState });
    const to = landed(res);
    assert.equal(to.searchParams.get("slack"), "error");
    assert.equal(to.searchParams.get("reason"), "state_invalid");
    assert.equal(exchanges.length, exchangesBefore, "the code was never exchanged");
    assert.equal(await count("SELECT COUNT(*) AS n FROM tenant_connections"), before);
  });

  await check("a tampered state (payload or signature changed) is refused before Slack is called", async () => {
    const fresh = stateFrom(await authorize()).state;
    const [body, sig] = fresh.split(".");
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Record<string, unknown>;
    const forgedBody = Buffer.from(JSON.stringify({ ...payload, t: BRAVO_CO })).toString("base64url");
    const exchangesBefore = exchanges.length;
    for (const tampered of [`${forgedBody}.${sig}`, `${body}.${sig.slice(0, -2)}AA`, "not-a-state"]) {
      const res = await callback({ code: "code-alpha", state: tampered });
      assert.equal(landed(res).searchParams.get("reason"), "state_invalid", tampered.slice(0, 20));
    }
    assert.equal(exchanges.length, exchangesBefore);
  });

  await check("a state started by one person cannot be finished by another (no consent lands in the wrong workspace)", async () => {
    await login(USERS.ownerA);
    const started = stateFrom(await authorize()).state;
    await login(USERS.ownerB);
    const exchangesBefore = exchanges.length;
    const res = await callback({ code: "code-alpha", state: started });
    assert.equal(landed(res).searchParams.get("reason"), "wrong_person");
    assert.equal(exchanges.length, exchangesBefore);
    assert.equal(await count("SELECT COUNT(*) AS n FROM tenant_connections WHERE tenant_id = ?", [BRAVO_CO]), 0);
  });

  await check("a Slack team already connected to another workspace is refused, and nothing is stored for the second one", async () => {
    await login(USERS.ownerB);
    const state = stateFrom(await authorize()).state;
    const res = await callback({ code: "code-bravo-same-team", state });
    assert.equal(landed(res).searchParams.get("reason"), "team_connected_elsewhere");
    assert.equal(await count("SELECT COUNT(*) AS n FROM tenant_connections WHERE tenant_id = ?", [BRAVO_CO]), 0);
    assert.equal(await count("SELECT COUNT(*) AS n FROM tenant_integration_credentials WHERE tenant_id = ?", [BRAVO_CO]), 0);
    assert.equal(await count("SELECT COUNT(*) AS n FROM provider_webhook_routes WHERE tenant_id = ?", [BRAVO_CO]), 0);
  });

  await check("a second, different team while one is connected is refused: switching is an explicit disconnect", async () => {
    await login(USERS.adminA);
    const state = stateFrom(await authorize()).state;
    const res = await callback({ code: "code-alpha-other-team", state });
    assert.equal(landed(res).searchParams.get("reason"), "another_team_connected");
    assert.equal(await count("SELECT COUNT(*) AS n FROM provider_webhook_routes WHERE external_key = 'T0SECOND'"), 0);
  });

  await check("a cancelled install connects nothing", async () => {
    await login(USERS.ownerA);
    const res = await callback({ error: "access_denied", state: "whatever" });
    assert.equal(landed(res).searchParams.get("slack"), "denied");
  });

  await check("the return banner turns only known codes into words and never echoes the query", () => {
    assert.equal(slackInstallBanner("connected", null)?.ok, true);
    assert.match(slackInstallBanner("error", "team_connected_elsewhere")!.text, /another OASIS workspace/);
    const hostile = slackInstallBanner("error", "<script>alert(1)</script>")!;
    assert.doesNotMatch(hostile.text, /script/);
    assert.equal(slackInstallBanner("weird", "x"), null);
  });

  // ── 3. The channel map API, and a disconnect ──────────────────────────────

  const channelsRoute = await import("../app/api/slack/channels/route");
  const disconnectRoute = await import("../app/api/connections/[provider]/disconnect/route");
  const putChannel = (b: Record<string, unknown>) =>
    channelsRoute.PUT(
      new NextRequest("https://oasisai.work/api/slack/channels", { method: "PUT", body: JSON.stringify(b), headers: { "content-type": "application/json" } }),
    );
  const routesOf = async (tenantId: string) => count("SELECT COUNT(*) AS n FROM slack_channel_routes WHERE tenant_id = ?", [tenantId]);

  await check("a channel shared with another company cannot be mapped: 409, and nothing is written", async () => {
    await login(USERS.ownerA);
    const res = await putChannel({ channel_id: "C0PARTNERS", department: "sales" });
    assert.equal(res.status, 409);
    assert.equal(((await res.json()) as { error: string }).error, "shared_channel");
    assert.equal(await count("SELECT COUNT(*) AS n FROM slack_channel_routes WHERE channel_id = 'C0PARTNERS'"), 0);
  });

  await check("a client workspace maps a channel only to a department with an AI teammate; the rest are refused with the reason", async () => {
    await login(USERS.ownerA);
    const refused = await putChannel({ channel_id: "C0MARKETING", department: "marketing" });
    assert.equal(refused.status, 400);
    const why = (await refused.json()) as { error: string; message: string };
    assert.equal(why.error, "department_not_set_up");
    assert.match(why.message, /^Marketing has no AI teammate in this workspace yet/);
    assert.equal(await count("SELECT COUNT(*) AS n FROM slack_channel_routes WHERE channel_id = 'C0MARKETING'"), 0);
    const mapped = await putChannel({ channel_id: "C0CLIENTS", department: "client_success" });
    assert.equal(mapped.status, 200, await mapped.clone().text());
    const general = await putChannel({ channel_id: "C0MARKETING", department: null });
    assert.equal(general.status, 200, "a general channel is always allowed");
    assert.equal(await routesOf(ALPHA), 2);
  });

  await check("disconnecting Slack deletes its channel map and the people it looked up; the next workspace to install that team can map its channels", async () => {
    const at = new Date().toISOString();
    await db.execute({
      sql: `INSERT INTO external_identities (id, tenant_id, provider, external_team_id, external_user_id, display_name, profile_id,
              is_guest, is_external, checked_at, created_at, updated_at)
            VALUES ('ei-alpha-1', ?, 'slack', 'T0ALPHA', 'UALPHA1', 'Ann Alpha', ?, 0, 0, ?, ?, ?)`,
      args: [ALPHA, `p-${USERS.ownerA.id}`, at, at, at],
    });
    await login(USERS.ownerA);
    const res = await disconnectRoute.POST(new Request("https://oasisai.work/api/connections/slack/disconnect", { method: "POST" }), ctx("slack"));
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.disconnected, true);
    assert.equal(await routesOf(ALPHA), 0, "the channel map went with the connection");
    assert.equal(await count("SELECT COUNT(*) AS n FROM external_identities WHERE tenant_id = ?", [ALPHA]), 0, "so did the Slack people");
    // The confirmation the owner reads before clicking says exactly that.
    const confirmCopy = read("components/settings/SlackDisconnect.tsx").replace(/\s+/g, " ");
    assert.match(confirmCopy, /OASIS deletes its Slack token, the channel map and the Slack names it looked up/);
    assert.doesNotMatch(confirmCopy, /Mapped channels and past messages stay/, "the old promise that the map stays is gone");

    // Bravo installs the same Slack team, then maps #clients.
    await login(USERS.ownerB);
    const state = stateFrom(await authorize()).state;
    const cb = await callback({ code: "code-bravo-same-team", state });
    assert.equal(landed(cb).searchParams.get("slack"), "connected", landed(cb).search);
    const mapped = await putChannel({ channel_id: "C0CLIENTS", department: "sales" });
    assert.equal(mapped.status, 200, await mapped.clone().text());
    const rows = (await db.execute("SELECT tenant_id, department FROM slack_channel_routes WHERE team_id = 'T0ALPHA' AND channel_id = 'C0CLIENTS'")).rows;
    assert.deepEqual(
      rows.map((r) => [String(r.tenant_id), String(r.department)]),
      [[BRAVO_CO, "sales"]],
    );
  });

  // ── 4. Independent verification (2026-09-30): install guards no earlier check held ──

  await check("unmapping takes a real channel id only; a real one is removed", async () => {
    await login(USERS.ownerB);
    const del = (id: string) => channelsRoute.DELETE(new NextRequest(`https://oasisai.work/api/slack/channels?channel_id=${encodeURIComponent(id)}`, { method: "DELETE" }));
    const bad = await del("C0CLIENTS' OR 1=1");
    assert.equal(bad.status, 400);
    assert.equal(((await bad.json()) as { error: string }).error, "invalid_channel");
    assert.equal(await routesOf(BRAVO_CO), 1, "nothing removed");
    const ok = await del("C0CLIENTS");
    assert.equal(ok.status, 200);
    assert.equal(((await ok.json()) as { removed: boolean }).removed, true);
    assert.equal(await routesOf(BRAVO_CO), 0);
  });

  await check("a mapped channel missing from a COMPLETE list is orphaned; missing from a TRUNCATED list it is only 'beyond the page' (CodeRabbit #501)", async () => {
    await login(USERS.ownerB);
    const at = new Date().toISOString();
    await db.execute({
      sql: `INSERT INTO slack_channel_routes (id, tenant_id, team_id, channel_id, channel_name, department, customer_id, created_by, created_at, updated_at)
            VALUES ('r-gone', ?, 'T0ALPHA', 'C0GONE', 'gone', 'sales', NULL, NULL, ?, ?)`,
      args: [BRAVO_CO, at, at],
    });
    try {
      type Listing = { ok: boolean; truncated: boolean; orphaned: Array<{ channel_id: string }>; beyond_page: Array<{ channel_id: string }> };
      listMode = "complete";
      const complete = (await (await channelsRoute.GET()).json()) as Listing;
      assert.equal(complete.ok, true, JSON.stringify(complete));
      assert.equal(complete.truncated, false);
      assert.deepEqual(complete.orphaned.map((o) => o.channel_id), ["C0GONE"], "a complete list proves the channel is gone");
      assert.deepEqual(complete.beyond_page, []);

      listMode = "endless";
      const truncated = (await (await channelsRoute.GET()).json()) as Listing;
      assert.equal(truncated.ok, true, JSON.stringify(truncated));
      assert.equal(truncated.truncated, true);
      assert.deepEqual(truncated.orphaned, [], "a truncated list proves nothing, so nothing is called orphaned");
      assert.deepEqual(truncated.beyond_page.map((o) => o.channel_id), ["C0GONE"], "but the mapping is still shown, so it can be unmapped");
      // The page renders that bucket with honest copy, never as "no longer lists".
      const ui = read("components/settings/SlackChannelMap.tsx");
      assert.match(ui, /beyond_page/);
      assert.match(ui, /not among the first 500 channels listed \(they may still be live\)/);
    } finally {
      listMode = "complete";
      await db.execute({ sql: "DELETE FROM slack_channel_routes WHERE id = 'r-gone'", args: [] });
    }
  });

  const liveSlackOf = async (tenantId: string) => count("SELECT COUNT(*) AS n FROM tenant_connections WHERE tenant_id = ? AND provider = 'slack' AND revoked_at IS NULL", [tenantId]);
  const botTokensOf = async (tenantId: string) => count("SELECT COUNT(*) AS n FROM tenant_integration_credentials WHERE tenant_id = ? AND field_key = 'bot_token'", [tenantId]);

  await check("an Enterprise Grid org-wide install and a token that is not a bot token are refused, and nothing is stored", async () => {
    await login(USERS.ownerA);
    assert.equal(await liveSlackOf(ALPHA), 0, "Alpha disconnected above");
    for (const [code, reason] of [["code-enterprise", "enterprise_install_unsupported"], ["code-user-token", "not_a_bot_token"]] as const) {
      const state = stateFrom(await authorize()).state;
      const res = await callback({ code, state });
      assert.equal(landed(res).searchParams.get("reason"), reason, code);
      assert.equal(await liveSlackOf(ALPHA), 0, `${code}: no connection`);
      assert.equal(await botTokensOf(ALPHA), 0, `${code}: no token stored`);
    }
    assert.equal(await count("SELECT COUNT(*) AS n FROM provider_webhook_routes WHERE external_key IN ('T0ENTERPRISE', 'T0USERTOK')"), 0);
  });

  await check("a team routed to another workspace mid-install (the race after the check) leaves nothing behind: no connection, no token", async () => {
    await login(USERS.ownerA);
    const state = stateFrom(await authorize()).state;
    const bravoConn = String((await db.execute({ sql: "SELECT id FROM tenant_connections WHERE tenant_id = ? AND provider = 'slack' AND revoked_at IS NULL", args: [BRAVO_CO] })).rows[0].id);
    // Bravo routes T0RACE between Alpha's check and Alpha's own route insert.
    let raced = false;
    const racingDb = new Proxy(db, {
      get(target, prop) {
        if (prop === "execute") {
          return async (stmt: Parameters<typeof db.execute>[0]) => {
            const sql = typeof stmt === "string" ? stmt : stmt.sql;
            if (!raced && /INSERT INTO provider_webhook_routes/.test(sql)) {
              raced = true;
              await target.execute({
                sql: "INSERT INTO provider_webhook_routes (id, tenant_id, provider, external_key, connection_id, created_at) VALUES ('route-race', ?, 'slack', 'T0RACE', ?, ?)",
                args: [BRAVO_CO, bravoConn, new Date().toISOString()],
              });
            }
            return target.execute(stmt);
          };
        }
        const v = Reflect.get(target, prop) as unknown;
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    const install = await import("../lib/slack/install");
    const done = await install.completeSlackInstall(
      { db: racingDb, now: () => new Date() },
      {
        provider: registry.providerForEnv("slack", process.env)!,
        state,
        code: "code-race",
        redirectUri: "https://oasisai.work/api/connections/slack/callback",
        session: { tenantId: ALPHA, userId: USERS.ownerA.id, email: USERS.ownerA.email },
      },
    );
    assert.equal(raced, true, "the race happened");
    assert.deepEqual(done, { ok: false, failure: "team_connected_elsewhere" });
    assert.equal(await liveSlackOf(ALPHA), 0, "the claim is undone");
    assert.equal(await botTokensOf(ALPHA), 0, "the saved token is deleted");
    const routes = (await db.execute("SELECT tenant_id FROM provider_webhook_routes WHERE external_key = 'T0RACE'")).rows.map((r) => String(r.tenant_id));
    assert.deepEqual(routes, [BRAVO_CO]);
    await db.execute("DELETE FROM provider_webhook_routes WHERE id = 'route-race'");
  });

  await check("an install whose token answers for another Slack team is recorded as down, never green", async () => {
    await login(USERS.ownerA);
    const state = stateFrom(await authorize()).state;
    await callback({ code: "code-mismatch", state });
    const conn = (await db.execute({ sql: "SELECT external_account_id, last_health_verdict, last_health_code FROM tenant_connections WHERE tenant_id = ? AND provider = 'slack' AND revoked_at IS NULL", args: [ALPHA] })).rows;
    assert.equal(conn.length, 1);
    assert.equal(conn[0].external_account_id, "T0MISMATCH");
    assert.equal(conn[0].last_health_verdict, "down");
    assert.equal(conn[0].last_health_code, "account_mismatch");
  });

  globalThis.fetch = realFetch;
  console.log(`\n${passed} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
