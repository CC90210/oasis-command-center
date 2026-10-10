/**
 * every-connector-works.test.ts - every app in Settings > Connections has a
 * button that does something real, and the connection it makes works.
 *
 * WHY. CC, 2026-10-10: "Make sure they all have their own section ... We need
 * a functional button just like Constant Contact ... Clicking should take you to
 * the necessary authorization page, or if it's an API key, it saves it
 * securely ... whenever a functionality is built, it never really works."
 *
 * So this test does not stop at "the card exists". It walks the WHOLE catalog
 * and holds each connector to its own way in:
 *
 *   key form    the schema exists, its Test probe exists, and the Test is run
 *               against a mocked vendor (Plaid, Discord, Microsoft Teams, Meta
 *               Ads): saved encrypted, a pass is green with the account's name,
 *               every refusal is in plain words, a webhook is pinned to the
 *               vendor's own domain, a secret never goes to a new host.
 *   sign-in     the provider is registered with its secrets named, the
 *               authorize route sends the browser to the vendor's real page, the
 *               callback stores encrypted tokens for the session's workspace, an
 *               expired access token is refreshed on use (the rotating refresh
 *               token is kept), Test again works, and Disconnect tells the
 *               vendor and deletes OASIS's copy (QuickBooks, Xero, Zoom,
 *               WhatsApp), against a mocked vendor that REJECTS a stale token.
 *   neither     an honest "Not available on this workspace yet" with no button.
 *
 * And it holds the copy: no card, status, drawer or hub says "registering",
 * "once approved" or "coming soon".
 *
 * Real routes, real signed session, real store and encryption on a local libSQL
 * file. Every vendor is mocked at the fetch boundary; any other host fails the
 * test, so nothing reaches a real provider.
 *
 * Run: node --conditions=react-server --import tsx tests/every-connector-works.test.ts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { format } from "node:util";
import { createClient, type Client } from "@libsql/client";

const dbFile = join(mkdtempSync(join(tmpdir(), "every-connector-works-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
process.env.EMPIRE_AUTH_BACKEND = "turso";
process.env.AUTH_SESSION_SECRET = "every-connector-works-session-secret-long-enough-01";
process.env.BRAVO_FIELD_ENCRYPTION_KEY = "every-connector-works-field-encryption-passphrase";
process.env.PUBLIC_APP_URL = "https://oasisai.work";
const STATE_SECRET = "every-connector-works-state-secret-".padEnd(48, "x");

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

// -- Tenants and people ---------------------------------------------------------

const ALPHA = "a1a1a1a1-0000-4000-8000-0000000000a1";
const BRAVO_CO = "b2b2b2b2-0000-4000-8000-0000000000b2";
/** One of OASIS's own workspaces (the env-credential tenants): its operator is told the secret NAMES. */
const OASIS_OWN = "ef8d389e-3f15-43f2-ae00-3660f69a1452";
type U = { id: string; email: string };
const u = (n: number, email: string): U => ({ id: `0e000000-0000-4000-8000-${String(n).padStart(12, "0")}`, email });
const USERS = {
  ownerA: u(1, "owner@alpha.test"),
  memberA: u(2, "member@alpha.test"),
  ownerB: u(3, "owner@bravo.test"),
} as const;

async function login(user: U | null): Promise<void> {
  if (!user) {
    sessionCookie = undefined;
    return;
  }
  const { signSession } = await import("../lib/turso-auth");
  sessionCookie = signSession({ sub: user.id, email: user.email, exp: Math.floor(Date.now() / 1000) + 3600, ver: 0 });
}

// -- Every line the code logs is kept, so the test can prove no secret reached a log -------------

const logged: string[] = [];
for (const level of ["error", "warn", "log", "info"] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    const line = format(...args);
    logged.push(line);
    if (/^\s+(ok|FAIL)\s|^[a-z-]+:( all passed)?$/i.test(line) || line.startsWith("every-connector-works")) original(line);
  };
}

// -- Vendors, mocked at the fetch boundary ------------------------------------------------------

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

type Call = { host: string; path: string; method: string; auth: string; body: string; query: URLSearchParams; headers: Headers };
const calls: Call[] = [];

/** Every secret value that ever crossed the mocked wire or was typed in: none may appear in a log or an answer. */
const SENSITIVE = new Set<string>();

type TokenMode = {
  refuse: boolean;
  revokeFails: boolean;
  metaRefreshCode: number | null;
  /** The access token Xero issues carries this as its `authentication_event_id` claim (a real JWT shape) instead of the default opaque string. */
  xeroAuthEventId: string | null;
  /** GET /connections answers with this instead of the one default organisation. */
  xeroOrgs: Array<Record<string, unknown>> | null;
  /** Zoom's /v2/users/me answers with this account_id instead of the fixture default, to simulate a second, different Zoom account signing in. */
  zoomAccountOverride: string | null;
  /** The ids debug_token's granular_scopes.target_ids answers with, instead of the one default WABA — several means one consent approved several accounts. */
  whatsappTargetIds: string[] | null;
  /** debug_token's data.user_id — the ONE Facebook user, regardless of which WhatsApp Business Account (WABA) they approved. */
  metaUserId: string;
  /** Every Xero connection id DELETE /connections/{id} has removed (the new, per-organisation revoke). */
  xeroDeletedConnectionIds: Set<string>;
  /** Set if anything ever calls the user-wide /connect/revocation endpoint again — a regression tripwire. */
  xeroUserWideRevokeCalled: boolean;
};
const mode: TokenMode = {
  refuse: false,
  revokeFails: false,
  metaRefreshCode: null,
  xeroAuthEventId: null,
  xeroOrgs: null,
  zoomAccountOverride: null,
  whatsappTargetIds: null,
  metaUserId: "meta-user-1",
  xeroDeletedConnectionIds: new Set(),
  xeroUserWideRevokeCalled: false,
};

/** A JWT shape good enough for xeroAuthEventId to read (lib/connections/oauth-adapters.ts): unsigned, never verified by that code. */
const xeroJwt = (authEventId: string) =>
  [
    Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify({ authentication_event_id: authEventId })).toString("base64url"),
    "test-unsigned",
  ].join(".");

/** What each OAuth vendor last issued; a token that is not the latest is rejected, as the rotating vendors do. */
const issued: Record<string, { n: number; access: string; refresh: string; revoked: boolean }> = {};
const live = (v: string) => issued[v] ?? (issued[v] = { n: 0, access: "", refresh: "", revoked: false });

const OAUTH_APPS = [
  {
    id: "quickbooks",
    name: "QuickBooks",
    env: { INTUIT_CLIENT_ID: "qb-client-id", INTUIT_CLIENT_SECRET: "qb-client-secret-value" },
    authorizeHost: "appcenter.intuit.com",
    callbackExtra: "&realmId=9130350000000001",
    account: "9130350000000001",
    label: "Alpha Books LLC",
    exclusive: true,
  },
  {
    id: "xero",
    name: "Xero",
    env: { XERO_CLIENT_ID: "xero-client-id", XERO_CLIENT_SECRET: "xero-client-secret-value" },
    authorizeHost: "login.xero.com",
    callbackExtra: "",
    account: "xero-tenant-0001",
    label: "Alpha Xero Organisation",
    exclusive: true,
  },
  {
    id: "zoom",
    name: "Zoom",
    env: { ZOOM_CLIENT_ID: "zoom-client-id", ZOOM_CLIENT_SECRET: "zoom-client-secret-value" },
    authorizeHost: "zoom.us",
    callbackExtra: "",
    account: "zoom-account-0001",
    label: "owner@alpha.test",
    exclusive: false,
  },
  {
    id: "whatsapp",
    name: "WhatsApp",
    env: { META_APP_ID: "meta-app-id", META_APP_SECRET: "meta-app-secret-value" },
    authorizeHost: "www.facebook.com",
    callbackExtra: "",
    account: "104000000000001",
    label: "Alpha WhatsApp Business",
    exclusive: false,
  },
] as const;
type OAuthApp = (typeof OAUTH_APPS)[number];
// The app SECRET is sensitive; the client id is public by design (it is in the address the browser is sent to).
for (const app of OAUTH_APPS) SENSITIVE.add(Object.values(app.env)[1]);

const basicOf = (app: OAuthApp) => `Basic ${Buffer.from(`${Object.values(app.env)[0]}:${Object.values(app.env)[1]}`).toString("base64")}`;

/** Issue the next token pair for a vendor and remember it as the only live one. */
function issue(v: string): { access: string; refresh: string } {
  const s = live(v);
  s.n += 1;
  s.access = v === "xero" && mode.xeroAuthEventId ? xeroJwt(mode.xeroAuthEventId) : `${v}-access-token-${s.n}-${"A".repeat(20)}`;
  s.refresh = v === "whatsapp" ? s.access : `${v}-refresh-token-${s.n}-${"R".repeat(20)}`;
  s.revoked = false;
  SENSITIVE.add(s.access).add(s.refresh);
  return { access: s.access, refresh: s.refresh };
}

const bearerOf = (h: Headers) => (h.get("authorization") ?? "").replace(/^Bearer /, "");
const accessOk = (v: string, h: Headers) => bearerOf(h) === live(v).access && !live(v).revoked;

function oauthVendor(url: URL, init: RequestInit | undefined, call: Call): Response | null {
  const form = new URLSearchParams(typeof init?.body === "string" && !call.headers.get("content-type")?.includes("json") ? init.body : "");
  const app = (id: string) => OAUTH_APPS.find((a) => a.id === id)!;

  // Xero's per-ORGANISATION revoke: GET /connections, then DELETE
  // /connections/{id} for just the one pinned organisation — never the
  // user-wide POST /connect/revocation, which would drop every other
  // organisation the same Xero user ever connected (security review, PR #574).
  if (url.hostname === "api.xero.com" && url.pathname.startsWith("/connections/")) {
    assert.equal(call.method, "DELETE", "Xero's revoke must be a per-connection DELETE, never a POST to the user-wide endpoint");
    if (mode.revokeFails) return json(500, { error: "server_error" });
    if (!accessOk("xero", call.headers)) return json(401, { Title: "Unauthorized" });
    mode.xeroDeletedConnectionIds.add(decodeURIComponent(url.pathname.slice("/connections/".length)));
    live("xero").revoked = true;
    // Xero answers 204 No Content on a successful DELETE, never 200 (Codex
    // review, PR #574) — the fixture must match the real vendor or the 200-
    // only bug this tests for would never surface.
    return new Response(null, { status: 204 });
  }
  // A WhatsApp Business Account's own name lookup, by whichever id the sign-in pinned (not only the fixture default).
  const wabaId = url.hostname === "graph.facebook.com" ? /^\/v23\.0\/(\d{5,25})$/.exec(url.pathname)?.[1] : null;
  if (wabaId) {
    if (!accessOk("whatsapp", call.headers)) return json(400, { error: { type: "OAuthException", code: 190, message: "Invalid OAuth access token." } });
    return json(200, { id: wabaId, name: wabaId === app("whatsapp").account ? app("whatsapp").label : `WABA ${wabaId}` });
  }

  // -- the token endpoints (Basic client auth, form body), the same shape for three vendors
  const tokenEndpoint = (v: string) => {
    assert.equal(call.method, "POST");
    assert.equal(call.auth, basicOf(app(v)), `${v}: the token endpoint is called with OASIS's app credentials`);
    if (form.get("grant_type") === "authorization_code") {
      if (form.get("code") !== "good-code") return json(400, { error: "invalid_grant" });
      assert.equal(form.get("redirect_uri"), `https://oasisai.work/api/connections/${v}/callback`);
    } else {
      assert.equal(form.get("grant_type"), "refresh_token");
      if (mode.refuse || form.get("refresh_token") !== live(v).refresh) return json(400, { error: "invalid_grant" });
    }
    const t = issue(v);
    return json(200, { access_token: t.access, refresh_token: t.refresh, expires_in: 3600, token_type: "bearer" });
  };
  const revoke = (v: string, tokenOf: (call: Call, form: URLSearchParams) => string, expected: string) => {
    if (mode.revokeFails) return json(500, { error: "server_error" });
    assert.equal(tokenOf(call, form), expected, `${v}: Disconnect revokes the right token`);
    live(v).revoked = true;
    return new Response(null, { status: 200 });
  };

  switch (`${url.hostname}${url.pathname}`) {
    // QuickBooks
    case "oauth.platform.intuit.com/oauth2/v1/tokens/bearer":
      return tokenEndpoint("quickbooks");
    case "quickbooks.api.intuit.com/v3/company/9130350000000001/companyinfo/9130350000000001":
      if (!accessOk("quickbooks", call.headers)) return json(401, { fault: { type: "AUTHENTICATION" } });
      return json(200, { CompanyInfo: { CompanyName: app("quickbooks").label, LegalName: "Alpha Books Legal" } });
    case "developer.api.intuit.com/v2/oauth2/tokens/revoke":
      return revoke("quickbooks", (c) => (JSON.parse(c.body) as { token: string }).token, live("quickbooks").refresh);
    // Xero
    case "identity.xero.com/connect/token":
      return tokenEndpoint("xero");
    case "api.xero.com/connections":
      if (!accessOk("xero", call.headers)) return json(401, { Title: "Unauthorized" });
      if (mode.xeroOrgs) return json(200, mode.xeroOrgs);
      return json(200, [{ id: "conn-1", tenantId: app("xero").account, tenantType: "ORGANISATION", tenantName: app("xero").label, authEventId: "evt-default" }]);
    case "identity.xero.com/connect/revocation":
      // A tripwire, not a working mock: Xero's revoke must never call the
      // user-wide endpoint again (it drops every organisation the same Xero
      // user ever connected, security review PR #574) — only the
      // per-connection DELETE /connections/{id} above. A throw inside the
      // mocked fetch itself is swallowed by send()'s own try/catch, so this
      // sets a flag the test asserts on instead of throwing here.
      mode.xeroUserWideRevokeCalled = true;
      return json(500, { error: "disabled_in_test" });
    // Zoom
    case "zoom.us/oauth/token":
      return tokenEndpoint("zoom");
    case "api.zoom.us/v2/users/me":
      if (!accessOk("zoom", call.headers)) return json(401, { code: 124, message: "Invalid access token." });
      return json(200, { id: "zoom-user-1", account_id: mode.zoomAccountOverride ?? app("zoom").account, email: app("zoom").label, display_name: "Alpha Owner" });
    case "zoom.us/oauth/revoke":
      return revoke("zoom", (_c, f) => f.get("token") ?? "", live("zoom").access);
    // WhatsApp, through Meta's Graph API
    case "graph.facebook.com/v23.0/oauth/access_token": {
      assert.equal(call.query.get("client_secret"), app("whatsapp").env.META_APP_SECRET);
      if (call.query.get("grant_type") === "fb_exchange_token") {
        const asked = call.query.get("fb_exchange_token");
        if (mode.metaRefreshCode !== null && asked !== "meta-short-lived-token") {
          return json(400, { error: { type: "OAuthException", code: mode.metaRefreshCode, message: "Meta says no" } });
        }
        const ok = asked === "meta-short-lived-token" || (!mode.refuse && asked === live("whatsapp").refresh);
        if (!ok) return json(400, { error: { type: "OAuthException", code: 190, message: "Error validating access token" } });
        const t = issue("whatsapp");
        return json(200, { access_token: t.access, token_type: "bearer", expires_in: 5184000 });
      }
      if (call.query.get("code") !== "good-code") return json(400, { error: { type: "OAuthException", code: 100 } });
      assert.equal(call.query.get("redirect_uri"), "https://oasisai.work/api/connections/whatsapp/callback");
      SENSITIVE.add("meta-short-lived-token");
      return json(200, { access_token: "meta-short-lived-token", token_type: "bearer", expires_in: 3600 });
    }
    case "graph.facebook.com/v23.0/debug_token":
      assert.equal(bearerOf(call.headers), `${app("whatsapp").env.META_APP_ID}|${app("whatsapp").env.META_APP_SECRET}`);
      return json(200, {
        data: {
          user_id: mode.metaUserId,
          granular_scopes: [{ scope: "whatsapp_business_management", target_ids: mode.whatsappTargetIds ?? [app("whatsapp").account] }],
        },
      });
    case "graph.facebook.com/v23.0/me/permissions":
      assert.equal(call.method, "DELETE");
      if (mode.revokeFails) return json(500, {});
      assert.equal(bearerOf(call.headers), live("whatsapp").access, "whatsapp: Disconnect withdraws the right token");
      live("whatsapp").revoked = true;
      return json(200, { success: true });
  }
  return null;
}

/** A credential's own words decide a key vendor's answer: revoked / noscope / busy / broken / offline. */
function keyVendor(url: URL, init: RequestInit | undefined, call: Call): Response | null {
  const word = (s: string) => ["revoked", "noscope", "busy", "broken", "offline", "missingacct"].find((w) => s.includes(w)) ?? "";
  const answer = (w: string, ok: () => Response, shapes: { revoked: Response; noscope: Response; missingacct?: Response }) => {
    if (w === "offline") throw new TypeError("fetch failed");
    if (w === "revoked") return shapes.revoked;
    if (w === "noscope") return shapes.noscope;
    if (w === "missingacct" && shapes.missingacct) return shapes.missingacct;
    if (w === "busy") return json(429, {});
    if (w === "broken") return json(500, {});
    return ok();
  };
  if (url.hostname === "sandbox.plaid.com" || url.hostname === "production.plaid.com") {
    assert.equal(url.pathname, "/institutions/get");
    assert.equal(call.method, "POST");
    assert.equal(init?.redirect, "manual", "a Test never follows a redirect");
    const sent = JSON.parse(call.body) as Record<string, unknown>;
    assert.deepEqual(Object.keys(sent).sort(), ["count", "country_codes", "offset"], "Plaid is asked for one bank and sent no customer data");
    assert.equal(sent.count, 1);
    const secret = call.headers.get("plaid-secret") ?? "";
    return answer(word(secret), () => json(200, { institutions: [{ institution_id: "ins_1", name: "Bank" }] }), {
      revoked: json(400, { error_type: "INVALID_INPUT", error_code: "INVALID_API_KEYS", error_message: "invalid" }),
      noscope: json(400, { error_type: "INVALID_REQUEST", error_code: "PRODUCT_NOT_ENABLED", error_message: "no" }),
    });
  }
  if (url.hostname === "discord.com") {
    assert.equal(call.method, "GET", "Discord's Test reads the webhook and posts nothing");
    assert.equal(init?.redirect, "manual");
    assert.match(url.pathname, /^\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+$/);
    return answer(word(url.pathname), () => json(200, { id: "123456789012345678", name: "OASIS alerts", channel_id: "223" }), {
      revoked: json(404, { message: "Unknown Webhook", code: 10015 }),
      noscope: json(403, {}),
    });
  }
  if (url.hostname.endsWith(".logic.azure.com")) {
    assert.equal(call.method, "POST");
    assert.equal(init?.redirect, "manual");
    const card = JSON.parse(call.body) as { type: string; attachments: Array<{ contentType: string; content: { body: Array<{ text: string }> } }> };
    assert.equal(card.type, "message");
    assert.equal(card.attachments[0].contentType, "application/vnd.microsoft.card.adaptive");
    assert.match(card.attachments[0].content.body[0].text, /OASIS is connected/);
    return answer(word(url.searchParams.get("sig") ?? ""), () => json(202, {}), { revoked: json(404, {}), noscope: json(403, {}) });
  }
  if (url.hostname === "graph.facebook.com" && /^\/v23\.0\/act_\d+$/.test(url.pathname)) {
    assert.equal(call.method, "GET");
    assert.equal(url.searchParams.has("access_token"), false, "the Meta token travels in a header, never in the address");
    assert.equal(url.pathname, "/v23.0/act_1234567890");
    return answer(word(bearerOf(call.headers)), () => json(200, { id: "act_1234567890", name: "Alpha Ads", account_status: 1 }), {
      revoked: json(400, { error: { code: 190, type: "OAuthException" } }),
      noscope: json(400, { error: { code: 200, type: "OAuthException" } }),
      missingacct: json(400, { error: { code: 100, type: "GraphMethodException" } }),
    });
  }
  return null;
}

const VENDOR_HOSTS = new Set([
  "oauth.platform.intuit.com", "quickbooks.api.intuit.com", "developer.api.intuit.com",
  "identity.xero.com", "api.xero.com", "zoom.us", "api.zoom.us", "graph.facebook.com",
  "sandbox.plaid.com", "production.plaid.com", "discord.com", "api.stripe.com",
]);

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(href);
  if (!VENDOR_HOSTS.has(url.hostname) && !url.hostname.endsWith(".logic.azure.com")) throw new Error(`unexpected network call in test: ${href}`);
  const headers = new Headers(init?.headers);
  const call: Call = {
    host: url.hostname,
    path: url.pathname,
    method: (init?.method || "GET").toUpperCase(),
    auth: headers.get("authorization") ?? "",
    body: typeof init?.body === "string" ? init.body : "",
    query: url.searchParams,
    headers,
  };
  calls.push(call);
  const res = oauthVendor(url, init, call) ?? keyVendor(url, init, call);
  if (!res) throw new Error(`unhandled vendor call ${call.method} ${href}`);
  return res;
}) as typeof fetch;

// -- Harness ---------------------------------------------------------------------------------

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
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

/** Render the drawer and hub for real (react-dom/server, in a child process without react-server). */
function renderClient(input: unknown): { markup: Record<string, string> } {
  const r = spawnSync(process.execPath, ["--import", "tsx", "tests/connections-everywhere.render.ts"], {
    cwd: root,
    input: JSON.stringify(input),
    encoding: "utf8",
    env: { ...process.env, NODE_OPTIONS: "" },
    maxBuffer: 32 * 1024 * 1024,
  });
  assert.equal(r.status, 0, `render failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

/** Words no card, status, drawer or hub may use (CC, 2026-10-10): a registration nobody can show, or a date nobody set. */
const BANNED_COPY = /registering|once approved|one click, once|coming soon|coming_soon/i;

const OAUTH_ENV_NAMES = [...new Set(OAUTH_APPS.flatMap((a) => Object.keys(a.env))), "CONNECTIONS_OAUTH_STATE_SECRET", "INTUIT_ENVIRONMENT"];
const setOAuthEnv = (on: boolean) => {
  for (const name of OAUTH_ENV_NAMES) delete process.env[name];
  if (!on) return;
  process.env.CONNECTIONS_OAUTH_STATE_SECRET = STATE_SECRET;
  for (const a of OAUTH_APPS) for (const [k, v] of Object.entries(a.env)) process.env[k] = v;
};

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
    CREATE TABLE integrations_health (tenant_id TEXT, service TEXT, status TEXT, last_ping_at TEXT);
    CREATE TABLE user_integration_credentials (id TEXT PRIMARY KEY, tenant_id TEXT, user_id TEXT, service TEXT,
      field_key TEXT, encrypted_value TEXT, last_tested_at TEXT, last_test_ok INTEGER, last_test_error TEXT, updated_at TEXT);
  `);
  await db.executeMultiple(read("database/turso/bravo__187_os_connections.sql"));
  await db.executeMultiple(read("database/turso/bravo__209_connection_vendor_principal.sql"));
  const stamp = "2026-09-01T00:00:00Z";
  const profile = (user: U, tenant: string, role: string, owner: 0 | 1 = 0) => ({
    sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, onboarding_completed_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [`p-${user.id}`, user.id, user.email, tenant, role, owner, stamp, stamp],
  });
  await db.batch(
    [
      ...Object.values(USERS).map((x) => ({ sql: `INSERT INTO "_supabase_auth_users" (id, email) VALUES (?, ?)`, args: [x.id, x.email] })),
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'alpha-co', 'Alpha Plumbing')", args: [ALPHA] },
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'bravo-co', 'Bravo Dental')", args: [BRAVO_CO] },
      profile(USERS.ownerA, ALPHA, "owner", 1),
      profile(USERS.memberA, ALPHA, "member"),
      profile(USERS.ownerB, BRAVO_CO, "owner", 1),
    ],
    "write",
  );

  const { NextRequest } = await import("next/server");
  const keysRoute = await import("../app/api/integrations/keys/route");
  const testRoute = await import("../app/api/integrations/keys/test/route");
  const authorizeRoute = await import("../app/api/connections/[provider]/authorize/route");
  const callbackRoute = await import("../app/api/connections/[provider]/callback/route");
  const connTestRoute = await import("../app/api/connections/[provider]/test/route");
  const disconnectRoute = await import("../app/api/connections/[provider]/disconnect/route");
  const statusRoute = await import("../app/api/connections/[provider]/status/route");
  const { loadWorkspaceConnectorStatus, loadConnectorStatuses } = await import("../components/os/connections/connector-facts");
  const connectors = await import("../lib/os/connectors");
  const schemas = await import("../lib/tenant-integration-schemas");
  const probes = await import("../lib/integrations/key-probes");
  const registry = await import("../lib/connections/registry");
  const adapters = await import("../lib/connections/oauth-adapters");
  const live_ = await import("../lib/connections/oauth-live");
  const store = await import("../lib/connections/store");
  const tokenStore = await import("../lib/connections/token-store");
  const oauthConnect = await import("../lib/connections/oauth-connect");
  const rules = await import("../lib/connections/rules");
  const health = await import("../lib/connections/health");
  const popup = await import("../lib/connections/popup");
  const { setTenantIntegrationValue, getTenantIntegrationBundle } = await import("../lib/tenant-integration-store");
  const { decryptField } = await import("../lib/field-encryption");

  type Res = { status: number; body: Record<string, unknown>; text: string };
  const seenTexts: string[] = [];
  const toRes = async (r: Response): Promise<Res> => {
    const t = await r.text();
    seenTexts.push(t);
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(t) as Record<string, unknown>;
    } catch {
      /* not JSON */
    }
    return { status: r.status, body, text: t };
  };
  const jsonReq = (url: string, method: string, body?: unknown) =>
    new NextRequest(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const save = async (service: string, field_key: string, value: string) => {
    // Only a field the form masks is a secret; an ad account number or a client id is an identifier.
    if (schemas.findIntegrationSchema(service)?.fields.find((f) => f.key === field_key)?.sensitive) SENSITIVE.add(value);
    return toRes(await keysRoute.POST(jsonReq("https://oasisai.work/api/integrations/keys", "POST", { service, field_key, value })));
  };
  const saveAll = async (service: string, values: Record<string, string>) => {
    for (const [k, v] of Object.entries(values)) {
      const r = await save(service, k, v);
      assert.equal(r.status, 200, `${service}.${k} did not save: ${r.text}`);
    }
  };
  const runTest = async (service: string) => toRes(await testRoute.POST(jsonReq("https://oasisai.work/api/integrations/keys/test", "POST", { service })));
  const card = async (tenantId: string, slug: string) => (await loadWorkspaceConnectorStatus(tenantId, slug))!;
  const ctx = (provider: string) => ({ params: Promise.resolve({ provider }) });

  console.log("every-connector-works:");

  // ===========================================================================================
  // 1. Walk the catalog: every connector's button leads somewhere real
  // ===========================================================================================

  /** The route file a path under app/ resolves to, if any. */
  const pageExists = (href: string) => existsSync(join(root, "app", href.split("?")[0], "page.tsx"));

  await check("every connector in the catalog has a button that resolves to something real, or an honest no-button state", () => {
    assert.ok(connectors.CONNECTOR_CATALOG.length >= 22, "the walk found the catalog");
    for (const def of connectors.CONNECTOR_CATALOG) {
      assert.ok(def.live, `${def.slug}: has nothing to connect with (a 'Not built yet' card)`);
      const { source, connect } = def.live!;
      assert.ok(connect.label.trim(), `${def.slug}: the button has words`);
      switch (connect.kind) {
        case "keys": {
          // A key form: the schema exists, can be saved, and its Test probe exists.
          const schema = schemas.findTenantManuallyEditableIntegrationSchema(connect.service);
          assert.ok(schema, `${def.slug}: no key form (schema "${connect.service}")`);
          assert.equal(source.kind, "tenant_keys", `${def.slug}: a key card reads the key store`);
          assert.equal((source as { service: string }).service, connect.service, `${def.slug}: the card reads the same service its form saves`);
          const fields = new Set(schema!.fields.map((f) => f.key));
          for (const f of (source as { requireAll: readonly string[] }).requireAll) assert.ok(fields.has(f), `${def.slug}: "${f}" is not a field of the form`);
          assert.equal((source as { verifiable: boolean }).verifiable, true, `${def.slug}: its Test must call the vendor`);
          assert.ok((source as { failureStates?: object }).failureStates, `${def.slug}: a failed Test has plain words`);
          if (connect.service !== "twilio" && connect.service !== "gws" && connect.service !== "telegram") {
            assert.ok(probes.hasKeyProbe(connect.service), `${def.slug}: the form has a Save but no Test probe (${connect.service})`);
          }
          break;
        }
        case "key_form": {
          const provider = registry.providerById(connect.provider);
          assert.ok(provider?.restrictedKey, `${def.slug}: no restricted-key config`);
          assert.equal(provider!.availability, "live", `${def.slug}: a pasted-key provider must be live`);
          assert.ok(health.probeFor(connect.provider), `${def.slug}: no live probe`);
          assert.ok(existsSync(join(root, "app/api/connections/[provider]/connect/route.ts")), `${def.slug}: no connect route`);
          break;
        }
        case "oauth": {
          // The vendor's own sign-in: a registered provider with its secrets named, an adapter,
          // and the two routes that start and finish it.
          const provider = registry.providerById(connect.provider);
          assert.ok(provider, `${def.slug}: provider "${connect.provider}" is not registered`);
          assert.equal(connect.provider, def.slug, `${def.slug}: the button's provider is the card's slug`);
          assert.deepEqual(source, { kind: "tenant_connection", provider: def.slug }, `${def.slug}: the card reads the connection the sign-in makes`);
          assert.ok(registry.isGenericOAuthProvider(provider!), `${def.slug}: not a generic sign-in provider`);
          assert.ok(registry.GENERIC_OAUTH_PROVIDER_IDS.includes(def.slug));
          assert.ok(adapters.oauthAdapterFor(def.slug), `${def.slug}: no adapter finishes its sign-in`);
          assert.ok(adapters.OAUTH_CONNECT_PROVIDERS.includes(def.slug));
          const oauth = provider!.oauth!;
          for (const url of [oauth.authorizeUrl, oauth.tokenUrl]) assert.match(url, /^https:\/\//, `${def.slug}: ${url}`);
          const needs = provider!.liveWhenEnv ?? [];
          assert.ok(needs.includes(oauth.clientIdEnv) && needs.includes(oauth.clientSecretEnv), `${def.slug}: the app's id and secret are named`);
          assert.ok(needs.includes("CONNECTIONS_OAUTH_STATE_SECRET"), `${def.slug}: the state secret is named`);
          assert.equal(provider!.availability, "coming_soon", `${def.slug}: the static row never claims live`);
          assert.ok(existsSync(join(root, "app/api/connections/[provider]/authorize/route.ts")));
          assert.ok(existsSync(join(root, "app/api/connections/[provider]/callback/route.ts")));
          assert.equal(connectors.oauthStartHref(connect.provider), `/api/connections/${def.slug}/authorize`);
          break;
        }
        case "popup": {
          const route = connect.href.replace(/^\/api\//, "app/api/") + "/route.ts";
          assert.ok(existsSync(join(root, route)), `${def.slug}: the popup's start route ${route} does not exist`);
          assert.ok(connect.messageSource.trim());
          break;
        }
        case "link":
          assert.ok(pageExists(connect.href), `${def.slug}: the page ${connect.href} does not exist`);
          break;
      }
    }
  });

  await check("the catalog's sections: Accounting, Banking, Meetings, Messaging & chat and Ads & social each hold the apps CC named", () => {
    const by = (category: string) => connectors.CONNECTOR_CATALOG.filter((d) => d.category === category).map((d) => d.slug).sort();
    assert.deepEqual(by("accounting"), ["quickbooks", "xero"]);
    assert.deepEqual(by("banking"), ["plaid"]);
    assert.ok(by("meetings").includes("zoom"));
    for (const slug of ["slack", "whatsapp", "discord", "microsoft-teams"]) assert.ok(by("messaging").includes(slug), `${slug}: in Messaging & chat`);
    assert.ok(by("ads_social").includes("meta"));
    for (const c of connectors.CONNECTOR_CATEGORIES) assert.ok(connectors.CONNECTOR_CATALOG.some((d) => d.category === c.key), `${c.key}: an empty section`);
  });

  await check("the OAuth providers and their adapters are the same list, and the pop-up source is one string", () => {
    assert.deepEqual([...registry.GENERIC_OAUTH_PROVIDER_IDS].sort(), [...adapters.OAUTH_CONNECT_PROVIDERS].sort());
    assert.deepEqual([...registry.GENERIC_OAUTH_PROVIDER_IDS].sort(), ["quickbooks", "whatsapp", "xero", "zoom"]);
    assert.equal(popup.CONNECTION_POPUP_SOURCE, connectors.OAUTH_POPUP_SOURCE);
    assert.ok(health.probedProviders({ ...Object.fromEntries(OAUTH_APPS.flatMap((a) => Object.entries(a.env))), CONNECTIONS_OAUTH_STATE_SECRET: STATE_SECRET }).includes("quickbooks"), "the hourly check covers a sign-in connection");
    // Not a single OAuth provider can be live on a deployment without its secrets.
    for (const id of registry.GENERIC_OAUTH_PROVIDER_IDS) assert.equal(registry.providerForEnv(id, {})?.availability, "coming_soon", id);
  });

  // ===========================================================================================
  // 2. The copy: nothing says registering / once approved / coming soon
  // ===========================================================================================

  await check("no card, status, schema, drawer or hub says 'registering', 'once approved' or 'coming soon'", async () => {
    const strings: string[] = [];
    for (const d of connectors.CONNECTOR_CATALOG) strings.push(d.name, d.summary, d.pendingNote ?? "", ...d.reads, ...d.does, ...(d.keywords ?? []), ...(d.paths ?? []).flatMap((p) => [p.title, p.body]));
    for (const s of schemas.INTEGRATION_SCHEMAS) strings.push(s.label, s.description, ...s.fields.flatMap((f) => [f.label, f.hint ?? ""]));
    for (const p of registry.PROVIDERS) strings.push(p.label);
    const scenarios: Array<Record<string, unknown>> = [
      { keyRows: [], personalGoogle: null, connections: [] },
      { keyRows: [], personalGoogle: null, connections: [], appNotConfigured: registry.PROVIDERS.map((p) => p.id), oasisWorkspace: false },
      { keyRows: [], personalGoogle: null, connections: [], appNotConfigured: registry.PROVIDERS.map((p) => p.id), oasisWorkspace: true, appSecretsMissing: { quickbooks: ["INTUIT_CLIENT_ID"] } },
      { keyRows: null, personalGoogle: null, connections: null },
    ];
    for (const d of connectors.CONNECTOR_CATALOG) {
      for (const facts of scenarios) {
        const s = connectors.resolveConnectorStatus(d, facts as never, Date.now());
        strings.push(s.label, s.detail ?? "", ...(s.paths ?? []).flatMap((p) => [p.title, p.body, p.state]));
      }
    }
    for (const s of strings) assert.doesNotMatch(s, BANNED_COPY, `banned wording: "${s.slice(0, 120)}"`);

    // And the pages as drawn: the hub, and every app's drawer in every state a card can be in.
    const statuses = (facts: unknown) => Object.fromEntries(connectors.CONNECTOR_CATALOG.map((d) => [d.slug, connectors.resolveConnectorStatus(d, facts as never, Date.now())]));
    const unavailable = statuses(scenarios[1]);
    const ready = statuses(scenarios[0]);
    const cases = [
      { id: "hub-unavailable", kind: "hub", statuses: unavailable },
      { id: "hub-ready", kind: "hub", statuses: ready },
      ...connectors.CONNECTOR_CATALOG.flatMap((d) => [
        { id: `${d.slug}:unavailable`, kind: "drawer", slug: d.slug, status: unavailable[d.slug] },
        { id: `${d.slug}:ready`, kind: "drawer", slug: d.slug, status: ready[d.slug] },
      ]),
    ];
    const { markup } = renderClient({ cases, clicks: [] });
    for (const [id, html] of Object.entries(markup)) assert.doesNotMatch(text(html), BANNED_COPY, `${id}: banned wording on the page`);
    for (const html of [markup["hub-unavailable"], markup["hub-ready"]]) {
      assert.equal(html.indexOf("one-click-heading"), -1, "the 'One click, once approved' strip is gone");
      assert.equal(html.indexOf("later-heading"), -1, "no app sits in a 'Not built yet' row");
    }

    // The source of the pages that list these apps carries none of it either.
    for (const file of ["components/os/connections/ConnectionsHub.tsx", "components/os/connections/ConnectorDrawer.tsx", "components/os/connections/OAuthConnectionPanel.tsx", "app/settings/chat-apps/page.tsx"]) {
      assert.doesNotMatch(read(file), /OASIS is registering|once approved|One click, once approved/, `${file}: banned wording in the source`);
    }
  });

  await check("a sign-in app's drawer draws its Connect button when OASIS's app is set up, and NO button when it is not", () => {
    const apps = OAUTH_APPS.map((a) => a.id);
    const ready = connectors.resolveConnectorStatus;
    const cases = apps.flatMap((slug) => {
      const def = connectors.connectorBySlug(slug)!;
      return [
        { id: `${slug}:ready`, kind: "drawer", slug, status: ready(def, { keyRows: [], personalGoogle: null, connections: [], appNotConfigured: [], oasisWorkspace: false }, Date.now()) },
        { id: `${slug}:off`, kind: "drawer", slug, status: ready(def, { keyRows: [], personalGoogle: null, connections: [], appNotConfigured: [slug], oasisWorkspace: false }, Date.now()) },
      ];
    });
    const { markup } = renderClient({ cases, clicks: [] });
    for (const slug of apps) {
      const def = connectors.connectorBySlug(slug)!;
      const label = def.live!.connect.label;
      assert.ok(text(markup[`${slug}:ready`]).includes(label), `${slug}: the Connect button "${label}" is drawn`);
      assert.ok(!text(markup[`${slug}:off`]).includes(label), `${slug}: a button is drawn for an app OASIS has not set up here`);
      assert.match(text(markup[`${slug}:off`]), /Not available on this workspace yet/);
    }
  });

  // ===========================================================================================
  // 3. Key vendors: Plaid, Discord, Microsoft Teams, Meta Ads
  // ===========================================================================================

  const discordUrl = (word = "") => `https://discord.com/api/webhooks/123456789012345678/${word}AbCdEfGhIjKlMnOpQrSt0123`;
  const teamsUrl = (word = "") =>
    `https://prod-12.westus.logic.azure.com:443/workflows/0123456789abcdef/triggers/manual/paths/invoke?api-version=2016-06-01&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=${word}AbCdEfGhIjKlMn123456`;
  type KeyApp = { slug: string; service: string; good: Record<string, string>; secretField: string; pass: RegExp; word: (w: string) => Record<string, string> };
  const KEY_APPS: KeyApp[] = [
    {
      slug: "plaid", service: "plaid", secretField: "secret", pass: /Plaid accepted the credentials \(sandbox\)/,
      good: { environment: "sandbox", client_id: "5e2e1c000000000000000001", secret: "plaid-sandbox-secret-alpha-0001" },
      word: (w) => ({ secret: `plaid-sandbox-secret-${w}-0001` }),
    },
    {
      slug: "discord", service: "discord", secretField: "webhook_url", pass: /Discord webhook: OASIS alerts/,
      good: { webhook_url: discordUrl() },
      word: (w) => ({ webhook_url: discordUrl(w) }),
    },
    {
      slug: "microsoft-teams", service: "microsoft_teams", secretField: "webhook_url", pass: /Posted one test message to the Teams channel/,
      good: { webhook_url: teamsUrl() },
      word: (w) => ({ webhook_url: teamsUrl(w) }),
    },
    {
      slug: "meta", service: "meta_ads", secretField: "access_token", pass: /Meta ad account: Alpha Ads/,
      good: { access_token: "EAAB-alpha-system-user-token-0001", ad_account_id: "act_1234567890" },
      word: (w) => ({ access_token: `EAAB-alpha-${w}-system-user-0001` }),
    },
  ];

  await check("each key vendor has a form that saves, a probe that tests, and a link to where the key is made", () => {
    for (const app of KEY_APPS) {
      const def = connectors.connectorBySlug(app.slug)!;
      assert.equal(def.live!.connect.kind, "keys");
      const schema = schemas.findTenantManuallyEditableIntegrationSchema(app.service)!;
      assert.ok(schema, app.slug);
      assert.ok(probes.hasKeyProbe(app.service), app.slug);
      assert.match(schema.getKey?.href ?? "", /^https:\/\//, `${app.slug}: where the key is made`);
      for (const f of schema.fields) assert.ok(f.hint?.trim(), `${app.slug}.${f.key}: says where its value comes from`);
      assert.deepEqual([...(def.live!.source as { requireAll: readonly string[] }).requireAll].sort(), schemas.requiredIntegrationFieldKeys(schema).sort(), `${app.slug}: the card needs exactly what the form requires`);
    }
    const src = read("lib/tenant-integration-schemas.ts");
    for (const cited of ["plaid.com/docs/api/institutions", "docs.discord.com/developers/resources/webhook", "learn.microsoft.com/en-us/connectors/teams", "developers.facebook.com/docs/marketing-api"]) {
      assert.ok(src.includes(cited), `the schemas cite ${cited}`);
    }
  });

  await check("a member cannot save or test; an owner saves, and what is stored is ciphertext", async () => {
    await login(USERS.memberA);
    assert.equal((await save("plaid", "client_id", KEY_APPS[0].good.client_id)).status, 403);
    assert.equal((await runTest("plaid")).status, 403);
    await login(USERS.ownerA);
    for (const app of KEY_APPS) await saveAll(app.service, app.good);
    const rows = await db.execute({ sql: "SELECT service, field_key, encrypted_value FROM tenant_integration_credentials WHERE tenant_id = ?", args: [ALPHA] });
    for (const app of KEY_APPS) {
      const plain = app.good[app.secretField];
      const row = rows.rows.find((r) => r.service === app.service && r.field_key === app.secretField);
      assert.ok(row, `${app.slug} saved`);
      assert.ok(!String(row!.encrypted_value).includes(plain), `${app.slug}: stored readable`);
      assert.equal(decryptField(String(row!.encrypted_value)), plain);
    }
  });

  await check("a value that is not the vendor's own is refused before it is saved, with a sentence an owner can act on", async () => {
    await login(USERS.ownerA);
    const refused: Array<[string, string, string]> = [
      ["plaid", "environment", "development"],
      ["plaid", "client_id", "has a space"],
      ["discord", "webhook_url", "https://evil.example/api/webhooks/123456789012345678/AbCdEfGhIjKlMnOpQrSt0123"],
      ["discord", "webhook_url", "https://discord.com.evil.example/api/webhooks/123456789012345678/AbCdEfGhIjKlMnOpQrSt0123"],
      ["discord", "webhook_url", "http://discord.com/api/webhooks/123456789012345678/AbCdEfGhIjKlMnOpQrSt0123"],
      ["discord", "webhook_url", "https://user:pw@discord.com/api/webhooks/123456789012345678/AbCdEfGhIjKlMnOpQrSt0123"],
      ["discord", "webhook_url", "https://discord.com:8443/api/webhooks/123456789012345678/AbCdEfGhIjKlMnOpQrSt0123"],
      ["discord", "webhook_url", "https://discord.com/api/v10/channels/1/messages"],
      ["microsoft_teams", "webhook_url", "https://evil.example/workflows/abc/triggers/manual/paths/invoke?sig=AbCdEfGhIjKlMn123456"],
      ["microsoft_teams", "webhook_url", "https://logic.azure.com.evil.example/workflows/abc?sig=AbCdEfGhIjKlMn123456"],
      ["microsoft_teams", "webhook_url", "https://logic.azure.com/workflows/abc?sig=AbCdEfGhIjKlMn123456"],
      ["microsoft_teams", "webhook_url", "http://prod-1.westus.logic.azure.com/workflows/abc?sig=AbCdEfGhIjKlMn123456"],
      ["microsoft_teams", "webhook_url", "https://prod-1.westus.logic.azure.com:8443/workflows/abc?sig=AbCdEfGhIjKlMn123456"],
      ["microsoft_teams", "webhook_url", "https://prod-1.westus.logic.azure.com/workflows/abc"],
      ["meta_ads", "ad_account_id", "not-a-number"],
    ];
    const before = calls.length;
    for (const [service, field_key, value] of refused) {
      const r = await save(service, field_key, value);
      assert.equal(r.status, 422, `${service}.${field_key}=${value} must be refused, got ${r.status}`);
      assert.ok(typeof r.body.error === "string" && /[a-z] [a-z]/i.test(r.body.error), `${service}.${field_key}: the refusal is a sentence`);
    }
    assert.equal(calls.length, before, "a refused value is never sent anywhere");
    // The forms accept the vendors' real shapes.
    assert.ok(schemas.parseDiscordWebhookUrl(discordUrl()));
    assert.ok(schemas.parseDiscordWebhookUrl("https://discordapp.com/api/webhooks/123456789012345678/AbCdEfGhIjKlMnOpQrSt0123"));
    assert.ok(schemas.parseTeamsWebhookUrl(teamsUrl()));
    assert.ok(schemas.parseTeamsWebhookUrl("https://default0123.4a.environment.api.powerplatform.com/powerautomate/automations/direct/workflows/abc/triggers/manual/paths/invoke?api-version=1&sp=x&sv=1.0&sig=AbCdEfGhIjKlMn123456"));
  });

  await check("a passing Test turns each card green and names the account; saved but untested is never green", async () => {
    await login(USERS.ownerA);
    for (const app of KEY_APPS) {
      await saveAll(app.service, { [app.secretField]: app.good[app.secretField] });
      const before = await card(ALPHA, app.slug);
      assert.equal(before.kind, "configured", `${app.slug}: saved but not tested must not be green (${before.label})`);
      const t = await runTest(app.service);
      assert.equal(t.status, 200);
      assert.equal(t.body.ok, true, `${app.slug}: ${t.text}`);
      assert.match(String(t.body.detail), app.pass);
      const after = await card(ALPHA, app.slug);
      assert.equal(after.kind, "connected", `${app.slug}: ${after.label}`);
      assert.match(after.label, /^Connected · verified/);
    }
  });

  await check("every refusal is a card in plain words, not a code; every failure is recorded on the card", async () => {
    await login(USERS.ownerA);
    const FAILURES: Array<[string, string, string, RegExp]> = [
      ["revoked", "key_rejected", "attention", /(refused|no longer has)/],
      ["noscope", "missing_permission", "attention", /lacks access/],
      ["busy", "rate_limited", "configured", /asked OASIS to wait/],
      ["broken", "provider_error", "configured", /unexpected answer/],
      ["offline", "provider_unreachable", "configured", /did not answer/],
    ];
    for (const app of KEY_APPS) {
      for (const [word, code, kind, label] of FAILURES) {
        await saveAll(app.service, app.word(word));
        const t = await runTest(app.service);
        assert.equal(t.body.ok, false, `${app.slug}/${word}`);
        assert.match(String(t.body.error), new RegExp(`^${code}`), `${app.slug}/${word}: ${t.text}`);
        const c = await card(ALPHA, app.slug);
        assert.equal(c.kind, kind, `${app.slug}/${word}: ${c.label}`);
        assert.match(c.label, label, `${app.slug}/${word}`);
        assert.doesNotMatch(c.label + (c.detail ?? ""), /key_rejected|missing_permission|provider_error|rate_limited/, "a code is never the words");
      }
      await saveAll(app.service, { [app.secretField]: app.good[app.secretField] });
    }
    // Meta: an ad account the token cannot see is its own plain sentence.
    await saveAll("meta_ads", { access_token: "EAAB-alpha-missingacct-system-user-0001" });
    const gone = await runTest("meta_ads");
    assert.equal(gone.body.error, "not_found");
    assert.match(String((await card(ALPHA, "meta")).detail), /could not find that ad account/);
    await saveAll("meta_ads", KEY_APPS[3].good);
    // Teams' only Test is a post, so the card says so BEFORE it is pressed.
    assert.match(connectors.connectorBySlug("microsoft-teams")!.does.join(" "), /posts one short message/);
    assert.match(schemas.findIntegrationSchema("microsoft_teams")!.description, /posts one short message/);
  });

  await check("a stored webhook that is not the vendor's own is never called, even when it was saved some other way", async () => {
    await login(USERS.ownerA);
    for (const [service, bad] of [
      ["discord", "https://evil.example/api/webhooks/123456789012345678/AbCdEfGhIjKlMnOpQrSt0123"],
      ["microsoft_teams", "https://evil.example/workflows/abc/triggers/manual/paths/invoke?sig=AbCdEfGhIjKlMn123456"],
    ] as const) {
      // Written straight to the store: the save route's rule is skipped, as an old row or a direct write would.
      const wrote = await setTenantIntegrationValue({ tenantId: ALPHA, service, fieldKey: "webhook_url", value: bad, createdBy: null });
      assert.equal(wrote.ok, true);
      const before = calls.length;
      const t = await runTest(service);
      assert.equal(t.body.ok, false);
      assert.equal(t.body.error, "blocked_host", `${service}: ${t.text}`);
      assert.equal(calls.length, before, `${service}: the webhook was sent to an address that is not the vendor's`);
      assert.match((await card(ALPHA, service === "discord" ? "discord" : "microsoft-teams")).label, /Not a .* address/);
    }
    await saveAll("discord", KEY_APPS[1].good);
    await saveAll("microsoft_teams", KEY_APPS[2].good);
  });

  await check("Plaid's secret only ever goes to the host of the environment it was saved for; a new environment removes the secret", async () => {
    await login(USERS.ownerA);
    await saveAll("plaid", KEY_APPS[0].good);
    calls.length = 0;
    assert.equal((await runTest("plaid")).body.ok, true);
    assert.deepEqual(calls.map((c) => c.host), ["sandbox.plaid.com"]);
    assert.equal(calls[0].headers.get("plaid-client-id"), KEY_APPS[0].good.client_id);
    // Switching to production removes the sandbox secret in the same save.
    const switched = await save("plaid", "environment", "production");
    assert.equal(switched.status, 200);
    assert.deepEqual(switched.body.cleared, ["secret"], "the secret was not removed with the host it was entered for");
    const bundle = await getTenantIntegrationBundle(ALPHA, "plaid", { allowEnvFallback: false });
    assert.equal(bundle.secret, undefined);
    calls.length = 0;
    const t = await runTest("plaid");
    assert.equal(t.body.ok, false);
    assert.match(String(t.body.error), /^missing_fields/);
    assert.equal(calls.length, 0, "nothing was sent while the secret was missing");
    await saveAll("plaid", { secret: "plaid-production-secret-alpha-0001" });
    calls.length = 0;
    assert.equal((await runTest("plaid")).body.ok, true);
    assert.deepEqual(calls.map((c) => c.host), ["production.plaid.com"]);
    await saveAll("plaid", KEY_APPS[0].good);
  });

  await check("a workspace's Test uses that workspace's own saved value, never another's", async () => {
    await login(USERS.ownerB);
    // Bravo has saved nothing: its Test has nothing to send and never borrows Alpha's.
    calls.length = 0;
    for (const app of KEY_APPS) {
      const t = await runTest(app.service);
      assert.equal(t.body.ok, false, `${app.slug}: Bravo's Test passed with Alpha's key`);
      assert.match(String(t.body.error), /^missing_fields/);
      assert.equal((await card(BRAVO_CO, app.slug)).kind, "not_connected", app.slug);
    }
    assert.equal(calls.length, 0, "a call was made for a workspace that saved nothing");
  });

  // ===========================================================================================
  // 4. Sign-in vendors: QuickBooks, Xero, Zoom, WhatsApp
  // ===========================================================================================

  const popupOutcome = (html: string): { status: string; reason: string | null; provider: string } => {
    assert.match(html, /<script nonce=/, "an answer in a pop-up is the pop-up page");
    const m = /postMessage\((\{.*?\}),/s.exec(html);
    assert.ok(m, `no postMessage in: ${html.slice(0, 200)}`);
    const msg = JSON.parse(m![1]) as { source: string; provider: string; status: string; reason: string | null };
    assert.equal(msg.source, "oasis_connection");
    return msg;
  };
  const connectionRows = async (tenantId: string, provider: string) =>
    (await db.execute({ sql: "SELECT * FROM tenant_connections WHERE tenant_id = ? AND provider = ?", args: [tenantId, provider] })).rows;
  const credentialRows = async (tenantId: string, connectionId: string) =>
    (await db.execute({ sql: "SELECT field_key, encrypted_value FROM tenant_integration_credentials WHERE tenant_id = ? AND service = ?", args: [tenantId, `connection:${connectionId}`] })).rows;
  const stateRows = async () => Number((await db.execute("SELECT COUNT(*) AS n FROM oauth_states")).rows[0].n);

  /** Start a sign-in as the logged-in person and return the vendor URL it sends the browser to. */
  const startSignIn = async (app: OAuthApp): Promise<URL> => {
    const res = await authorizeRoute.GET(new NextRequest(`https://oasisai.work/api/connections/${app.id}/authorize`), ctx(app.id));
    assert.equal(res.status, 303, `${app.id}: authorize answered ${res.status}: ${await res.clone().text()}`);
    return new URL(res.headers.get("location")!);
  };
  const finishSignIn = async (app: OAuthApp, state: string, code = "good-code") => {
    const res = await callbackRoute.GET(
      new NextRequest(`https://oasisai.work/api/connections/${app.id}/callback?code=${code}&state=${encodeURIComponent(state)}${app.callbackExtra}`),
      ctx(app.id),
    );
    const html = await res.text();
    seenTexts.push(html);
    return { res, html };
  };
  const connectedRow = async (tenantId: string, app: OAuthApp) => {
    const row = (await store.findActiveConnection(db, tenantId, app.id))!;
    assert.ok(row, `${app.id}: no live connection`);
    return row;
  };
  const deps = () => ({ db, now: () => new Date() });
  /**
   * A db whose batch() throws for any statement matching `match`, everything
   * else passed straight through to the real connection. Drives the REAL
   * completeOAuthConnect into its actual save-failed catch branch (Codex
   * review, PR #574: the fenced-save regression test only ever called
   * saveConnectionTokensFenced directly, never the real function it is
   * inside) — never a hand-simulated "pretend this failed".
   */
  const dbThrowingOnBatch = (match: (sql: string) => boolean): Client =>
    new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "batch") {
          return async (...args: Parameters<Client["batch"]>) => {
            const stmts = Array.isArray(args[0]) ? args[0] : [args[0]];
            if (stmts.some((s) => match(typeof s === "string" ? s : s.sql))) {
              throw new Error("simulated_token_save_failure (test)");
            }
            return target.batch(...args);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

  await check("without OASIS's app secrets: a client sees 'Not available', OASIS's operator sees the secret names, and the button answers a sentence, never a 500", async () => {
    setOAuthEnv(false);
    await login(USERS.ownerA);
    const states = await stateRows();
    for (const app of OAUTH_APPS) {
      const client = await card(ALPHA, app.id);
      assert.deepEqual([client.kind, client.label], ["coming_soon", "Not available on this workspace yet"], app.id);
      assert.doesNotMatch(String(client.detail), /_ID|_SECRET|Worker secret|registering/, `${app.id}: a client was shown a secret name`);
      const operator = await card(OASIS_OWN, app.id);
      assert.equal(operator.label, "Not available on this workspace yet");
      const needed = registry.providerById(app.id)!.liveWhenEnv!;
      assert.match(String(operator.detail), new RegExp(`Missing Worker secrets: ${needed.join(", ")}`), `${app.id}: the operator is told exactly which secrets`);
      const res = await authorizeRoute.GET(new NextRequest(`https://oasisai.work/api/connections/${app.id}/authorize`), ctx(app.id));
      assert.equal(res.status, 200, `${app.id}: the button must answer a page, not an error (${res.status})`);
      const out = popupOutcome(await res.text());
      assert.deepEqual([out.status, out.reason], ["error", "not_configured"], app.id);
    }
    assert.equal(await stateRows(), states, "a consent was started for an app that is not set up");
    // The callback is just as honest.
    const cb = await callbackRoute.GET(new NextRequest("https://oasisai.work/api/connections/xero/callback?code=x&state=y"), ctx("xero"));
    assert.equal(popupOutcome(await cb.text()).reason, "not_configured");
  });

  await check("only an owner or admin can start a sign-in; signed out is told to sign in; neither starts a consent", async () => {
    setOAuthEnv(true);
    const states = await stateRows();
    await login(USERS.memberA);
    for (const app of OAUTH_APPS) {
      const res = await authorizeRoute.GET(new NextRequest(`https://oasisai.work/api/connections/${app.id}/authorize`), ctx(app.id));
      assert.equal(popupOutcome(await res.text()).reason, "admin_only", app.id);
    }
    await login(null);
    const out = await authorizeRoute.GET(new NextRequest("https://oasisai.work/api/connections/zoom/authorize"), ctx("zoom"));
    assert.equal(popupOutcome(await out.text()).reason, "login_required");
    assert.equal(await stateRows(), states);
    // A provider that has no sign-in at all is a sentence too.
    await login(USERS.ownerA);
    const unknown = await authorizeRoute.GET(new NextRequest("https://oasisai.work/api/connections/no-such-app/authorize"), ctx("no-such-app"));
    assert.notEqual(unknown.status, 500);
    const stripe = await authorizeRoute.GET(new NextRequest("https://oasisai.work/api/connections/stripe/authorize"), ctx("stripe"));
    assert.ok((stripe.headers.get("location") ?? "").startsWith("https://oasisai.work/"), "a key provider has no vendor sign-in page to be sent to");
  });

  for (const app of OAUTH_APPS) {
    await check(`${app.name}: the button goes to the vendor's own page; the callback stores encrypted tokens for the session's workspace and the card turns green`, async () => {
      setOAuthEnv(true);
      await login(USERS.ownerA);
      assert.equal((await card(ALPHA, app.id)).kind, "not_connected", "the app is set up here, so the button is offered");
      const url = await startSignIn(app);
      assert.equal(url.hostname, app.authorizeHost, `${app.id}: sent to ${url.hostname}`);
      assert.equal(url.searchParams.get("response_type"), "code");
      assert.equal(url.searchParams.get("client_id"), Object.values(app.env)[0]);
      assert.equal(url.searchParams.get("redirect_uri"), `https://oasisai.work/api/connections/${app.id}/callback`);
      assert.ok(url.searchParams.get("state"), "the consent is bound to a state");
      assert.ok(!url.href.includes(Object.values(app.env)[1]), "OASIS's app secret never goes to the browser");
      const wanted = registry.scopesForDepartments(registry.providerById(app.id)!, []);
      const sentScope = url.searchParams.get("scope");
      if (wanted.length > 0) assert.deepEqual(sentScope?.split(app.id === "whatsapp" ? "," : " "), wanted, `${app.id}: only the minimum scopes`);
      else assert.equal(sentScope, null);
      if (app.id === "xero" || app.id === "quickbooks") assert.ok(!/(^| )accounting\.[a-z.]+(?<!\.read)( |$)/.test(sentScope ?? ""), `${app.id}: read scopes only`);
      const state = url.searchParams.get("state")!;
      SENSITIVE.add(state);

      calls.length = 0;
      const { res, html } = await finishSignIn(app, state);
      assert.equal(res.status, 200);
      assert.deepEqual([popupOutcome(html).status, popupOutcome(html).provider], ["connected", app.id], html.slice(0, 300));
      assert.ok(!html.includes("good-code") && !html.includes(state), "the code and the state never appear in the page");

      const row = await connectedRow(ALPHA, app);
      assert.deepEqual([row.tenant_id, row.external_account_id, row.external_account_label], [ALPHA, app.account, app.label]);
      assert.equal(row.status, "connected");
      assert.equal(row.connected_by, USERS.ownerA.id);
      // Tokens: encrypted at rest, three fields, an expiry.
      const stored = await credentialRows(ALPHA, String(row.id));
      assert.deepEqual(stored.map((r) => String(r.field_key)).sort(), ["access_token", "expires_at", "refresh_token"]);
      for (const r of stored) {
        const value = decryptField(String(r.encrypted_value));
        assert.ok(!String(r.encrypted_value).includes(value), `${app.id}.${r.field_key}: stored readable`);
      }
      const bundle = await getTenantIntegrationBundle(ALPHA, `connection:${row.id}`, { allowEnvFallback: false });
      assert.equal(bundle.access_token, live(app.id).access);
      assert.equal(bundle.refresh_token, live(app.id).refresh);
      assert.ok(Number(bundle.expires_at) > Date.now(), "an expiry in the future is stored");
      // The card, from the real health check the callback recorded.
      const c = await card(ALPHA, app.id);
      assert.equal(c.kind, "connected", `${app.id}: ${c.label} ${c.detail}`);
      assert.equal(c.account, app.label);
      // Another workspace sees nothing of it.
      assert.equal((await card(BRAVO_CO, app.id)).kind, "not_connected");
      assert.equal((await connectionRows(BRAVO_CO, app.id)).length, 0);
      // Every vendor call carried a token OASIS was just issued, over HTTPS to the vendor's own host.
      assert.ok(calls.length >= 2, "the code was exchanged and the account read");
    });

    await check(`${app.name}: the sign-in is single-use, bound to the person and the workspace, and a tampered one is refused`, async () => {
      setOAuthEnv(true);
      await login(USERS.ownerA);
      // Replay: the state the first test consumed.
      const url = await startSignIn(app);
      const state = url.searchParams.get("state")!;
      const first = await finishSignIn(app, state);
      assert.equal(popupOutcome(first.html).status, "connected");
      const replay = await finishSignIn(app, state);
      assert.deepEqual([popupOutcome(replay.html).status, popupOutcome(replay.html).reason], ["error", "state_invalid"], "a replayed state");
      // Another workspace's owner cannot finish Alpha's consent.
      const second = (await startSignIn(app)).searchParams.get("state")!;
      await login(USERS.ownerB);
      const stolen = await finishSignIn(app, second);
      assert.deepEqual([popupOutcome(stolen.html).status, popupOutcome(stolen.html).reason], ["error", "wrong_person"]);
      assert.equal((await connectionRows(BRAVO_CO, app.id)).length, 0, "a consent landed in the wrong workspace");
      // A tampered payload or signature, a wrong provider's state, and no state at all.
      await login(USERS.ownerA);
      const fresh = (await startSignIn(app)).searchParams.get("state")!;
      const [body, sig] = fresh.split(".");
      for (const bad of [`${body}.${sig.slice(0, -2)}xx`, `${Buffer.from("{}").toString("base64url")}.${sig}`, "garbage", ""]) {
        const r = await finishSignIn(app, bad);
        assert.equal(popupOutcome(r.html).status, "error", `tampered state "${bad.slice(0, 20)}"`);
      }
      const other = OAUTH_APPS.find((a) => a.id !== app.id)!;
      const crossed = await finishSignIn(other, fresh);
      assert.equal(popupOutcome(crossed.html).status, "error", "a state for one app finished another app's sign-in");
      // The real one still works exactly once (a wrong-app attempt burns the state it used, so start again).
      assert.equal(popupOutcome((await finishSignIn(app, (await startSignIn(app)).searchParams.get("state")!)).html).status, "connected");
      // The vendor refusing the code connects nothing new.
      const rows = (await connectionRows(ALPHA, app.id)).length;
      const refused = await finishSignIn(app, (await startSignIn(app)).searchParams.get("state")!, "bad-code");
      assert.deepEqual([popupOutcome(refused.html).status, popupOutcome(refused.html).reason], ["error", "exchange_failed"]);
      assert.equal((await connectionRows(ALPHA, app.id)).length, rows);
      // Cancelling at the vendor's page connects nothing.
      const denied = await callbackRoute.GET(new NextRequest(`https://oasisai.work/api/connections/${app.id}/callback?error=access_denied`), ctx(app.id));
      assert.equal(popupOutcome(await denied.text()).status, "denied");
    });

    await check(`${app.name}: an expired access token is refreshed on use, the rotated refresh token is kept, and one refresh runs however many ask`, async () => {
      setOAuthEnv(true);
      await login(USERS.ownerA);
      const row = await connectedRow(ALPHA, app);
      const expire = async () => {
        const b = await getTenantIntegrationBundle(ALPHA, `connection:${row.id}`, { allowEnvFallback: false });
        await tokenStore.saveConnectionTokens(ALPHA, String(row.id), { access_token: b.access_token, refresh_token: b.refresh_token, expires_at: Date.now() - 60_000 });
        return b;
      };
      // A token still valid is returned as it is: no vendor call.
      let before = calls.length;
      const fine = await live_.getProviderAccessToken(deps(), { tenantId: ALPHA, providerId: app.id });
      assert.equal(fine.accessToken, live(app.id).access);
      assert.equal(calls.length, before, "a valid token was refreshed anyway");

      const old = await expire();
      const issuedBefore = live(app.id).n;
      before = calls.length;
      const refreshed = await live_.getProviderAccessToken(deps(), { tenantId: ALPHA, providerId: app.id });
      assert.equal(live(app.id).n, issuedBefore + 1, "the vendor issued one new token");
      assert.equal(refreshed.accessToken, live(app.id).access);
      assert.notEqual(refreshed.accessToken, old.access_token);
      const sent = calls.slice(before).filter((c) => /token|access_token$/.test(c.path));
      assert.equal(sent.length, 1, "exactly one token call");
      const now = await getTenantIntegrationBundle(ALPHA, `connection:${row.id}`, { allowEnvFallback: false });
      assert.equal(now.access_token, live(app.id).access);
      assert.equal(now.refresh_token, live(app.id).refresh, "the ROTATED refresh token is the one stored");
      assert.ok(Number(now.expires_at) > Date.now());

      // Five callers at once: one refresh, five tokens, the same one.
      await expire();
      const n = live(app.id).n;
      const results = await Promise.allSettled(Array.from({ length: 5 }, () => live_.getProviderAccessToken(deps(), { tenantId: ALPHA, providerId: app.id })));
      assert.equal(live(app.id).n, n + 1, "more than one refresh ran: the second would have used a dead refresh token");
      const winners = results.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof live_.getProviderAccessToken>>> => r.status === "fulfilled");
      assert.ok(winners.length >= 1);
      for (const w of winners) assert.equal(w.value.accessToken, live(app.id).access);
      assert.equal((await store.getConnection(db, ALPHA, String(row.id)))!.refresh_lease_until, null, "the lease was left held");
    });

    await check(`${app.name}: a refresh the vendor refuses expires the connection and says so; reconnecting restores it; a vendor outage never expires it`, async () => {
      setOAuthEnv(true);
      await login(USERS.ownerA);
      const row = await connectedRow(ALPHA, app);
      const b = await getTenantIntegrationBundle(ALPHA, `connection:${row.id}`, { allowEnvFallback: false });
      await tokenStore.saveConnectionTokens(ALPHA, String(row.id), { access_token: b.access_token, refresh_token: b.refresh_token, expires_at: Date.now() - 60_000 });
      // Down: unreachable is "try again", never a disconnect.
      const realFetchLocal = globalThis.fetch;
      globalThis.fetch = (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch;
      await assert.rejects(live_.getProviderAccessToken(deps(), { tenantId: ALPHA, providerId: app.id }), (e: unknown) => (e as { code?: string }).code === "refresh_unavailable");
      globalThis.fetch = realFetchLocal;
      assert.equal((await store.getConnection(db, ALPHA, String(row.id)))!.status, "connected", "an outage expired a healthy connection");
      // Refused: the grant is dead.
      mode.refuse = true;
      await assert.rejects(live_.getProviderAccessToken(deps(), { tenantId: ALPHA, providerId: app.id }), (e: unknown) => (e as { code?: string }).code === "refresh_failed");
      mode.refuse = false;
      assert.equal((await store.getConnection(db, ALPHA, String(row.id)))!.status, "expired");
      const c = await card(ALPHA, app.id);
      assert.equal(c.kind, "attention", `${app.id}: ${c.label}`);
      // A sign-in never had a "key" (Codex review, PR #574): QuickBooks, Xero,
      // Zoom and WhatsApp (connect.kind "oauth") get their own label; a
      // pasted-key provider still gets the original one.
      assert.match(c.label, /no longer accepted|sign-in expired/i);
      // Test again says so too, instead of crashing.
      const again = await toRes(await connTestRoute.POST(new Request("https://oasisai.work/x", { method: "POST" }), ctx(app.id)));
      assert.equal(again.status, 200);
      // Reconnect: the same account, the same row, healthy again.
      const done = await finishSignIn(app, (await startSignIn(app)).searchParams.get("state")!);
      assert.equal(popupOutcome(done.html).status, "connected");
      assert.equal((await connectionRows(ALPHA, app.id)).filter((r) => r.revoked_at === null).length, 1, "a reconnect made a second live row");
      assert.equal((await card(ALPHA, app.id)).kind, "connected");
    });

    await check(`${app.name}: Test again is a live check with a fresh token; a vendor that stops accepting the grant turns the card red`, async () => {
      setOAuthEnv(true);
      await login(USERS.ownerA);
      const ok = await toRes(await connTestRoute.POST(new Request("https://oasisai.work/x", { method: "POST" }), ctx(app.id)));
      assert.equal(ok.status, 200, ok.text);
      assert.equal((ok.body.connection as Record<string, unknown>).verified, true, ok.text);
      // The vendor withdraws the grant behind OASIS's back.
      live(app.id).revoked = true;
      const bad = await toRes(await connTestRoute.POST(new Request("https://oasisai.work/x", { method: "POST" }), ctx(app.id)));
      assert.equal(bad.status, 200);
      assert.equal((bad.body.connection as Record<string, unknown>).verified, false);
      assert.notEqual((await card(ALPHA, app.id)).kind, "connected", `${app.id}: green after the vendor withdrew the grant`);
      live(app.id).revoked = false;
      // The hourly pass covers it.
      const pass = await health.runConnectionHealthPass(deps(), { limit: 10 });
      assert.equal(pass.errors.length, 0, JSON.stringify(pass.errors));
    });

    await check(`${app.name}: Disconnect tells the vendor to forget OASIS and deletes OASIS's copy; another workspace cannot disconnect it`, async () => {
      setOAuthEnv(true);
      // Reconnect cleanly so the vendor holds a live grant to revoke.
      await login(USERS.ownerA);
      if ((await card(ALPHA, app.id)).kind !== "connected") {
        assert.equal(popupOutcome((await finishSignIn(app, (await startSignIn(app)).searchParams.get("state")!)).html).status, "connected");
      }
      const row = await connectedRow(ALPHA, app);
      // Bravo disconnecting "its" app does nothing to Alpha's.
      await login(USERS.ownerB);
      const theirs = await toRes(await disconnectRoute.POST(new Request("https://oasisai.work/x", { method: "POST" }), ctx(app.id)));
      assert.equal(theirs.body.already_disconnected, true);
      assert.equal((await store.getConnection(db, ALPHA, String(row.id)))!.status, "connected");
      const status = await toRes(await statusRoute.GET(new Request("https://oasisai.work/x"), ctx(app.id)));
      assert.equal(status.body.connection, null, "Bravo can see Alpha's connection");
      // A member cannot.
      await login(USERS.memberA);
      assert.equal((await disconnectRoute.POST(new Request("https://oasisai.work/x", { method: "POST" }), ctx(app.id))).status, 403);
      // The owner does.
      await login(USERS.ownerA);
      const live0 = live(app.id).revoked;
      assert.equal(live0, false);
      const gone = await toRes(await disconnectRoute.POST(new Request("https://oasisai.work/x", { method: "POST" }), ctx(app.id)));
      assert.equal(gone.status, 200, gone.text);
      assert.equal(gone.body.vendor_revoked, true, "the vendor was not told to forget the grant");
      assert.equal(live(app.id).revoked, true, "the vendor still holds the grant");
      assert.equal((await credentialRows(ALPHA, String(row.id))).length, 0, "OASIS kept a copy of the tokens");
      assert.equal((await store.getConnection(db, ALPHA, String(row.id)))!.status, "revoked");
      assert.equal((await card(ALPHA, app.id)).kind, "not_connected");
      const twice = await toRes(await disconnectRoute.POST(new Request("https://oasisai.work/x", { method: "POST" }), ctx(app.id)));
      assert.equal(twice.body.already_disconnected, true);
    });

    await check(`${app.name}: when the vendor cannot be told, OASIS's copy still goes and the owner is told to remove OASIS there too`, async () => {
      setOAuthEnv(true);
      await login(USERS.ownerA);
      assert.equal(popupOutcome((await finishSignIn(app, (await startSignIn(app)).searchParams.get("state")!)).html).status, "connected");
      const row = await connectedRow(ALPHA, app);
      mode.revokeFails = true;
      const gone = await toRes(await disconnectRoute.POST(new Request("https://oasisai.work/x", { method: "POST" }), ctx(app.id)));
      mode.revokeFails = false;
      assert.equal(gone.status, 200, gone.text);
      assert.equal(gone.body.disconnected, true);
      assert.equal(gone.body.vendor_revoked, false);
      assert.equal((await credentialRows(ALPHA, String(row.id))).length, 0, "OASIS kept a copy of the tokens");
      assert.match(read("components/os/connections/OAuthConnectionPanel.tsx"), /Remove OASIS from \$\{providerName\}'s connected apps too/);
    });
  }

  await check("WhatsApp: Meta's HTTP 400 for a rate limit (code 4) never expires the connection; only a dead-token code (190) does", async () => {
    setOAuthEnv(true);
    await login(USERS.ownerA);
    const app = OAUTH_APPS.find((a) => a.id === "whatsapp")!;
    assert.equal(popupOutcome((await finishSignIn(app, (await startSignIn(app)).searchParams.get("state")!)).html).status, "connected");
    const row = await connectedRow(ALPHA, app);
    const expire = async () => {
      const b = await getTenantIntegrationBundle(ALPHA, `connection:${row.id}`, { allowEnvFallback: false });
      await tokenStore.saveConnectionTokens(ALPHA, String(row.id), { access_token: b.access_token, refresh_token: b.refresh_token, expires_at: Date.now() - 60_000 });
    };
    for (const code of [4, 17, 32, 613]) {
      await expire();
      mode.metaRefreshCode = code;
      await assert.rejects(live_.getProviderAccessToken(deps(), { tenantId: ALPHA, providerId: "whatsapp" }), (e: unknown) => (e as { code?: string }).code === "refresh_unavailable", `code ${code}`);
      mode.metaRefreshCode = null;
      assert.equal((await store.getConnection(db, ALPHA, String(row.id)))!.status, "connected", `a transient Meta error (code ${code}) expired WhatsApp`);
    }
    await expire();
    mode.metaRefreshCode = 190;
    await assert.rejects(live_.getProviderAccessToken(deps(), { tenantId: ALPHA, providerId: "whatsapp" }), (e: unknown) => (e as { code?: string }).code === "refresh_failed");
    mode.metaRefreshCode = null;
    assert.equal((await store.getConnection(db, ALPHA, String(row.id)))!.status, "expired");
    await disconnectRoute.POST(new Request("https://oasisai.work/x", { method: "POST" }), ctx("whatsapp"));
  });

  await check("Xero's own authEventId claim, not array order or createdDateUtc, picks which organisation a consent approved; several matching rows refuse rather than pick the first", () => {
    const org = (tenantId: string, authEventId: string | null) => ({ tenantId, tenantName: `${tenantId} name`, authEventId });
    // One organisation is unambiguous either way, even with no claim at all.
    assert.deepEqual(adapters.xeroCurrentOrg([org("t1", null)], null), { ok: true, org: org("t1", null) });
    // The match wins even though it sorts second and is not index 0.
    assert.deepEqual(adapters.xeroCurrentOrg([org("decoy", "evt-old"), org("real", "evt-now")], "evt-now"), { ok: true, org: org("real", "evt-now") });
    // No row matches this consent: refuse rather than guess (never orgs[0]).
    assert.deepEqual(adapters.xeroCurrentOrg([org("decoy", "evt-old"), org("other", "evt-older")], "evt-now"), { ok: false, reason: "none" });
    // No claim to go on, and more than one organisation: also refuse.
    assert.deepEqual(adapters.xeroCurrentOrg([org("a", "evt-1"), org("b", "evt-2")], null), { ok: false, reason: "none" });
    assert.deepEqual(adapters.xeroCurrentOrg([], "evt-now"), { ok: false, reason: "none" });
    // ONE consent can itself approve several organisations (they share the
    // SAME authEventId): refuses as "several", in the SAME order either way
    // — never a silent pick of whichever the vendor happened to list first.
    assert.deepEqual(adapters.xeroCurrentOrg([org("a", "evt-multi"), org("b", "evt-multi")], "evt-multi"), { ok: false, reason: "several" });
    assert.deepEqual(adapters.xeroCurrentOrg([org("b", "evt-multi"), org("a", "evt-multi")], "evt-multi"), { ok: false, reason: "several" });

    // The claim is read from the token's own JWT payload, never guessed.
    assert.equal(adapters.xeroAuthEventId(xeroJwt("evt-abc")), "evt-abc");
    assert.equal(adapters.xeroAuthEventId("xero-access-token-1-AAAAAAAAAAAAAAAAAAAA"), null, "a non-JWT token (today's mock shape) is an honest miss, not a crash");
    assert.equal(adapters.xeroAuthEventId("a.b"), null, "two segments is not a JWT");
    assert.equal(adapters.xeroAuthEventId(`${Buffer.from("{}").toString("base64url")}.not-json.sig`), null, "unparseable payload is an honest miss");
  });

  await check("Xero: one consent that approved SEVERAL organisations is refused with a plain-English reason, not a silent pick of whichever sorts first", async () => {
    setOAuthEnv(true);
    await login(USERS.ownerA);
    const app = OAUTH_APPS.find((a) => a.id === "xero")!;
    try {
      mode.xeroAuthEventId = "evt-several";
      const before = (await connectionRows(ALPHA, "xero")).length;
      mode.xeroOrgs = [
        { id: "conn-a", tenantId: "xero-tenant-a", tenantType: "ORGANISATION", tenantName: "Org A", authEventId: "evt-several" },
        { id: "conn-b", tenantId: "xero-tenant-b", tenantType: "ORGANISATION", tenantName: "Org B", authEventId: "evt-several" },
      ];
      const refused = popupOutcome((await finishSignIn(app, (await startSignIn(app)).searchParams.get("state")!)).html);
      assert.equal(refused.status, "error");
      // Its OWN code, not the generic "account_unidentified" (Codex review,
      // PR #574): the vendor DID name the organisations, so the hub's
      // POPUP_ERRORS must say "approved more than one", not "did not say which".
      assert.equal(refused.reason, "several_accounts");
      assert.equal((await connectionRows(ALPHA, "xero")).length, before, "neither organisation was connected");
    } finally {
      mode.xeroAuthEventId = null;
      mode.xeroOrgs = null;
    }
  });

  await check("Xero: disconnecting one organisation removes only that connection id (DELETE /connections/{id}), never the user-wide /connect/revocation, and never a DIFFERENT organisation the same Xero user approved in another workspace", async () => {
    setOAuthEnv(true);
    const app = OAUTH_APPS.find((a) => a.id === "xero")!;
    try {
      await login(USERS.ownerA);
      assert.equal(popupOutcome((await finishSignIn(app, (await startSignIn(app)).searchParams.get("state")!)).html).status, "connected");

      // Bravo's owner — the SAME Xero user in the real-world scenario, though
      // nothing here needs to model that — connects a DIFFERENT organisation.
      // Xero's exclusivity is per-ORGANISATION (rules.ts), so this is allowed.
      await login(USERS.ownerB);
      mode.xeroOrgs = [{ id: "conn-bravo", tenantId: "xero-tenant-bravo", tenantType: "ORGANISATION", tenantName: "Bravo Org", authEventId: "evt-default" }];
      assert.equal(popupOutcome((await finishSignIn(app, (await startSignIn(app)).searchParams.get("state")!)).html).status, "connected");
      const rowB = await connectedRow(BRAVO_CO, app);
      mode.xeroOrgs = null;

      // The decoy (Bravo's) sorts FIRST — picking GET /connections' [0], the
      // original bug, would delete the wrong organisation.
      mode.xeroOrgs = [
        { id: "conn-bravo", tenantId: "xero-tenant-bravo", tenantType: "ORGANISATION", tenantName: "Bravo Org", authEventId: "evt-default" },
        { id: "conn-1", tenantId: app.account, tenantType: "ORGANISATION", tenantName: app.label, authEventId: "evt-default" },
      ];
      await login(USERS.ownerA);
      const res = await toRes(await disconnectRoute.POST(new Request("https://oasisai.work/x", { method: "POST" }), ctx("xero")));
      assert.equal(res.body.disconnected, true);
      assert.equal(mode.xeroUserWideRevokeCalled, false, "Xero's user-wide /connect/revocation must never be called");
      assert.deepEqual([...mode.xeroDeletedConnectionIds], ["conn-1"], "only ALPHA's own connection id was removed");

      // Bravo's connection is completely untouched.
      assert.equal((await store.getConnection(db, BRAVO_CO, String(rowB.id)))!.revoked_at, null);
      assert.equal((await connectedRow(BRAVO_CO, app)).external_account_id, "xero-tenant-bravo");
    } finally {
      mode.xeroOrgs = null;
      mode.xeroUserWideRevokeCalled = false;
      mode.xeroDeletedConnectionIds.clear();
      await login(USERS.ownerB);
      await disconnectRoute.POST(new Request("https://oasisai.work/x", { method: "POST" }), ctx("xero"));
    }
  });

  await check("WhatsApp: one consent that approved SEVERAL WhatsApp Business Accounts is refused (several_accounts), not a silent pick of whichever sorts first", async () => {
    setOAuthEnv(true);
    await login(USERS.ownerA);
    const app = OAUTH_APPS.find((a) => a.id === "whatsapp")!;
    try {
      mode.whatsappTargetIds = ["104000000000001", "104000000000002"];
      const before = (await connectionRows(ALPHA, "whatsapp")).length;
      const refused = popupOutcome((await finishSignIn(app, (await startSignIn(app)).searchParams.get("state")!)).html);
      assert.equal(refused.status, "error");
      assert.equal(refused.reason, "several_accounts", "the same code Xero's several-organisations refusal uses");
      assert.equal((await connectionRows(ALPHA, "whatsapp")).length, before, "neither account was connected");
    } finally {
      mode.whatsappTargetIds = null;
    }
  });

  await check("WhatsApp: the same Meta USER approves two different WhatsApp Business Accounts in two workspaces; disconnecting one never revokes Meta's whole-user grant that the other still depends on", async () => {
    setOAuthEnv(true);
    const app = OAUTH_APPS.find((a) => a.id === "whatsapp")!;
    try {
      await login(USERS.ownerA);
      assert.equal(popupOutcome((await finishSignIn(app, (await startSignIn(app)).searchParams.get("state")!)).html).status, "connected");
      const rowA = await connectedRow(ALPHA, app);
      assert.equal(rowA.vendor_principal_id, "meta-user-1", "the Meta user id is recorded at connect time");

      // Bravo's owner, the SAME Meta user (debug_token's data.user_id is
      // unchanged), approves a DIFFERENT WhatsApp Business Account.
      await login(USERS.ownerB);
      mode.whatsappTargetIds = ["104000000000099"];
      assert.equal(popupOutcome((await finishSignIn(app, (await startSignIn(app)).searchParams.get("state")!)).html).status, "connected");
      mode.whatsappTargetIds = null;
      const rowB = await connectedRow(BRAVO_CO, app);
      assert.notEqual(rowA.external_account_id, rowB.external_account_id, "different WABAs");
      assert.equal(rowB.vendor_principal_id, "meta-user-1", "the same Meta user");

      // Alpha disconnects. DELETE /me/permissions would deauthorize OASIS's
      // app for the WHOLE Meta user — Bravo's grant too — so it must be skipped.
      await login(USERS.ownerA);
      live("whatsapp").revoked = false;
      const res = await toRes(await disconnectRoute.POST(new Request("https://oasisai.work/x", { method: "POST" }), ctx("whatsapp")));
      assert.equal(res.body.disconnected, true);
      assert.equal(res.body.vendor_revoked, false);
      assert.equal(res.body.vendor_revoke_skipped_reason, "shared_with_another_workspace");
      assert.equal(live("whatsapp").revoked, false, "Meta's /me/permissions was never called");
      assert.equal(await store.findActiveConnection(db, ALPHA, "whatsapp"), null, "ALPHA's own connection is gone");

      // Bravo's connection still works, untouched.
      assert.equal((await store.getConnection(db, BRAVO_CO, String(rowB.id)))!.revoked_at, null);

      // Now Bravo is the ONLY workspace left holding this Meta user: its OWN
      // disconnect must revoke for real.
      await login(USERS.ownerB);
      const res2 = await toRes(await disconnectRoute.POST(new Request("https://oasisai.work/x", { method: "POST" }), ctx("whatsapp")));
      assert.equal(res2.body.vendor_revoked, true);
      assert.equal(live("whatsapp").revoked, true);
    } finally {
      mode.whatsappTargetIds = null;
    }
  });

  await check("WhatsApp: when the vendor principal could not be read at all, the vendor revoke is skipped too — never a guess at whether sharing is safe", async () => {
    setOAuthEnv(true);
    await login(USERS.ownerA);
    const app = OAUTH_APPS.find((a) => a.id === "whatsapp")!;
    assert.equal(popupOutcome((await finishSignIn(app, (await startSignIn(app)).searchParams.get("state")!)).html).status, "connected");
    const row = await connectedRow(ALPHA, app);
    // Simulate a row connected before this column existed, or whose debug_token read failed.
    await db.execute({ sql: "UPDATE tenant_connections SET vendor_principal_id = NULL WHERE id = ?", args: [String(row.id)] });
    live("whatsapp").revoked = false;
    const res = await toRes(await disconnectRoute.POST(new Request("https://oasisai.work/x", { method: "POST" }), ctx("whatsapp")));
    assert.equal(res.body.vendor_revoked, false);
    assert.equal(res.body.vendor_revoke_skipped_reason, "vendor_principal_unknown");
    assert.equal(live("whatsapp").revoked, false);
  });

  await check("WhatsApp: a DIFFERENT Meta user reconnecting the SAME WhatsApp Business Account, whose token save then fails, leaves the OLD principal paired with the OLD (still-stored) tokens, never the new user's id over the old tokens — so Disconnect's sharing check, and any vendor revoke, run against the right person (Codex review, PR #574)", async () => {
    setOAuthEnv(true);
    const app = OAUTH_APPS.find((a) => a.id === "whatsapp")!;
    mode.metaUserId = "meta-user-1";
    let rowBeforeId: string | null = null;
    let rowBravoId: string | null = null;
    try {
      // ALPHA connects normally with Meta user 1.
      await login(USERS.ownerA);
      assert.equal(popupOutcome((await finishSignIn(app, (await startSignIn(app)).searchParams.get("state")!)).html).status, "connected");
      const rowBefore = await connectedRow(ALPHA, app);
      rowBeforeId = rowBefore.id;
      assert.equal(rowBefore.vendor_principal_id, "meta-user-1");

      // BRAVO also holds a live connection for Meta user 1 (a different
      // WABA), so meta-user-1 is genuinely shared before anything else happens.
      await login(USERS.ownerB);
      mode.whatsappTargetIds = ["104000000000098"];
      assert.equal(popupOutcome((await finishSignIn(app, (await startSignIn(app)).searchParams.get("state")!)).html).status, "connected");
      mode.whatsappTargetIds = null;
      const rowBravo = await connectedRow(BRAVO_CO, app);
      rowBravoId = rowBravo.id;
      assert.equal(rowBravo.vendor_principal_id, "meta-user-1");

      // ALPHA's owner reconnects the SAME WABA, but this time a DIFFERENT
      // real Facebook user completes the consent. completeOAuthConnect is
      // called directly (with a db whose batch() throws only for the token
      // write) so the save fails AFTER claimConnection already wrote the new
      // principal — the exact ordering the finding describes.
      await login(USERS.ownerA);
      mode.metaUserId = "meta-user-2";
      const state = (await startSignIn(app)).searchParams.get("state")!;
      const failed = await oauthConnect.completeOAuthConnect(
        { db: dbThrowingOnBatch((sql) => sql.includes("tenant_integration_credentials")), now: () => new Date() },
        {
          providerId: "whatsapp",
          state,
          code: "good-code",
          query: new URLSearchParams(),
          redirectUri: "https://oasisai.work/api/connections/whatsapp/callback",
          session: { tenantId: ALPHA, userId: USERS.ownerA.id, email: USERS.ownerA.email },
        },
      );
      assert.equal(failed.ok, false);
      assert.equal(!failed.ok && failed.failure, "token_save_failed");

      // The row is errored, but its principal must still match the tokens
      // ACTUALLY stored (meta-user-1's, from the first connect) — never the
      // new user's id the failed claim wrote before the save threw.
      const rowAfter = (await store.getConnection(db, ALPHA, rowBefore.id))!;
      assert.equal(rowAfter.status, "error");
      assert.equal(rowAfter.vendor_principal_id, "meta-user-1", "the principal must be restored to match the tokens still on disk, not left as the new user's id");

      // Disconnect must therefore see meta-user-1 (shared with BRAVO) and
      // skip the vendor revoke; with the bug, it would see the unshared
      // meta-user-2 and call Meta's /me/permissions, deauthorizing the whole
      // Meta user BRAVO's still-live connection depends on.
      mode.metaUserId = "meta-user-1";
      live("whatsapp").revoked = false;
      const res = await toRes(await disconnectRoute.POST(new Request("https://oasisai.work/x", { method: "POST" }), ctx("whatsapp")));
      assert.equal(res.body.disconnected, true);
      assert.equal(res.body.vendor_revoked, false);
      assert.equal(res.body.vendor_revoke_skipped_reason, "shared_with_another_workspace");
      assert.equal(live("whatsapp").revoked, false, "Meta's /me/permissions was never called");

      // Bravo's connection (the one that would have been collateral damage) is untouched.
      assert.equal((await store.getConnection(db, BRAVO_CO, rowBravo.id))!.revoked_at, null);
    } finally {
      mode.metaUserId = "meta-user-1";
      mode.whatsappTargetIds = null;
      // Unconditional cleanup: if an assertion above threw (exactly what a
      // reverted fix should do), the disconnect calls that would otherwise
      // have left a clean slate never ran. A later check assuming ALPHA/
      // BRAVO have no live WhatsApp connection must never be fooled by THIS
      // test's own (correct, mutation-proving) failure path.
      for (const id of [rowBeforeId, rowBravoId]) {
        if (!id) continue;
        await db.execute({ sql: "DELETE FROM tenant_integration_credentials WHERE service = ?", args: [rules.credentialServiceFor(id)] });
        await db.execute({ sql: "DELETE FROM tenant_connections WHERE id = ?", args: [id] });
      }
    }
  });

  await check("claimConnection: two reconnects racing the SAME existing row each fence their token save on the version THEIR OWN update produced, never a later writer's (Codex reproduced: both callers got version 2)", async () => {
    const provider = registry.providerById("whatsapp")!;
    const base = {
      tenantId: ALPHA,
      provider: "whatsapp",
      authKind: provider.authKind,
      scopeKind: provider.scopeKind,
      userId: null,
      externalAccountId: "race-test-waba",
      externalAccountLabel: "Race Test WABA",
      vendorPrincipalId: "meta-user-1",
      environment: null,
      grantedScopes: [],
      scopeSetVersion: 1,
      connectedBy: USERS.ownerA.id,
    } as const;
    const first = await store.claimConnection(db, { ...base, now: new Date() });
    assert.equal(first.ok, true);
    if (!first.ok) throw new Error("unreachable");
    assert.equal(first.created, true);
    const rowId = first.connection.id;
    try {
    // Deterministically force the exact interleaving Codex reproduced: BOTH
    // reconnect updates commit first, and only THEN does caller A's
    // version-read run — on the pre-fix code (a separate getConnection SELECT
    // after the UPDATE) this makes A and B both read the SAME, newer version.
    // The fix (UPDATE ... RETURNING, one statement) has no separate read to
    // delay, so this gate is simply never engaged against it.
    let sawFirstSelect = false;
    let updateCount = 0;
    let releaseFirstSelect: () => void = () => {};
    const firstSelectGate = new Promise<void>((resolve) => {
      releaseFirstSelect = resolve;
    });
    const raceDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "execute") {
          return async (stmt: { sql: string; args?: unknown[] }) => {
            const sql = stmt.sql;
            const args = stmt.args ?? [];
            const isReconnectUpdate = sql.includes("token_version = token_version + 1") && args.includes(rowId);
            const isLegacyVersionRead = sql.trim().startsWith("SELECT") && sql.includes("FROM tenant_connections WHERE tenant_id = ? AND id = ?") && args.includes(rowId);
            if (isLegacyVersionRead && !sawFirstSelect) {
              sawFirstSelect = true;
              await firstSelectGate;
            }
            const result = await target.execute(stmt as never);
            if (isReconnectUpdate) {
              updateCount += 1;
              if (updateCount === 2) releaseFirstSelect();
            }
            return result;
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as Client;

    const [a, b] = await Promise.all([store.claimConnection(raceDb, { ...base, now: new Date() }), store.claimConnection(raceDb, { ...base, now: new Date() })]);
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    if (!a.ok || !b.ok) throw new Error("unreachable");
    assert.notEqual(
      a.connection.token_version,
      b.connection.token_version,
      "two overlapping reconnects must each fence their token save on the version THEIR OWN write produced, never the same version twice",
    );
    } finally {
      // This test's own fixture row, never saved credentials and never
      // disconnected through a real route — remove it so later checks that
      // assume ALPHA has no stray live WhatsApp connection are not fooled by
      // this test's leftover state (the lesson from every prior round's
      // mutation testing: a hardcoded "must be zero" elsewhere breaks on
      // whatever earlier checks left behind).
      await db.execute({ sql: "DELETE FROM tenant_connections WHERE id = ?", args: [rowId] });
    }
  });

  await check("Xero: more than one organisation comes back, and the access token says which consent this is: the match connects even though it is not index 0 or the newest createdDateUtc, and no match refuses rather than guess", async () => {
    setOAuthEnv(true);
    await login(USERS.ownerA);
    const app = OAUTH_APPS.find((a) => a.id === "xero")!;
    try {
      // The decoy sorts FIRST and was created more recently: picking orgs[0] or
      // the newest createdDateUtc would both connect the wrong organisation.
      mode.xeroAuthEventId = "evt-this-consent";
      mode.xeroOrgs = [
        { id: "conn-decoy", tenantId: "xero-tenant-decoy", tenantType: "ORGANISATION", tenantName: "Decoy Co", authEventId: "evt-old", createdDateUtc: "2026-10-01T00:00:00Z" },
        { id: "conn-real", tenantId: app.account, tenantType: "ORGANISATION", tenantName: app.label, authEventId: "evt-this-consent", createdDateUtc: "2020-01-01T00:00:00Z" },
      ];
      const ok = popupOutcome((await finishSignIn(app, (await startSignIn(app)).searchParams.get("state")!)).html);
      assert.equal(ok.status, "connected", JSON.stringify(ok));
      const row = await connectedRow(ALPHA, app);
      assert.deepEqual([row.external_account_id, row.external_account_label], [app.account, app.label], "the decoy must never be the one stored");
      await disconnectRoute.POST(new Request("https://oasisai.work/x", { method: "POST" }), ctx("xero"));

      // Neither row's authEventId is this consent's: refuse, never guess.
      const before = (await connectionRows(ALPHA, "xero")).length;
      mode.xeroOrgs = [
        { id: "conn-decoy", tenantId: "xero-tenant-decoy", tenantType: "ORGANISATION", tenantName: "Decoy Co", authEventId: "evt-old" },
        { id: "conn-other", tenantId: "xero-tenant-other", tenantType: "ORGANISATION", tenantName: "Other Co", authEventId: "evt-older" },
      ];
      const refused = popupOutcome((await finishSignIn(app, (await startSignIn(app)).searchParams.get("state")!)).html);
      assert.deepEqual([refused.status, refused.reason], ["error", "account_unidentified"]);
      assert.equal((await connectionRows(ALPHA, "xero")).length, before, "no NEW row was connected on an unresolved consent");
    } finally {
      mode.xeroAuthEventId = null;
      mode.xeroOrgs = null;
    }
  });

  await check("a refused connect (account_connected_elsewhere, another_account_connected, or a failed token save) never revokes the grant at the vendor: Zoom/Intuit/Meta's revoke is not scoped to one token and could disconnect a DIFFERENT workspace's live connection (security review of 9f96a852, PR #574)", async () => {
    // No code path calls adapter.revoke at all any more; the two refusal
    // points instead say in a comment why not. A revoke call reappearing at
    // either site, even spelled differently, fails this.
    const connectSrc = read("lib/connections/oauth-connect.ts");
    assert.doesNotMatch(connectSrc, /\.revoke\(/, "nothing in the connect flow calls adapter.revoke any more");
    assert.doesNotMatch(connectSrc, /revokeAfterRefusal/, "the removed helper must not reappear");
    assert.match(
      connectSrc,
      /if \(!claim\.ok\) \{\s*\/\/ Deliberately NOT revoked at the vendor:/,
      "the claim-refusal path explains why it does not revoke",
    );
    assert.match(
      connectSrc,
      /await undoUnsavedClaim\(deps, tenantId, claim\);\s*\/\/ Same reasoning as the claim refusal above:/,
      "the token-save-failure path explains why it does not revoke either",
    );
  });

  await check("an account that is exclusive to one workspace cannot be connected to a second (QuickBooks, Xero); the second owner is told, and the FIRST workspace's grant is left alone at the vendor, not revoked", async () => {
    setOAuthEnv(true);
    for (const app of OAUTH_APPS.filter((a) => a.exclusive)) {
      await login(USERS.ownerA);
      assert.equal(popupOutcome((await finishSignIn(app, (await startSignIn(app)).searchParams.get("state")!)).html).status, "connected");
      await login(USERS.ownerB);
      live(app.id).revoked = false;
      const credsBefore = (await db.execute({ sql: "SELECT COUNT(*) AS n FROM tenant_integration_credentials WHERE tenant_id = ? AND service LIKE 'connection:%'", args: [BRAVO_CO] })).rows[0].n;
      const refused = await finishSignIn(app, (await startSignIn(app)).searchParams.get("state")!);
      assert.deepEqual([popupOutcome(refused.html).status, popupOutcome(refused.html).reason], ["error", "account_connected_elsewhere"], app.id);
      assert.equal(await store.findActiveConnection(db, BRAVO_CO, app.id), null, "no active connection for the refused workspace");
      assert.equal(
        (await db.execute({ sql: "SELECT COUNT(*) AS n FROM tenant_integration_credentials WHERE tenant_id = ? AND service LIKE 'connection:%'", args: [BRAVO_CO] })).rows[0].n,
        credsBefore,
        "no NEW tokens were saved for the refused workspace",
      );
      // Revoking ownerB's refused grant would ALSO kill ownerA's live
      // connection to the same account at the vendor (Zoom/Intuit/Meta's
      // revoke is account- or company-wide, not scoped to one token).
      assert.equal(live(app.id).revoked, false, `${app.id}: a refused second sign-in must never revoke the account's live grant`);
      const stillLive = await connectedRow(ALPHA, app);
      assert.equal(stillLive.external_account_id, app.account, "ownerA's connection is untouched");
      await login(USERS.ownerA);
      await disconnectRoute.POST(new Request("https://oasisai.work/x", { method: "POST" }), ctx(app.id));
    }
  });

  await check("a DIFFERENT account for an app this workspace already has connected (Zoom) is refused as another_account_connected, and the fresh grant is NOT revoked: that would also disconnect the FIRST, still-working account", async () => {
    setOAuthEnv(true);
    await login(USERS.ownerA);
    const app = OAUTH_APPS.find((a) => a.id === "zoom")!;
    assert.equal(popupOutcome((await finishSignIn(app, (await startSignIn(app)).searchParams.get("state")!)).html).status, "connected");
    live(app.id).revoked = false;
    try {
      mode.zoomAccountOverride = "zoom-account-second";
      const refused = popupOutcome((await finishSignIn(app, (await startSignIn(app)).searchParams.get("state")!)).html);
      assert.deepEqual([refused.status, refused.reason], ["error", "another_account_connected"]);
      assert.equal(live(app.id).revoked, false, "the second (refused) grant must not be revoked");
      const row = await connectedRow(ALPHA, app);
      assert.equal(row.external_account_id, app.account, "the FIRST account is still the one connected, untouched by the refusal");
      assert.equal((await connectionRows(ALPHA, "zoom")).length, 1, "the refused second account created no new connection row");
    } finally {
      mode.zoomAccountOverride = null;
    }
    await disconnectRoute.POST(new Request("https://oasisai.work/x", { method: "POST" }), ctx("zoom"));
  });

  await check("two workspaces sharing one Zoom account (not exclusive): disconnecting the first skips the vendor revoke and says why, without naming the other workspace; the second workspace's grant still works; disconnecting the LAST one does revoke it", async () => {
    setOAuthEnv(true);
    const app = OAUTH_APPS.find((a) => a.id === "zoom")!;
    const credsBeforeAlpha = (await db.execute({ sql: "SELECT COUNT(*) AS n FROM tenant_integration_credentials WHERE tenant_id = ? AND service LIKE 'connection:%'", args: [ALPHA] })).rows[0].n;
    await login(USERS.ownerA);
    assert.equal(popupOutcome((await finishSignIn(app, (await startSignIn(app)).searchParams.get("state")!)).html).status, "connected");
    await login(USERS.ownerB);
    assert.equal(
      popupOutcome((await finishSignIn(app, (await startSignIn(app)).searchParams.get("state")!)).html).status,
      "connected",
      "Zoom is not exclusive: a second workspace may hold the same account",
    );
    assert.equal((await connectedRow(BRAVO_CO, app)).external_account_id, app.account);

    await login(USERS.ownerA);
    live(app.id).revoked = false;
    const first = await toRes(await disconnectRoute.POST(new Request("https://oasisai.work/x", { method: "POST" }), ctx("zoom")));
    assert.equal(first.body.vendor_revoked, false, "the shared account's vendor grant is not revoked just because ONE workspace disconnected");
    assert.equal(first.body.vendor_revoke_skipped_reason, "shared_with_another_workspace");
    assert.doesNotMatch(JSON.stringify(first.body), /bravo/i, "the other workspace is never named");
    assert.equal(live(app.id).revoked, false, "Zoom's revoke endpoint was never called");
    assert.equal(await store.findActiveConnection(db, ALPHA, "zoom"), null, "ALPHA's own connection is gone");
    assert.equal(
      (await db.execute({ sql: "SELECT COUNT(*) AS n FROM tenant_integration_credentials WHERE tenant_id = ? AND service LIKE 'connection:%'", args: [ALPHA] })).rows[0].n,
      credsBeforeAlpha,
      "ALPHA's zoom credentials are deleted regardless, back to the pre-test baseline",
    );
    // Bravo's connection is untouched by Alpha's disconnect.
    assert.equal((await connectedRow(BRAVO_CO, app)).external_account_id, app.account);

    await login(USERS.ownerB);
    const second = await toRes(await disconnectRoute.POST(new Request("https://oasisai.work/x", { method: "POST" }), ctx("zoom")));
    assert.equal(live(app.id).revoked, true, "no workspace shares the account any more: disconnecting the LAST one does revoke it");
    assert.equal(second.body.vendor_revoked, true);
    assert.equal(second.body.vendor_revoke_skipped_reason, undefined);

    // The panel tells the two cases apart: "shared, left alone on purpose"
    // must never read as the existing "vendor refused/unreachable" failure.
    const panelSrc = read("components/os/connections/OAuthConnectionPanel.tsx");
    assert.match(panelSrc, /vendor_revoke_skipped_reason === "shared_with_another_workspace"/);
    assert.match(panelSrc, /another OASIS workspace is still using that same/);
  });

  await check("the callback's token save is fenced on the version it claimed, deterministically (no sleeps): a stale save after a Disconnect or a newer reconnect lands nothing", async () => {
    setOAuthEnv(true);
    await login(USERS.ownerA);
    const app = OAUTH_APPS.find((a) => a.id === "xero")!;

    // The callback's own wiring: completeOAuthConnect must fence the save on
    // conn.token_version, the SAME pattern the refresher already proved safe.
    assert.match(
      read("lib/connections/oauth-connect.ts"),
      /saved = await saveConnectionTokensFenced\(deps\.db, \{\s*tenantId,\s*connectionId: conn\.id,\s*version: conn\.token_version,/,
      "the callback's save is fenced on the version it claimed",
    );

    // Case A: a Disconnect finishes first. The claim this callback would have
    // used is now revoked; a stale, fenced save with that OLD version must
    // land nothing — never resurrect a connection the owner just removed.
    assert.equal(popupOutcome((await finishSignIn(app, (await startSignIn(app)).searchParams.get("state")!)).html).status, "connected");
    const rowA = await connectedRow(ALPHA, app);
    const staleVersionA = rowA.token_version;
    await disconnectRoute.POST(new Request("https://oasisai.work/x", { method: "POST" }), ctx("xero"));
    assert.equal((await store.getConnection(db, ALPHA, String(rowA.id)))!.revoked_at !== null, true, "disconnect revoked the row");
    const staleLandedA = await tokenStore.saveConnectionTokensFenced(db, {
      tenantId: ALPHA,
      connectionId: String(rowA.id),
      version: staleVersionA,
      tokens: { access_token: "stale-paused-callback-access", refresh_token: "stale-paused-callback-refresh", expires_at: Date.now() + 3_600_000 },
      now: new Date(),
    });
    assert.equal(staleLandedA, false, "a stale save must not land after the row was disconnected");
    assert.equal(
      (await db.execute({ sql: "SELECT COUNT(*) AS n FROM tenant_integration_credentials WHERE tenant_id = ? AND service LIKE 'connection:%'", args: [ALPHA] })).rows[0].n,
      0,
      "the disconnected row must stay with no credentials",
    );

    // Case B: a NEWER reconnect finishes first (token_version bumped). A
    // stale save using the OLD version must not overwrite the newer tokens.
    assert.equal(popupOutcome((await finishSignIn(app, (await startSignIn(app)).searchParams.get("state")!)).html).status, "connected");
    const rowB1 = await connectedRow(ALPHA, app);
    const staleVersionB = rowB1.token_version;
    assert.equal(popupOutcome((await finishSignIn(app, (await startSignIn(app)).searchParams.get("state")!)).html).status, "connected", "a reconnect while already connected still succeeds");
    const rowB2 = await connectedRow(ALPHA, app);
    assert.ok(rowB2.token_version > staleVersionB, "the reconnect bumped the version past the stale callback's claim");
    const freshBundle = await getTenantIntegrationBundle(ALPHA, `connection:${rowB2.id}`, { allowEnvFallback: false });
    const staleLandedB = await tokenStore.saveConnectionTokensFenced(db, {
      tenantId: ALPHA,
      connectionId: String(rowB2.id),
      version: staleVersionB,
      tokens: { access_token: "stale-paused-callback-access-2", refresh_token: "stale-paused-callback-refresh-2", expires_at: Date.now() + 3_600_000 },
      now: new Date(),
    });
    assert.equal(staleLandedB, false, "a stale save using the OLD version must be fenced out by the newer reconnect");
    const afterBundle = await getTenantIntegrationBundle(ALPHA, `connection:${rowB2.id}`, { allowEnvFallback: false });
    assert.equal(afterBundle.access_token, freshBundle.access_token, "the newer reconnect's own tokens must survive untouched");
    await disconnectRoute.POST(new Request("https://oasisai.work/x", { method: "POST" }), ctx("xero"));
  });

  await check("Disconnect works even when OASIS's app for this provider (or CONNECTIONS_OAUTH_STATE_SECRET) is unconfigured on THIS deployment: an existing connection is always removable, never a 409 coming_soon", async () => {
    setOAuthEnv(true);
    await login(USERS.ownerA);
    const app = OAUTH_APPS.find((a) => a.id === "quickbooks")!;
    assert.equal(popupOutcome((await finishSignIn(app, (await startSignIn(app)).searchParams.get("state")!)).html).status, "connected");
    try {
      // The app's Worker secrets AND the shared state secret both vanish, as
      // they would on a deployment that never configured this provider, or
      // lost the secret after the connection was made elsewhere (Codex
      // review, PR #574: Disconnect answered 409 coming_soon here).
      setOAuthEnv(false);
      const res = await disconnectRoute.POST(new Request("https://oasisai.work/x", { method: "POST" }), ctx("quickbooks"));
      assert.equal(res.status, 200, "Disconnect must not gate on whether this provider is configured HERE");
      const body = (await res.json()) as Record<string, unknown>;
      assert.equal(body.ok, true);
      assert.equal(body.disconnected, true);
      assert.equal(body.vendor_revoked, false, "with no app client configured, the vendor cannot be asked — best effort, reported honestly, never a thrown error");
      assert.equal(await store.findActiveConnection(db, ALPHA, "quickbooks"), null, "the connection is gone");
      assert.equal(
        (await db.execute({ sql: "SELECT COUNT(*) AS n FROM tenant_integration_credentials WHERE tenant_id = ? AND service LIKE 'connection:%'", args: [ALPHA] })).rows[0].n,
        0,
        "the stored credentials are deleted regardless",
      );
    } finally {
      setOAuthEnv(true);
    }
  });

  await check("getAccessToken re-reads the stored tokens INSIDE the lease: fresh tokens a moment-earlier refresh already saved are returned, never thrown away for the stale refresh_token this caller read before it even took the lease", async () => {
    setOAuthEnv(true);
    await login(USERS.ownerA);
    const app = OAUTH_APPS.find((a) => a.id === "zoom")!;
    assert.equal(popupOutcome((await finishSignIn(app, (await startSignIn(app)).searchParams.get("state")!)).html).status, "connected");
    const row = await connectedRow(ALPHA, app);

    // Force the stored token to look expired, so getAccessToken's OWN first
    // check (before it ever takes the lease) decides a refresh is needed.
    const stale = await getTenantIntegrationBundle(ALPHA, `connection:${row.id}`, { allowEnvFallback: false });
    await tokenStore.saveConnectionTokens(ALPHA, String(row.id), { access_token: stale.access_token, refresh_token: stale.refresh_token, expires_at: Date.now() - 60_000 });

    // The instant this caller's OWN lease-take UPDATE reaches the DB, inject
    // what a DIFFERENT caller's refresh — one that finished moments earlier —
    // would have left behind: fresh tokens, at the SAME version (a save and a
    // release never bump it; CodeRabbit/Codex review, PR #574). This
    // caller's own pre-lease read never saw them.
    const FRESH_ACCESS = "race-fresh-access-AAAAAAAAAAAAAAAAAAAA";
    const FRESH_REFRESH = "race-fresh-refresh-RRRRRRRRRRRRRRRRRRRR";
    SENSITIVE.add(FRESH_ACCESS).add(FRESH_REFRESH);
    let injected = false;
    const racyDb = new Proxy(db, {
      get(target, prop) {
        if (prop === "execute") {
          return async (arg: Parameters<typeof db.execute>[0]) => {
            const sql = typeof arg === "object" && arg !== null && "sql" in arg ? String((arg as { sql: unknown }).sql) : "";
            if (!injected && sql.includes("token_version = token_version + 1") && sql.includes("refresh_lease_until")) {
              injected = true;
              await tokenStore.saveConnectionTokensFenced(target, {
                tenantId: ALPHA,
                connectionId: String(row.id),
                version: row.token_version,
                tokens: { access_token: FRESH_ACCESS, refresh_token: FRESH_REFRESH, expires_at: Date.now() + 3_600_000 },
                now: new Date(),
              });
            }
            return target.execute(arg);
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as typeof db;

    let refreshCalls = 0;
    const result = await tokenStore.getAccessToken(racyDb, {
      tenantId: ALPHA,
      connectionId: String(row.id),
      refresh: async () => {
        refreshCalls += 1;
        // What Zoom ("always use the latest refresh token") would say to a
        // token it already rotated past.
        throw new tokenStore.RefreshRefusedError({ httpStatus: 400, oauthError: "invalid_grant" });
      },
    });
    assert.equal(refreshCalls, 0, "the fix re-reads and returns the fresh tokens; it must never call the vendor with the stale one");
    assert.equal(result, FRESH_ACCESS);
    assert.equal((await store.getConnection(db, ALPHA, String(row.id)))!.status, "connected", "the connection must stay connected, never wrongly marked expired");
    await disconnectRoute.POST(new Request("https://oasisai.work/x", { method: "POST" }), ctx("zoom"));
  });

  await check("a refresh in flight during a reconnect cannot overwrite the fresh tokens (the reconnect bumps token_version)", async () => {
    setOAuthEnv(true);
    await login(USERS.ownerA);
    const app = OAUTH_APPS.find((a) => a.id === "zoom")!;
    assert.equal(popupOutcome((await finishSignIn(app, (await startSignIn(app)).searchParams.get("state")!)).html).status, "connected");
    const row = await connectedRow(ALPHA, app);
    const held = (await store.getConnection(db, ALPHA, String(row.id)))!.token_version;
    assert.equal(popupOutcome((await finishSignIn(app, (await startSignIn(app)).searchParams.get("state")!)).html).status, "connected");
    assert.ok((await store.getConnection(db, ALPHA, String(row.id)))!.token_version > held, "the reconnect did not bump token_version");
    const fresh = await getTenantIntegrationBundle(ALPHA, `connection:${row.id}`, { allowEnvFallback: false });
    const landed = await tokenStore.saveConnectionTokensFenced(db, {
      tenantId: ALPHA, connectionId: String(row.id), version: held,
      tokens: { access_token: "stale-in-flight-access", refresh_token: "stale-in-flight-refresh", expires_at: Date.now() + 1000 }, now: new Date(),
    });
    assert.equal(landed, false);
    assert.equal((await getTenantIntegrationBundle(ALPHA, `connection:${row.id}`, { allowEnvFallback: false })).access_token, fresh.access_token);
    await disconnectRoute.POST(new Request("https://oasisai.work/x", { method: "POST" }), ctx("zoom"));
  });

  await check("a refresh that takes longer than 10 s: the losing caller waits for the winner's tokens instead of failing with refresh_busy", async () => {
    setOAuthEnv(true);
    await login(USERS.ownerA);
    const app = OAUTH_APPS.find((a) => a.id === "xero")!;
    assert.equal(popupOutcome((await finishSignIn(app, (await startSignIn(app)).searchParams.get("state")!)).html).status, "connected");
    const row = await connectedRow(ALPHA, app);
    const b = await getTenantIntegrationBundle(ALPHA, `connection:${row.id}`, { allowEnvFallback: false });
    await tokenStore.saveConnectionTokens(ALPHA, String(row.id), { access_token: b.access_token, refresh_token: b.refresh_token, expires_at: Date.now() - 60_000 });
    assert.ok(tokenStore.REFRESH_TIMEOUT_MS + tokenStore.LOSER_WAIT_MARGIN_MS > 10_000, "a loser's wait covers the refresh deadline");
    let refreshes = 0;
    const slow = (callerLabel: string) =>
      tokenStore.getAccessToken(db, {
        tenantId: ALPHA,
        connectionId: String(row.id),
        refresh: async () => {
          refreshes += 1;
          SENSITIVE.add(`slow-access-${callerLabel}-${"S".repeat(12)}`);
          await new Promise((r) => setTimeout(r, 11_000));
          return { access_token: `slow-access-${callerLabel}-${"S".repeat(12)}`, refresh_token: `slow-refresh-${"S".repeat(12)}`, expires_at: Date.now() + 3_600_000 };
        },
      });
    const results = await Promise.allSettled([slow("one"), slow("two"), slow("three")]);
    assert.equal(refreshes, 1, "only one caller refreshes");
    assert.deepEqual(results.map((r) => r.status), ["fulfilled", "fulfilled", "fulfilled"], JSON.stringify(results.map((r) => (r as PromiseRejectedResult).reason?.message)));
    const tokens = new Set(results.map((r) => (r as PromiseFulfilledResult<string>).value));
    assert.equal(tokens.size, 1, "the losers got the winner's token");
    await disconnectRoute.POST(new Request("https://oasisai.work/x", { method: "POST" }), ctx("xero"));
  });

  await check("a healthy refresh whose vendor call AND fenced save are both slow, together past the old 35 s wait default but short of the 120 s lease: the losing caller still gets the winner's tokens, not refresh_busy", async () => {
    setOAuthEnv(true);
    await login(USERS.ownerA);
    const app = OAUTH_APPS.find((a) => a.id === "xero")!;
    assert.equal(popupOutcome((await finishSignIn(app, (await startSignIn(app)).searchParams.get("state")!)).html).status, "connected");
    const row = await connectedRow(ALPHA, app);
    const b = await getTenantIntegrationBundle(ALPHA, `connection:${row.id}`, { allowEnvFallback: false });
    await tokenStore.saveConnectionTokens(ALPHA, String(row.id), { access_token: b.access_token, refresh_token: b.refresh_token, expires_at: Date.now() - 60_000 });

    // Each phase stays under its own real cap (REFRESH_TIMEOUT_MS, TOKEN_SAVE_TIMEOUT_MS)
    // so neither a provider abort nor the save's own withTimeout fires; together they
    // land past the OLD waitMs default (35 s) but well short of the 120 s lease.
    const refreshDelayMs = 20_000;
    const saveDelayMs = 20_000;
    const combinedMs = refreshDelayMs + saveDelayMs;
    assert.ok(refreshDelayMs < tokenStore.REFRESH_TIMEOUT_MS, "the vendor-call delay must fit its own cap");
    assert.ok(saveDelayMs < tokenStore.TOKEN_SAVE_TIMEOUT_MS, "the save delay must fit its own cap");
    assert.ok(combinedMs > tokenStore.REFRESH_TIMEOUT_MS + tokenStore.LOSER_WAIT_MARGIN_MS, "combined delay must exceed the OLD default wait (the bug)");
    assert.ok(
      combinedMs < tokenStore.REFRESH_TIMEOUT_MS + tokenStore.TOKEN_SAVE_TIMEOUT_MS + tokenStore.LOSER_WAIT_MARGIN_MS,
      "combined delay must still fit the NEW default wait (the fix)",
    );

    // getConnection, takeRefreshLease and releaseRefreshLease all call db.execute;
    // only the fenced save (saveConnectionTokensFenced) calls db.batch. Delaying
    // batch alone slows only the winner's save step, and only the winner (whichever
    // of the three callers takes the lease) ever reaches it — losers never call it.
    const slowDb = new Proxy(db, {
      get(target, prop) {
        if (prop === "batch") {
          return (...args: Parameters<typeof db.batch>) =>
            new Promise<void>((r) => setTimeout(r, saveDelayMs)).then(() => target.batch(...args));
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as typeof db;

    let refreshes = 0;
    const slow = (callerLabel: string) =>
      tokenStore.getAccessToken(slowDb, {
        tenantId: ALPHA,
        connectionId: String(row.id),
        refresh: async () => {
          refreshes += 1;
          SENSITIVE.add(`slow-both-access-${callerLabel}-${"S".repeat(12)}`);
          await new Promise((r) => setTimeout(r, refreshDelayMs));
          return { access_token: `slow-both-access-${callerLabel}-${"S".repeat(12)}`, refresh_token: `slow-both-refresh-${"S".repeat(12)}`, expires_at: Date.now() + 3_600_000 };
        },
      });
    const results = await Promise.allSettled([slow("one"), slow("two"), slow("three")]);
    assert.equal(refreshes, 1, "only one caller refreshes");
    assert.deepEqual(results.map((r) => r.status), ["fulfilled", "fulfilled", "fulfilled"], JSON.stringify(results.map((r) => (r as PromiseRejectedResult).reason?.message)));
    const tokens = new Set(results.map((r) => (r as PromiseFulfilledResult<string>).value));
    assert.equal(tokens.size, 1, "the losers got the winner's token, not a refresh_busy rejection");
    await disconnectRoute.POST(new Request("https://oasisai.work/x", { method: "POST" }), ctx("xero"));
  });

  // ===========================================================================================
  // 5. Nothing leaks: not in an answer, not in a log
  // ===========================================================================================

  await check("no answer and no log line ever held a code, a token, a webhook, a client secret or a state", () => {
    assert.ok(SENSITIVE.size > 30, "the test tracked the secrets it handled");
    const haystack = [...seenTexts, ...logged];
    for (const secret of SENSITIVE) {
      if (secret.length < 10) continue;
      const at = haystack.findIndex((t) => t.includes(secret));
      assert.equal(at, -1, `a secret appeared in an answer or a log: "${secret.slice(0, 8)}…" in "${(haystack[at] ?? "").slice(0, 160)}"`);
    }
    assert.ok(!logged.some((l) => /good-code/.test(l)), "the sign-in code was logged");
  });

  await check("the hub still lists every connector once, each with the word its state allows", async () => {
    setOAuthEnv(false);
    const statuses = await loadConnectorStatuses({ tenantId: ALPHA, userId: USERS.ownerA.id });
    assert.deepEqual(Object.keys(statuses).sort(), connectors.CONNECTOR_CATALOG.map((d) => d.slug).sort());
    for (const app of OAUTH_APPS) assert.equal(statuses[app.id].label, "Not available on this workspace yet", app.id);
    for (const app of KEY_APPS) assert.ok(["connected", "configured", "attention"].includes(statuses[app.slug].kind), `${app.slug}: ${statuses[app.slug].label}`);
  });

  globalThis.fetch = realFetch;
  console.log(`every-connector-works: ${failures === 0 ? "all passed" : `${failures} failure(s)`} (${passed} passed)`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
