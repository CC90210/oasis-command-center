/**
 * twilio-connection.test.ts - a workspace's OWN Twilio, end to end (W10a).
 *
 * WHY. CC, 2026-10-01: Twilio must work "product-wide", for every client as
 * well as OASIS. The failures that matter are quiet ones:
 *   - a real Account SID pasted from Twilio's console refused by a validation
 *     written for upper-case SIDs, so nobody can save one at all;
 *   - a test that says "failed: missing_sender" to an owner whose account
 *     simply has no number yet, or a card that says "Connected" because keys
 *     were saved;
 *   - one workspace's text verified, sent or reconfigured with another
 *     workspace's credentials (or OASIS's);
 *   - an API key accepted for sending while incoming texts silently fail;
 *   - a send that goes out while the live-send switch is off.
 * Each is invisible until a customer's text goes missing, so each is pinned.
 *
 * Real routes, real signed session, real store and encryption on a local
 * libSQL file. Twilio's REST API is mocked at the fetch boundary (four
 * accounts with their own numbers, keys and messaging services); any other
 * host fails the test. Nothing reaches a real provider.
 *
 * Run: node --conditions=react-server --import tsx tests/twilio-connection.test.ts
 */
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createClient } from "@libsql/client";

const dbFile = join(mkdtempSync(join(tmpdir(), "twilio-connection-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
process.env.EMPIRE_AUTH_BACKEND = "turso";
process.env.AUTH_SESSION_SECRET = "twilio-connection-test-session-secret-long-enough-0001";
process.env.BRAVO_FIELD_ENCRYPTION_KEY = "twilio-connection-test-field-encryption-passphrase";
process.env.PUBLIC_APP_URL = "https://oasisai.work";
// Never let the developer's shell decide the origin, the send gate or whose
// Twilio account a tenant falls back to.
for (const k of [
  "BRAVO_DASHBOARD_URL",
  "OASIS_PUBLIC_ORIGIN",
  "NEXT_PUBLIC_SITE_URL",
  "NEXT_PUBLIC_APP_URL",
  "LIVE_SEND_TWILIO",
  "DASHBOARD_LIVE_SEND",
  "BRAVO_FORCE_DRY_RUN",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_FROM_NUMBER",
  "TWILIO_MESSAGING_SERVICE_SID",
  "TWILIO_TENANT_ID",
]) {
  delete process.env[k];
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
stub("next/navigation", {
  notFound: () => {
    throw new Error("NEXT_HTTP_ERROR_FALLBACK;404");
  },
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT;${url}`);
  },
});

// -- Tenants and people -------------------------------------------------------

const ALPHA = "a1a1a1a1-0000-4000-8000-0000000000a1"; // a number that can text
const BRAVO_CO = "b2b2b2b2-0000-4000-8000-0000000000b2"; // an account with NO number
const CHARLIE = "c3c3c3c3-0000-4000-8000-0000000000c3"; // an API key only
const DELTA = "d4d4d4d4-0000-4000-8000-0000000000d4"; // a messaging service
const ECHO = "e5e5e5e5-0000-4000-8000-0000000000e5"; // nothing saved at all
const OASIS = "ef8d389e-3f15-43f2-ae00-3660f69a1452"; // OASIS's own workspace (env account)

type U = { id: string; email: string };
const u = (n: number, email: string): U => ({ id: `0e000000-0000-4000-8000-${String(n).padStart(12, "0")}`, email });
const USERS = {
  ownerA: u(1, "owner@alpha.test"),
  memberA: u(2, "member@alpha.test"),
  ownerB: u(3, "owner@bravo.test"),
  ownerC: u(4, "owner@charlie.test"),
  ownerD: u(5, "owner@delta.test"),
  ownerE: u(6, "owner@echo.test"),
  oasisOwner: u(7, "founder@oasisai.work"),
} as const;

async function login(user: U | null): Promise<void> {
  if (!user) {
    sessionCookie = undefined;
    return;
  }
  const { signSession } = await import("../lib/turso-auth");
  sessionCookie = signSession({ sub: user.id, email: user.email, exp: Math.floor(Date.now() / 1000) + 3600, ver: 0 });
}

// -- Twilio, mocked at the fetch boundary ------------------------------------

const hex = (seed: string) => createHash("md5").update(seed).digest("hex"); // 32 lower-case hex, like Twilio's
const sid = (prefix: string, seed: string) => `${prefix}${hex(`${prefix}:${seed}`)}`;

type MockNumber = { sid: string; phone: string; sms: boolean; smsUrl: string | null };
type MockService = { sid: string; name: string; senders: string[]; inbound: string | null; statusCallback: string | null };
type MockAccount = {
  sid: string;
  token: string;
  /** API key SID -> secret. Standard keys: cannot read the account resource (Twilio 20003). */
  keys: Record<string, string>;
  status: string;
  type: string;
  name: string;
  numbers: MockNumber[];
  services: MockService[];
  down?: boolean;
};

const ACCT_A: MockAccount = {
  sid: sid("AC", "alpha"),
  token: "alpha-auth-token-0000000000000001",
  keys: {},
  status: "active",
  type: "Full",
  name: "Alpha Plumbing",
  numbers: [
    { sid: sid("PN", "alpha-1"), phone: "+14165550101", sms: true, smsUrl: null },
    { sid: sid("PN", "alpha-voice"), phone: "+14165550102", sms: false, smsUrl: "https://alpha.example/voice-only" },
  ],
  services: [],
};
const ACCT_B: MockAccount = { sid: sid("AC", "bravo"), token: "bravo-auth-token-00000000000000002", keys: {}, status: "active", type: "Trial", name: "Bravo Dental", numbers: [], services: [] };
const SK_C = sid("SK", "charlie");
const ACCT_C: MockAccount = {
  sid: sid("AC", "charlie"),
  token: "charlie-auth-token-never-given-to-oasis",
  keys: { [SK_C]: "charlie-api-key-secret-000000000003" },
  status: "active",
  type: "Full",
  name: "Charlie Co",
  numbers: [{ sid: sid("PN", "charlie-1"), phone: "+14165550103", sms: true, smsUrl: null }],
  services: [],
};
const MG_D = sid("MG", "delta");
const MG_EMPTY = sid("MG", "delta-empty");
const ACCT_D: MockAccount = {
  sid: sid("AC", "delta"),
  token: "delta-auth-token-000000000000000004",
  keys: {},
  status: "active",
  type: "Full",
  name: "Delta Clinic",
  numbers: [{ sid: sid("PN", "delta-1"), phone: "+14165550104", sms: true, smsUrl: null }],
  services: [
    { sid: MG_D, name: "Delta texts", senders: ["+14165550104"], inbound: null, statusCallback: null },
    { sid: MG_EMPTY, name: "Empty pool", senders: [], inbound: null, statusCallback: null },
  ],
};
const ACCT_SUSPENDED: MockAccount = { sid: sid("AC", "suspended"), token: "suspended-token-0000000000000005", keys: {}, status: "suspended", type: "Full", name: "Gone", numbers: [], services: [] };
const ACCT_DOWN: MockAccount = { sid: sid("AC", "down"), token: "down-token-000000000000000000006", keys: {}, status: "active", type: "Full", name: "Down", numbers: [], services: [], down: true };
// OASIS's own account: active, no number yet (2026-10-01).
const ACCT_OASIS: MockAccount = { sid: sid("AC", "oasis"), token: "oasis-env-auth-token-00000000007", keys: {}, status: "active", type: "Full", name: "OASIS AI", numbers: [], services: [] };
const ACCOUNTS = [ACCT_A, ACCT_B, ACCT_C, ACCT_D, ACCT_SUSPENDED, ACCT_DOWN, ACCT_OASIS];

type Call = { method: string; host: string; path: string; search: string; user: string; form: Record<string, string> };
const calls: Call[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(href);
  if (url.hostname !== "api.twilio.com" && url.hostname !== "messaging.twilio.com") {
    throw new Error(`unexpected network call in test: ${href}`);
  }
  const method = (init?.method || "GET").toUpperCase();
  const basic = (new Headers(init?.headers).get("authorization") || "").replace(/^Basic /, "");
  const [user = "", pass = ""] = Buffer.from(basic, "base64").toString("utf8").split(":");
  const form = new URLSearchParams(typeof init?.body === "string" ? init.body : "");
  calls.push({ method, host: url.hostname, path: url.pathname, search: url.search, user, form: Object.fromEntries(form) });
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const unauth = () => json(401, { code: 20003, message: "Authenticate", status: 401 });
  const acct = ACCOUNTS.find((a) => (user === a.sid && pass === a.token) || (a.keys[user] !== undefined && a.keys[user] === pass));
  if (!acct) return unauth();
  if (acct.down) return json(503, { message: "Service Unavailable" });
  const viaKey = user !== acct.sid;

  if (url.hostname === "api.twilio.com") {
    const m = /^\/2010-04-01\/Accounts\/([^/.]+)(\.json|\/(.+))$/.exec(url.pathname);
    if (!m) return json(404, { code: 20404, message: "not found" });
    if (m[1] !== acct.sid) return unauth();
    if (m[2] === ".json") {
      if (viaKey) return unauth(); // a Standard API key may not read the account resource
      return json(200, { sid: acct.sid, friendly_name: acct.name, status: acct.status, type: acct.type });
    }
    const rest = m[3];
    if (rest === "IncomingPhoneNumbers.json" && method === "GET") {
      const want = url.searchParams.get("PhoneNumber");
      return json(200, {
        incoming_phone_numbers: acct.numbers
          .filter((n) => !want || n.phone === want)
          .map((n) => ({ sid: n.sid, phone_number: n.phone, capabilities: { voice: true, sms: n.sms, mms: false, fax: false }, sms_url: n.smsUrl ?? "" })),
      });
    }
    const pn = /^IncomingPhoneNumbers\/(PN[0-9a-f]{32})\.json$/.exec(rest);
    if (pn && method === "POST") {
      const n = acct.numbers.find((x) => x.sid === pn[1]);
      if (!n) return json(404, { code: 20404, message: "not found" });
      if (form.get("SmsUrl")) n.smsUrl = form.get("SmsUrl");
      return json(200, { sid: n.sid, phone_number: n.phone, sms_url: n.smsUrl });
    }
    if (rest === "Messages.json" && method === "POST") {
      return json(201, { sid: sid("SM", `${acct.sid}:${calls.length}`), status: "queued" });
    }
    return json(404, { code: 20404, message: "not found" });
  }

  const s = /^\/v1\/Services\/([^/]+)(?:\/(PhoneNumbers|ShortCodes|AlphaSenders))?$/.exec(url.pathname);
  const svc = s ? acct.services.find((x) => x.sid === s[1]) : undefined;
  if (!s || !svc) return json(404, { code: 20404, message: "not found" });
  if (!s[2]) {
    if (method === "POST") {
      svc.inbound = form.get("InboundRequestUrl");
      svc.statusCallback = form.get("StatusCallback");
    }
    return json(200, { sid: svc.sid, friendly_name: svc.name, inbound_request_url: svc.inbound, status_callback: svc.statusCallback, use_inbound_webhook_on_number: false });
  }
  if (s[2] === "PhoneNumbers") return json(200, { phone_numbers: svc.senders.map((p) => ({ phone_number: p, capabilities: ["SMS"] })) });
  if (s[2] === "ShortCodes") return json(200, { short_codes: [] });
  return json(200, { alpha_senders: [] });
}) as typeof fetch;

/** Twilio's request signature, computed here from Twilio's published algorithm (not the app's code). */
function twilioSign(token: string, url: string, params: Record<string, string>): string {
  const data = Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], url);
  return createHmac("sha1", token).update(data, "utf8").digest("base64");
}

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

/** channel_accounts as it is live (Turso, read 2026-10-01), foreign key dropped; bravo__201 adds its two indexes. */
const CHANNEL_ACCOUNTS_DDL = `
  CREATE TABLE "channel_accounts" (
    "id" TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))),
    "tenant_id" TEXT NOT NULL, "provider" TEXT NOT NULL, "owner_user_id" TEXT, "display_name" TEXT,
    "from_email" TEXT, "from_phone" TEXT, "texttorrent_act_as_email" TEXT,
    "twilio_messaging_service_sid" TEXT, "twilio_phone_sid" TEXT,
    "capabilities" TEXT NOT NULL DEFAULT '{}', "credential_ref" TEXT,
    "is_active" INTEGER NOT NULL DEFAULT 1, "is_dry_run" INTEGER NOT NULL DEFAULT 0,
    "metadata" TEXT NOT NULL DEFAULT '{}',
    "created_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    "updated_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY ("id"));
  CREATE UNIQUE INDEX "ux_channel_accounts_phone" ON "channel_accounts" (tenant_id, provider, from_phone) WHERE (from_phone IS NOT NULL);
  CREATE INDEX "idx_channel_accounts_owner" ON "channel_accounts" (tenant_id, owner_user_id);
`;
const INBOUND_URL = "https://oasisai.work/api/webhooks/twilio/sms-inbound";
const STATUS_URL = "https://oasisai.work/api/webhooks/twilio/sms-status";

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
    CREATE TABLE tenant_manifests (tenant_id TEXT, slug TEXT, manifest TEXT);
    CREATE TABLE tenant_records (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, entity_type TEXT NOT NULL, data TEXT);
    CREATE TABLE sms_agent_jobs (id TEXT PRIMARY KEY, tenant_id TEXT, provider TEXT, provider_message_id TEXT,
      from_phone TEXT, to_phone TEXT, phone_last10 TEXT, body TEXT, lead_id TEXT, appointment_id TEXT, interaction_id TEXT,
      status TEXT, intent TEXT, intent_confidence TEXT, intent_source TEXT, proposed_action TEXT, executed_action TEXT,
      attempts INTEGER, received_at TEXT, completed_at TEXT, last_error TEXT);
    CREATE UNIQUE INDEX ux_sms_jobs ON sms_agent_jobs (tenant_id, provider, provider_message_id);
    CREATE TABLE lead_interactions (id TEXT PRIMARY KEY, tenant_id TEXT, lead_id TEXT, type TEXT, channel TEXT,
      direction TEXT, agent_source TEXT, provider TEXT, provider_message_id TEXT, from_phone TEXT, to_phone TEXT,
      content TEXT, content_preview TEXT, actor_user_id TEXT, created_at TEXT, metadata TEXT);
    CREATE UNIQUE INDEX ux_li_provider ON lead_interactions (tenant_id, provider, provider_message_id);
    CREATE TABLE sunbiz_phone_suppressions (tenant_id TEXT, phone_last10 TEXT);
  `);
  await db.executeMultiple(read("database/turso/bravo__187_os_connections.sql"));
  await db.executeMultiple(read("database/turso/bravo__209_connection_vendor_principal.sql"));
  // The webhook routing table and its indexes (W10a R6). The code is also
  // proven to route before bravo__201 exists (section 7).
  await db.executeMultiple(CHANNEL_ACCOUNTS_DDL);
  await db.executeMultiple(read("database/turso/bravo__201_channel_accounts_twilio_lookup.sql"));
  const stamp = "2026-09-01T00:00:00Z";
  const profile = (user: U, tenant: string, role: string, owner: 0 | 1 = 0, onboarded: string | null = stamp) => ({
    sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, onboarding_completed_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [`p-${user.id}`, user.id, user.email, tenant, role, owner, onboarded, stamp],
  });
  await db.batch(
    [
      ...Object.values(USERS).map((x) => ({ sql: `INSERT INTO "_supabase_auth_users" (id, email) VALUES (?, ?)`, args: [x.id, x.email] })),
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'alpha-co', 'Alpha Plumbing')", args: [ALPHA] },
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'bravo-co', 'Bravo Dental')", args: [BRAVO_CO] },
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'charlie-co', 'Charlie Co')", args: [CHARLIE] },
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'delta-co', 'Delta Clinic')", args: [DELTA] },
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'echo-co', 'Echo Co')", args: [ECHO] },
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'oasis-ai-cc', 'OASIS AI')", args: [OASIS] },
      profile(USERS.ownerA, ALPHA, "owner", 1),
      profile(USERS.memberA, ALPHA, "member"),
      // Bravo's owner is still in the workspace setup: the wizard renders for them.
      profile(USERS.ownerB, BRAVO_CO, "owner", 1, null),
      profile(USERS.ownerC, CHARLIE, "owner", 1),
      profile(USERS.ownerD, DELTA, "owner", 1),
      profile(USERS.ownerE, ECHO, "owner", 1),
      profile(USERS.oasisOwner, OASIS, "owner", 1),
    ],
    "write",
  );

  const { NextRequest } = await import("next/server");
  const keysRoute = await import("../app/api/integrations/keys/route");
  const testRoute = await import("../app/api/integrations/keys/test/route");
  const webhooksRoute = await import("../app/api/integrations/twilio/webhooks/route");
  const inboundRoute = await import("../app/api/webhooks/twilio/sms-inbound/route");
  const statusRoute = await import("../app/api/webhooks/twilio/sms-status/route");
  const connection = await import("../lib/twilio/connection");
  const direct = await import("../lib/sms-direct-twilio");
  const { loadConnectorFacts } = await import("../components/os/connections/connector-facts");
  const connectors = await import("../lib/os/connectors");
  const { validateIntegrationValue, findIntegrationSchema } = await import("../lib/tenant-integration-schemas");
  const { loadProviderAvailability } = await import("../lib/routing/provider-availability");

  type Res = { status: number; body: Record<string, unknown>; text: string };
  const toRes = async (r: Response): Promise<Res> => {
    const text = await r.text();
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      /* not JSON (TwiML or empty) */
    }
    return { status: r.status, body, text };
  };
  const jsonReq = (url: string, method: string, body?: unknown) =>
    new NextRequest(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const saveKey = async (field_key: string, value: string) =>
    toRes(await keysRoute.POST(jsonReq("https://oasisai.work/api/integrations/keys", "POST", { service: "twilio", field_key, value })));
  const runTest = async () => toRes(await testRoute.POST(jsonReq("https://oasisai.work/api/integrations/keys/test", "POST", { service: "twilio" })));
  // The card exactly as Settings > Connections computes it: the hub's facts loader, then the resolver.
  const twilioCard = async (tenantId: string, userId: string) =>
    connectors.resolveConnectorStatus(connectors.connectorBySlug("twilio")!, await loadConnectorFacts({ tenantId, userId }), Date.now());
  const callsSince = (n: number) => calls.slice(n);
  const twilioPost = (url: string, params: Record<string, string>, signature: string | null) =>
    new NextRequest(url, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...(signature ? { "x-twilio-signature": signature } : {}),
      },
      body: new URLSearchParams(params).toString(),
    });

  console.log("twilio-connection:");

  // -- 1. Saving real Twilio values --------------------------------------------

  await check("a real Account SID (AC + 32 lower-case hex, as Twilio's console shows it) saves; a wrong prefix is refused", async () => {
    const schema = findIntegrationSchema("twilio")!;
    const field = (k: string) => schema.fields.find((f) => f.key === k)!;
    assert.equal(validateIntegrationValue(field("account_sid"), ACCT_A.sid), null);
    assert.equal(validateIntegrationValue(field("api_key_sid"), SK_C), null);
    assert.equal(validateIntegrationValue(field("messaging_service_sid"), MG_D), null);
    assert.ok(validateIntegrationValue(field("account_sid"), SK_C), "an API key SID is not an Account SID");
    assert.ok(validateIntegrationValue(field("messaging_service_sid"), ACCT_A.sid), "an Account SID is not a messaging service");
    assert.ok(validateIntegrationValue(field("account_sid"), "AC123"), "too short");
    await login(USERS.ownerA);
    const saved = await saveKey("account_sid", ACCT_A.sid);
    assert.equal(saved.status, 200, saved.text);
    assert.equal((await saveKey("auth_token", ACCT_A.token)).status, 200);
  });

  await check("a member who is not an owner or admin cannot save Twilio keys", async () => {
    await login(USERS.memberA);
    assert.equal((await saveKey("auth_token", "member-guess")).status, 403);
  });

  // -- 2. The test, state by state, through the real route ------------------------

  await check("keys saved but no sender: Test runs anyway and lists the account's own texting numbers ('Needs a number')", async () => {
    await login(USERS.ownerA);
    const before = calls.length;
    const r = await runTest();
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.ok, false);
    assert.equal(r.body.state, "needs_number");
    assert.match(String(r.body.message), /^Needs a number\. Save one of this account's numbers as the From Number: \+14165550101\.$/);
    assert.doesNotMatch(String(r.body.message), /\+14165550102/, "a number that cannot text is not offered");
    assert.ok(callsSince(before).every((c) => c.method === "GET"), "the test is read-only");
    assert.ok(callsSince(before).every((c) => c.user === ACCT_A.sid), "only Alpha's own account is called");
    const card = await twilioCard(ALPHA, USERS.ownerA.id);
    assert.deepEqual([card.kind, card.label], ["attention", "Needs a number"]);
  });

  await check("a number that is on the account but cannot text: 'Number cannot send texts' (after a save, the card first says not tested)", async () => {
    await login(USERS.ownerA);
    assert.equal((await saveKey("from_number", "+14165550102")).status, 200);
    const untested = await twilioCard(ALPHA, USERS.ownerA.id);
    assert.deepEqual([untested.kind, untested.label], ["configured", "Set up · not tested yet"], "an answer about the old keys is not repeated");
    const r = await runTest();
    assert.equal(r.body.state, "number_lacks_sms");
    assert.match(String(r.body.message), /^Number cannot send texts\. \+14165550102 is on this account/);
    const card = await twilioCard(ALPHA, USERS.ownerA.id);
    assert.deepEqual([card.kind, card.label], ["attention", "Number cannot send texts"]);
  });

  await check("a number not on the account: 'Needs a number', naming it", async () => {
    await login(USERS.ownerA);
    await saveKey("from_number", "+15145550000");
    const r = await runTest();
    assert.equal(r.body.state, "needs_number");
    assert.match(String(r.body.message), /\+15145550000 is not a phone number on this Twilio account/);
  });

  await check("a number that can text: connected, the card is green from the test, and it says where incoming texts go", async () => {
    await login(USERS.ownerA);
    await saveKey("from_number", "+14165550101");
    const r = await runTest();
    assert.equal(r.body.ok, true, r.text);
    assert.equal(r.body.state, "connected");
    assert.match(String(r.body.message), /^Connected\. \+14165550101 can send texts from this Twilio account\.$/);
    assert.equal(r.body.detail, "Incoming texts are not sent anywhere yet.");
    const card = await twilioCard(ALPHA, USERS.ownerA.id);
    assert.equal(card.kind, "connected");
    assert.match(card.label, /^Connected · verified /);
  });

  await check("the keys API hands the drawer real booleans (libSQL stores the result as 0/1): every Twilio field passed", async () => {
    await login(USERS.ownerA);
    const r = await toRes(await keysRoute.GET());
    assert.equal(r.status, 200, r.text);
    const rows = (r.body.rows as Array<{ service: string; field_key: string; last_test_ok: unknown }>).filter((x) => x.service === "twilio");
    assert.ok(rows.length >= 3, "account, token and number are saved");
    assert.ok(rows.every((x) => x.last_test_ok === true), JSON.stringify(rows));
    const { storedTestResult } = await import("../lib/tenant-integration-store");
    assert.deepEqual(
      [1, "1", true, 0, "0", false, null, undefined, "yes"].map(storedTestResult),
      [true, true, true, false, false, false, null, null, null],
    );
  });

  await check("a wrong Auth Token: 'Credentials rejected', and the card says so", async () => {
    await login(USERS.ownerA);
    await saveKey("auth_token", "not-alphas-token");
    try {
      const r = await runTest();
      assert.equal(r.body.state, "credentials_rejected");
      assert.match(String(r.body.message), /^Credentials rejected\./);
      const card = await twilioCard(ALPHA, USERS.ownerA.id);
      assert.deepEqual([card.kind, card.label], ["attention", "Credentials rejected"]);
    } finally {
      // Put Alpha's real token back whatever happened, so later checks start clean.
      await saveKey("auth_token", ACCT_A.token);
    }
    assert.equal((await runTest()).body.state, "connected");
  });

  await check("a tenant whose Twilio account has NO number: 'Needs a number' (buy one), its own account only", async () => {
    await login(USERS.ownerB);
    await saveKey("account_sid", ACCT_B.sid);
    await saveKey("auth_token", ACCT_B.token);
    const before = calls.length;
    const r = await runTest();
    assert.equal(r.body.state, "needs_number");
    assert.match(String(r.body.message), /has no phone number that can text yet: buy one in Twilio/);
    assert.ok(callsSince(before).length > 0 && callsSince(before).every((c) => c.user === ACCT_B.sid), "Bravo's test used Bravo's account only");
    const card = await twilioCard(BRAVO_CO, USERS.ownerB.id);
    assert.deepEqual([card.kind, card.label], ["attention", "Needs a number"]);
    // Alpha's card is untouched by Bravo's test.
    assert.equal((await twilioCard(ALPHA, USERS.ownerA.id)).kind, "connected");
  });

  await check("an API key (SK + secret) with no Auth Token: the key is proven by a read it may make, sends work, incoming texts cannot be verified", async () => {
    await login(USERS.ownerC);
    for (const [k, v] of [["account_sid", ACCT_C.sid], ["api_key_sid", SK_C], ["api_key_secret", ACCT_C.keys[SK_C]], ["from_number", "+14165550103"]] as const) {
      assert.equal((await saveKey(k, v)).status, 200, k);
    }
    const before = calls.length;
    const r = await runTest();
    assert.equal(r.body.state, "connected", r.text);
    assert.ok(callsSince(before).every((c) => c.user === SK_C), "authenticated with the API key, never the account SID");
    assert.match(String(r.body.detail), /cannot verify incoming texts without the Auth Token/);
    const avail = await loadProviderAvailability(CHARLIE);
    assert.equal(avail.twilio.configured, true, "an API key bundle counts as configured for outbound routing");
  });

  await check("an API key with the wrong secret: credentials rejected", async () => {
    const probe = await connection.probeTwilioConnection({ account_sid: ACCT_C.sid, api_key_sid: SK_C, api_key_secret: "wrong", from_number: "+14165550103" });
    assert.equal(probe.state, "credentials_rejected");
  });

  await check("messaging services: a sender pool connects, an empty pool needs a number, an unknown SID is not found", async () => {
    const base = { account_sid: ACCT_D.sid, auth_token: ACCT_D.token };
    const ok = await connection.probeTwilioConnection({ ...base, messaging_service_sid: MG_D });
    assert.equal(ok.state, "connected");
    assert.match(ok.message, /Messaging service Delta texts can send texts/);
    const empty = await connection.probeTwilioConnection({ ...base, messaging_service_sid: MG_EMPTY });
    assert.equal(empty.state, "needs_number");
    assert.match(empty.message, /Empty pool has no sender yet/);
    const missing = await connection.probeTwilioConnection({ ...base, messaging_service_sid: sid("MG", "nobody") });
    assert.equal(missing.state, "messaging_service_not_found");
  });

  await check("a suspended account, Twilio down, keys incomplete, and a Twilio that never answers", async () => {
    assert.equal((await connection.probeTwilioConnection({ account_sid: ACCT_SUSPENDED.sid, auth_token: ACCT_SUSPENDED.token, from_number: "+1" })).state, "account_inactive");
    const down = await connection.probeTwilioConnection({ account_sid: ACCT_DOWN.sid, auth_token: ACCT_DOWN.token });
    assert.deepEqual([down.state, down.ok, down.httpStatus], ["unreachable", false, 503]);
    const before = calls.length;
    assert.equal((await connection.probeTwilioConnection({ auth_token: "x" })).state, "incomplete");
    assert.equal((await connection.probeTwilioConnection({ account_sid: ACCT_A.sid })).state, "incomplete");
    assert.equal(calls.length, before, "incomplete keys never call Twilio");
    const started = Date.now();
    const hung = await connection.probeTwilioConnection(
      { account_sid: ACCT_A.sid, auth_token: ACCT_A.token },
      { fetchImpl: (() => new Promise<Response>(() => {})) as typeof fetch, timeoutMs: 50 },
    );
    assert.equal(hung.state, "unreachable");
    assert.ok(Date.now() - started < 1_500, "the deadline holds");
  });

  await check("OASIS's own workspace tests through its deployment account (no number yet), and no client ever reaches it", async () => {
    process.env.TWILIO_ACCOUNT_SID = ACCT_OASIS.sid;
    process.env.TWILIO_AUTH_TOKEN = ACCT_OASIS.token;
    try {
      await login(USERS.oasisOwner);
      const oasis = await runTest();
      assert.equal(oasis.body.state, "needs_number", oasis.text);
      await login(USERS.ownerE);
      const before = calls.length;
      const client = await runTest();
      assert.equal(client.body.state, "incomplete", "a client with no keys of its own never borrows OASIS's");
      assert.equal(calls.length, before, "and nothing was sent to Twilio for it");
    } finally {
      delete process.env.TWILIO_ACCOUNT_SID;
      delete process.env.TWILIO_AUTH_TOKEN;
    }
  });

  // -- 3. The webhook addresses, and pointing a sender at them --------------------

  await check("GET: the two addresses on OASIS's public origin, the saved sender, and whether incoming texts can be verified", async () => {
    await login(USERS.ownerA);
    const r = await toRes(await webhooksRoute.GET());
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(
      [r.body.inbound_url, r.body.status_url, r.body.sender, r.body.inbound_verifiable],
      [INBOUND_URL, STATUS_URL, { kind: "number", label: "+14165550101" }, true],
    );
    assert.ok(!r.text.includes(ACCT_A.token), "no key in the response");
    await login(USERS.ownerC);
    assert.equal((await toRes(await webhooksRoute.GET())).body.inbound_verifiable, false);
  });

  await check("only an owner or admin may point a number at OASIS", async () => {
    await login(USERS.memberA);
    const before = calls.length;
    assert.equal((await webhooksRoute.POST()).status, 403);
    assert.equal(calls.length, before, "Twilio was not called");
  });

  await check("the owner points Alpha's texting number at OASIS: only that number's incoming URL changes, in Alpha's account, audited", async () => {
    await login(USERS.ownerA);
    const before = calls.length;
    const r = await toRes(await webhooksRoute.POST());
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.target, "number");
    assert.equal(ACCT_A.numbers[0].smsUrl, INBOUND_URL);
    assert.equal(ACCT_A.numbers[1].smsUrl, "https://alpha.example/voice-only", "the other number is untouched");
    const posts = callsSince(before).filter((c) => c.method === "POST");
    assert.equal(posts.length, 1);
    assert.deepEqual(posts[0].form, { SmsUrl: INBOUND_URL, SmsMethod: "POST" });
    assert.ok(callsSince(before).every((c) => c.user === ACCT_A.sid));
    const audit = (await db.execute({ sql: "SELECT action_type FROM tenant_audit_log WHERE tenant_id = ? AND action_type = 'twilio.webhooks_set'", args: [ALPHA] })).rows;
    assert.equal(audit.length, 1);
    // The next test now reports it.
    assert.equal((await runTest()).body.detail, "Incoming texts reach OASIS.");
  });

  await check("a messaging service gets OASIS's incoming URL and status callback", async () => {
    await login(USERS.ownerD);
    for (const [k, v] of [["account_sid", ACCT_D.sid], ["auth_token", ACCT_D.token], ["messaging_service_sid", MG_D]] as const) {
      assert.equal((await saveKey(k, v)).status, 200, k);
    }
    const r = await toRes(await webhooksRoute.POST());
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.target, "messaging_service");
    const svc = ACCT_D.services.find((x) => x.sid === MG_D)!;
    assert.deepEqual([svc.inbound, svc.statusCallback], [INBOUND_URL, STATUS_URL]);
  });

  await check("refused, with Twilio untouched: no Auth Token (an API key cannot verify incoming texts), and no sender saved", async () => {
    await login(USERS.ownerC);
    const before = calls.length;
    const c = await toRes(await webhooksRoute.POST());
    assert.deepEqual([c.status, c.body.error], [409, "auth_token_required"]);
    assert.equal(ACCT_C.numbers[0].smsUrl, null);
    await login(USERS.ownerB);
    const b = await toRes(await webhooksRoute.POST());
    assert.deepEqual([b.status, b.body.error], [409, "needs_number"]);
    assert.equal(calls.length, before, "neither refusal called Twilio");
  });

  // -- 4. Incoming texts: each workspace's own token -----------------------------

  const inboundParams = (to: string, sidSeed: string) => ({
    AccountSid: ACCT_A.sid,
    From: "+15145550199",
    To: to,
    Body: "Hi, is Thursday still good?",
    MessageSid: sid("SM", sidSeed),
  });

  await check("a text to Alpha's number signed with Alpha's Auth Token is taken in, for Alpha", async () => {
    const params = inboundParams("+14165550101", "in-alpha");
    const res = await toRes(await inboundRoute.POST(twilioPost(INBOUND_URL, params, twilioSign(ACCT_A.token, INBOUND_URL, params))));
    assert.equal(res.status, 200, res.text);
    const jobs = (await db.execute({ sql: "SELECT tenant_id FROM sms_agent_jobs WHERE provider_message_id = ?", args: [params.MessageSid] })).rows;
    assert.deepEqual(jobs.map((r) => String(r.tenant_id)), [ALPHA]);
  });

  await check("the same text signed with ANOTHER workspace's token, or unsigned, is refused and nothing is written", async () => {
    const params = inboundParams("+14165550101", "in-forged");
    const forged = await inboundRoute.POST(twilioPost(INBOUND_URL, params, twilioSign(ACCT_B.token, INBOUND_URL, params)));
    assert.equal(forged.status, 403);
    assert.equal((await inboundRoute.POST(twilioPost(INBOUND_URL, params, null))).status, 403);
    const jobs = (await db.execute({ sql: "SELECT COUNT(*) AS n FROM sms_agent_jobs WHERE provider_message_id = ?", args: [params.MessageSid] })).rows;
    assert.equal(Number(jobs[0].n), 0);
  });

  await check("a workspace with only an API key cannot have its incoming texts verified, so they are refused", async () => {
    const params = { ...inboundParams("+14165550103", "in-charlie"), AccountSid: ACCT_C.sid };
    // Even signed with Charlie's real Auth Token, which OASIS was never given.
    const res = await inboundRoute.POST(twilioPost(INBOUND_URL, params, twilioSign(ACCT_C.token, INBOUND_URL, params)));
    assert.equal(res.status, 403);
  });

  // -- 5. Delivery updates ---------------------------------------------------------

  const SM_OUT = sid("SM", "outbound-alpha");
  await db.batch(
    [
      {
        sql: `INSERT INTO lead_interactions (id, tenant_id, type, channel, direction, provider, provider_message_id, metadata)
              VALUES ('li-alpha', ?, 'sms_sent', 'sms', 'outbound', 'twilio_direct', ?, '{"provider_receipt":"x"}')`,
        args: [ALPHA, SM_OUT],
      },
      // Another workspace's row under the same message id must never be touched.
      {
        sql: `INSERT INTO lead_interactions (id, tenant_id, type, channel, direction, provider, provider_message_id, metadata)
              VALUES ('li-bravo', ?, 'sms_sent', 'sms', 'outbound', 'twilio_direct', ?, '{}')`,
        args: [BRAVO_CO, SM_OUT],
      },
    ],
    "write",
  );
  const statusParams = (status: string, over: Record<string, string> = {}) => ({
    AccountSid: ACCT_A.sid,
    From: "+14165550101",
    To: "+15145550199",
    MessageSid: SM_OUT,
    MessageStatus: status,
    ...over,
  });
  const metadataOf = async (id: string) =>
    JSON.parse(String((await db.execute({ sql: "SELECT metadata FROM lead_interactions WHERE id = ?", args: [id] })).rows[0].metadata)) as Record<string, unknown>;

  await check("a delivery report signed by Alpha's account lands on Alpha's message only; a late 'sent' never overwrites 'delivered'", async () => {
    const p = statusParams("delivered");
    const res = await statusRoute.POST(twilioPost(STATUS_URL, p, twilioSign(ACCT_A.token, STATUS_URL, p)));
    assert.equal(res.status, 204);
    const a = await metadataOf("li-alpha");
    assert.equal(a.delivery_status, "delivered");
    assert.equal(a.provider_receipt, "x", "the rest of the metadata is kept");
    assert.deepEqual(await metadataOf("li-bravo"), {}, "another workspace's row is untouched");
    const late = statusParams("sent");
    assert.equal((await statusRoute.POST(twilioPost(STATUS_URL, late, twilioSign(ACCT_A.token, STATUS_URL, late)))).status, 204);
    assert.equal((await metadataOf("li-alpha")).delivery_status, "delivered");
  });

  await check("a delivery report with a bad signature, or naming another Twilio account, is refused and writes nothing", async () => {
    const p = statusParams("failed", { ErrorCode: "30003" });
    assert.equal((await statusRoute.POST(twilioPost(STATUS_URL, p, twilioSign(ACCT_B.token, STATUS_URL, p)))).status, 403);
    const other = statusParams("failed", { AccountSid: ACCT_B.sid });
    assert.equal((await statusRoute.POST(twilioPost(STATUS_URL, other, twilioSign(ACCT_A.token, STATUS_URL, other)))).status, 403);
    assert.equal((await metadataOf("li-alpha")).delivery_status, "delivered");
  });

  // -- 6. Sending: the workspace's own credential, and only when live -------------

  await check("with the live-send switch off, nothing is sent: no Twilio call at all", async () => {
    const before = calls.length;
    const r = await direct.sendSmsDirectTwilio({ tenantId: ALPHA, to: "+15145550199", body: "Test" });
    assert.deepEqual(r, { ok: false, provider: "twilio_direct", error: "live_send_disabled", http_status: 409 });
    assert.equal(calls.length, before);
  });

  await check("live: Alpha sends with its own account and asks for delivery updates; Charlie sends with its API key and asks for none", async () => {
    process.env.LIVE_SEND_TWILIO = "1";
    try {
      const before = calls.length;
      const a = await direct.sendSmsDirectTwilio({ tenantId: ALPHA, to: "+15145550199", body: "Hello from Alpha" });
      assert.equal(a.ok, true, JSON.stringify(a));
      const sentA = callsSince(before).find((c) => c.path.endsWith("/Messages.json"))!;
      assert.equal(sentA.user, ACCT_A.sid);
      assert.equal(sentA.path, `/2010-04-01/Accounts/${ACCT_A.sid}/Messages.json`);
      assert.deepEqual(
        [sentA.form.From, sentA.form.To, sentA.form.StatusCallback],
        ["+14165550101", "+15145550199", STATUS_URL],
      );
      const mid = calls.length;
      const c = await direct.sendSmsDirectTwilio({ tenantId: CHARLIE, to: "+15145550199", body: "Hello from Charlie" });
      assert.equal(c.ok, true, JSON.stringify(c));
      const sentC = callsSince(mid).find((x) => x.path.endsWith("/Messages.json"))!;
      assert.equal(sentC.user, SK_C, "the API key, not an Auth Token");
      assert.equal(sentC.path, `/2010-04-01/Accounts/${ACCT_C.sid}/Messages.json`);
      assert.equal(sentC.form.StatusCallback, undefined, "no delivery updates OASIS could not verify");
      const none = await direct.sendSmsDirectTwilio({ tenantId: ECHO, to: "+15145550199", body: "x" });
      assert.deepEqual([none.ok, !none.ok && none.error], [false, "missing_twilio_credentials"]);
    } finally {
      delete process.env.LIVE_SEND_TWILIO;
    }
  });

  // W10a R3: the card may say only what the send gate does. It used to promise
  // that a send made while live texting was off "is recorded as a test"; no
  // path records anything, and the gate makes no Twilio call at all.
  await check("the Twilio card promises only what the live-send gate does: nothing goes to Twilio while it is off, and no record is claimed", async () => {
    const does = connectors.connectorBySlug("twilio")!.does;
    const gate = does.find((d) => /live texting/i.test(d));
    assert.equal(gate, "Sends only while live texting is switched on. While it is off, OASIS asks Twilio to send nothing, so no text leaves your number");
    assert.ok(does.every((d) => !/record|for OASIS|test send/i.test(d)), does.join(" | "));
    const before = calls.length;
    const off = await direct.sendSmsDirectTwilio({ tenantId: ALPHA, to: "+15145550199", body: "while off" });
    assert.equal(!off.ok && off.error, "live_send_disabled");
    assert.equal(callsSince(before).length, 0, "the gate asks Twilio nothing");
  });

  // -- 7. Routing: the webhooks find a workspace by an index (W10a R6) -------------

  const { encryptField } = await import("../lib/field-encryption");
  const { createTursoPostgrest } = await import("../lib/turso-postgrest");
  const { getServiceSupabase } = await import("../lib/supabase-server");
  const inbound = await import("../lib/sms/twilio-inbound");
  const routeOf = async (tenantId: string) =>
    (
      await db.execute({
        sql: "SELECT from_phone, twilio_messaging_service_sid, is_active FROM channel_accounts WHERE tenant_id = ? AND provider = 'twilio'",
        args: [tenantId],
      })
    ).rows.map((r) => [r.from_phone ?? null, r.twilio_messaging_service_sid ?? null, Number(r.is_active)]);
  const removeKey = async (field_key: string) =>
    toRes(await keysRoute.DELETE(jsonReq("https://oasisai.work/api/integrations/keys", "DELETE", { service: "twilio", field_key })));
  const jobsFor = async (messageSid: string) =>
    (await db.execute({ sql: "SELECT tenant_id FROM sms_agent_jobs WHERE provider_message_id = ?", args: [messageSid] })).rows.map((r) => String(r.tenant_id));

  await check("saving a Twilio sender writes the workspace's one routing row (its number, or its messaging service), never a second", async () => {
    assert.deepEqual(await routeOf(ALPHA), [["+14165550101", null, 1]]);
    assert.deepEqual(await routeOf(CHARLIE), [["+14165550103", null, 1]]);
    assert.deepEqual(await routeOf(DELTA), [[null, MG_D, 1]]);
    assert.deepEqual(await routeOf(BRAVO_CO), [], "keys with no sender: nothing to route");
    await login(USERS.ownerA);
    const again = await saveKey("from_number", "+14165550101");
    assert.equal(again.body.routing, "synced", again.text);
    assert.deepEqual(await routeOf(ALPHA), [["+14165550101", null, 1]], "saved again: the same row");
    assert.equal((await runTest()).body.routing, "synced", "Test writes it too");
  });

  // Thirty more workspaces with a saved number: more than the old scan reads
  // (above 25 it refused every incoming text and delivery report).
  const DECOYS = Array.from({ length: 30 }, (_, i) => `d0d0d0d0-0000-4000-8000-${String(i).padStart(12, "0")}`);
  await check("with thirty more workspaces' numbers saved, the scan alone refuses everyone; the routing row still finds each owner", async () => {
    await db.batch(
      DECOYS.map((t, i) => ({
        sql: "INSERT INTO tenant_integration_credentials (tenant_id, service, field_key, encrypted_value) VALUES (?, 'twilio', 'from_number', ?)",
        args: [t, encryptField(`+1647555${1000 + i}`)],
      })),
      "write",
    );
    // A number stored with no routing row, as every sender was before this
    // change: only the scan can find it, and past its cap it gives up.
    await db.execute({
      sql: "INSERT INTO tenant_integration_credentials (tenant_id, service, field_key, encrypted_value) VALUES (?, 'twilio', 'from_number', ?)",
      args: [ECHO, encryptField("+14165550177")],
    });
    try {
      assert.equal(await inbound.resolveTwilioInboundTenant(getServiceSupabase(), "+14165550177", {}), null, "the cliff the routing row removes");
      const a = inboundParams("+14165550101", "in-alpha-crowd");
      const ra = await toRes(await inboundRoute.POST(twilioPost(INBOUND_URL, a, twilioSign(ACCT_A.token, INBOUND_URL, a))));
      assert.equal(ra.status, 200, ra.text);
      assert.deepEqual(await jobsFor(a.MessageSid), [ALPHA]);
      // A messaging-service workspace, found by its service SID.
      const d = { ...inboundParams("+14165550104", "in-delta-crowd"), AccountSid: ACCT_D.sid, MessagingServiceSid: MG_D };
      const rd = await toRes(await inboundRoute.POST(twilioPost(INBOUND_URL, d, twilioSign(ACCT_D.token, INBOUND_URL, d))));
      assert.equal(rd.status, 200, rd.text);
      assert.deepEqual(await jobsFor(d.MessageSid), [DELTA]);
      // And a delivery report from Alpha's number.
      const p = statusParams("read");
      assert.equal((await statusRoute.POST(twilioPost(STATUS_URL, p, twilioSign(ACCT_A.token, STATUS_URL, p)))).status, 204);
    } finally {
      await db.execute({
        sql: `DELETE FROM tenant_integration_credentials WHERE tenant_id IN (${DECOYS.map(() => "?").join(", ")}) OR (tenant_id = ? AND field_key = 'from_number')`,
        args: [...DECOYS, ECHO],
      });
    }
  });

  await check("the lookup is ONE index search by number or messaging service (bravo__201), then only the owner's own sender, never the credential scan; before that migration it still routes", async () => {
    // Two copies of the routing rows written above, each on its own database
    // so a query plan never holds the shared file: one with bravo__201 applied,
    // one without it (a deploy and its migration are not atomic).
    const rows = (await db.execute("SELECT id, tenant_id, provider, from_phone, twilio_messaging_service_sid, is_active FROM channel_accounts")).rows;
    const copy = async (withMigration: boolean) => {
      const c = createClient({ url: ":memory:" });
      await c.executeMultiple(CHANNEL_ACCOUNTS_DDL);
      if (withMigration) await c.executeMultiple(read("database/turso/bravo__201_channel_accounts_twilio_lookup.sql"));
      for (const r of rows) {
        await c.execute({
          sql: "INSERT INTO channel_accounts (id, tenant_id, provider, from_phone, twilio_messaging_service_sid, is_active) VALUES (?, ?, ?, ?, ?, ?)",
          args: [r.id, r.tenant_id, r.provider, r.from_phone ?? null, r.twilio_messaging_service_sid ?? null, r.is_active],
        });
      }
      return c;
    };
    const after = await copy(true);
    const before = await copy(false);
    // The resolver's own query, captured through the production query builder.
    const seen: Array<{ sql: string; args: unknown[] }> = [];
    const recording = new Proxy(after, {
      get(target, prop) {
        if (prop === "execute") {
          return async (stmt: unknown) => {
            const s = stmt as string | { sql: string; args?: unknown };
            seen.push(typeof s === "string" ? { sql: s, args: [] } : { sql: s.sql, args: (s.args ?? []) as unknown[] });
            return target.execute(stmt as never);
          };
        }
        const v = Reflect.get(target, prop) as unknown;
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    const shim = createTursoPostgrest(recording as typeof after);
    const cases: Array<[string, string, string, RegExp]> = [
      ["+14165550101", "", ALPHA, /idx_channel_accounts_from_phone/],
      ["+14165550104", MG_D, DELTA, /idx_channel_accounts_twilio_mg/],
    ];
    try {
      for (const [to, mg, owner, index] of cases) {
        seen.length = 0;
        const found = await inbound.resolveTwilioInboundTenant(shim as never, to, {}, undefined, mg);
        assert.equal(found?.tenantId, owner, to);
        const lookups = seen.filter((s) => /channel_accounts/.test(s.sql));
        assert.equal(lookups.length, 1, `${to}: one read`);
        // The owner's sender is confirmed through its own two reads
        // (currentTwilioSender), never by scanning every workspace's credentials.
        assert.equal(seen.filter((s) => /tenant_integration_credentials/.test(s.sql)).length, 0, `${to}: no credential scan`);
        const plan = (await after.execute({ sql: `EXPLAIN QUERY PLAN ${lookups[0].sql}`, args: lookups[0].args as never })).rows.map((r) => String(r.detail));
        assert.ok(plan.some((step) => /USING (COVERING )?INDEX/.test(step) && index.test(step)), `${to}: ${plan.join(" | ")}`);
        assert.ok(!plan.some((step) => /^SCAN channel_accounts\b/.test(step)), `${to}: ${plan.join(" | ")}`);
        // Without the migration: the same read, unindexed, the same owner.
        assert.equal((await inbound.resolveTwilioInboundTenant(createTursoPostgrest(before) as never, to, {}, undefined, mg))?.tenantId, owner, `${to} before bravo__201`);
      }
    } finally {
      after.close();
      before.close();
    }
  });

  await check("a number saved by two workspaces is routed to neither; removing it unroutes that workspace and the owner's texts arrive again", async () => {
    await login(USERS.ownerB);
    assert.equal((await saveKey("from_number", "+14165550101")).body.routing, "synced");
    const amb = inboundParams("+14165550101", "in-ambiguous");
    assert.equal((await inboundRoute.POST(twilioPost(INBOUND_URL, amb, twilioSign(ACCT_A.token, INBOUND_URL, amb)))).status, 403);
    assert.deepEqual(await jobsFor(amb.MessageSid), [], "never handed to one of two claimants");
    const removed = await removeKey("from_number");
    assert.equal(removed.status, 200, removed.text);
    assert.equal(removed.body.routing, "synced");
    assert.deepEqual(await routeOf(BRAVO_CO), [[null, null, 0]], "inactive and emptied");
    const back = inboundParams("+14165550101", "in-after-remove");
    assert.equal((await inboundRoute.POST(twilioPost(INBOUND_URL, back, twilioSign(ACCT_A.token, INBOUND_URL, back)))).status, 200);
    assert.deepEqual(await jobsFor(back.MessageSid), [ALPHA]);
  });

  await check("OASIS's own workspace: Test routes its deployment number (never stored), and its texts arrive; no client can claim that number's route", async () => {
    process.env.TWILIO_ACCOUNT_SID = ACCT_OASIS.sid;
    process.env.TWILIO_AUTH_TOKEN = ACCT_OASIS.token;
    process.env.TWILIO_FROM_NUMBER = "+14165550170";
    try {
      await login(USERS.oasisOwner);
      assert.equal((await runTest()).body.routing, "synced");
      assert.deepEqual(await routeOf(OASIS), [["+14165550170", null, 1]]);
      const o = { ...inboundParams("+14165550170", "in-oasis"), AccountSid: ACCT_OASIS.sid };
      const res = await toRes(await inboundRoute.POST(twilioPost(INBOUND_URL, o, twilioSign(ACCT_OASIS.token, INBOUND_URL, o))));
      assert.equal(res.status, 200, res.text);
      assert.deepEqual(await jobsFor(o.MessageSid), [OASIS]);
      // A client's Test never reads the deployment number.
      await login(USERS.ownerE);
      await runTest();
      assert.deepEqual(await routeOf(ECHO), []);
    } finally {
      delete process.env.TWILIO_ACCOUNT_SID;
      delete process.env.TWILIO_AUTH_TOKEN;
      delete process.env.TWILIO_FROM_NUMBER;
    }
  });

  // CodeRabbit on #520: the server updates Twilio BEFORE it answers, so a lost or
  // unexplained answer is an unknown outcome, never "Twilio was not changed".
  await check("after 'Set them', an unconfirmed update says it could not be confirmed, never that Twilio is unchanged", async () => {
    const { applyResultNotice } = await import("../components/os/connections/TwilioWebhooksPanel");
    assert.deepEqual(applyResultNotice({ ok: true, status: 200 }, { ok: true, message: "Done." }), { tone: "ok", text: "Done." });
    const refusal = applyResultNotice({ ok: false, status: 409 }, { ok: false, message: "Save your Auth Token first. Nothing was changed in Twilio.", error: "no_auth_token" });
    assert.equal(refusal?.text, "Save your Auth Token first. Nothing was changed in Twilio.", "the server's own explanation is shown as is");
    for (const [res, data] of [
      [{ ok: false, status: 502 }, null],
      [{ ok: false, status: 500 }, { ok: false, error: "twilio_failed" }],
      [{ ok: true, status: 200 }, null],
      [null, null],
    ] as const) {
      const n = applyResultNotice(res, data);
      assert.equal(n?.tone, "err", JSON.stringify([res, data]));
      assert.match(n!.text, /could not be confirmed/, JSON.stringify([res, data]));
      assert.doesNotMatch(n!.text, /not changed|unchanged/i, `claims nothing changed: ${n!.text}`);
    }
  });

  // CodeRabbit on #520: the panel re-read its sender only when the status label
  // changed, and saving an Auth Token on an incomplete setup keeps it "Needs
  // attention". The drawer now counts saved and removed keys and the panel reloads
  // on that count. (No DOM in this suite, so the wiring is pinned in source.)
  await check("the Twilio panel reloads after every saved or removed key, not only when the status label changes", () => {
    const drawer = read("components/os/connections/ConnectorDrawer.tsx");
    assert.match(drawer, /setKeysRevision\(\(n\) => n \+ 1\)/, "every key change bumps the revision");
    assert.match(drawer, /<ServiceKeysForm[^>]*onChanged=\{onKeysChanged\}/, "the key form reports its saves through the revision");
    assert.match(drawer, /<TwilioWebhooksPanel[^>]*version=\{keysRevision\}/, "the panel reloads on the revision");
    assert.doesNotMatch(drawer, /version=\{status\?\.label\}/, "not on the status label");
  });

  // CodeRabbit on #520: a route row left active by a failed sync (the workspace
  // removed the number, the row write failed) must not capture texts meant for
  // the number's new owner. The row is believed only while that workspace's
  // current sender (currentTwilioSender) agrees with it.
  await check("a stale route row (its workspace no longer holds the number) loses to the number's current owner", async () => {
    const shim = createTursoPostgrest(db);
    const NUM = "+14165550199";
    // BRAVO_CO's row claims NUM, but BRAVO_CO has no saved number: a failed sync.
    await db.execute({
      sql: "UPDATE channel_accounts SET is_active = 1, from_phone = ? WHERE tenant_id = ? AND provider = 'twilio'",
      args: [NUM, BRAVO_CO],
    });
    // ECHO saves NUM, and its own routing row is then lost (another failed sync).
    await login(USERS.ownerE);
    const saved = await saveKey("from_number", NUM);
    assert.equal(saved.status, 200, saved.text);
    await db.execute({ sql: "DELETE FROM channel_accounts WHERE tenant_id = ? AND provider = 'twilio'", args: [ECHO] });
    try {
      assert.deepEqual(await routeOf(BRAVO_CO), [[NUM, null, 1]], "the stale row is the only active one");
      assert.equal(
        (await inbound.resolveTwilioInboundTenant(shim as never, NUM, {}))?.tenantId,
        ECHO,
        "the current owner, found by the credential scan, not the stale row",
      );
      // A row whose workspace does hold its number is still believed.
      assert.equal((await inbound.resolveTwilioInboundTenant(shim as never, "+14165550101", {}))?.tenantId, ALPHA);
    } finally {
      await db.execute({
        sql: "UPDATE channel_accounts SET is_active = 0, from_phone = NULL WHERE tenant_id = ? AND provider = 'twilio'",
        args: [BRAVO_CO],
      });
      await removeKey("from_number");
    }
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
