/**
 * connectors-by-key.test.ts - every app a client connects with a key from its
 * own account (Calendly, Cal.com, Fathom, Fireflies, Zernio, GoHighLevel, n8n,
 * its own mail server), end to end, plus Stripe's and Jev's key Test.
 *
 * WHY. CC, 2026-10-09: "You can't add API keys, which should be the easiest
 * thing ... when you click on that connection, you can attach the required
 * credentials, and then it saves, and those keys are hidden." The failures
 * that matter are quiet ones:
 *   - a card that says "Connected" because a key was saved, not because the
 *     vendor accepted it; or a vendor's refusal shown as a code nobody reads;
 *   - a saved key stored readable, or sent back to the browser in any answer;
 *   - one workspace's Test run with another workspace's key;
 *   - a Test aimed at an address inside a network (n8n, SMTP: owner-typed hosts);
 *   - Jev's TypeSafe key refused in the browser by Stripe's key rule.
 *
 * Real routes, real signed session, real store and encryption on a local
 * libSQL file. Every vendor is mocked at the fetch boundary; any other host
 * fails the test, so nothing reaches a real provider.
 *
 * Run: node --conditions=react-server --import tsx tests/connectors-by-key.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createClient } from "@libsql/client";

const dbFile = join(mkdtempSync(join(tmpdir(), "connectors-by-key-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
process.env.EMPIRE_AUTH_BACKEND = "turso";
process.env.AUTH_SESSION_SECRET = "connectors-by-key-test-session-secret-long-enough-0001";
process.env.BRAVO_FIELD_ENCRYPTION_KEY = "connectors-by-key-test-field-encryption-passphrase";
process.env.PUBLIC_APP_URL = "https://oasisai.work";

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

// -- Tenants and people -------------------------------------------------------

const ALPHA = "a1a1a1a1-0000-4000-8000-0000000000a1";
const BRAVO_CO = "b2b2b2b2-0000-4000-8000-0000000000b2";
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

// -- Vendors, mocked at the fetch boundary -----------------------------------
//
// A credential's own words decide the answer, the same way for every vendor:
//   ...revoked...  -> the vendor refuses it (401, or Fireflies' auth_failed)
//   ...noscope...  -> 403
//   ...busy...     -> 429
//   ...offline...  -> the network fails
//   ...broken...   -> 500
//   anything else  -> accepted, with the account's name

type Call = { host: string; path: string; method: string; credential: string };
const calls: Call[] = [];
const VENDOR_HOSTS = new Set([
  "api.calendly.com",
  "api.cal.com",
  "api.fathom.ai",
  "api.fireflies.ai",
  "zernio.com",
  "services.leadconnectorhq.com",
  "alpha.app.n8n.cloud",
  "ghost.app.n8n.cloud",
  "api.stripe.com",
  "cloudflare-dns.com",
]);

function credentialOf(host: string, headers: Headers): string {
  if (host === "api.fathom.ai") return headers.get("x-api-key") ?? "";
  if (host.endsWith(".app.n8n.cloud")) return headers.get("x-n8n-api-key") ?? "";
  return (headers.get("authorization") ?? "").replace(/^Bearer /, "");
}

// -- DNS, mocked at the same boundary (DNS over HTTPS) ---------------------------
//
// Public answers use 93.184.216.34 / 2606:2800:220:1::1; the hostile ones point
// inside a network, partly or wholly, or change between lookups (rebinding).
const PUBLIC_V4 = "93.184.216.34";
const DNS: Record<string, { A?: string[]; AAAA?: string[]; nx?: boolean }> = {
  "alpha.app.n8n.cloud": { A: [PUBLIC_V4] },
  "ghost.app.n8n.cloud": { A: [PUBLIC_V4] },
  "automations.alpha.test": { A: [PUBLIC_V4], AAAA: ["2606:2800:220:1::1"] },
  "smtp.alpha.test": { A: [PUBLIC_V4] },
  "evil.alpha.test": { A: ["10.0.0.5"] },
  "loop.alpha.test": { A: ["127.0.0.1"] },
  "meta.alpha.test": { A: ["169.254.169.254"] },
  "mixed.alpha.test": { A: [PUBLIC_V4, "192.168.1.20"] },
  "mapped.alpha.test": { A: [PUBLIC_V4], AAAA: ["::ffff:10.1.2.3"] },
  "ula.alpha.test": { AAAA: ["fd00::1"] },
  "smtp.office365.com": { A: [PUBLIC_V4] },
  "nowhere.alpha.test": { nx: true },
};
/** rebind.alpha.test answers a public address the first time it is asked, then a private one. */
const rebindAsked = { A: 0, AAAA: 0 };
let dnsLookups = 0;

function dnsAnswer(url: URL): Response {
  dnsLookups += 1;
  const name = url.searchParams.get("name") ?? "";
  const type = url.searchParams.get("type") === "AAAA" ? "AAAA" : "A";
  const code = type === "A" ? 1 : 28;
  let entry = DNS[name];
  if (name === "rebind.alpha.test") {
    rebindAsked[type] += 1;
    entry = rebindAsked[type] === 1 ? { A: [PUBLIC_V4] } : { A: ["127.0.0.1"] };
  }
  if (!entry || entry.nx) return json(200, { Status: 3, Answer: [] });
  return json(200, { Status: 0, Answer: (entry[type] ?? []).map((data) => ({ name, type: code, data })) });
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(href);
  if (!VENDOR_HOSTS.has(url.hostname)) throw new Error(`unexpected network call in test: ${href}`);
  if (url.hostname === "cloudflare-dns.com") return dnsAnswer(url);
  const headers = new Headers(init?.headers);
  const credential = credentialOf(url.hostname, headers);
  calls.push({ host: url.hostname, path: url.pathname + url.search, method: (init?.method || "GET").toUpperCase(), credential });
  if (url.hostname === "api.stripe.com") {
    return json(401, { error: { type: "invalid_request_error", message: "Invalid API Key provided" } });
  }
  // Every key-app Test must refuse to follow a redirect to somewhere else.
  assert.equal(init?.redirect, "manual", `${url.hostname}: a Test must never follow a redirect`);
  if (credential.includes("offline")) throw new TypeError("fetch failed");
  if (url.hostname === "api.fireflies.ai") {
    assert.equal(init?.method, "POST");
    const q = JSON.parse(String(init?.body ?? "{}")) as { query?: string };
    assert.match(q.query ?? "", /user\s*\{/, "Fireflies is asked only who the key belongs to");
    if (credential.includes("revoked")) return json(200, { errors: [{ message: "Invalid API key", extensions: { code: "auth_failed" } }] });
    if (credential.includes("paid")) return json(403, { errors: [{ message: "Upgrade", extensions: { code: "paid_required" } }] });
  }
  if (credential.includes("revoked")) return json(401, { message: "Unauthenticated" });
  if (credential.includes("noscope")) return json(403, { message: "Forbidden" });
  if (credential.includes("busy")) return json(429, { message: "Too many requests" });
  if (credential.includes("broken")) return json(500, { message: "Server error" });
  switch (url.hostname) {
    case "api.calendly.com":
      assert.equal(url.pathname, "/users/me");
      return json(200, { resource: { name: "Alpha Plumbing", email: "owner@alpha.test", uri: "https://api.calendly.com/users/X" } });
    case "api.cal.com":
      assert.equal(url.pathname, "/v2/me");
      return json(200, { status: "success", data: { id: 7, email: "owner@alpha.test", username: "alpha", name: "Alpha Plumbing" } });
    case "api.fathom.ai":
      assert.equal(url.pathname, "/external/v1/meetings");
      return json(200, { items: [], limit: 10, next_cursor: null });
    case "api.fireflies.ai":
      return json(200, { data: { user: { name: "Alpha Plumbing", email: "owner@alpha.test" } } });
    case "zernio.com":
      assert.equal(url.pathname, "/api/v1/profiles");
      return json(200, { profiles: [{ _id: "p1", name: "Main", isDefault: true }, { _id: "p2", name: "Second" }] });
    case "services.leadconnectorhq.com": {
      assert.equal(headers.get("version"), "2021-07-28", "GoHighLevel needs its API version header");
      const id = decodeURIComponent(url.pathname.replace(/^\/locations\//, ""));
      if (id === "loc-missing") return json(404, { message: "Location not found" });
      return json(200, { location: { id, name: "Alpha Plumbing HQ", email: "owner@alpha.test" } });
    }
    case "alpha.app.n8n.cloud":
      assert.equal(url.pathname, "/api/v1/workflows");
      assert.equal(url.searchParams.get("limit"), "1", "n8n is asked for one workflow, never more");
      return json(200, { data: [{ id: "1", name: "Lead intake" }], nextCursor: null });
    case "ghost.app.n8n.cloud":
      return json(404, { message: "not found" });
  }
  throw new Error(`unhandled ${href}`);
}) as typeof fetch;

// -- Harness ------------------------------------------------------------------

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

/** Each app, its card, the values a working setup saves, and the account name its Test reports. */
type App = { slug: string; service: string; good: Record<string, string>; secretField: string; passDetail: RegExp };
const APPS: App[] = [
  { slug: "calendly", service: "calendly", good: { access_token: "eyJcalendly-alpha-token-0001" }, secretField: "access_token", passDetail: /Calendly account: Alpha Plumbing \(owner@alpha\.test\)/ },
  { slug: "cal-com", service: "cal_com", good: { api_key: "cal_live_alpha0000000000000001" }, secretField: "api_key", passDetail: /Cal\.com account: Alpha Plumbing/ },
  { slug: "fathom", service: "fathom", good: { api_key: "fathom-alpha-key-0000000001" }, secretField: "api_key", passDetail: /Fathom accepted the key/ },
  { slug: "fireflies", service: "fireflies", good: { api_key: "ff-alpha-key-00000000000001" }, secretField: "api_key", passDetail: /Fireflies account: Alpha Plumbing/ },
  { slug: "zernio", service: "late", good: { api_key: "sk_alpha000000000000000000000001" }, secretField: "api_key", passDetail: /2 profiles/ },
  { slug: "gohighlevel", service: "gohighlevel", good: { private_token: "pit-alpha-0000000000000001", location_id: "loc-alpha-1" }, secretField: "private_token", passDetail: /sub-account: Alpha Plumbing HQ/ },
  { slug: "n8n", service: "n8n", good: { base_url: "https://alpha.app.n8n.cloud", api_key: "n8n-alpha-key-00000000001" }, secretField: "api_key", passDetail: /n8n accepted the key/ },
];

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
  const checkRoute = await import("../app/api/connections/[provider]/check/route");
  const { loadWorkspaceConnectorStatus } = await import("../components/os/connections/connector-facts");
  const connectors = await import("../lib/os/connectors");
  const schemas = await import("../lib/tenant-integration-schemas");
  const probes = await import("../lib/integrations/key-probes");
  const { testResultNotice } = await import("../components/os/connections/test-notice");
  const { clientKeyCheck } = await import("../components/os/connections/key-rules");
  const { decryptField } = await import("../lib/field-encryption");

  type Res = { status: number; body: Record<string, unknown>; text: string };
  const toRes = async (r: Response): Promise<Res> => {
    const text = await r.text();
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      /* not JSON */
    }
    return { status: r.status, body, text };
  };
  const jsonReq = (url: string, method: string, body?: unknown) =>
    new NextRequest(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const save = async (service: string, field_key: string, value: string) =>
    toRes(await keysRoute.POST(jsonReq("https://oasisai.work/api/integrations/keys", "POST", { service, field_key, value })));
  const saveAll = async (service: string, values: Record<string, string>) => {
    for (const [k, v] of Object.entries(values)) {
      const r = await save(service, k, v);
      assert.equal(r.status, 200, `${service}.${k} did not save: ${r.text}`);
    }
  };
  const runTest = async (service: string) =>
    toRes(await testRoute.POST(jsonReq("https://oasisai.work/api/integrations/keys/test", "POST", { service })));
  const listKeys = async () => toRes(await keysRoute.GET());
  const card = async (tenantId: string, slug: string) => (await loadWorkspaceConnectorStatus(tenantId, slug))!;
  const words = (slug: string, code: string) => {
    const src = connectors.connectorBySlug(slug)!.live!.source;
    assert.equal(src.kind, "tenant_keys");
    return (src as { failureStates: Record<string, { label: string; kind: string }> }).failureStates[code];
  };
  const checkStripe = async (key: string) =>
    toRes(await checkRoute.POST(
      jsonReq("https://oasisai.work/api/connections/stripe/check", "POST", { key }),
      { params: Promise.resolve({ provider: "stripe" }) },
    ));

  console.log("connectors-by-key:");

  // -- 1. Every app is a live card with a real Test -----------------------------

  await check("every key app is live on the key store, with a schema, a Test and a link to where the key is made", () => {
    for (const app of [...APPS, { slug: "smtp", service: "smtp" }]) {
      const def = connectors.connectorBySlug(app.slug)!;
      assert.ok(def, `${app.slug} is in the catalog`);
      assert.ok(def.live, `${app.slug} is live, not "Not built yet"`);
      assert.equal(def.live!.connect.kind, "keys");
      assert.equal(def.live!.source.kind, "tenant_keys");
      const src = def.live!.source as { service: string; verifiable: boolean; requireAll: readonly string[]; failureStates?: object };
      assert.equal(src.service, app.service);
      assert.equal(src.verifiable, true, `${app.slug}: its Test calls the vendor, so a pass can prove the key`);
      assert.ok(src.failureStates, `${app.slug}: a failed Test has plain words`);
      const schema = schemas.findTenantManuallyEditableIntegrationSchema(app.service)!;
      assert.ok(schema, `${app.slug}: an owner can save its keys`);
      assert.deepEqual([...src.requireAll].sort(), schemas.requiredIntegrationFieldKeys(schema).sort(), `${app.slug}: the card needs exactly the fields the form requires`);
      assert.ok(probes.hasKeyProbe(app.service), `${app.slug}: a live Test exists`);
      for (const f of schema.fields) assert.ok(f.hint?.trim(), `${app.slug}.${f.key}: every field says where its value comes from`);
      if (app.slug !== "smtp") assert.match(schema.getKey?.href ?? "", /^https:\/\//, `${app.slug}: a link to where the key is made`);
    }
    // Every schema cites the vendor doc it was built from.
    const src = read("lib/tenant-integration-schemas.ts");
    for (const host of ["developer.calendly.com", "cal.com/docs", "developers.fathom.ai", "docs.fireflies.ai", "docs.zernio.com", "marketplace.gohighlevel.com/docs", "docs.n8n.io"]) {
      assert.ok(src.includes(host), `the schemas cite ${host}`);
    }
    // The form links to it and asks for what the schema requires, not every field.
    const form = read("components/os/connections/ServiceKeysForm.tsx");
    assert.match(form, /schema\.getKey && \(/);
    assert.match(form, /requiredIntegrationFieldKeys\(schema\)\.every\(has\)/);
  });

  // -- 2. Saving: validated, encrypted at rest, admins only ---------------------

  await check("a member cannot save a key; an owner can, and the stored value is ciphertext", async () => {
    await login(USERS.memberA);
    assert.equal((await save("calendly", "access_token", APPS[0].good.access_token)).status, 403);
    await login(USERS.ownerA);
    for (const app of APPS) await saveAll(app.service, app.good);
    const rows = await db.execute({ sql: "SELECT service, field_key, encrypted_value FROM tenant_integration_credentials WHERE tenant_id = ?", args: [ALPHA] });
    assert.ok(rows.rows.length >= APPS.length);
    for (const app of APPS) {
      const plain = app.good[app.secretField];
      const row = rows.rows.find((r) => r.service === app.service && r.field_key === app.secretField);
      assert.ok(row, `${app.slug} saved`);
      const stored = String(row!.encrypted_value);
      assert.ok(!stored.includes(plain), `${app.slug}: the key is not stored readable`);
      assert.equal(decryptField(stored), plain, `${app.slug}: it decrypts to what was pasted`);
    }
  });

  await check("bad values are refused before anything is saved, with a sentence an owner can act on", async () => {
    await login(USERS.ownerA);
    const refused: [string, string, string][] = [
      ["calendly", "access_token", "has a space in it"],
      ["n8n", "base_url", "http://automations.alpha.test"],
      ["n8n", "base_url", "https://10.0.0.5"],
      ["n8n", "base_url", "https://127.0.0.1:5678"],
      ["n8n", "base_url", "https://n8n.internal"],
      ["n8n", "base_url", "https://localhost"],
      ["n8n", "base_url", "https://user:pw@automations.alpha.test"],
      ["smtp", "host", "192.168.1.10"],
      ["smtp", "host", "mail.corp"],
      ["smtp", "host", "[::1]"],
      ["smtp", "port", "22"],
      ["smtp", "from_address", "not-an-email"],
    ];
    for (const [service, field_key, value] of refused) {
      const r = await save(service, field_key, value);
      assert.equal(r.status, 422, `${service}.${field_key}=${value} must be refused, got ${r.status}`);
      assert.ok(typeof r.body.error === "string" && /[a-z] [a-z]/i.test(r.body.error), `${service}.${field_key}: the refusal is a sentence`);
    }
    for (const [field, value] of [["host", "smtp.office365.com"], ["port", "587"], ["port", "465"], ["port", "2525"]] as const) {
      const f = schemas.findIntegrationSchema("smtp")!.fields.find((x) => x.key === field)!;
      assert.equal(schemas.validateIntegrationValue(f, value), null, `smtp.${field}=${value} is accepted`);
    }
    const n8nUrl = schemas.findIntegrationSchema("n8n")!.fields.find((f) => f.key === "base_url")!;
    assert.equal(schemas.validateIntegrationValue(n8nUrl, "https://yourname.app.n8n.cloud"), null);
    assert.equal(schemas.validateIntegrationValue(n8nUrl, "https://n8n.example.com/"), null);
  });

  // -- 3. Never back to the browser -------------------------------------------

  await check("no answer ever carries a saved key: the list, a Test, a failed Test", async () => {
    await login(USERS.ownerA);
    const secrets = APPS.map((a) => a.good[a.secretField]);
    const list = await listKeys();
    assert.equal(list.status, 200);
    for (const s of secrets) assert.ok(!list.text.includes(s), "the key list never holds a value");
    assert.doesNotMatch(list.text, /encrypted_value/);
    for (const app of APPS) {
      const t = await runTest(app.service);
      for (const s of secrets) assert.ok(!t.text.includes(s), `${app.slug}: its Test answer never holds a key`);
    }
  });

  // -- 4. Test: a pass is green, with the account's name ------------------------

  await check("a passing Test turns each card green and names the account", async () => {
    await login(USERS.ownerA);
    for (const app of APPS) {
      // Re-saving clears the earlier Test (section 3 ran them), so the card starts untested.
      await saveAll(app.service, { [app.secretField]: app.good[app.secretField] });
      const before = await card(ALPHA, app.slug);
      assert.equal(before.kind, "configured", `${app.slug}: saved but not tested is never green (${before.label})`);
      const t = await runTest(app.service);
      assert.equal(t.status, 200);
      assert.equal(t.body.ok, true, `${app.slug}: ${t.text}`);
      assert.match(String(t.body.detail), app.passDetail);
      const after = await card(ALPHA, app.slug);
      assert.equal(after.kind, "connected", `${app.slug}: ${after.label}`);
      assert.match(after.label, /^Connected · verified/);
      const notice = testResultNotice({ service: app.service, appName: connectors.connectorBySlug(app.slug)!.name, ok: true, data: t.body, requestFailure: "x" });
      assert.equal(notice.tone, "ok");
      assert.match(notice.text, app.passDetail, `${app.slug}: the form says which account passed`);
    }
  });

  // -- 5. Test: every failure in plain words ------------------------------------

  const FAILURES: [string, string, RegExp][] = [
    ["revoked", "key_rejected", /refused the/],
    ["noscope", "missing_permission", /lacks access/],
    ["busy", "rate_limited", /asked OASIS to wait/],
    ["offline", "provider_unreachable", /did not answer the last Test/],
    ["broken", "provider_error", /unexpected answer/],
  ];
  await check("each vendor refusal is stored as one code and shown in the card's own words", async () => {
    await login(USERS.ownerA);
    for (const app of APPS) {
      for (const [marker, code, label] of FAILURES) {
        await save(app.service, app.secretField, `${app.good[app.secretField]}-${marker}`);
        const changed = await card(ALPHA, app.slug);
        assert.equal(changed.kind, "configured", `${app.slug}: a new key is not tested yet, never still green`);
        const t = await runTest(app.service);
        assert.equal(t.body.ok, false, `${app.slug}/${marker}`);
        assert.equal(String(t.body.error).split(":")[0], code, `${app.slug}/${marker}: ${t.text}`);
        const c = await card(ALPHA, app.slug);
        assert.match(c.label, label, `${app.slug}/${marker}: card said "${c.label}"`);
        assert.equal(c.kind, words(app.slug, code).kind);
        assert.notEqual(c.kind, "connected");
        const notice = testResultNotice({ service: app.service, appName: connectors.connectorBySlug(app.slug)!.name, ok: false, data: t.body, requestFailure: "x" });
        assert.equal(notice.tone, "err");
        assert.doesNotMatch(notice.text, /key_rejected|missing_permission|rate_limited|provider_/, `${app.slug}: no code reaches the owner`);
      }
      await saveAll(app.service, { [app.secretField]: app.good[app.secretField] });
    }
  });

  await check("vendor-specific answers: Fireflies' auth_failed on a 200, its paid plan, GoHighLevel's unknown sub-account, n8n's wrong address", async () => {
    await login(USERS.ownerA);
    await save("fireflies", "api_key", "ff-alpha-key-revoked-0001");
    let t = await runTest("fireflies");
    assert.equal(t.body.error, "key_rejected", "a GraphQL refusal on HTTP 200 is still a refusal");
    assert.equal((await card(ALPHA, "fireflies")).kind, "attention");
    await save("fireflies", "api_key", "ff-alpha-key-paid-00001");
    t = await runTest("fireflies");
    assert.equal(t.body.error, "plan_required");
    assert.match((await card(ALPHA, "fireflies")).label, /plan has no API access/);
    await saveAll("fireflies", APPS[3].good);

    await save("gohighlevel", "location_id", "loc-missing");
    t = await runTest("gohighlevel");
    assert.equal(t.body.error, "not_found");
    assert.equal((await card(ALPHA, "gohighlevel")).label, "Not found");
    await saveAll("gohighlevel", APPS[5].good);

    await save("n8n", "base_url", "https://ghost.app.n8n.cloud");
    t = await runTest("n8n");
    assert.equal(t.body.error, "not_found");
    assert.match((await card(ALPHA, "n8n")).detail ?? "", /no n8n API at this address/);
    await saveAll("n8n", APPS[6].good);
  });

  await check("a missing required value is said as missing and calls no vendor", async () => {
    await login(USERS.ownerA);
    const before = calls.length;
    const del = await toRes(await keysRoute.DELETE(jsonReq("https://oasisai.work/api/integrations/keys", "DELETE", { service: "gohighlevel", field_key: "location_id" })));
    assert.equal(del.status, 200);
    const t = await runTest("gohighlevel");
    assert.equal(t.body.ok, false);
    assert.match(String(t.body.error), /^missing_fields: location_id/);
    assert.equal(calls.length, before, "nothing is sent with half a setup");
    assert.equal((await card(ALPHA, "gohighlevel")).kind, "attention");
    await saveAll("gohighlevel", APPS[5].good);
  });

  // -- 6. Self-hosted addresses: never inside a network -------------------------

  await check("n8n and SMTP Tests never connect to an internal address, even one saved before the rule", async () => {
    await login(USERS.ownerA);
    // Planted straight into the store (the save route refuses these).
    const { setTenantIntegrationValue } = await import("../lib/tenant-integration-store");
    const before = calls.length;
    for (const host of ["https://169.254.169.254", "https://10.1.2.3", "https://localhost", "https://n8n.internal", "http://automations.alpha.test"]) {
      await setTenantIntegrationValue({ tenantId: ALPHA, service: "n8n", fieldKey: "base_url", value: host });
      const t = await runTest("n8n");
      assert.equal(t.body.error, "blocked_host", `${host} is never called`);
    }
    assert.equal(calls.length, before, "no request left OASIS for any of them");
    assert.equal((await card(ALPHA, "n8n")).label, "Address not allowed");
    await saveAll("n8n", APPS[6].good);

    let verified = 0;
    const smtpVerify = async () => {
      verified += 1;
    };
    for (const [host, port] of [["192.168.0.2", "587"], ["localhost", "587"], ["mail.internal", "587"], ["smtp.alpha.test", "22"], ["smtp.alpha.test", "3306"]]) {
      const r = await probes.runKeyProbe("smtp", { host, port, user: "u", password: "p", from_address: "a@alpha.test" }, { smtpVerify });
      assert.equal(r.error, "blocked_host", `${host}:${port}`);
    }
    assert.equal(verified, 0, "no sign-in was attempted");
  });

  await check("SMTP: a sign-in that works, a refused password, a server that does not answer; TLS on 465, STARTTLS required elsewhere", async () => {
    const seen: { host: string; port: number; secure: boolean }[] = [];
    const ok = await probes.runKeyProbe(
      "smtp",
      { host: "smtp.alpha.test", port: "465", user: "owner@alpha.test", password: "pw-secret-0001", from_address: "owner@alpha.test" },
      { smtpVerify: async (i) => void seen.push({ host: i.host, port: i.port, secure: i.secure }) },
    );
    assert.equal(ok.ok, true);
    assert.match(ok.detail ?? "", /Signed in to smtp\.alpha\.test as owner@alpha\.test/);
    assert.ok(!(ok.detail ?? "").includes("pw-secret-0001"));
    await probes.runKeyProbe("smtp", { host: "smtp.alpha.test", port: "587", user: "u", password: "p", from_address: "a@alpha.test" }, {
      smtpVerify: async (i) => void seen.push({ host: i.host, port: i.port, secure: i.secure }),
    });
    assert.deepEqual(seen, [{ host: "smtp.alpha.test", port: 465, secure: true }, { host: "smtp.alpha.test", port: 587, secure: false }]);
    // The real sign-in demands TLS whenever it is not already on (no password in the clear).
    assert.match(read("lib/integrations/key-probes.ts"), /requireTLS: !secure/);
    const refused = await probes.runKeyProbe("smtp", { host: "smtp.alpha.test", port: "587", user: "u", password: "p", from_address: "a@alpha.test" }, {
      smtpVerify: async () => {
        throw Object.assign(new Error("Invalid login"), { code: "EAUTH" });
      },
    });
    assert.equal(refused.error, "smtp_auth_failed");
    const down = await probes.runKeyProbe("smtp", { host: "smtp.alpha.test", port: "587", user: "u", password: "p", from_address: "a@alpha.test" }, {
      smtpVerify: async () => {
        throw Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
      },
    });
    assert.equal(String(down.error).split(":")[0], "provider_unreachable");
    const smtpStates = (connectors.connectorBySlug("smtp")!.live!.source as { failureStates: Record<string, { label: string }> }).failureStates;
    assert.match(smtpStates.smtp_auth_failed.label, /Could not sign in/);
    assert.match(smtpStates.provider_unreachable.label, /Could not reach/);
    assert.match(smtpStates.blocked_host.label, /not allowed/);
  });

  // -- 6b. What a name RESOLVES to (Codex review, 2026-10-09) ---------------------

  const hostSafety = await import("../lib/integrations/host-safety");

  await check("every private, loopback, link-local, multicast, unspecified and reserved address is refused, IPv4 and IPv6, mapped forms included", () => {
    const blocked = [
      "0.0.0.0", "10.1.2.3", "100.64.0.1", "127.0.0.1", "127.255.255.254", "169.254.169.254", "172.16.0.1", "172.31.255.255",
      "192.0.0.8", "192.0.2.1", "192.88.99.1", "192.168.1.1", "198.18.0.1", "198.51.100.7", "203.0.113.9", "224.0.0.1", "239.1.1.1",
      "240.0.0.1", "255.255.255.255",
      "::", "::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:7f00:1", "::10.0.0.1", "64:ff9b::a00:1", "2002:c0a8:101::1",
      "fc00::1", "fd12:3456::1", "fe80::1", "fec0::1", "ff02::1", "100::1", "2001::1", "2001:db8::1", "[::1]",
      "not-an-ip", "", "1.2.3", "300.1.1.1",
    ];
    for (const ip of blocked) assert.equal(hostSafety.isBlockedAddress(ip), true, `${ip} must be refused`);
    for (const ip of ["93.184.216.34", "8.8.8.8", "172.32.0.1", "100.128.0.1", "2606:2800:220:1::1", "2a00:1450:4001::200e", "::ffff:93.184.216.34", "2002:5db8:d822::1"]) {
      assert.equal(hostSafety.isBlockedAddress(ip), false, `${ip} is public`);
    }
  });

  await check("a public-looking name that resolves (wholly or partly) inside a network is refused at save, and nothing is saved", async () => {
    await login(USERS.ownerA);
    for (const name of ["evil.alpha.test", "loop.alpha.test", "meta.alpha.test", "mixed.alpha.test", "mapped.alpha.test", "ula.alpha.test", "nowhere.alpha.test"]) {
      const n8n = await save("n8n", "base_url", `https://${name}`);
      assert.equal(n8n.status, 422, `n8n ${name}: ${n8n.text}`);
      assert.match(String(n8n.body.error), name === "nowhere.alpha.test" ? /could not find that address/ : /points inside a private network/);
      const smtp = await save("smtp", "host", name);
      assert.equal(smtp.status, 422, `smtp ${name}: ${smtp.text}`);
    }
    const rows = await db.execute({ sql: "SELECT field_key, encrypted_value FROM tenant_integration_credentials WHERE tenant_id = ? AND service IN ('n8n','smtp') AND field_key IN ('base_url','host')", args: [ALPHA] });
    for (const r of rows.rows) {
      const v = decryptField(String(r.encrypted_value));
      assert.ok(!/evil|loop|meta|mixed|mapped|ula|nowhere/.test(v), `${v} must not have been saved`);
    }
  });

  await check("every Test resolves again: a name that answered a public address at save and a private one now is refused, and nothing is sent", async () => {
    await login(USERS.ownerA);
    const saved = await save("n8n", "base_url", "https://rebind.alpha.test");
    assert.equal(saved.status, 200, `the first answer was public: ${saved.text}`);
    const before = calls.length;
    const t = await runTest("n8n");
    assert.equal(t.body.error, "blocked_host", t.text);
    assert.equal(calls.length, before, "no request was made to the re-pointed name");
    await saveAll("n8n", APPS[6].good);
  });

  await check("a self-hosted address is reached at the ONE address that was checked (pinned), with the name kept for SNI, Host and the certificate; DNS is never asked again", async () => {
    let lookups = 0;
    // Rebinding: the first answer is public, every later answer is loopback.
    const resolve: import("../lib/integrations/host-safety").Resolver = async (_name, type) => {
      lookups += 1;
      if (type === "AAAA") return [];
      return lookups <= 2 ? [PUBLIC_V4] : ["127.0.0.1"];
    };
    const got: { ip: string; hostname: string; path: string; headers: Record<string, string> }[] = [];
    const before = calls.length;
    const r = await probes.runKeyProbe(
      "n8n",
      { base_url: "https://automations.alpha.test", api_key: "n8n-self-hosted-key-0001" },
      {
        runtime: "node",
        resolve,
        pinnedHttpsGet: async (i) => {
          got.push({ ip: i.ip, hostname: i.hostname, path: i.path, headers: i.headers });
          return { status: 200, body: JSON.stringify({ data: [] }) };
        },
      },
    );
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(lookups, 2, "one A and one AAAA lookup per Test, none at connect time");
    assert.deepEqual(got.map((g) => [g.ip, g.hostname, g.path]), [[PUBLIC_V4, "automations.alpha.test", "/api/v1/workflows?limit=1"]]);
    assert.equal(got[0].headers["X-N8N-API-KEY"], "n8n-self-hosted-key-0001");
    assert.equal(calls.length, before, "no fetch by name for a self-hosted address");
    // The real pinned client connects to the address with the name as SNI and Host.
    const src = read("lib/integrations/key-probes.ts");
    assert.match(src, /https\.request\(\s*\{ host: ip, port: 443, servername: hostname, method: "GET", path, headers: \{ \.\.\.headers, Host: hostname \}/);
    assert.match(src, /host: connectHost,[\s\S]{0,300}tls: \{ servername: host \}/, "SMTP connects to the checked address and verifies the saved name");
    // One total deadline (the request's own `timeout` is only an idle limit),
    // and an answer past 1 MB ends the request instead of being read on (CodeRabbit #563).
    assert.match(src, /deadline = setTimeout\(\(\) => req\.destroy\(/);
    assert.match(src, /if \(size > 1_000_000\) \{\s*req\.destroy\(/);

    // SMTP: the sign-in goes to the checked address.
    const seen: { host: string; connectHost: string }[] = [];
    const s = await probes.runKeyProbe(
      "smtp",
      { host: "smtp.alpha.test", port: "587", user: "u@alpha.test", password: "pw-0001", from_address: "u@alpha.test" },
      { runtime: "node", smtpVerify: async (i) => void seen.push({ host: i.host, connectHost: i.connectHost }) },
    );
    assert.equal(s.ok, true);
    assert.deepEqual(seen, [{ host: "smtp.alpha.test", connectHost: PUBLIC_V4 }]);
  });

  await check("where a connection cannot be pinned (the Worker), a self-hosted address is refused and nothing is sent; a vendor's own host still tests by name", async () => {
    let pinned = 0;
    let signedIn: string[] = [];
    const before = calls.length;
    const n8n = await probes.runKeyProbe(
      "n8n",
      { base_url: "https://automations.alpha.test", api_key: "n8n-self-hosted-key-0001" },
      { runtime: "workers", pinnedHttpsGet: async () => ((pinned += 1), { status: 200, body: "{}" }) },
    );
    assert.equal(n8n.error, "cannot_pin");
    const smtp = await probes.runKeyProbe(
      "smtp",
      { host: "smtp.alpha.test", port: "587", user: "u", password: "p", from_address: "u@alpha.test" },
      { runtime: "workers", smtpVerify: async (i) => void signedIn.push(i.connectHost) },
    );
    assert.equal(smtp.error, "cannot_pin");
    assert.equal(pinned + signedIn.length, 0, "nothing was connected to");
    assert.equal(calls.length, before);
    // n8n Cloud and a big provider's SMTP name: only the vendor controls their DNS.
    const cloud = await probes.runKeyProbe("n8n", { base_url: "https://alpha.app.n8n.cloud", api_key: "n8n-alpha-key-00000000001" }, { runtime: "workers" });
    assert.equal(cloud.ok, true, JSON.stringify(cloud));
    signedIn = [];
    const o365 = await probes.runKeyProbe(
      "smtp",
      { host: "smtp.office365.com", port: "587", user: "u@alpha.test", password: "p", from_address: "u@alpha.test" },
      { runtime: "workers", smtpVerify: async (i) => void signedIn.push(i.connectHost) },
    );
    assert.equal(o365.ok, true);
    assert.deepEqual(signedIn, ["smtp.office365.com"]);
    // Even a vendor's host is resolved and refused if it pointed inside a network.
    const cloudEvil = await probes.runKeyProbe("n8n", { base_url: "https://alpha.app.n8n.cloud", api_key: "k-00000000" }, {
      runtime: "workers",
      resolve: async (_n, t) => (t === "A" ? ["10.0.0.9"] : []),
    });
    assert.equal(cloudEvil.error, "blocked_host");
    // The card says it in words.
    const words = (connectors.connectorBySlug("n8n")!.live!.source as { failureStates: Record<string, { label: string; kind: string }> }).failureStates.cannot_pin;
    assert.equal(words.kind, "configured");
    assert.match(words.label, /can't be tested from OASIS yet/);
    assert.equal(hostSafety.connectPlan("n8n", "automations.alpha.test", "workers"), "refuse");
    assert.equal(hostSafety.connectPlan("n8n", "automations.alpha.test", "node"), "pinned");
    assert.equal(hostSafety.connectPlan("n8n", "x.app.n8n.cloud.evil.test", "workers"), "refuse", "a look-alike suffix is not n8n's");
  });

  // -- 6c. Who may run a Test (Codex review, 2026-10-09) ----------------------------

  await check("a member gets 403 for every key-backed service: no credential is read, no vendor or DNS is called, no Test state changes", async () => {
    await login(USERS.ownerA);
    const snapshot = async () =>
      JSON.stringify((await db.execute({ sql: "SELECT service, field_key, last_tested_at, last_test_ok, last_test_error FROM tenant_integration_credentials WHERE tenant_id = ? ORDER BY service, field_key", args: [ALPHA] })).rows);
    const before = await snapshot();
    const callsBefore = calls.length;
    const dnsBefore = dnsLookups;
    await login(USERS.memberA);
    const services = schemas.TENANT_MANUALLY_EDITABLE_INTEGRATION_SCHEMAS.map((s) => s.service);
    assert.ok(services.length >= 12, services.join(","));
    for (const service of services) {
      const t = await runTest(service);
      assert.equal(t.status, 403, `${service}: ${t.text}`);
      assert.equal(t.body.ok, false);
      assert.doesNotMatch(t.text, /Alpha Plumbing|owner@alpha|Signed in|account/i, `${service}: nothing about the account`);
    }
    assert.equal(calls.length, callsBefore, "no vendor was called");
    assert.equal(dnsLookups, dnsBefore, "no DNS lookup was made");
    await login(USERS.ownerA);
    assert.equal(await snapshot(), before, "no Test result changed");
    // The owner still can.
    assert.equal((await runTest("calendly")).status, 200);
  });

  // -- 7. Tenant isolation ------------------------------------------------------

  await check("another workspace never sees, tests with or is shown this workspace's keys", async () => {
    const alphaBefore = await card(ALPHA, "calendly");
    await login(USERS.ownerB);
    const list = await listKeys();
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.rows, [], "Bravo has saved nothing and sees nothing");
    const before = calls.length;
    for (const app of APPS) {
      const t = await runTest(app.service);
      assert.equal(t.body.ok, false);
      assert.match(String(t.body.error), /^missing_fields/, `${app.slug}: Bravo's Test has nothing to send`);
      assert.equal((await card(BRAVO_CO, app.slug)).kind, "not_connected", `${app.slug}: Bravo's card is its own`);
    }
    assert.equal(calls.length, before, "no vendor was called with Alpha's key on Bravo's behalf");
    await saveAll("calendly", { access_token: "eyJcalendly-bravo-token-0002" });
    await runTest("calendly");
    assert.deepEqual(calls.slice(before).map((c) => c.credential), ["eyJcalendly-bravo-token-0002"], "Bravo's own key is the only one used for Bravo");
    assert.equal((await card(BRAVO_CO, "calendly")).kind, "connected");
    assert.deepEqual(await card(ALPHA, "calendly"), alphaBefore, "Alpha's card did not move");
  });

  // -- 8. Stripe and Jev: Test a key without saving it ---------------------------

  await check("Stripe's Test checks a key live and saves nothing; a full secret key is refused before any call", async () => {
    await login(USERS.ownerA);
    const before = calls.length;
    const r = await checkStripe("rk_test_revoked0000000000000000");
    assert.equal(r.status, 200, r.text);
    const result = r.body.check as { passed: boolean; detail: string | null; saved: boolean };
    assert.equal(result.passed, false);
    assert.equal(result.saved, false);
    assert.ok(result.detail && /[a-z] [a-z]/i.test(result.detail), "the refusal is a sentence");
    assert.ok(!r.text.includes("rk_test_revoked0000000000000000"), "the key is never echoed");
    assert.ok(calls.slice(before).some((c) => c.host === "api.stripe.com"), "the key was checked with Stripe");
    const conns = await db.execute({ sql: "SELECT COUNT(*) AS n FROM tenant_connections WHERE tenant_id = ?", args: [ALPHA] });
    assert.equal(Number(conns.rows[0].n), 0, "no connection was created");
    const stored = await db.execute({ sql: "SELECT COUNT(*) AS n FROM tenant_integration_credentials WHERE tenant_id = ? AND service LIKE 'connection:%'", args: [ALPHA] });
    assert.equal(Number(stored.rows[0].n), 0, "no key was stored");
    const before2 = calls.length;
    const sk = await checkStripe("sk_live_abcdefghijklmnop1234");
    assert.equal(sk.status, 422);
    assert.equal(sk.body.error, "secret_key_refused");
    assert.equal(calls.length, before2, "a full secret key is never sent to Stripe");
    await login(USERS.memberA);
    assert.equal((await checkStripe("rk_test_x000000000000000000000")).status, 403, "a member may not test keys for the workspace");
  });

  await check("each pasted-key app is pre-checked in the browser with its OWN rule: a TypeSafe key is not refused as a Stripe key", () => {
    const typesafe = "ts_live_0123456789abcdefghij";
    assert.equal(clientKeyCheck("jev", typesafe).ok, true, "Jev's key passes Jev's rule");
    assert.equal(clientKeyCheck("stripe", typesafe).ok, false, "and would have failed Stripe's");
    assert.equal(clientKeyCheck("stripe", "rk_live_abcdefghijklmnop1234").ok, true);
    const sk = clientKeyCheck("stripe", "sk_live_abcdefghijklmnop1234");
    assert.equal(sk.ok, false);
    assert.equal((sk as { error: string }).error, "secret_key_refused");
    const panel = read("components/os/connections/KeyConnectionPanel.tsx");
    assert.match(panel, /clientKeyCheck\(providerId, key\)/, "the panel checks with the provider's own rule");
    assert.doesNotMatch(panel, /checkStripeRestrictedKey\(key\)/, "never Stripe's rule for every provider");
    assert.match(panel, /\$\{base\}\/check/, "the panel's Test checks without saving");
  });

  console.log(`\n${passed} passed, ${failures} failed`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
