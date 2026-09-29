/**
 * os-connections.test.ts — the Connections framework and the live Stripe
 * restricted-key connection (docs/os-revamp/03 §(a), §(e.3); migration
 * bravo__187).
 *
 * WHY. A connection is where a client hands OASIS the keys to their business,
 * so every failure that matters here is either a money leak or a lie:
 *   - a full Stripe secret key (sk_) accepted, when the decision is read-only
 *     with no money movement;
 *   - one company's Stripe account feeding two workspaces' books (doc 03 F6);
 *   - tenant B reading, testing or disconnecting tenant A's connection;
 *   - a card that turns green because a key was SAVED, not because Stripe
 *     answered;
 *   - an OAuth state that can be replayed, or signed with the credential
 *     encryption key when its own secret is missing (doc 03 F7);
 *   - two token refreshes racing on a rotating refresh token;
 *   - a disconnect that says "disconnected" while the key is still stored.
 * Each is invisible until it has already happened, so each is pinned here.
 *
 * Real everything against a local libSQL file: the real migration bravo__187,
 * the real signed session, the real Turso adapter, store, routes and cron
 * route. Two stand-ins only: next/headers (the session cookie) and the Stripe
 * HTTP API, mocked at the fetch boundary — every other network call fails the
 * test.
 *
 * Run: node --conditions=react-server --import tsx tests/os-connections.test.ts
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createClient } from "@libsql/client";

const dbFile = join(mkdtempSync(join(tmpdir(), "os-connections-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
process.env.EMPIRE_AUTH_BACKEND = "turso";
process.env.AUTH_SESSION_SECRET = "os-connections-test-session-secret-long-enough-0001";
process.env.BRAVO_FIELD_ENCRYPTION_KEY = "os-connections-test-field-encryption-passphrase";
process.env.STRIPE_SECRET_KEY = "sk_test_oasis_worker_key_unchanged";
process.env.CRON_SECRET = "os-connections-cron-secret";
process.env.CRON_ATTEST_SECRET = "os-connections-cron-attest";
// The dedicated OAuth state secret is deliberately NOT set: the no-fallback
// test below must see the field-encryption key present and still refuse.
delete process.env.CONNECTIONS_OAUTH_STATE_SECRET;

const SESSION_COOKIE_NAME = "oasis_session";
let sessionCookie: string | undefined;
function stub(request: string, exports: Record<string, unknown>) {
  const p = require.resolve(request);
  require.cache[p] = {
    id: p,
    filename: p,
    path: dirname(p),
    loaded: true,
    children: [],
    paths: [],
    exports,
  } as unknown as NodeModule;
}
stub("next/headers", {
  cookies: async () => ({
    get: (name: string) =>
      name === SESSION_COOKIE_NAME && sessionCookie ? { name, value: sessionCookie } : undefined,
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

// ── Tenants and people ────────────────────────────────────────────────────

const TENANT_A = "a1a1a1a1-0000-4000-8000-0000000000a1";
const TENANT_B = "b2b2b2b2-0000-4000-8000-0000000000b2";
const TENANT_C = "c3c3c3c3-0000-4000-8000-0000000000c3"; // driven through the service directly
const OASIS = "ef8d389e-3f15-43f2-ae00-3660f69a1452";

type U = { id: string; email: string };
const u = (n: number, email: string): U => ({ id: `0c000000-0000-4000-8000-${String(n).padStart(12, "0")}`, email });
const USERS = {
  ownerA: u(1, "owner@alpha.test"),
  memberA: u(2, "member@alpha.test"),
  ownerB: u(3, "owner@bravo.test"),
  oasisOwner: u(4, "founder@oasisai.work"),
} as const;

async function login(user: U | null): Promise<void> {
  if (!user) {
    sessionCookie = undefined;
    return;
  }
  const { signSession } = await import("../lib/turso-auth");
  sessionCookie = signSession({ sub: user.id, email: user.email, exp: Math.floor(Date.now() / 1000) + 3600, ver: 0 });
}

// ── Stripe, mocked at the fetch boundary ──────────────────────────────────

type StripeAccount = {
  account: string;
  name: string | null;
  livemode: boolean;
  accountRead: boolean;
  /** Whether Stripe's 403 message names the account (it normally does). */
  accountInError: boolean;
  /** Endpoints this key's permissions do not cover (e.g. "/v1/invoices"): Stripe answers 403. */
  refused: readonly string[];
};
type StripeBehavior = { kind: "ok"; acct: StripeAccount } | { kind: "dead" } | { kind: "down" };
const STRIPE = new Map<string, StripeBehavior>();
const stripeCalls: Array<{ method: string; path: string; search: string; key: string }> = [];

/**
 * The Stripe list endpoints behind the Read permissions OASIS asks for — typed
 * here from Stripe's API reference, not imported from lib/connections/health,
 * so a probe that asks for the wrong path gets this mock's 404.
 */
const STRIPE_LISTS = [
  "/v1/balance_transactions",
  "/v1/charges",
  "/v1/refunds",
  "/v1/customers",
  "/v1/disputes",
  "/v1/events",
  "/v1/invoices",
  "/v1/payouts",
  "/v1/prices",
  "/v1/products",
  "/v1/subscriptions",
];

const rk = (mode: "live" | "test", tag: string) => `rk_${mode}_${tag}${"Z9".repeat(14)}`;
const acct = (over: Partial<StripeAccount> & { account: string }): StripeAccount => ({
  name: null,
  livemode: false,
  accountRead: true,
  accountInError: true,
  refused: [],
  ...over,
});

const KEY_A = rk("test", "alphaOne");
const KEY_A_ROTATED = rk("test", "alphaTwo");
const KEY_ALPHA_FOR_B = rk("test", "alphaForBravo"); // a key for ALPHA's account, pasted in B
const KEY_OTHER_FOR_A = rk("test", "charlieInAlpha");
const KEY_B = rk("live", "bravoOne");
const KEY_DEAD = rk("test", "deadKey");
const KEY_NO_EVENTS = rk("test", "noEvents");
const KEY_NO_INVOICES = rk("test", "noInvoices"); // Balance + Events fine, two advertised reads missing
const KEY_NO_ACCOUNT = rk("test", "noAccount");
const KEY_STRIPE_DOWN = rk("test", "stripeDown");
const KEY_OASIS = rk("live", "oasisRead");
const KEY_C = rk("test", "deltaOne"); // tenant C's own account
const KEY_C_ECHO = rk("test", "echoOne");
const KEY_C_FOX = rk("test", "foxOne");

const ALPHA = acct({ account: "acct_1Alpha", name: "Alpha Co" });
STRIPE.set(KEY_A, { kind: "ok", acct: ALPHA });
STRIPE.set(KEY_A_ROTATED, { kind: "ok", acct: ALPHA });
STRIPE.set(KEY_ALPHA_FOR_B, { kind: "ok", acct: ALPHA });
STRIPE.set(KEY_OTHER_FOR_A, { kind: "ok", acct: acct({ account: "acct_1Charlie", name: "Charlie Ltd" }) });
// B's key may not read /v1/account: the id must come from Stripe's own 403.
STRIPE.set(KEY_B, { kind: "ok", acct: acct({ account: "acct_1Bravo", livemode: true, accountRead: false }) });
STRIPE.set(KEY_DEAD, { kind: "dead" });
STRIPE.set(KEY_NO_EVENTS, { kind: "ok", acct: acct({ account: "acct_1NoEvents", refused: ["/v1/events"] }) });
STRIPE.set(KEY_NO_INVOICES, {
  kind: "ok",
  acct: acct({ account: "acct_1NoInvoices", refused: ["/v1/invoices", "/v1/subscriptions"] }),
});
STRIPE.set(KEY_NO_ACCOUNT, { kind: "ok", acct: acct({ account: "acct_1Hidden", accountRead: false, accountInError: false }) });
STRIPE.set(KEY_STRIPE_DOWN, { kind: "down" });
STRIPE.set(KEY_OASIS, { kind: "ok", acct: acct({ account: "acct_1Oasis", name: "OASIS AI", livemode: true }) });
STRIPE.set(KEY_C, { kind: "ok", acct: acct({ account: "acct_1Delta", name: "Delta Inc" }) });
STRIPE.set(KEY_C_ECHO, { kind: "ok", acct: acct({ account: "acct_1Echo" }) });
STRIPE.set(KEY_C_FOX, { kind: "ok", acct: acct({ account: "acct_1Fox" }) });

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(href);
  if (url.hostname !== "api.stripe.com") throw new Error(`unexpected network call in test: ${href}`);
  const method = (init?.method || "GET").toUpperCase();
  const key = (new Headers(init?.headers).get("authorization") || "").replace(/^Bearer /, "");
  stripeCalls.push({ method, path: url.pathname, search: url.search, key });
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const behavior = STRIPE.get(key);
  if (!behavior || behavior.kind === "dead") {
    return json(401, { error: { type: "invalid_request_error", message: "Invalid API Key provided: rk_test_****" } });
  }
  if (behavior.kind === "down") return json(503, { error: { message: "Stripe is temporarily unavailable" } });
  const a = behavior.acct;
  const refuse = (perm: string) =>
    json(403, {
      error: {
        type: "invalid_request_error",
        message: `The provided key 'rk_****' does not have the required permissions for this endpoint on account '${a.accountInError ? a.account : "(hidden)"}'. Having the '${perm}' permission would allow this request to continue.`,
      },
    });
  if (a.refused.includes(url.pathname)) return refuse(`rak_${url.pathname.slice(4)}_read`);
  if (url.pathname === "/v1/balance") return json(200, { object: "balance", livemode: a.livemode, available: [], pending: [] });
  if (url.pathname === "/v1/account") {
    return a.accountRead
      ? json(200, { id: a.account, object: "account", settings: { dashboard: { display_name: a.name } } })
      : refuse("rak_accounts_kyc_basic_read");
  }
  if (STRIPE_LISTS.includes(url.pathname)) return json(200, { object: "list", data: [], has_more: false });
  return json(404, { error: { message: "no such endpoint" } });
}) as typeof fetch;

// ── Harness ───────────────────────────────────────────────────────────────

let failures = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${(e as Error).stack?.split("\n").slice(0, 6).join("\n        ")}`);
  }
}

const root = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");
const MIGRATION = read("database/turso/bravo__187_os_connections.sql");

async function main() {
  const db = createClient({ url: `file:${dbFile}` });
  await db.executeMultiple(`
    CREATE TABLE "_supabase_auth_users" (id TEXT PRIMARY KEY, email TEXT NOT NULL,
      session_version INTEGER NOT NULL DEFAULT 0, banned_until TEXT, deleted_at TEXT);
    CREATE TABLE user_profiles (id TEXT PRIMARY KEY, auth_user_id TEXT, email TEXT, tenant_id TEXT,
      team_role TEXT, is_owner INTEGER DEFAULT 0, admin_access INTEGER DEFAULT 0,
      onboarding_completed_at TEXT, updated_at TEXT, deactivated_at TEXT);
    CREATE TABLE tenants (id TEXT PRIMARY KEY, slug TEXT, name TEXT);
    -- Live DDL (read from Turso 2026-09-29), foreign keys dropped.
    CREATE TABLE "tenant_integration_credentials" (
      "id" TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))),
      "tenant_id" TEXT NOT NULL, "service" TEXT NOT NULL, "field_key" TEXT NOT NULL,
      "encrypted_value" TEXT NOT NULL, "last_tested_at" TEXT, "last_test_ok" INTEGER, "last_test_error" TEXT,
      "created_by" TEXT,
      "created_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      "updated_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      PRIMARY KEY ("id"));
    CREATE UNIQUE INDEX "tenant_integration_credentials_tenant_id_service_field_key_key"
      ON "tenant_integration_credentials" (tenant_id, service, field_key);
    CREATE TABLE "tenant_audit_log" (
      "id" TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))),
      "tenant_id" TEXT NOT NULL, "actor_user_id" TEXT, "actor_email" TEXT, "action_type" TEXT NOT NULL,
      "target_table" TEXT, "target_id" TEXT, "before" TEXT, "after" TEXT, "ip_hash" TEXT, "user_agent" TEXT,
      "metadata" TEXT NOT NULL DEFAULT '{}',
      "created_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      PRIMARY KEY ("id"));
    CREATE TABLE integrations_health (tenant_id TEXT, service TEXT, status TEXT, last_ping_at TEXT);
    -- The Feed's tape (no tenant_id column; correlation_id carries the tenant).
    CREATE TABLE agent_events (id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      event_type TEXT, publisher_agent TEXT, target_agent TEXT, severity TEXT, payload TEXT,
      correlation_id TEXT, status TEXT, published_at TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
    CREATE TABLE user_integration_credentials (id TEXT PRIMARY KEY, tenant_id TEXT, user_id TEXT, service TEXT,
      field_key TEXT, encrypted_value TEXT, last_tested_at TEXT, last_test_ok INTEGER, last_test_error TEXT,
      updated_at TEXT);
  `);
  // The real migration, as one script (it carries triggers).
  await db.executeMultiple(MIGRATION);

  const stamp = "2026-09-01T00:00:00Z";
  const profile = (user: U, tenant: string, role: string, owner: 0 | 1 = 0) => ({
    sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, onboarding_completed_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [`p-${user.id}`, user.id, user.email, tenant, role, owner, stamp, stamp],
  });
  await db.batch(
    [
      ...Object.values(USERS).map((x) => ({ sql: `INSERT INTO "_supabase_auth_users" (id, email) VALUES (?, ?)`, args: [x.id, x.email] })),
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'alpha-co', 'Alpha Co')", args: [TENANT_A] },
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'bravo-co', 'Bravo Co')", args: [TENANT_B] },
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'oasis-ai-cc', 'OASIS AI')", args: [OASIS] },
      profile(USERS.ownerA, TENANT_A, "owner", 1),
      profile(USERS.memberA, TENANT_A, "member"),
      profile(USERS.ownerB, TENANT_B, "owner", 1),
      profile(USERS.oasisOwner, OASIS, "owner", 1),
    ],
    "write",
  );

  const { NextRequest } = await import("next/server");
  const rules = await import("../lib/connections/rules");
  const registry = await import("../lib/connections/registry");
  const store = await import("../lib/connections/store");
  const oauth = await import("../lib/connections/oauth");
  const tokens = await import("../lib/connections/token-store");
  const popup = await import("../lib/connections/popup");
  const credentials = await import("../lib/tenant-integration-store");
  const { decryptField } = await import("../lib/field-encryption");
  const { loadConnectorFacts } = await import("../components/os/connections/connector-facts");
  const connectors = await import("../lib/os/connectors");
  const connectRoute = await import("../app/api/connections/[provider]/connect/route");
  const testRoute = await import("../app/api/connections/[provider]/test/route");
  const disconnectRoute = await import("../app/api/connections/[provider]/disconnect/route");
  const statusRoute = await import("../app/api/connections/[provider]/status/route");
  const cronRoute = await import("../app/api/cron/connection-health/route");
  const keysRoute = await import("../app/api/integrations/keys/route");
  const { CRON_TABLE } = await import("../workers/oasis-cc-cron/src/index");
  const health = await import("../lib/connections/health");
  const service = await import("../lib/connections/service");
  const todayModel = await import("../components/os/today/model");
  const { loadConnectionAlerts } = await import("../components/os/today/loaders");
  const { loadTenantFeed } = await import("../components/os/landings/feed-data");
  const { departmentForEvent } = await import("../components/os/landings/feed-model");
  const { projectEvent } = await import("../lib/event-projection");

  type Res = { status: number; body: Record<string, unknown>; text: string };
  const toRes = async (r: Response): Promise<Res> => {
    const text = await r.text();
    return { status: r.status, text, body: JSON.parse(text) as Record<string, unknown> };
  };
  const ctx = (provider: string) => ({ params: Promise.resolve({ provider }) });
  const connect = async (provider: string, key: unknown) =>
    toRes(
      await connectRoute.POST(
        new NextRequest(`https://oasisai.work/api/connections/${provider}/connect`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ key }),
        }),
        ctx(provider),
      ),
    );
  const test = async (provider: string) =>
    toRes(await testRoute.POST(new Request(`https://oasisai.work/api/connections/${provider}/test`, { method: "POST" }), ctx(provider)));
  const disconnect = async (provider: string) =>
    toRes(await disconnectRoute.POST(new Request(`https://oasisai.work/api/connections/${provider}/disconnect`, { method: "POST" }), ctx(provider)));
  const status = async (provider: string) =>
    toRes(await statusRoute.GET(new Request(`https://oasisai.work/api/connections/${provider}/status`), ctx(provider)));

  const credentialRows = async (tenantId: string) =>
    (await db.execute({ sql: "SELECT service, field_key, encrypted_value FROM tenant_integration_credentials WHERE tenant_id = ?", args: [tenantId] })).rows;
  const connectionRows = async (tenantId: string) =>
    (await db.execute({ sql: "SELECT * FROM tenant_connections WHERE tenant_id = ?", args: [tenantId] })).rows;
  const stripeCard = async (tenantId: string, userId: string) => {
    const facts = await loadConnectorFacts({ tenantId, userId });
    return connectors.resolveConnectorStatus(connectors.connectorBySlug("stripe")!, facts, Date.now());
  };
  const assertNoKey = (text: string) => {
    for (const k of [KEY_A, KEY_A_ROTATED, KEY_ALPHA_FOR_B, KEY_B, KEY_OASIS, KEY_DEAD]) {
      assert.ok(!text.includes(k), "a response echoed a Stripe key");
    }
  };
  const attentionEvents = async (tenantId: string) =>
    (
      await db.execute({
        sql: "SELECT publisher_agent, severity, payload FROM agent_events WHERE correlation_id = ? AND event_type = 'CONNECTION_NEEDS_ATTENTION' ORDER BY created_at",
        args: [tenantId],
      })
    ).rows.map((r) => ({ publisher: String(r.publisher_agent), severity: String(r.severity), payload: JSON.parse(String(r.payload)) as Record<string, unknown> }));
  const auditCount = async (tenantId: string, action: string) =>
    Number((await db.execute({ sql: "SELECT COUNT(*) AS n FROM tenant_audit_log WHERE tenant_id = ? AND action_type = ?", args: [tenantId, action] })).rows[0].n);
  const historyCount = async (connectionId: string) =>
    Number((await db.execute({ sql: "SELECT COUNT(*) AS n FROM connection_health_checks WHERE connection_id = ?", args: [connectionId] })).rows[0].n);
  /** The owner's Needs you, built from the real loader over the tenant's live connections. */
  const needsYouFor = async (tenantId: string) =>
    todayModel.buildNeedsYou({ sales: null, delivery: null, inbound: null, cash: null, connections: await loadConnectionAlerts(tenantId), nowMs: Date.now() });
  /** The real client, with `hook` run just before each batch (to land a write between a read and a batch). */
  const withBatchHook = (hook: (statements: ReadonlyArray<string | { sql: string }>) => Promise<void>) =>
    new Proxy(db, {
      get(target, prop) {
        if (prop === "batch") {
          return async (...args: Parameters<typeof db.batch>) => {
            await hook(args[0] as ReadonlyArray<string | { sql: string }>);
            return target.batch(...args);
          };
        }
        const v = Reflect.get(target, prop, target);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
  const deps = () => ({ db, now: () => new Date() });
  const actorC = { tenantId: TENANT_C, userId: "0c000000-0000-4000-8000-0000000000c3", profileId: null, email: "owner@charlie.test" };
  const stripeDef = registry.providerById("stripe")!;

  console.log("os-connections:");

  // ── 1. The migration and its pinned vocabularies ─────────────────────────

  await check("migration bravo__187 creates the four tables", async () => {
    const names = (await db.execute("SELECT name FROM sqlite_master WHERE type='table'")).rows.map((r) => String(r.name));
    for (const t of ["tenant_connections", "oauth_states", "connection_health_checks", "provider_webhook_routes"]) {
      assert.ok(names.includes(t), `${t} missing`);
    }
  });

  await check("every tenant_connections index leads with tenant_id, except the two cross-tenant uniques", async () => {
    const idx = (await db.execute("SELECT name, sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL AND tbl_name IN ('tenant_connections','oauth_states','connection_health_checks','provider_webhook_routes')")).rows;
    const exceptions = new Set(["ux_tenant_connections_exclusive_account", "ux_provider_webhook_routes_key"]);
    for (const r of idx) {
      const name = String(r.name);
      const cols = /\(([^)]*)/.exec(String(r.sql))![1].trim();
      if (exceptions.has(name)) continue;
      assert.ok(cols.startsWith("tenant_id"), `${name} does not lead with tenant_id`);
    }
    assert.equal(idx.filter((r) => exceptions.has(String(r.name))).length, 2);
  });

  await check("EXCLUSIVE_PROVIDERS equals the provider list in the exclusive unique index", async () => {
    const ddl = String(
      (await db.execute("SELECT sql FROM sqlite_master WHERE name = 'ux_tenant_connections_exclusive_account'")).rows[0].sql,
    );
    const list = /provider IN \(([^)]+)\)/.exec(ddl)![1].split(",").map((s) => s.trim().replace(/'/g, "")).sort();
    assert.deepEqual(list, [...rules.EXCLUSIVE_PROVIDERS].sort());
    assert.match(ddl, /revoked_at IS NULL/);
  });

  await check("no CHECK constraint on any enum column (the values live in rules.ts)", () => {
    assert.doesNotMatch(MIGRATION.replace(/--.*$/gm, ""), /\bCHECK\s*\(/i);
  });

  // ── 2. Rules ─────────────────────────────────────────────────────────────

  await check("restricted keys (rk_live_/rk_test_) are accepted with their mode", () => {
    const live = rules.checkStripeRestrictedKey(`  ${KEY_B}  `);
    assert.deepEqual(live.ok && [live.key, live.environment], [KEY_B, "live"]);
    const t = rules.checkStripeRestrictedKey(KEY_A);
    assert.ok(t.ok && t.environment === "test");
  });

  await check("full secret keys (sk_) and publishable keys (pk_) are refused, and never echoed", () => {
    for (const bad of ["sk_live_" + "a".repeat(40), "sk_test_" + "b".repeat(40)]) {
      const r = rules.checkStripeRestrictedKey(bad);
      assert.ok(!r.ok && r.error === "secret_key_refused");
      assert.ok(!r.ok && !r.message.includes(bad));
      assert.match(!r.ok ? r.message : "", /restricted key/);
    }
    const pk = rules.checkStripeRestrictedKey("pk_live_" + "c".repeat(40));
    assert.ok(!pk.ok && pk.error === "publishable_key_refused");
    for (const junk of ["", null, 42, "rk_live_short", "rk_prod_" + "d".repeat(30), "rk_live_" + "e".repeat(20) + " x"]) {
      const r = rules.checkStripeRestrictedKey(junk);
      assert.ok(!r.ok, `accepted ${String(junk)}`);
    }
  });

  await check("statusAfterProbe: healthy connects; a dead key expires; revoked never comes back", () => {
    assert.deepEqual(rules.statusAfterProbe("pending", { verdict: "healthy", code: null }, 4), { status: "connected", consecutiveFailures: 0 });
    assert.equal(rules.statusAfterProbe("connected", { verdict: "down", code: "key_rejected" }, 0).status, "expired");
    assert.equal(rules.statusAfterProbe("connected", { verdict: "down", code: "account_mismatch" }, 0).status, "error");
    assert.equal(rules.statusAfterProbe("connected", { verdict: "degraded", code: "missing_permissions" }, 0).status, "degraded");
    assert.equal(rules.statusAfterProbe("revoked", { verdict: "healthy", code: null }, 0).status, "revoked");
    // One outage is not a broken connection; three in a row are worth a look.
    assert.equal(rules.statusAfterProbe("connected", { verdict: "unknown", code: "provider_unreachable" }, 0).status, "connected");
    assert.equal(rules.statusAfterProbe("connected", { verdict: "unknown", code: "provider_unreachable" }, 2).status, "degraded");
  });

  await check("isVerifiedHealthy: only a connected row with a fresh passing probe", () => {
    const now = Date.parse("2026-09-29T12:00:00Z");
    const at = (msAgo: number) => new Date(now - msAgo).toISOString();
    const ok = { status: "connected", last_health_verdict: "healthy", last_health_at: at(60_000) };
    assert.equal(rules.isVerifiedHealthy(ok, now), true);
    assert.equal(rules.isVerifiedHealthy({ ...ok, last_health_at: at(25 * 3_600_000) }, now), false, "stale");
    assert.equal(rules.isVerifiedHealthy({ ...ok, last_health_at: at(-3_600_000) }, now), false, "future");
    assert.equal(rules.isVerifiedHealthy({ ...ok, last_health_verdict: "unknown" }, now), false, "unreachable");
    assert.equal(rules.isVerifiedHealthy({ ...ok, status: "pending" }, now), false, "saved, not proven");
    assert.equal(rules.isVerifiedHealthy({ ...ok, last_health_at: null }, now), false, "never probed");
  });

  await check("[1] every Read permission the setup steps ask for has a probe, and nothing else is probed", () => {
    assert.deepEqual(Object.keys(health.STRIPE_PERMISSION_PROBES).sort(), [...registry.STRIPE_READ_PERMISSIONS].sort());
    assert.deepEqual(registry.providerById("stripe")!.restrictedKey!.readPermissions, registry.STRIPE_READ_PERMISSIONS);
  });

  await check("[2] the probe deadline covers the body: headers on time, a body that never arrives → timed out, not a hang", async () => {
    const stalledBody = (async () => ({ status: 200, json: () => new Promise<never>(() => {}) }) as unknown as Response) as typeof fetch;
    const started = Date.now();
    let guard: ReturnType<typeof setTimeout> | undefined;
    const r = await Promise.race([
      health.probeStripeRestrictedKey(KEY_A, { fetchImpl: stalledBody, timeoutMs: 100 }),
      new Promise<"hung">((res) => {
        guard = setTimeout(() => res("hung"), 3_000);
      }),
    ]);
    clearTimeout(guard);
    assert.notEqual(r, "hung", "the probe hung past its deadline");
    const probe = r as Exclude<typeof r, "hung">;
    assert.deepEqual([probe.verdict, probe.code], ["unknown", "provider_unreachable"]);
    assert.match(String(probe.detail), /timed out/);
    assert.ok(Date.now() - started < 1_500, `took ${Date.now() - started}ms against a 100ms deadline`);
  });

  // ── 3. Registry ──────────────────────────────────────────────────────────

  await check("Stripe is the one live provider; every OAuth provider without app credentials is coming_soon", () => {
    assert.deepEqual(registry.PROVIDERS.filter((p) => p.availability === "live").map((p) => p.id), ["stripe"]);
    const stripe = registry.providerById("stripe")!;
    assert.equal(stripe.authKind, "restricted_key");
    for (const id of ["meta", "quickbooks", "xero", "plaid", "slack", "gohighlevel", "zoom"]) {
      assert.equal(registry.providerById(id)?.availability, "coming_soon", `${id} must be coming_soon`);
      assert.ok(registry.providerById(id)!.blockedOn, `${id} must say what it waits on`);
    }
  });

  await check("registry ↔ hub catalog: same slugs, live only where live, every provider has a real icon", () => {
    for (const p of registry.PROVIDERS) {
      const def = connectors.connectorBySlug(p.id);
      assert.ok(def, `${p.id} has no hub card`);
      assert.ok(def!.icon.kind === "svg" || def!.icon.reason, `${p.id}: no icon`);
      assert.equal(p.exclusive, (rules.EXCLUSIVE_PROVIDERS as readonly string[]).includes(p.id));
      if (p.availability === "live") {
        assert.deepEqual(def!.live?.source, { kind: "tenant_connection", provider: p.id });
      } else {
        assert.equal(def!.live, null, `${p.id} is coming soon but its card has a connect path`);
      }
    }
  });

  await check("scopes are requested incrementally by department", () => {
    const meta = registry.providerById("meta")!;
    assert.deepEqual(registry.scopesForDepartments(meta, []), ["ads_read", "pages_show_list"]);
    const withMarketing = registry.scopesForDepartments(meta, ["marketing", "marketing"]);
    assert.ok(withMarketing.includes("leads_retrieval") && new Set(withMarketing).size === withMarketing.length);
  });

  // ── 4. Connect: refusals first, nothing stored ───────────────────────────

  await check("signed out: 401; a member (not owner/admin): 403 — before Stripe is called", async () => {
    const before = stripeCalls.length;
    await login(null);
    assert.equal((await connect("stripe", KEY_A)).status, 401);
    await login(USERS.memberA);
    const r = await connect("stripe", KEY_A);
    assert.equal(r.status, 403);
    assert.equal(stripeCalls.length, before, "Stripe was called for a refused caller");
  });

  await check("an sk_ key is refused with a clear message; nothing is sent to Stripe or stored", async () => {
    await login(USERS.ownerA);
    const before = stripeCalls.length;
    const sk = "sk_live_" + "Q".repeat(40);
    const r = await connect("stripe", sk);
    assert.equal(r.status, 422);
    assert.equal(r.body.error, "secret_key_refused");
    assert.match(String(r.body.message), /restricted key \(rk_/);
    assert.ok(!r.text.includes(sk));
    assert.equal(stripeCalls.length, before);
    assert.equal((await credentialRows(TENANT_A)).length, 0);
    assert.equal((await connectionRows(TENANT_A)).length, 0);
  });

  await check("coming-soon providers answer 409 (no fake connect); unknown ones 404", async () => {
    await login(USERS.ownerA);
    for (const id of ["quickbooks", "xero", "plaid", "meta", "slack", "gohighlevel", "zoom"]) {
      const r = await connect(id, KEY_A);
      assert.equal(r.status, 409, id);
      assert.equal(r.body.error, "coming_soon");
    }
    assert.equal((await connect("no-such-app", KEY_A)).status, 404);
  });

  await check("a key Stripe rejects, one missing Events, one with no identifiable account, or Stripe down: refused, nothing stored", async () => {
    await login(USERS.ownerA);
    const dead = await connect("stripe", KEY_DEAD);
    assert.deepEqual([dead.status, dead.body.error], [422, "key_rejected"]);
    const noEvents = await connect("stripe", KEY_NO_EVENTS);
    assert.deepEqual([noEvents.status, noEvents.body.error], [422, "missing_permissions"]);
    assert.match(String(noEvents.body.message), /Events/);
    const noAccount = await connect("stripe", KEY_NO_ACCOUNT);
    assert.deepEqual([noAccount.status, noAccount.body.error], [422, "account_unidentified"]);
    const down = await connect("stripe", KEY_STRIPE_DOWN);
    assert.deepEqual([down.status, down.body.error], [502, "provider_unreachable"]);
    assert.equal((await credentialRows(TENANT_A)).length, 0);
    assert.equal((await connectionRows(TENANT_A)).length, 0);
  });

  await check("[1] a key that reads Balance and Events but not every advertised permission is refused, naming exactly what is missing", async () => {
    await login(USERS.ownerA);
    const r = await connect("stripe", KEY_NO_INVOICES);
    assert.deepEqual([r.status, r.body.error], [422, "missing_permissions"]);
    assert.match(String(r.body.message), /^Missing: Invoices read, Subscriptions read\./);
    assert.doesNotMatch(String(r.body.message), /Balance|Events|Charges/);
    // Nothing recorded: no connection claims the advertised scope set for a key that cannot use it.
    assert.equal((await connectionRows(TENANT_A)).length, 0);
    assert.equal((await credentialRows(TENANT_A)).length, 0);
  });

  // ── 5. Connect: the real thing ───────────────────────────────────────────

  let alphaConnectionId = "";
  await check("owner connects a restricted key: probed with GETs only, account pinned, key stored encrypted, card green", async () => {
    await login(USERS.ownerA);
    const before = stripeCalls.length;
    const r = await connect("stripe", KEY_A);
    assert.equal(r.status, 200, r.text);
    assertNoKey(r.text);
    const conn = r.body.connection as Record<string, unknown>;
    alphaConnectionId = String(conn.id);
    assert.equal(conn.status, "connected");
    assert.equal(conn.verified, true);
    assert.equal(conn.account_id, "acct_1Alpha");
    assert.equal(conn.account_label, "Alpha Co (acct_1Alpha)");
    assert.equal(conn.environment, "test");

    // Every advertised Read permission is proven (one GET each, lists one row), plus /v1/account.
    const calls = stripeCalls.slice(before);
    assert.equal(calls.length, 2 + STRIPE_LISTS.length);
    assert.ok(calls.every((c) => c.method === "GET"), "a non-GET request went to Stripe");
    assert.deepEqual(new Set(calls.map((c) => c.path)), new Set(["/v1/balance", "/v1/account", ...STRIPE_LISTS]));
    assert.ok(calls.filter((c) => STRIPE_LISTS.includes(c.path)).every((c) => c.search === "?limit=1"), "a list read asked for more than one row");
    const recorded = (await connectionRows(TENANT_A))[0];
    assert.deepEqual(JSON.parse(String(recorded.granted_scopes_json)), [...registry.providerById("stripe")!.scopes.base]);

    const stored = await credentialRows(TENANT_A);
    assert.equal(stored.length, 1);
    assert.equal(stored[0].service, `connection:${alphaConnectionId}`);
    assert.equal(stored[0].field_key, "restricted_key");
    assert.notEqual(String(stored[0].encrypted_value), KEY_A, "stored in plaintext");
    assert.equal(decryptField(String(stored[0].encrypted_value)), KEY_A);

    const checks = await store.listRecentHealthChecks(db, TENANT_A, alphaConnectionId);
    assert.deepEqual([checks.length, checks[0].check_source, checks[0].verdict], [1, "connect", "healthy"]);
    const audit = (await db.execute({ sql: "SELECT action_type, target_id FROM tenant_audit_log WHERE tenant_id = ?", args: [TENANT_A] })).rows;
    assert.ok(audit.some((a) => a.action_type === "connection.connected" && a.target_id === alphaConnectionId));

    const card = await stripeCard(TENANT_A, USERS.ownerA.id);
    assert.equal(card.kind, "connected");
    assert.match(card.label, /^Connected · verified/);
    assert.equal(card.account, "Alpha Co (acct_1Alpha) · test mode");
  });

  await check("the same Stripe account is refused for a second tenant (route and database)", async () => {
    await login(USERS.ownerB);
    const r = await connect("stripe", KEY_ALPHA_FOR_B);
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "account_connected_elsewhere");
    assert.ok(!r.text.includes(TENANT_A) && !r.text.includes("Alpha Co"), "the refusal names the other tenant");
    assert.equal((await connectionRows(TENANT_B)).length, 0);
    assert.equal((await credentialRows(TENANT_B)).length, 0);
    // The index, not just the app check: a hand-written second live row fails.
    await assert.rejects(
      db.execute({
        sql: `INSERT INTO tenant_connections (id, tenant_id, provider, auth_kind, external_account_id, status, created_at, updated_at)
              VALUES ('sneaky', ?, 'stripe', 'restricted_key', 'acct_1Alpha', 'connected', ?, ?)`,
        args: [TENANT_B, stamp, stamp],
      }),
      /UNIQUE constraint failed/,
    );
  });

  await check("a pinned account is never swapped in place (trigger), and tenant_id never changes", async () => {
    await assert.rejects(
      db.execute({ sql: "UPDATE tenant_connections SET external_account_id = 'acct_1Other' WHERE id = ?", args: [alphaConnectionId] }),
      /pinned/,
    );
    await assert.rejects(
      db.execute({ sql: "UPDATE tenant_connections SET tenant_id = ? WHERE id = ?", args: [TENANT_B, alphaConnectionId] }),
      /immutable/,
    );
    await assert.rejects(db.execute("UPDATE connection_health_checks SET verdict = 'healthy'"), /append-only/);
  });

  await check("a second, different Stripe account while one is live: 409, disconnect first", async () => {
    await login(USERS.ownerA);
    const r = await connect("stripe", KEY_OTHER_FOR_A);
    assert.deepEqual([r.status, r.body.error], [409, "provider_already_connected"]);
    assert.match(String(r.body.message), /Alpha Co/);
    assert.equal((await connectionRows(TENANT_A)).length, 1);
  });

  await check("a rotated key for the same account replaces the stored key on the same connection", async () => {
    await login(USERS.ownerA);
    const r = await connect("stripe", KEY_A_ROTATED);
    assert.equal(r.status, 200, r.text);
    assert.equal((r.body.connection as Record<string, unknown>).id, alphaConnectionId);
    const stored = await credentialRows(TENANT_A);
    assert.equal(stored.length, 1);
    assert.equal(decryptField(String(stored[0].encrypted_value)), KEY_A_ROTATED);
  });

  await check("status route: state and recent checks, never the key", async () => {
    await login(USERS.ownerA);
    const r = await status("stripe");
    assert.equal(r.status, 200);
    assertNoKey(r.text);
    assert.doesNotMatch(r.text, /rk_(live|test)_/);
    const conn = r.body.connection as Record<string, unknown>;
    assert.equal(conn.id, alphaConnectionId);
    assert.equal(conn.verified, true);
    assert.ok((r.body.recent_checks as unknown[]).length >= 2);
    const soon = await status("quickbooks");
    assert.equal(soon.status, 200);
    assert.equal((soon.body.provider as Record<string, unknown>).availability, "coming_soon");
    assert.equal(soon.body.connection, null);
  });

  // ── 6. Tenant isolation ──────────────────────────────────────────────────

  await check("isolation (routes): tenant B can neither read, test nor disconnect tenant A's Stripe", async () => {
    await login(USERS.ownerB);
    const s = await status("stripe");
    assert.equal(s.status, 200);
    assert.equal(s.body.connection, null);
    assert.ok(!s.text.includes(alphaConnectionId) && !s.text.includes("acct_1Alpha"));
    const t = await test("stripe");
    assert.deepEqual([t.status, t.body.error], [404, "not_connected"]);
    const d = await disconnect("stripe");
    assert.deepEqual([d.status, d.body.already_disconnected], [200, true]);
    const a = (await connectionRows(TENANT_A))[0];
    assert.equal(a.status, "connected");
    assert.equal(a.revoked_at, null);
    assert.equal((await credentialRows(TENANT_A)).length, 1, "A's key was touched by B");
  });

  await check("isolation (repository): B's tenant id never reaches A's rows", async () => {
    const now = new Date();
    assert.equal(await store.getConnection(db, TENANT_B, alphaConnectionId), null);
    assert.equal(await store.findActiveConnection(db, TENANT_B, "stripe"), null);
    assert.equal((await store.listActiveConnections(db, TENANT_B)).length, 0);
    assert.equal(await store.revokeConnection(db, { tenantId: TENANT_B, connectionId: alphaConnectionId, revokedBy: USERS.ownerB.id, now }), false);
    await assert.rejects(
      store.recordHealthCheck(db, {
        tenantId: TENANT_B,
        connectionId: alphaConnectionId,
        source: "manual",
        verdict: "down",
        code: "key_rejected",
        detail: null,
        latencyMs: null,
        now,
      }),
      /connection_not_found/,
    );
    assert.equal((await store.listRecentHealthChecks(db, TENANT_B, alphaConnectionId)).length, 0);
    assert.equal(await store.takeRefreshLease(db, { tenantId: TENANT_B, connectionId: alphaConnectionId, expectedVersion: 0, now, leaseMs: 60_000 }), null);
    assert.deepEqual(
      await store.registerWebhookRoute(db, { tenantId: TENANT_B, provider: "stripe", externalKey: "acct_1Alpha", connectionId: alphaConnectionId, now }),
      { ok: false, error: "connection_not_found" },
    );
    const read = await credentials.readTenantCredentialStrict(TENANT_B, `connection:${alphaConnectionId}`, "restricted_key");
    assert.deepEqual(read, { ok: false, reason: "missing" });
    const a = await store.getConnection(db, TENANT_A, alphaConnectionId);
    assert.equal(a?.status, "connected");
    assert.equal(a?.last_health_verdict, "healthy");
  });

  await check("webhook routes: one external key → one tenant; resolved only while the connection is live", async () => {
    const now = new Date();
    assert.deepEqual(
      await store.registerWebhookRoute(db, { tenantId: TENANT_A, provider: "stripe", externalKey: "acct_1Alpha", connectionId: alphaConnectionId, now }),
      { ok: true },
    );
    assert.deepEqual(await store.resolveWebhookRoute(db, "stripe", "acct_1Alpha"), { tenantId: TENANT_A, connectionId: alphaConnectionId });
    assert.equal(await store.resolveWebhookRoute(db, "stripe", "acct_nobody"), null);
  });

  // ── 7. Green only after a passing probe ──────────────────────────────────

  await check("B connects a live key whose account id only Stripe's 403 reveals; a pending claim is never green", async () => {
    await login(USERS.ownerB);
    const r = await connect("stripe", KEY_B);
    assert.equal(r.status, 200, r.text);
    const conn = r.body.connection as Record<string, unknown>;
    assert.equal(conn.account_id, "acct_1Bravo");
    assert.equal(conn.environment, "live");
    assert.equal((await stripeCard(TENANT_B, USERS.ownerB.id)).kind, "connected");

    // A claim that no probe has recorded (the state between "claimed" and
    // "probed") is "setting up", not green — even with a key stored.
    const claim = await store.claimConnection(db, {
      tenantId: TENANT_B,
      provider: "xero",
      authKind: "oauth2",
      scopeKind: "tenant",
      userId: null,
      externalAccountId: "xero-org-bravo",
      externalAccountLabel: "Bravo books",
      environment: null,
      grantedScopes: [],
      scopeSetVersion: 1,
      connectedBy: USERS.ownerB.id,
      now: new Date(),
    });
    assert.ok(claim.ok);
    const facts = await loadConnectorFacts({ tenantId: TENANT_B, userId: USERS.ownerB.id });
    const pending = facts.connections!.find((c) => c.provider === "xero")!;
    assert.equal(pending.status, "pending");
    assert.equal(rules.isVerifiedHealthy(pending, Date.now()), false);
  });

  await check("Stripe unreachable on Test again: still connected, no longer green, and the card says why", async () => {
    await login(USERS.ownerB);
    STRIPE.set(KEY_B, { kind: "down" });
    const auditsBefore = await auditCount(TENANT_B, "connection.health_changed");
    const r = await test("stripe");
    assert.equal(r.status, 200);
    const conn = r.body.connection as Record<string, unknown>;
    assert.equal(conn.status, "connected");
    assert.equal(conn.verified, false);
    const card = await stripeCard(TENANT_B, USERS.ownerB.id);
    assert.equal(card.kind, "configured");
    assert.match(card.label, /did not answer/);
    // [5] Same status, but the card lost its green: that is a health flip, and it is audited.
    assert.equal(await auditCount(TENANT_B, "connection.health_changed"), auditsBefore + 1, "healthy → unknown was not audited");
    const lost = (await db.execute({ sql: "SELECT after FROM tenant_audit_log WHERE tenant_id = ? AND action_type = 'connection.health_changed' ORDER BY created_at DESC LIMIT 1", args: [TENANT_B] })).rows[0];
    assert.deepEqual(
      (({ from, to, from_verdict, verdict, verified }) => ({ from, to, from_verdict, verdict, verified }))(JSON.parse(String(lost.after))),
      { from: "connected", to: "connected", from_verdict: "healthy", verdict: "unknown", verified: false },
    );
    // One outage is not an alert.
    assert.equal((await attentionEvents(TENANT_B)).length, 0);
    STRIPE.set(KEY_B, { kind: "ok", acct: acct({ account: "acct_1Bravo", livemode: true, accountRead: false }) });
    const back = await test("stripe");
    assert.equal((back.body.connection as Record<string, unknown>).verified, true);
    assert.equal(await auditCount(TENANT_B, "connection.health_changed"), auditsBefore + 2, "the recovery to green was not audited");
  });

  await check("[1] a stored key that loses an advertised permission goes degraded, not green; Needs you shows it until it recovers", async () => {
    await login(USERS.ownerB);
    STRIPE.set(KEY_B, { kind: "ok", acct: acct({ account: "acct_1Bravo", livemode: true, accountRead: false, refused: ["/v1/subscriptions"] }) });
    const r = await test("stripe");
    const conn = r.body.connection as Record<string, unknown>;
    assert.deepEqual([conn.status, conn.verified, conn.last_health_code], ["degraded", false, "missing_permissions"]);
    const card = await stripeCard(TENANT_B, USERS.ownerB.id);
    assert.equal(card.kind, "attention");
    assert.match(String(card.detail), /^Missing: Subscriptions read\./);
    // [6] A flip to a worse status alerts (warn for degraded) and puts it under Needs you.
    const alerts = await attentionEvents(TENANT_B);
    assert.deepEqual(alerts.map((a) => [a.severity, a.payload.to]), [["warn", "degraded"]]);
    // ...and the owner sees it on the Feed, under Operations, saying what it is.
    const feed = await loadTenantFeed({ tenantId: TENANT_B });
    assert.ok(feed.ok, "the Feed could not be read");
    const onFeed = feed.rows.filter((r) => r.event_type === "CONNECTION_NEEDS_ATTENTION");
    assert.equal(onFeed.length, 1, "the alert is not on the workspace's Feed");
    assert.equal(departmentForEvent(onFeed[0]), "operations");
    assert.match(projectEvent(onFeed[0]).summary, /Stripe connection/);
    const feedA = await loadTenantFeed({ tenantId: TENANT_A });
    assert.ok(feedA.ok && !feedA.rows.some((r) => r.event_type === "CONNECTION_NEEDS_ATTENTION"), "another workspace saw B's alert");
    const item = (await needsYouFor(TENANT_B)).items.find((i) => i.id === "connection-stripe");
    assert.deepEqual([item?.tone, item?.href], ["attention", "/settings/connections"]);
    assert.match(String(item?.detail), /^Missing: Subscriptions read\./);

    STRIPE.set(KEY_B, { kind: "ok", acct: acct({ account: "acct_1Bravo", livemode: true, accountRead: false }) });
    assert.equal(((await test("stripe")).body.connection as Record<string, unknown>).verified, true);
    // A recovery clears the item and raises nothing new.
    assert.equal((await needsYouFor(TENANT_B)).items.length, 0);
    assert.equal((await attentionEvents(TENANT_B)).length, 1);
  });

  await check("a passing probe older than a day stops being green", async () => {
    const old = new Date(Date.now() - 25 * 3_600_000).toISOString();
    await db.execute({ sql: "UPDATE tenant_connections SET last_health_at = ? WHERE tenant_id = ? AND provider = 'stripe'", args: [old, TENANT_B] });
    const card = await stripeCard(TENANT_B, USERS.ownerB.id);
    assert.equal(card.kind, "configured");
    assert.match(card.label, /waiting for a health check/);
  });

  // ── 8. The health cron ───────────────────────────────────────────────────

  await check("cron route: refuses without both cron proofs", async () => {
    const bare = await cronRoute.GET(new NextRequest("https://oasisai.work/api/cron/connection-health"));
    assert.equal(bare.status, 401);
  });

  await check("cron: re-probes stale connections, flips a key revoked in Stripe to expired, restores B to green", async () => {
    // A's key is revoked in Stripe; both connections are due (checked > 50 min ago).
    STRIPE.set(KEY_A_ROTATED, { kind: "dead" });
    const due = new Date(Date.now() - 2 * 3_600_000).toISOString();
    await db.execute({ sql: "UPDATE tenant_connections SET last_health_at = ? WHERE provider = 'stripe'", args: [due] });
    const res = await toRes(
      await cronRoute.GET(
        new NextRequest("https://oasisai.work/api/cron/connection-health", {
          headers: { authorization: `Bearer ${process.env.CRON_SECRET}`, "x-oasis-cron-attest": process.env.CRON_ATTEST_SECRET! },
        }),
      ),
    );
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.checked, 2);
    const flipped = res.body.flipped as Array<{ connection_id: string; to: string }>;
    assert.deepEqual(flipped.map((f) => [f.connection_id, f.to]), [[alphaConnectionId, "expired"]]);
    const a = await store.getConnection(db, TENANT_A, alphaConnectionId);
    assert.deepEqual([a?.status, a?.last_health_code], ["expired", "key_rejected"]);
    const cardA = await stripeCard(TENANT_A, USERS.ownerA.id);
    assert.deepEqual([cardA.kind, cardA.label], ["attention", "Key no longer accepted"]);
    assert.equal((await stripeCard(TENANT_B, USERS.ownerB.id)).kind, "connected");
    const audit = (await db.execute({ sql: "SELECT action_type FROM tenant_audit_log WHERE tenant_id = ? AND action_type = 'connection.health_changed'", args: [TENANT_A] })).rows;
    assert.equal(audit.length, 1);
    // The xero claim has no probe: the cron never touches a provider it cannot check.
    assert.equal((await store.findActiveConnection(db, TENANT_B, "xero"))?.status, "pending");
  });

  await check("cron: a key now answering for a different account is stopped (account_mismatch)", async () => {
    STRIPE.set(KEY_B, { kind: "ok", acct: acct({ account: "acct_1Imposter", livemode: true }) });
    const row = (await store.findActiveConnection(db, TENANT_B, "stripe"))!;
    const { probeStoredConnection } = await import("../lib/connections/health");
    const rec = await probeStoredConnection({ db, now: () => new Date() }, row, "manual", { userId: null, email: null });
    assert.deepEqual([rec.connection.status, rec.connection.last_health_code], ["error", "account_mismatch"]);
    assert.equal(rec.connection.external_account_id, "acct_1Bravo", "the pinned account moved");
    STRIPE.set(KEY_B, { kind: "ok", acct: acct({ account: "acct_1Bravo", livemode: true, accountRead: false }) });
  });

  await check("cron: a missing stored key is reported, never guessed around", async () => {
    const row = (await store.findActiveConnection(db, TENANT_B, "stripe"))!;
    await db.execute({ sql: "DELETE FROM tenant_integration_credentials WHERE tenant_id = ? AND service = ?", args: [TENANT_B, `connection:${row.id}`] });
    const { probeStoredConnection } = await import("../lib/connections/health");
    const rec = await probeStoredConnection({ db, now: () => new Date() }, row, "manual", { userId: null, email: null });
    assert.deepEqual([rec.connection.status, rec.connection.last_health_code], ["error", "credential_missing"]);
  });

  // ── 9. Disconnect ────────────────────────────────────────────────────────

  await check("disconnect deletes the stored key, marks revoked, drops webhook routes, and frees the account", async () => {
    await login(USERS.ownerA);
    const r = await disconnect("stripe");
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.disconnected, true);
    assert.equal(r.body.credentials_deleted, 1);
    assert.equal((await credentialRows(TENANT_A)).length, 0, "the key survived disconnect");
    const a = await store.getConnection(db, TENANT_A, alphaConnectionId);
    assert.equal(a?.status, "revoked");
    assert.ok(a?.revoked_at);
    assert.equal(await store.resolveWebhookRoute(db, "stripe", "acct_1Alpha"), null);
    assert.equal((await status("stripe")).body.connection, null);
    assert.equal((await stripeCard(TENANT_A, USERS.ownerA.id)).kind, "not_connected");
    const audit = (await db.execute({ sql: "SELECT 1 FROM tenant_audit_log WHERE tenant_id = ? AND action_type = 'connection.revoked'", args: [TENANT_A] })).rows;
    assert.equal(audit.length, 1);
    // Idempotent.
    assert.equal((await disconnect("stripe")).body.already_disconnected, true);
  });

  await check("once A disconnected, the account may be connected elsewhere; A reconnecting reuses its row", async () => {
    await login(USERS.ownerB);
    // B must first let go of its own (now errored) Stripe connection.
    assert.equal((await disconnect("stripe")).body.disconnected, true);
    STRIPE.set(KEY_ALPHA_FOR_B, { kind: "ok", acct: ALPHA });
    const b = await connect("stripe", KEY_ALPHA_FOR_B);
    assert.equal(b.status, 200, b.text);
    assert.equal((b.body.connection as Record<string, unknown>).account_id, "acct_1Alpha");
    // And now A cannot take it back while B holds it.
    await login(USERS.ownerA);
    STRIPE.set(KEY_A, { kind: "ok", acct: ALPHA });
    assert.equal((await connect("stripe", KEY_A)).body.error, "account_connected_elsewhere");
    await login(USERS.ownerB);
    await disconnect("stripe");
    await login(USERS.ownerA);
    const again = await connect("stripe", KEY_A);
    assert.equal(again.status, 200, again.text);
    assert.equal((again.body.connection as Record<string, unknown>).id, alphaConnectionId, "history split across rows");
    assert.equal((again.body.connection as Record<string, unknown>).verified, true);
  });

  // ── 10. The OASIS tenant's Worker Stripe key is untouched ────────────────

  await check("OASIS: connecting a restricted key leaves the Worker's STRIPE_SECRET_KEY path unchanged", async () => {
    await login(USERS.oasisOwner);
    const r = await connect("stripe", KEY_OASIS);
    assert.equal(r.status, 200, r.text);
    assert.equal(await credentials.getTenantIntegrationValue(OASIS, "stripe", "secret_key"), "sk_test_oasis_worker_key_unchanged");
    assert.equal((await credentials.getTenantIntegrationBundle(OASIS, "stripe")).secret_key, "sk_test_oasis_worker_key_unchanged");
    // And the restricted key never becomes anyone's env fallback.
    assert.deepEqual(credentials.envKeysFor(`connection:${(r.body.connection as Record<string, unknown>).id}`, "restricted_key"), []);
  });

  await check("the Credentials editor refuses a Stripe secret key for a client workspace, not for OASIS", async () => {
    const post = (body: unknown) =>
      keysRoute.POST(
        new NextRequest("https://oasisai.work/api/integrations/keys", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
    await login(USERS.ownerA);
    const client = await toRes(await post({ service: "stripe", field_key: "secret_key", value: "sk_live_" + "R".repeat(40) }));
    assert.deepEqual([client.status, client.body.error], [422, "stripe_connects_with_restricted_key"]);
    assert.equal(
      (await db.execute({ sql: "SELECT 1 FROM tenant_integration_credentials WHERE tenant_id = ? AND service = 'stripe'", args: [TENANT_A] })).rows.length,
      0,
    );
    await login(USERS.oasisOwner);
    const oasisRes = await toRes(await post({ service: "stripe", field_key: "publishable_key", value: "pk_test_" + "S".repeat(30) }));
    assert.equal(oasisRes.status, 200, oasisRes.text);
  });

  // ── 11. OAuth: dedicated secret, single-use state ────────────────────────

  const STATE_SECRET = "state-secret-for-tests-".padEnd(48, "x");
  const liveXero = { ...registry.providerById("xero")!, availability: "live" as const };
  const oauthEnv = { CONNECTIONS_OAUTH_STATE_SECRET: STATE_SECRET, XERO_CLIENT_ID: "xero-client", XERO_CLIENT_SECRET: "xero-secret" };

  await check("no state-secret fallback: the field-encryption key present, the state secret absent → refused", async () => {
    assert.ok(process.env.BRAVO_FIELD_ENCRYPTION_KEY, "precondition: the encryption key is set");
    assert.throws(() => oauth.oauthStateSecret(process.env), /CONNECTIONS_OAUTH_STATE_SECRET/);
    await assert.rejects(
      oauth.startAuthorize(db, {
        provider: liveXero,
        tenantId: TENANT_A,
        userId: USERS.ownerA.id,
        scopes: ["offline_access"],
        redirectUri: "https://oasisai.work/api/connections/xero/callback",
        now: new Date(),
        env: { BRAVO_FIELD_ENCRYPTION_KEY: process.env.BRAVO_FIELD_ENCRYPTION_KEY, XERO_CLIENT_ID: "a", XERO_CLIENT_SECRET: "b" },
      }),
      (e: unknown) => (e as { code?: string }).code === "state_secret_missing",
    );
    assert.equal((await db.execute("SELECT COUNT(*) AS n FROM oauth_states")).rows[0].n, 0, "a state row was written");
    await assert.rejects(oauth.completeCallback(db, { state: "x.y", now: new Date(), env: { BRAVO_FIELD_ENCRYPTION_KEY: "k".repeat(40) } }), /CONNECTIONS_OAUTH_STATE_SECRET/);
  });

  await check("a coming-soon provider cannot even start a consent", async () => {
    await assert.rejects(
      oauth.startAuthorize(db, {
        provider: registry.providerById("xero")!,
        tenantId: TENANT_A,
        userId: USERS.ownerA.id,
        scopes: [],
        redirectUri: "https://oasisai.work/cb",
        now: new Date(),
        env: oauthEnv,
      }),
      (e: unknown) => (e as { code?: string }).code === "provider_not_available",
    );
  });

  await check("OAuth state is single-use: the first callback succeeds (PKCE verifier returned), a replay is refused", async () => {
    const now = new Date();
    const started = await oauth.startAuthorize(db, {
      provider: liveXero,
      tenantId: TENANT_A,
      userId: USERS.ownerA.id,
      scopes: registry.scopesForDepartments(liveXero, ["finance"]),
      redirectUri: "https://oasisai.work/api/connections/xero/callback",
      now,
      env: oauthEnv,
    });
    const url = new URL(started.url);
    assert.equal(url.searchParams.get("client_id"), "xero-client");
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    const first = await oauth.completeCallback(db, { state: started.state, now: new Date(now.getTime() + 1000), env: oauthEnv });
    assert.deepEqual([first.tenantId, first.userId, first.provider], [TENANT_A, USERS.ownerA.id, "xero"]);
    assert.equal(createHash("sha256").update(first.pkceVerifier!).digest("base64url"), url.searchParams.get("code_challenge"));
    await assert.rejects(
      oauth.completeCallback(db, { state: started.state, now: new Date(now.getTime() + 2000), env: oauthEnv }),
      (e: unknown) => (e as { code?: string }).code === "state_replayed_or_unknown",
    );
  });

  await check("OAuth state: tampered, expired, or re-signed for another tenant → refused", async () => {
    const now = new Date();
    const started = await oauth.startAuthorize(db, {
      provider: liveXero,
      tenantId: TENANT_A,
      userId: USERS.ownerA.id,
      scopes: [],
      redirectUri: "https://oasisai.work/cb",
      now,
      env: oauthEnv,
    });
    const [body, sig] = started.state.split(".");
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    const forgedBody = Buffer.from(JSON.stringify({ ...payload, t: TENANT_B })).toString("base64url");
    await assert.rejects(
      oauth.completeCallback(db, { state: `${forgedBody}.${sig}`, now, env: oauthEnv }),
      (e: unknown) => (e as { code?: string }).code === "state_signature_invalid",
    );
    // Even correctly signed (a leaked secret), B's claim on A's nonce matches no row.
    const resigned = oauth.signState({ ...payload, t: TENANT_B }, STATE_SECRET);
    await assert.rejects(
      oauth.completeCallback(db, { state: resigned, now, env: oauthEnv }),
      (e: unknown) => (e as { code?: string }).code === "state_replayed_or_unknown",
    );
    await assert.rejects(
      oauth.completeCallback(db, { state: started.state, now: new Date(now.getTime() + 11 * 60_000), env: oauthEnv }),
      (e: unknown) => (e as { code?: string }).code === "state_expired",
    );
    // The untouched original still works exactly once.
    assert.equal((await oauth.completeCallback(db, { state: started.state, now, env: oauthEnv })).tenantId, TENANT_A);
  });

  // ── 12. Token store: atomic save, one refresh at a time, fail closed ─────

  await check("token set saves atomically: a bad field writes nothing", async () => {
    const bad = await credentials.setTenantIntegrationBundle({
      tenantId: TENANT_A,
      service: "connection:atomic-probe",
      bundle: { access_token: "a", refresh_token: "", expires_at: "1" },
    });
    assert.equal(bad.ok, false);
    assert.equal(
      (await db.execute({ sql: "SELECT 1 FROM tenant_integration_credentials WHERE service = 'connection:atomic-probe'" })).rows.length,
      0,
    );
  });

  await check("one live connection per provider: two DIFFERENT accounts connecting at once, exactly one wins", async () => {
    // A non-exclusive provider: the cross-tenant index does not cover it, so
    // only ux_tenant_connections_one_live stops the second account. Both
    // claims pass claimConnection's read before either inserts.
    const claimFor = (account: string) =>
      store.claimConnection(db, {
        tenantId: TENANT_B,
        provider: "zoom",
        authKind: "oauth2",
        scopeKind: "tenant",
        userId: null,
        externalAccountId: account,
        externalAccountLabel: account,
        environment: null,
        grantedScopes: [],
        scopeSetVersion: 1,
        connectedBy: USERS.ownerB.id,
        now: new Date(),
      });
    const results = await Promise.all([claimFor("zoom-acct-1"), claimFor("zoom-acct-2")]);
    assert.equal(results.filter((r) => r.ok).length, 1, `exactly one claim wins: ${JSON.stringify(results.map((r) => (r.ok ? "ok" : r.error)))}`);
    const loser = results.find((r) => !r.ok);
    assert.ok(loser && !loser.ok && loser.error === "provider_already_connected");
    const live = await db.execute({
      sql: "SELECT COUNT(*) AS n FROM tenant_connections WHERE tenant_id = ? AND provider = 'zoom' AND revoked_at IS NULL",
      args: [TENANT_B],
    });
    assert.equal(Number(live.rows[0].n), 1, "the database holds one live zoom connection for B");
  });

  await check("two concurrent refreshes: the provider is called ONCE, both callers get the new token", async () => {
    const claim = await store.claimConnection(db, {
      tenantId: TENANT_A,
      provider: "xero",
      authKind: "oauth2",
      scopeKind: "tenant",
      userId: null,
      externalAccountId: "xero-org-alpha",
      externalAccountLabel: "Alpha books",
      environment: null,
      grantedScopes: ["offline_access"],
      scopeSetVersion: 1,
      connectedBy: USERS.ownerA.id,
      now: new Date(),
    });
    assert.ok(claim.ok);
    const id = claim.connection.id;
    await store.recordHealthCheck(db, { tenantId: TENANT_A, connectionId: id, source: "connect", verdict: "healthy", code: null, detail: null, latencyMs: 1, now: new Date() });
    await tokens.saveConnectionTokens(TENANT_A, id, { access_token: "old-access", refresh_token: "rotating-1", expires_at: Date.now() - 1000 });
    const versionBefore = (await store.getConnection(db, TENANT_A, id))!.token_version;

    let calls = 0;
    const refresh = async (refreshToken: string) => {
      calls += 1;
      assert.equal(refreshToken, "rotating-1");
      await new Promise((r) => setTimeout(r, 120));
      return { access_token: "new-access", refresh_token: "rotating-2", expires_at: Date.now() + 3_600_000 };
    };
    const [x, y] = await Promise.all([
      tokens.getAccessToken(db, { tenantId: TENANT_A, connectionId: id, refresh, pollMs: 20 }),
      tokens.getAccessToken(db, { tenantId: TENANT_A, connectionId: id, refresh, pollMs: 20 }),
    ]);
    assert.deepEqual([x, y, calls], ["new-access", "new-access", 1]);
    const after = (await store.getConnection(db, TENANT_A, id))!;
    assert.equal(after.token_version, versionBefore + 1);
    assert.equal(after.refresh_lease_until, null);
    const bundle = await credentials.getTenantIntegrationBundle(TENANT_A, `connection:${id}`, { allowEnvFallback: false });
    assert.equal(bundle.refresh_token, "rotating-2");
    // B cannot borrow A's token, even by id.
    await assert.rejects(tokens.getAccessToken(db, { tenantId: TENANT_B, connectionId: id, refresh }), /connection_not_found/);
  });

  await check("[4] only a refusal the provider confirmed counts: invalid_grant / 400 / 401, never a 5xx or a thrown blip", () => {
    const { RefreshRefusedError, isConfirmedRefreshRefusal } = tokens;
    assert.equal(isConfirmedRefreshRefusal(new RefreshRefusedError({ oauthError: "invalid_grant" })), true);
    assert.equal(isConfirmedRefreshRefusal(new RefreshRefusedError({ httpStatus: 401 })), true);
    assert.equal(isConfirmedRefreshRefusal(new RefreshRefusedError({ httpStatus: 503 })), false, "a 5xx says nothing about the grant");
    assert.equal(isConfirmedRefreshRefusal(new Error("invalid_grant")), false, "an untyped error is not a confirmed refusal");
  });

  await check("[4] a transient refresh failure releases the lease and does NOT expire the connection", async () => {
    const row = (await store.findActiveConnection(db, TENANT_A, "xero"))!;
    await tokens.saveConnectionTokens(TENANT_A, row.id, { access_token: "stale", refresh_token: "rotating-2", expires_at: Date.now() - 1000 });
    const statusBefore = row.status;
    const historyBefore = await historyCount(row.id);
    await assert.rejects(
      tokens.getAccessToken(db, {
        tenantId: TENANT_A,
        connectionId: row.id,
        refresh: async () => {
          throw new Error("socket hang up");
        },
      }),
      (e: unknown) => (e as { code?: string }).code === "refresh_unavailable",
    );
    const after = (await store.getConnection(db, TENANT_A, row.id))!;
    assert.deepEqual([after.status, after.refresh_lease_until], [statusBefore, null], "one blip expired the account or kept the lease");
    assert.equal(await historyCount(row.id), historyBefore, "a blip wrote a health row nothing would ever clear");
  });

  await check("[4] the lease is released even when recording a refusal throws", async () => {
    const row = (await store.findActiveConnection(db, TENANT_A, "xero"))!;
    const failingBatch = withBatchHook(async () => {
      throw new Error("batch write failed");
    });
    await assert.rejects(
      tokens.getAccessToken(failingBatch as unknown as typeof db, {
        tenantId: TENANT_A,
        connectionId: row.id,
        refresh: async () => {
          throw new tokens.RefreshRefusedError({ oauthError: "invalid_grant" });
        },
      }),
    );
    assert.equal((await store.getConnection(db, TENANT_A, row.id))!.refresh_lease_until, null, "a failed health write stranded the lease");
  });

  await check("[lease] refresh + save fit inside the lease; a lease lost mid-save returns no token", async () => {
    assert.ok(tokens.REFRESH_TIMEOUT_MS + tokens.TOKEN_SAVE_TIMEOUT_MS < rules.REFRESH_LEASE_MS, "refresh + save can outlive the lease");
    const row = (await store.findActiveConnection(db, TENANT_A, "xero"))!;
    await tokens.saveConnectionTokens(TENANT_A, row.id, { access_token: "stale", refresh_token: "rotating-2", expires_at: Date.now() - 1000 });
    try {
      await assert.rejects(
        tokens.getAccessToken(db, {
          tenantId: TENANT_A,
          connectionId: row.id,
          refresh: async () => {
            // Another caller takes the lease while this refresh runs.
            await db.execute({
              sql: "UPDATE tenant_connections SET token_version = token_version + 1 WHERE id = ? AND tenant_id = ?",
              args: [row.id, TENANT_A],
            });
            return { access_token: "orphan-access", refresh_token: "rotating-3", expires_at: Date.now() + 3_600_000 };
          },
        }),
        (e: unknown) => (e as { code?: string }).code === "refresh_busy",
      );
    } finally {
      await db.execute({ sql: "UPDATE tenant_connections SET refresh_lease_until = NULL WHERE id = ? AND tenant_id = ?", args: [row.id, TENANT_A] });
    }
  });

  await check("[lease] a refresh that ran past its lease saves nothing and returns no token", async () => {
    const row = (await store.findActiveConnection(db, TENANT_A, "xero"))!;
    await tokens.saveConnectionTokens(TENANT_A, row.id, { access_token: "stale", refresh_token: "keep-me", expires_at: Date.now() - 1000 });
    let t = Date.now();
    await assert.rejects(
      tokens.getAccessToken(db, {
        tenantId: TENANT_A,
        connectionId: row.id,
        now: () => new Date(t),
        refresh: async () => {
          t += rules.REFRESH_LEASE_MS; // the provider answered, but only after the lease ran out
          return { access_token: "late-access", refresh_token: "late-refresh", expires_at: t + 3_600_000 };
        },
      }),
      (e: unknown) => (e as { code?: string }).code === "refresh_busy",
    );
    const bundle = await credentials.getTenantIntegrationBundle(TENANT_A, `connection:${row.id}`, { allowEnvFallback: false });
    assert.equal(bundle.refresh_token, "keep-me", "tokens were saved over a newer refresh");
    assert.equal((await store.getConnection(db, TENANT_A, row.id))!.refresh_lease_until, null, "the lease was not released");
  });

  await check("[in-flight] a Stripe probe never has more than six requests open; the pass runs one probe at a time", async () => {
    let open = 0;
    let most = 0;
    let calls = 0;
    const counting = (async (input: RequestInfo | URL, init?: RequestInit) => {
      open += 1;
      calls += 1;
      most = Math.max(most, open);
      try {
        await new Promise((r) => setTimeout(r, 15));
        return await globalThis.fetch(input, init);
      } finally {
        open -= 1;
      }
    }) as typeof fetch;
    const r = await health.probeStripeRestrictedKey(KEY_B, { fetchImpl: counting });
    assert.equal(r.verdict, "healthy");
    assert.equal(calls, 1 + registry.STRIPE_READ_PERMISSIONS.length, "every advertised permission plus /v1/account");
    assert.ok(most <= health.STRIPE_MAX_IN_FLIGHT, `${most} requests were open at once`);
    assert.ok(health.HEALTH_PASS_CONCURRENCY * health.STRIPE_MAX_IN_FLIGHT <= 6, "the pass can open more than a Worker's six connections");
  });

  await check("a refused refresh fails closed: expired, lease released, health row written", async () => {
    const row = (await store.findActiveConnection(db, TENANT_A, "xero"))!;
    await tokens.saveConnectionTokens(TENANT_A, row.id, { access_token: "stale", refresh_token: "rotating-2", expires_at: Date.now() - 1000 });
    await assert.rejects(
      tokens.getAccessToken(db, {
        tenantId: TENANT_A,
        connectionId: row.id,
        refresh: async () => {
          throw new tokens.RefreshRefusedError({ oauthError: "invalid_grant" });
        },
      }),
      (e: unknown) => (e as { code?: string }).code === "refresh_failed",
    );
    const after = (await store.getConnection(db, TENANT_A, row.id))!;
    assert.deepEqual([after.status, after.last_health_code, after.refresh_lease_until], ["expired", "refresh_failed", null]);
    const latest = (await store.listRecentHealthChecks(db, TENANT_A, row.id, 1))[0];
    assert.deepEqual([latest.check_source, latest.error_code], ["refresh", "refresh_failed"]);
  });

  // ── 12b. Review fixes (#472): budget, error hygiene, undo, races ─────────

  await check("[3] the health pass stops inside its budget, defers the rest (still due), and prunes first", async () => {
    // Three connections due, one lane, and a clock that runs out after one probe.
    // One throwaway workspace per row: a workspace holds ONE live Stripe
    // connection (ux_tenant_connections_one_live).
    const stale = new Date(Date.now() - 3 * 3_600_000).toISOString();
    const ids: string[] = [];
    try {
    for (const n of [1, 2, 3]) {
      const id = `budget-${n}-0000-4000-8000-000000000000`;
      ids.push(id);
      await db.execute({
        sql: `INSERT INTO tenant_connections (id, tenant_id, provider, auth_kind, external_account_id, status, last_health_at, last_health_verdict, created_at, updated_at)
              VALUES (?, ?, 'stripe', 'restricted_key', ?, 'connected', ?, 'healthy', ?, ?)`,
        args: [id, `t-budget-${n}`, `acct_budget_${n}`, stale, stale, stale],
      });
    }
    const due = await store.listConnectionsDueForHealth(db, {
      providers: ["stripe"],
      staleBefore: new Date(Date.now() - rules.HEALTH_RECHECK_AFTER_MS),
      limit: 50,
    });
    const ticks = [0, 0, 70];
    const clock = () => (ticks.length > 1 ? ticks.shift()! : ticks[0]);
    const result = await health.runConnectionHealthPass(
      { db, now: () => new Date() },
      { limit: 50, concurrency: 1, budgetMs: 100, probeWorstCaseMs: 60, clock },
    );
    assert.equal(result.checked + result.errors.length, 1, "exactly one probe fit the budget");
    assert.equal(result.deferred, due.length - 1, "everything else was deferred, and counted");
    assert.ok(result.pruned && typeof result.pruned.healthChecksDeleted === "number", "pruning ran even though the pass ran out of time");
    const stillDue = await store.listConnectionsDueForHealth(db, {
      providers: ["stripe"],
      staleBefore: new Date(Date.now() - rules.HEALTH_RECHECK_AFTER_MS),
      limit: 50,
    });
    assert.equal(stillDue.length, due.length - 1, "a deferred connection must stay due for the next pass");
    // The shipped limits fit the route's deadline even when every probe runs to its worst case.
    assert.ok(
      (health.HEALTH_PASS_LIMIT / health.HEALTH_PASS_CONCURRENCY) * health.PROBE_WORST_CASE_MS <= health.HEALTH_PASS_BUDGET_MS,
      "the batch cap does not fit the pass budget",
    );
    assert.match(read("app/api/cron/connection-health/route.ts"), /export const maxDuration = 60;/);
    assert.ok(health.HEALTH_PASS_BUDGET_MS < 60_000);
    } finally {
      for (const id of ids) await db.execute({ sql: "DELETE FROM connection_health_checks WHERE connection_id = ?", args: [id] });
      for (const id of ids) await db.execute({ sql: "DELETE FROM tenant_connections WHERE id = ?", args: [id] });
    }
  });

  await check("[7] a probe that throws is reported by a stable code; its message never reaches the response", async () => {
    const stale = new Date(Date.now() - 3 * 3_600_000).toISOString();
    const id = "throws-00-0000-4000-8000-000000000000";
    await db.execute({
      sql: `INSERT INTO tenant_connections (id, tenant_id, provider, auth_kind, external_account_id, status, last_health_at, last_health_verdict, created_at, updated_at)
            VALUES (?, ?, 'stripe', 'restricted_key', 'acct_throws', 'connected', ?, 'healthy', ?, ?)`,
      args: [id, "t-throws", stale, stale, stale],
    });
    try {
    // The health write fails with a message that must stay in the server log.
    // Only the probe's write: pruning (also a batch) runs first and must pass.
    const leaky = withBatchHook(async (statements) => {
      if (statements.some((st) => (typeof st === "string" ? st : st.sql).includes("INSERT INTO connection_health_checks"))) {
        throw new Error("SQLITE_IOERR: disk detail SECRET-DETAIL-XYZ at /var/db");
      }
    });
    const quiet = console.error;
    console.error = () => {};
    let result: Awaited<ReturnType<typeof health.runConnectionHealthPass>>;
    try {
      result = await health.runConnectionHealthPass({ db: leaky as unknown as typeof db, now: () => new Date() }, { limit: 50 });
    } finally {
      console.error = quiet;
    }
    const mine = result.errors.find((e) => e.connection_id === id);
    assert.equal(mine?.error, "probe_threw");
    assert.ok(!JSON.stringify(result).includes("SECRET-DETAIL"), "a raw error message reached the cron response");
    // The route's own catch returns a code only (the body is printed to a public Actions log).
    const routeSrc = read("app/api/cron/connection-health/route.ts");
    assert.doesNotMatch(routeSrc, /err\.message|detail:/, "the route puts an exception message in its response");
    } finally {
      await db.execute({ sql: "DELETE FROM tenant_connections WHERE id = ?", args: [id] });
    }
  });

  // Makes every credential write fail (the save path returns { ok: false }), so
  // connect has to undo its claim.
  const failCredentialWrites = async () => {
    await db.execute(
      "CREATE TRIGGER test_fail_cred_insert BEFORE INSERT ON tenant_integration_credentials BEGIN SELECT RAISE(ABORT, 'forced credential write failure'); END",
    );
    await db.execute(
      "CREATE TRIGGER test_fail_cred_update BEFORE UPDATE ON tenant_integration_credentials BEGIN SELECT RAISE(ABORT, 'forced credential write failure'); END",
    );
  };
  const restoreCredentialWrites = async () => {
    await db.execute("DROP TRIGGER IF EXISTS test_fail_cred_insert");
    await db.execute("DROP TRIGGER IF EXISTS test_fail_cred_update");
  };
  const quietErrors = async <T,>(fn: () => Promise<T>): Promise<T> => {
    const quiet = console.error;
    console.error = () => {};
    try {
      return await fn();
    } finally {
      console.error = quiet;
    }
  };

  await check("[9] a failed RECONNECT puts the revoked row back, history intact, never deletes it", async () => {
    const first = await service.connectWithRestrictedKey(deps(), actorC, stripeDef, KEY_C);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const id = String((first.body.connection as Record<string, unknown>).id);
    assert.equal((await service.disconnectConnection(deps(), actorC, stripeDef)).status, 200);
    const revoked = (await store.getConnection(db, TENANT_C, id))!;
    const history = await historyCount(id);
    assert.ok(history > 0, "precondition: the connection has health history");
    await failCredentialWrites();
    let again: Awaited<ReturnType<typeof service.connectWithRestrictedKey>>;
    try {
      again = await quietErrors(() => service.connectWithRestrictedKey(deps(), actorC, stripeDef, KEY_C));
    } finally {
      await restoreCredentialWrites();
    }
    assert.deepEqual([again.status, again.body.error], [500, "credential_save_failed"]);
    const back = await store.getConnection(db, TENANT_C, id);
    assert.ok(back, "the reactivated row with history was deleted");
    assert.deepEqual([back!.status, back!.revoked_at], [revoked.status, revoked.revoked_at], "the row is not revoked exactly as the disconnect left it");
    assert.equal(await historyCount(id), history, "health history was lost");
  });

  await check("[8] when the undo itself fails (throws, or deletes nothing), the claim is marked error, never left pending", async () => {
    // A different account each round: reconnecting a revoked account is the
    // restore path ([9]), not the brand-new-claim delete this case is about.
    for (const [label, trigger, key] of [
      ["throws", "CREATE TRIGGER test_block_delete BEFORE DELETE ON tenant_connections BEGIN SELECT RAISE(ABORT, 'forced delete failure'); END", KEY_C_ECHO],
      ["deletes nothing", "CREATE TRIGGER test_block_delete BEFORE DELETE ON tenant_connections BEGIN SELECT RAISE(IGNORE); END", KEY_C_FOX],
    ] as const) {
      await failCredentialWrites();
      await db.execute(trigger);
      let r: Awaited<ReturnType<typeof service.connectWithRestrictedKey>>;
      try {
        r = await quietErrors(() => service.connectWithRestrictedKey(deps(), actorC, stripeDef, key));
      } finally {
        await db.execute("DROP TRIGGER IF EXISTS test_block_delete");
        await restoreCredentialWrites();
      }
      assert.deepEqual([r.status, r.body.error], [500, "credential_save_failed"], label);
      const rows = (await connectionRows(TENANT_C)).filter((row) => row.provider === "stripe" && row.revoked_at === null);
      assert.equal(rows.filter((row) => row.status === "pending").length, 0, `${label}: a pending orphan was left behind`);
      assert.equal(rows.filter((row) => row.status === "error").length, 1, `${label}: the failed claim is not marked error`);
      // The owner clears it from its card; the next case starts clean.
      assert.equal((await service.disconnectConnection(deps(), actorC, stripeDef)).status, 200);
    }
  });

  await check("[10] a probe that finishes after a disconnect writes no history and reports no flip", async () => {
    const claim = await store.claimConnection(db, {
      tenantId: TENANT_C,
      provider: "calendly",
      authKind: "oauth2",
      scopeKind: "tenant",
      userId: null,
      externalAccountId: "calendly-charlie",
      externalAccountLabel: "Charlie calendar",
      environment: null,
      grantedScopes: [],
      scopeSetVersion: 1,
      connectedBy: actorC.userId,
      now: new Date(),
    });
    assert.ok(claim.ok);
    const id = claim.connection.id;
    // The disconnect lands between the probe's read and its write.
    const racing = withBatchHook(async () => {
      await db.execute({
        sql: "UPDATE tenant_connections SET status = 'revoked', revoked_at = ?, updated_at = ? WHERE id = ? AND tenant_id = ?",
        args: [new Date().toISOString(), new Date().toISOString(), id, TENANT_C],
      });
    });
    const rec = await store.recordHealthCheck(racing as unknown as typeof db, {
      tenantId: TENANT_C,
      connectionId: id,
      source: "cron",
      verdict: "healthy",
      code: null,
      detail: null,
      latencyMs: 5,
      now: new Date(),
    });
    assert.deepEqual([rec.recorded, rec.flipped, rec.worsened], [false, false, false]);
    assert.equal(rec.connection.status, "revoked");
    assert.equal(await historyCount(id), 0, "a history row was written for a revoked connection");
  });

  // ── 13. Popup and cron registration ──────────────────────────────────────

  await check("popup result: an attacker's reason cannot break out of the script", async () => {
    const res = popup.connectionPopupResult({
      provider: "xero",
      status: "error",
      reason: "</script><script>alert(1)</script>",
      origin: "https://oasisai.work",
    });
    const html = await res.text();
    assert.ok(!html.includes("</script><script>alert(1)"), "reason broke out");
    assert.match(res.headers.get("content-security-policy") || "", /script-src 'nonce-/);
    assert.match(html, /"source":"oasis_connection"/);
  });

  await check("connection-health is registered in the Worker table, the registry and the rollback driver", () => {
    const path = "/api/cron/connection-health";
    const entry = CRON_TABLE.find((c) => c.path === path);
    assert.deepEqual(entry, { path, schedule: "*/15 * * * *" });
    const reg = JSON.parse(read("config/cron-registry.json")) as { crons: Array<{ path: string; schedule: string }> };
    assert.deepEqual(reg.crons.find((c) => c.path === path), { path, schedule: "*/15 * * * *" });
    // Inside the driver's 15-minute group, not merely somewhere in the file.
    const driver = read(".github/workflows/cron-driver.yml");
    // The group runs from its case label to the ";;" that closes it. (Ending
    // at the next label broke silently when #467 removed the */30 group:
    // indexOf returned -1 and the "group" became most of the file.)
    const start = driver.indexOf('"*/15 * * * *")');
    assert.ok(start >= 0, "the driver has no */15 group");
    const group = driver.slice(start, driver.indexOf(";;", start));
    assert.match(group, /\/api\/cron\/connection-health/);
  });

  globalThis.fetch = realFetch;
  if (failures > 0) {
    console.log(`os-connections: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log("os-connections: all passed");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
