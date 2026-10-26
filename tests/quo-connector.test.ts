/**
 * quo-connector.test.ts - Quo (formerly OpenPhone), the built-in SMS connector.
 *
 * WHY. CC, 2026-10-26: Twilio broke; he signed up for Quo and wants to set it
 * up in Settings > Connections and send texts from OASIS. The failures that
 * matter are quiet ones:
 *   - a text Quo refused (a US number before registration, an ended
 *     subscription, a daily limit) reported as sent;
 *   - the key sent as a Bearer token, or anywhere but api.quo.com, or shown
 *     in an answer or a log line;
 *   - a text sent while live texting is off, or to someone who replied STOP;
 *   - a client workspace texting through OASIS's Quo account, or an OASIS
 *     text going out through another provider while Quo is set up.
 *
 * Real store and encryption on a local libSQL file, and the real reply route
 * (app/api/conversations/reply) with a stand-in session. Quo is mocked at the
 * fetch boundary: any other host fails the test, so nothing reaches a real
 * provider and no text is ever sent.
 *
 * Run: node --conditions=react-server --import tsx tests/quo-connector.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { format } from "node:util";
import { createClient } from "@libsql/client";

const dbFile = join(mkdtempSync(join(tmpdir(), "quo-connector-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
process.env.BRAVO_FIELD_ENCRYPTION_KEY = "quo-connector-test-field-encryption-passphrase";
// No switch from the shell may decide a result here.
for (const name of [
  "QUO_API_KEY", "QUO_FROM_E164", "LIVE_SEND_QUO", "LIVE_SEND_TEXTTORRENT", "LIVE_SEND_KIXIE", "LIVE_SEND_TWILIO",
  "DASHBOARD_LIVE_SEND", "BRAVO_FORCE_DRY_RUN", "PROVIDER_QUO_ENABLED",
]) {
  delete process.env[name];
}

/** OASIS's own workspaces (isOasisInternalTenant, and the env-credential tenants). */
const OASIS = "ef8d389e-3f15-43f2-ae00-3660f69a1452";
const OASIS_WEBDEV = "42423fde-be8b-454f-932a-750e8c9b743d";
/** A client workspace with no Quo, and one that saved its own Quo key. */
const CLIENT = "c1c1c1c1-0000-4000-8000-0000000000c1";
const CLIENT_OWN = "c2c2c2c2-0000-4000-8000-0000000000c2";
/** SunBiz, retired 2026-09-28 (lib/tenant/retired.ts). */
const SUNBIZ = "aa04fa1f-ad6a-44b0-ac4b-2ff5d1067110";

// Key-shaped strings are built at run time, never written as one literal.
const key = (who: string) => ["quo", "test", who, "key", "0001"].join("-");
const OASIS_KEY = key("oasis");
const CLIENT_KEY = key("client");
const KEYS = [OASIS_KEY, CLIENT_KEY];

const QUO_NUMBER = "+13653603976";
const TO = "+14165550199";

// -- Every line the code logs is kept, so the test can prove no key reached a log ------------

const logged: string[] = [];
for (const level of ["error", "warn", "log", "info"] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    const line = format(...args);
    logged.push(line);
    if (/^\s+(ok|FAIL)\s|^quo-connector/.test(line)) original(line);
  };
}

// -- Quo, mocked at the fetch boundary ---------------------------------------------------------

type Call = { url: URL; method: string; headers: Headers; body: string; redirect?: RequestRedirect };
type QuoAnswer = (call: Call, init?: RequestInit) => Response | Promise<Response>;
const calls: Call[] = [];
let quo: QuoAnswer = () => {
  throw new Error("this check set no Quo answer");
};
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(href);
  if (url.hostname !== "api.quo.com") throw new Error(`unexpected network call in test: ${href}`);
  const call: Call = {
    url,
    method: (init?.method ?? "GET").toUpperCase(),
    headers: new Headers(init?.headers),
    body: typeof init?.body === "string" ? init.body : "",
    redirect: init?.redirect,
  };
  calls.push(call);
  return quo(call, init);
}) as typeof fetch;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const OPEN_CA = { CA: "unrestricted", US: "restricted", Intl: "restricted" };
/** One number as GET /v1/phone-numbers lists it. */
const numberRow = (number: string, messaging: Record<string, string> = OPEN_CA, name = "Primary") => ({
  id: `PN${number.slice(-4)}`,
  groupId: "1234",
  portRequestId: null,
  formattedNumber: number,
  forward: null,
  name,
  number,
  portingStatus: null,
  symbol: null,
  users: [],
  createdAt: "2026-10-26T00:00:00Z",
  updatedAt: "2026-10-26T00:00:00Z",
  restrictions: { messaging, calling: { CA: "unrestricted", US: "unrestricted", Intl: "restricted" } },
});

let messageSeq = 0;
/** A Quo that lists `numbers` and accepts every text, answering 202 as Quo does. */
const quoWith = (numbers: unknown[]): QuoAnswer => (call) => {
  if (call.method === "GET" && call.url.pathname === "/v1/phone-numbers") return json(200, { data: numbers });
  if (call.method === "POST" && call.url.pathname === "/v1/messages") {
    const sent = JSON.parse(call.body) as { content: string; from: string; to: string[] };
    messageSeq += 1;
    return json(202, {
      data: {
        id: `ACmsg${String(messageSeq).padStart(4, "0")}`,
        to: sent.to,
        from: sent.from,
        text: sent.content,
        phoneNumberId: "PN3976",
        conversationId: "CNconv0001",
        direction: "outgoing",
        userId: null,
        status: "queued",
        createdAt: "2026-10-26T12:00:00Z",
        updatedAt: "2026-10-26T12:00:00Z",
      },
    });
  }
  throw new Error(`unhandled Quo call ${call.method} ${call.url.pathname}`);
};

// -- Harness ------------------------------------------------------------------------------------

let failures = 0;
let passed = 0;
let finished = false;
// A run that stops early (a promise nothing will ever settle) must not exit 0.
process.on("exit", (code) => {
  if (code === 0 && !finished) {
    process.stderr.write(`quo-connector: stopped before the last check (${passed} passed)\n`);
    process.exitCode = 1;
  }
});
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

function stubModule(path: string, exports: Record<string, unknown>) {
  require.cache[path] = { id: path, filename: path, path: dirname(path), loaded: true, children: [], paths: [], exports } as unknown as NodeModule;
}

/** Live texting through Quo on, or the dashboard's default dry-run. */
function liveQuo(on: boolean) {
  if (on) process.env.LIVE_SEND_QUO = "1";
  else delete process.env.LIVE_SEND_QUO;
}

/** Flip one byte of the GCM ciphertext: the same shape as a value sealed under another key. */
function tamper(packed: string): string {
  const [iv, tag, ct] = packed.split(".");
  const bytes = Buffer.from(ct, "base64");
  bytes[0] ^= 0xff;
  return `${iv}.${tag}.${bytes.toString("base64")}`;
}

async function main() {
  const db = createClient({ url: `file:${dbFile}` });
  await db.executeMultiple(`
    CREATE TABLE tenant_integration_credentials (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      tenant_id TEXT NOT NULL, service TEXT NOT NULL, field_key TEXT NOT NULL, encrypted_value TEXT NOT NULL,
      last_tested_at TEXT, last_test_ok INTEGER, last_test_error TEXT, created_by TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
    CREATE UNIQUE INDEX tic_key ON tenant_integration_credentials (tenant_id, service, field_key);
    CREATE TABLE lead_interactions (id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      tenant_id TEXT, lead_id TEXT, type TEXT, channel TEXT, direction TEXT, agent_source TEXT, provider TEXT,
      provider_message_id TEXT, to_phone TEXT, to_email TEXT, from_phone TEXT, from_email TEXT, subject TEXT,
      content TEXT, content_preview TEXT, actor_user_id TEXT, metadata TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
    CREATE UNIQUE INDEX ux_lead_interactions_provider_msg ON lead_interactions (provider, provider_message_id);
    CREATE TABLE sunbiz_phone_suppressions (tenant_id TEXT, phone_last10 TEXT);
    CREATE TABLE _realtime_nudges (scope TEXT PRIMARY KEY, bumped_at TEXT);
  `);

  const schemas = await import("../lib/tenant-integration-schemas");
  const store = await import("../lib/tenant-integration-store");
  const quoLib = await import("../lib/integrations/quo");
  const probes = await import("../lib/integrations/key-probes");
  const connectors = await import("../lib/os/connectors");
  const routing = await import("../lib/routing/outbound-routing");
  const { loadProviderAvailability } = await import("../lib/routing/provider-availability");
  const { isDryRun } = await import("../lib/integrations/send-mode");
  const { encryptField } = await import("../lib/field-encryption");

  // The real reply route, signed in as an owner of whichever workspace a check names.
  const realApiAuth = await import("../lib/api-auth");
  let session: Record<string, unknown> = { ok: false, reason: "no_session" };
  stubModule(require.resolve("../lib/api-auth"), { ...realApiAuth, resolveSessionContext: async () => session });
  const replyRoute = await import("../app/api/conversations/reply/route");
  const { NextRequest } = await import("next/server");
  const answers: string[] = [];
  const reply = async (tenantId: string, body: Record<string, unknown>) => {
    session = {
      ok: true, userId: "0e000000-0000-4000-8000-000000000001", profileId: "p-owner", tenantId,
      email: "owner@workspace.test", teamRole: "owner", isAdmin: true, isTrueAdmin: true, adminAccess: false,
    };
    const res = await replyRoute.POST(
      new NextRequest("https://oasisai.work/api/conversations/reply", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    const text = await res.text();
    answers.push(text);
    return { status: res.status, body: JSON.parse(text) as Record<string, unknown> };
  };
  const quoRows = async (tenantId: string) =>
    (await db.execute({ sql: "SELECT provider, provider_message_id, to_phone, channel, direction FROM lead_interactions WHERE tenant_id = ? ORDER BY created_at", args: [tenantId] })).rows;

  console.log("quo-connector:");

  // ===========================================================================================
  // 1. Setup: the form, the server values, the stored key
  // ===========================================================================================

  await check("Settings > Connections > Quo: one API key, kept secret, and an optional From number in E.164, with a link to where the key is made", () => {
    const schema = schemas.findTenantManuallyEditableIntegrationSchema("quo");
    assert.ok(schema, "an owner can save Quo keys");
    assert.equal(schema!.label, "Quo");
    assert.deepEqual(schema!.fields.map((f) => f.key), ["api_key", "from_number"]);
    const [apiKey, from] = schema!.fields;
    assert.equal(apiKey.sensitive, true, "the key is a password field");
    assert.equal(from.sensitive, false);
    assert.equal(from.validation, "phone_e164");
    assert.deepEqual(schemas.requiredIntegrationFieldKeys(schema!), ["api_key"], "a workspace with one number needs only the key");
    for (const f of schema!.fields) assert.ok(f.hint?.trim(), `${f.key}: says where its value comes from`);
    assert.match(schema!.getKey?.href ?? "", /^https:\/\/www\.quo\.com\//);
    assert.equal(schemas.validateIntegrationValue(from, QUO_NUMBER), null);
    for (const bad of ["3653603976", "(365) 360-3976", "+1 365 360 3976"]) {
      assert.ok(schemas.validateIntegrationValue(from, bad), `${bad} is refused`);
    }
    assert.equal(schemas.validateIntegrationValue(apiKey, OASIS_KEY), null);
    assert.ok(schemas.validateIntegrationValue(apiKey, "has a space in it"), "a key with a space is refused");
    const src = readFileSync(join(__dirname, "..", "lib/tenant-integration-schemas.ts"), "utf8");
    for (const cited of ["quo.com/docs/mdx/api-reference/authentication", "quo.com/docs/mdx/api-reference/messages/send-a-text-message"]) {
      assert.ok(src.includes(cited), `the schema cites ${cited}`);
    }
  });

  await check("OASIS's own server values are QUO_API_KEY and QUO_FROM_E164, and only OASIS's own workspaces get them", async () => {
    assert.deepEqual(store.ENV_FALLBACKS.quo, { api_key: "QUO_API_KEY", from_number: "QUO_FROM_E164" });
    process.env.QUO_API_KEY = OASIS_KEY;
    try {
      for (const t of [OASIS, OASIS_WEBDEV]) {
        const creds = await quoLib.getQuoCredentials(t);
        assert.equal(creds.apiKey, OASIS_KEY);
        assert.equal(creds.fromNumber, null, "no From number: the workspace's only number is used");
      }
      process.env.QUO_FROM_E164 = QUO_NUMBER;
      assert.equal((await quoLib.getQuoCredentials(OASIS)).fromNumber, QUO_NUMBER);
      for (const t of [CLIENT, SUNBIZ, OASIS.toUpperCase(), ""]) {
        await assert.rejects(
          quoLib.getQuoCredentials(t),
          (e: unknown) => e instanceof quoLib.QuoError && e.code === "missing_credentials",
          `${t || "(empty)"} must not get OASIS's key`,
        );
        assert.equal(await quoLib.quoCredentialsOrNull(t), null);
      }
    } finally {
      delete process.env.QUO_API_KEY;
      delete process.env.QUO_FROM_E164;
    }
    assert.equal(await quoLib.quoCredentialsOrNull(OASIS), null, "no key anywhere: Quo is not set up");
  });

  await check("a client workspace's own saved key is stored encrypted and used for that workspace only", async () => {
    const saved = await store.setTenantIntegrationValue({ tenantId: CLIENT_OWN, service: "quo", fieldKey: "api_key", value: CLIENT_KEY });
    assert.equal(saved.ok, true);
    const row = await db.execute({
      sql: "SELECT encrypted_value FROM tenant_integration_credentials WHERE tenant_id = ? AND service = 'quo' AND field_key = 'api_key'",
      args: [CLIENT_OWN],
    });
    assert.ok(!String(row.rows[0].encrypted_value).includes(CLIENT_KEY), "the key is not stored readable");
    process.env.QUO_API_KEY = OASIS_KEY;
    try {
      const creds = await quoLib.getQuoCredentials(CLIENT_OWN);
      assert.equal(creds.apiKey, CLIENT_KEY, "the client's own key, never OASIS's");
      assert.equal(creds.fromNumber, null);
    } finally {
      delete process.env.QUO_API_KEY;
    }
  });

  await check("a saved Quo key that will not decrypt is an error to fix, never 'not set up'", async () => {
    await db.execute({
      sql: "INSERT INTO tenant_integration_credentials (tenant_id, service, field_key, encrypted_value) VALUES (?, 'quo', 'api_key', ?)",
      args: [OASIS_WEBDEV, tamper(encryptField(key("webdev")))],
    });
    process.env.QUO_API_KEY = OASIS_KEY;
    try {
      await assert.rejects(
        quoLib.getQuoCredentials(OASIS_WEBDEV),
        (e: unknown) => e instanceof quoLib.QuoError && e.code === "credentials_unreadable",
        "OASIS's server key must not stand in for a saved key that cannot be read",
      );
      await assert.rejects(quoLib.quoCredentialsOrNull(OASIS_WEBDEV), /could not read the saved Quo API key/);
      const avail = await loadProviderAvailability(OASIS_WEBDEV);
      assert.equal(avail.quo.configured, false, "an unreadable key is not configured");
    } finally {
      delete process.env.QUO_API_KEY;
    }
  });

  // ===========================================================================================
  // 2. Sending
  // ===========================================================================================

  await check("a text is one POST to https://api.quo.com/v1/messages: the raw key (no Bearer), JSON, {content, from, to: [number]}", async () => {
    liveQuo(true);
    try {
      calls.length = 0;
      quo = quoWith([numberRow(QUO_NUMBER)]);
      const r = await quoLib.sendQuoSms({ tenantId: OASIS, apiKey: OASIS_KEY, fromNumber: QUO_NUMBER }, { to: TO, text: "  Hi from OASIS  " });
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.deepEqual(r, { ok: true, id: `ACmsg${String(messageSeq).padStart(4, "0")}`, status: "queued", conversationId: "CNconv0001", from: QUO_NUMBER });
      assert.equal(calls.length, 1, "a saved From number needs no lookup");
      const [c] = calls;
      assert.equal(c.url.href, "https://api.quo.com/v1/messages");
      assert.equal(c.method, "POST");
      assert.equal(c.headers.get("authorization"), OASIS_KEY, "the raw key, as Quo documents it");
      assert.equal(c.headers.get("content-type"), "application/json");
      assert.equal(c.redirect, "manual", "a redirect never carries the key anywhere");
      assert.deepEqual(JSON.parse(c.body), { content: "Hi from OASIS", from: QUO_NUMBER, to: [TO] });
    } finally {
      liveQuo(false);
    }
  });

  await check("the sender: the saved From number as it is; else the workspace's only number; no number or several is a failure that says what to do", async () => {
    liveQuo(true);
    try {
      const creds = { tenantId: OASIS, apiKey: OASIS_KEY, fromNumber: null };
      calls.length = 0;
      quo = quoWith([numberRow(QUO_NUMBER)]);
      const sole = await quoLib.sendQuoSms(creds, { to: TO, text: "Hello" });
      assert.equal(sole.ok, true, JSON.stringify(sole));
      assert.equal(sole.ok && sole.from, QUO_NUMBER);
      assert.deepEqual(calls.map((c) => `${c.method} ${c.url.pathname}`), ["GET /v1/phone-numbers", "POST /v1/messages"]);
      assert.equal(calls[0].headers.get("authorization"), OASIS_KEY);
      assert.equal(JSON.parse(calls[1].body).from, QUO_NUMBER);
      assert.deepEqual(await quoLib.quoSender({ ...creds, fromNumber: "+15195550123" }), { ok: true, number: "+15195550123", source: "configured" });

      const cases: Array<[unknown[], RegExp]> = [
        [[], /no phone number/],
        [[numberRow(QUO_NUMBER), numberRow("+14165550100", OPEN_CA, "Second")], /has 2 numbers.*From number/],
      ];
      for (const [numbers, words] of cases) {
        calls.length = 0;
        quo = quoWith(numbers);
        const r = await quoLib.sendQuoSms(creds, { to: TO, text: "Hello" });
        assert.equal(r.ok, false);
        assert.equal(r.ok === false && r.code, "no_sender");
        assert.match(r.ok === false ? r.reason : "", words);
        assert.deepEqual(calls.map((c) => c.method), ["GET"], "nothing was sent");
      }
      // The number list itself refused: Quo's status is kept and nothing is sent.
      calls.length = 0;
      quo = () => json(401, { error: { message: "Invalid API key", key: "Unauthorized" } });
      const refused = await quoLib.sendQuoSms(creds, { to: TO, text: "Hello" });
      assert.equal(refused.ok === false && refused.code, "quo_refused");
      assert.equal(refused.ok === false && refused.status, 401);
      assert.deepEqual(calls.map((c) => c.method), ["GET"]);
    } finally {
      liveQuo(false);
    }
  });

  await check("every refusal is a failed send in Quo's own words with its HTTP status: never a success, never the key", async () => {
    liveQuo(true);
    try {
      const creds = { tenantId: OASIS, apiKey: OASIS_KEY, fromNumber: QUO_NUMBER };
      const cases: Array<[number, unknown, RegExp, number]> = [
        [400, { message: "Your organization's A2P registration is not approved.", code: "0206400", status: 400, title: "A2P Registration Not Approved", docs: "https://quo.com/docs" },
          /^Quo refused the text \(HTTP 400\): A2P Registration Not Approved: Your organization's A2P registration is not approved\.$/, 502],
        [401, { error: { message: `Invalid API key ${OASIS_KEY}`, key: "Unauthorized" } },
          /^Quo refused the text \(HTTP 401\): Invalid API key \[key\]\. Check the Quo API key in Settings > Connections > Quo\.$/, 502],
        [402, { title: "Subscription Expired", message: "Your subscription has expired", status: 402 }, /\(HTTP 402\): Subscription Expired: Your subscription has expired/, 502],
        [403, { title: "International Messaging Not Allowed", message: "The recipient is outside the allowed regions.", status: 403 }, /\(HTTP 403\): International Messaging Not Allowed/, 502],
        [429, { title: "Daily Conversation Limit Reached", message: "Try again tomorrow.", status: 429 }, /\(HTTP 429\): Daily Conversation Limit Reached/, 429],
        [500, { title: "Unknown", message: "Unexpected error", status: 500 }, /\(HTTP 500\): Unknown: Unexpected error/, 502],
      ];
      for (const [status, body, words, routeStatus] of cases) {
        quo = () => json(status, body);
        const r = await quoLib.sendQuoSms(creds, { to: TO, text: "Hello" });
        assert.equal(r.ok, false, `HTTP ${status} must never read as sent`);
        if (r.ok) continue;
        assert.equal(r.code, "quo_refused");
        assert.equal(r.status, status);
        assert.match(r.reason, words);
        assert.ok(!JSON.stringify(r).includes(OASIS_KEY), `HTTP ${status}: the key is in the answer`);
        assert.equal(quoLib.quoFailureHttpStatus(r), routeStatus, `HTTP ${status}: what the route answers`);
      }
      // No JSON in the answer: still a failure with the status.
      quo = () => new Response("<html>bad gateway</html>", { status: 503 });
      const html = await quoLib.sendQuoSms(creds, { to: TO, text: "Hello" });
      assert.equal(html.ok === false && html.reason, "Quo refused the text (HTTP 503).");
      // A redirect is not followed and is not a success.
      quo = () => new Response(null, { status: 302, headers: { location: "https://elsewhere.example/" } });
      const moved = await quoLib.sendQuoSms(creds, { to: TO, text: "Hello" });
      assert.equal(moved.ok === false && moved.status, 302);
      // No answer at all: OASIS cannot know whether the text went out, and says so.
      quo = () => {
        throw new TypeError("fetch failed");
      };
      const down = await quoLib.sendQuoSms(creds, { to: TO, text: "Hello" });
      assert.equal(down.ok === false && down.code, "quo_unreachable");
      assert.equal(down.ok === false ? down.status : "sent", undefined);
      assert.match(down.ok === false ? down.reason : "", /cannot tell whether the text went out/);
      // A Quo that never answers is cut off by the timeout, and answered the same way.
      // (AbortSignal.timeout's timer does not hold the process open; this one does.)
      quo = (_call, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
        });
      const holdOpen = setTimeout(() => undefined, 5_000);
      try {
        const slow = await quoLib.sendQuoSms(creds, { to: TO, text: "Hello" }, { timeoutMs: 30 });
        assert.equal(slow.ok === false && slow.code, "quo_unreachable");
      } finally {
        clearTimeout(holdOpen);
      }
    } finally {
      liveQuo(false);
    }
  });

  await check("nothing reaches Quo while live texting is off, for a retired workspace, for someone who replied STOP, or for a bad number or an empty text", async () => {
    const creds = { tenantId: OASIS, apiKey: OASIS_KEY, fromNumber: QUO_NUMBER };
    const codeOf = async (c: typeof creds, input: { to: string; text: string }) => {
      const r = await quoLib.sendQuoSms(c, input);
      return r.ok ? "sent" : r.code;
    };
    quo = quoWith([numberRow(QUO_NUMBER)]);
    calls.length = 0;
    try {
      assert.equal(await codeOf(creds, { to: TO, text: "Hello" }), "live_send_disabled", "the dashboard starts in dry-run");
      process.env.LIVE_SEND_QUO = "1";
      process.env.BRAVO_FORCE_DRY_RUN = "1";
      assert.equal(await codeOf(creds, { to: TO, text: "Hello" }), "live_send_disabled", "the kill switch wins over LIVE_SEND_QUO");
      delete process.env.BRAVO_FORCE_DRY_RUN;
      // Quo has its own switch; the dashboard-wide one covers it too, as it covers Twilio.
      assert.equal(isDryRun("quo"), false);
      delete process.env.LIVE_SEND_QUO;
      process.env.DASHBOARD_LIVE_SEND = "1";
      assert.equal(isDryRun("quo"), false);
      process.env.LIVE_SEND_QUO = "0";
      assert.equal(isDryRun("quo"), true, "LIVE_SEND_QUO=0 holds Quo alone");
      delete process.env.DASHBOARD_LIVE_SEND;
      liveQuo(true);

      assert.equal(await codeOf({ ...creds, tenantId: SUNBIZ }, { to: TO, text: "Hello" }), "tenant_retired");
      for (const to of ["4165550199", "+1 416 555 0199", ""]) {
        assert.equal(await codeOf(creds, { to, text: "Hello" }), "invalid_recipient", JSON.stringify(to));
      }
      for (const text of ["", "   ", "x".repeat(1601)]) {
        assert.equal(await codeOf(creds, { to: TO, text }), "invalid_text", `${text.length} characters`);
      }
      await db.execute({ sql: "INSERT INTO sunbiz_phone_suppressions (tenant_id, phone_last10) VALUES (?, ?)", args: [OASIS, "4165550199"] });
      assert.equal(await codeOf(creds, { to: TO, text: "Hello" }), "recipient_opted_out");
      await db.execute({ sql: "DELETE FROM sunbiz_phone_suppressions WHERE tenant_id = ?", args: [OASIS] });
      // The STOP list cannot be read: the send fails closed (CASL / TCPA).
      await db.execute("ALTER TABLE sunbiz_phone_suppressions RENAME TO sunbiz_phone_suppressions_hidden");
      try {
        assert.equal(await codeOf(creds, { to: TO, text: "Hello" }), "opt_out_check_failed");
      } finally {
        await db.execute("ALTER TABLE sunbiz_phone_suppressions_hidden RENAME TO sunbiz_phone_suppressions");
      }
      assert.equal(calls.length, 0, `nothing may reach Quo, got ${calls.map((c) => c.url.pathname).join(", ")}`);
      assert.equal(await codeOf(creds, { to: TO, text: "Hello" }), "sent", "control: the same text goes out once nothing stops it");
    } finally {
      liveQuo(false);
      delete process.env.BRAVO_FORCE_DRY_RUN;
      delete process.env.DASHBOARD_LIVE_SEND;
    }
  });

  // ===========================================================================================
  // 3. The Test button and the card
  // ===========================================================================================

  await check("Test lists the numbers, sends no text, and names the number and where it may text", async () => {
    assert.equal(probes.hasKeyProbe("quo"), true);
    calls.length = 0;
    quo = quoWith([numberRow(QUO_NUMBER)]);
    assert.deepEqual(await probes.runKeyProbe("quo", { api_key: OASIS_KEY }), {
      ok: true,
      detail: "+1 365 360 3976: Canada yes, US waiting on registration, international off",
    });
    assert.deepEqual(calls.map((c) => `${c.method} ${c.url.href}`), ["GET https://api.quo.com/v1/phone-numbers"]);
    assert.equal(calls[0].headers.get("authorization"), OASIS_KEY);
    assert.equal(calls[0].redirect, "manual");

    quo = quoWith([numberRow("+14165550100", { CA: "unrestricted", US: "unrestricted", Intl: "unrestricted" }, "Main"), numberRow(QUO_NUMBER)]);
    assert.deepEqual(await probes.runKeyProbe("quo", { api_key: OASIS_KEY, from_number: "+14165550100" }), {
      ok: true,
      detail: "+1 416 555 0100: Canada yes, US yes, international yes",
    });
    assert.deepEqual(await probes.runKeyProbe("quo", { api_key: OASIS_KEY, from_number: "+15195550123" }), { ok: false, error: "not_found" });
    assert.deepEqual(await probes.runKeyProbe("quo", { api_key: OASIS_KEY }), { ok: false, error: "needs_number" });
    quo = quoWith([]);
    assert.deepEqual(await probes.runKeyProbe("quo", { api_key: OASIS_KEY }), { ok: false, error: "no_number" });

    const shared: Array<[QuoAnswer, string]> = [
      [() => json(401, { error: { message: "Unauthorized", key: "Unauthorized" } }), "key_rejected"],
      [() => json(402, { title: "Subscription Expired" }), "plan_required"],
      [() => json(403, { title: "Forbidden" }), "missing_permission"],
      [() => json(429, { title: "Too Many Requests" }), "rate_limited"],
      [() => json(500, { title: "Unknown" }), "provider_error: http 500"],
      [() => json(200, { nothing: true }), "provider_error: no number list in the answer"],
      [() => { throw new TypeError("fetch failed"); }, "provider_unreachable: TypeError"],
    ];
    for (const [answer, code] of shared) {
      quo = answer;
      assert.deepEqual(await probes.runKeyProbe("quo", { api_key: OASIS_KEY }), { ok: false, error: code });
    }
    calls.length = 0;
    assert.deepEqual(await probes.runKeyProbe("quo", { from_number: QUO_NUMBER }), {
      ok: false,
      error: "missing_fields: api_key",
      noLiveCheck: true,
    });
    assert.equal(calls.length, 0, "nothing is asked without a key");
  });

  await check("the Quo card: live in Messaging & chat, read from the key store, green only after a passing Test, and every Test answer in plain words", () => {
    const def = connectors.connectorBySlug("quo");
    assert.ok(def, "the hub lists Quo");
    assert.equal(def!.name, "Quo");
    assert.equal(def!.summary, "Business texting from your Quo number");
    assert.equal(def!.category, "messaging");
    assert.deepEqual(def!.departments, ["sales", "client_success"]);
    assert.deepEqual(def!.keywords, ["openphone", "sms", "text"]);
    assert.equal(def!.icon.kind, "monogram");
    assert.equal(def!.brandColor, null);
    assert.ok(connectors.connectorMatches(def!, "openphone"), "searching the old name finds it");
    const source = def!.live!.source as { kind: string; service: string; requireAll: readonly string[]; verifiable: boolean };
    assert.equal(source.kind, "tenant_keys");
    assert.equal(source.service, "quo");
    assert.deepEqual(source.requireAll, ["api_key"]);
    assert.equal(source.verifiable, true, "its Test calls Quo, so a pass can prove the key");
    assert.deepEqual(def!.live!.connect, { kind: "keys", label: "Connect Quo", service: "quo" });
    for (const code of [
      "key_rejected", "missing_permission", "plan_required", "rate_limited", "provider_unreachable: TypeError",
      "provider_error: http 500", "not_found", "needs_number", "no_number", "missing_fields: api_key",
    ]) {
      const words = connectors.testFailureWords("quo", code);
      assert.ok(words, `${code}: no words on the card`);
      assert.doesNotMatch(`${words!.label} ${words!.detail}`, /_/, `${code}: a code in the words`);
    }
    assert.equal(connectors.testFailureWords("quo", "needs_number")!.label, "Choose the number to text from");

    const now = Date.parse("2026-10-26T12:00:00Z");
    const minuteAgo = new Date(now - 60_000).toISOString();
    const row = (over: Record<string, unknown> = {}) => ({
      service: "quo", field_key: "api_key", has_value: true, last_tested_at: null, last_test_ok: null, last_test_error: null, ...over,
    });
    const status = (keyRows: unknown[]) => connectors.resolveConnectorStatus(def!, { keyRows, connections: [] } as never, now);
    assert.equal(status([]).kind, "not_connected");
    assert.equal(status([row()]).kind, "configured", "a saved key nothing has tested is never green");
    assert.equal(status([row({ last_test_ok: true, last_tested_at: minuteAgo })]).kind, "connected");
    const failed = status([row({ last_test_ok: false, last_tested_at: minuteAgo, last_test_error: "needs_number" })]);
    assert.equal(failed.kind, "attention");
    assert.equal(failed.label, "Choose the number to text from");
  });

  // ===========================================================================================
  // 4. Which provider sends: OASIS through Quo, clients unchanged
  // ===========================================================================================

  await check("the rule: an OASIS workspace texts through Quo whenever it is set up; a client keeps its provider; naming Quo means Quo", () => {
    for (const requested of ["texttorrent", "kixie", "twilio", "quo"] as const) {
      for (const t of [OASIS, OASIS_WEBDEV]) {
        assert.equal(routing.chooseSmsProvider({ requested, tenantId: t, quoReady: true }), "quo", `OASIS asking for ${requested}`);
      }
      assert.equal(
        routing.chooseSmsProvider({ requested, tenantId: OASIS, quoReady: false }),
        requested,
        `OASIS without Quo keeps ${requested}`,
      );
      assert.equal(routing.chooseSmsProvider({ requested, tenantId: CLIENT, quoReady: true }), requested, `a client asking for ${requested} keeps it`);
    }
    for (const notOasis of [OASIS.toUpperCase(), "oasis-ai-cc", "", null, undefined]) {
      assert.equal(routing.chooseSmsProvider({ requested: "texttorrent", tenantId: notOasis, quoReady: true }), "texttorrent", String(notOasis));
    }
    assert.equal(routing.smsMayUseQuo({ requested: "texttorrent", tenantId: CLIENT }), false, "a client's ordinary send never reads the Quo key");
    assert.equal(routing.smsMayUseQuo({ requested: "quo", tenantId: CLIENT }), true);
    // The drip lanes never name Quo: SunBiz and Bluerise keep their providers even with Quo live.
    const on = { configured: true, enabled: true };
    const all = { gws: on, gws_bluerise: on, texttorrent: on, twilio: on, quo: on };
    const sunbiz = routing.routeOutbound({ channel: "sms", purpose: "drip", brand: "sunbiz", available: all });
    const bluerise = routing.routeOutbound({ channel: "sms", purpose: "drip", brand: "bluerise", available: all });
    assert.equal(sunbiz.send && sunbiz.provider, "texttorrent");
    assert.equal(bluerise.send && bluerise.provider, "twilio");
  });

  await check("Quo counts as an available provider exactly when getQuoCredentials resolves, and PROVIDER_QUO_ENABLED=0 switches it off", async () => {
    process.env.QUO_API_KEY = OASIS_KEY;
    try {
      for (const t of [OASIS, CLIENT, CLIENT_OWN, SUNBIZ]) {
        const avail = await loadProviderAvailability(t);
        const resolves = (await quoLib.quoCredentialsOrNull(t)) !== null;
        assert.deepEqual(avail.quo, { configured: resolves, enabled: resolves }, t);
      }
      assert.equal((await loadProviderAvailability(OASIS)).quo.configured, true, "anti-vacuity: OASIS's server key counts for OASIS");
      assert.equal((await loadProviderAvailability(CLIENT)).quo.configured, false, "OASIS's server key is never a client's");
      process.env.PROVIDER_QUO_ENABLED = "0";
      assert.deepEqual((await loadProviderAvailability(OASIS)).quo, { configured: true, enabled: false });
    } finally {
      delete process.env.QUO_API_KEY;
      delete process.env.PROVIDER_QUO_ENABLED;
    }
  });

  // ===========================================================================================
  // 5. The real send path: POST /api/conversations/reply
  // ===========================================================================================

  await check("reply route: an OASIS text from the inbox or a lead goes out through Quo, once each, from the workspace's number, logged as a Quo text", async () => {
    process.env.QUO_API_KEY = OASIS_KEY;
    liveQuo(true);
    try {
      for (const asked of ["texttorrent", "kixie"]) {
        calls.length = 0;
        quo = quoWith([numberRow(QUO_NUMBER)]);
        const before = (await quoRows(OASIS)).length;
        const r = await reply(OASIS, { to_phone: TO, message: `Hi, this is OASIS (${asked}).`, provider: asked });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.equal(r.body.ok, true);
        assert.equal(r.body.dry_run, false);
        assert.equal(r.body.provider, "quo", `the inbox asked for ${asked}`);
        assert.equal(r.body.tracking_warning, null);
        assert.deepEqual(calls.map((c) => `${c.method} ${c.url.pathname}`), ["GET /v1/phone-numbers", "POST /v1/messages"]);
        assert.deepEqual(JSON.parse(calls[1].body), { content: `Hi, this is OASIS (${asked}).`, from: QUO_NUMBER, to: [TO] });
        const rows = await quoRows(OASIS);
        assert.equal(rows.length, before + 1, "one timeline row per text");
        const last = rows[rows.length - 1];
        assert.equal(last.provider, "quo");
        assert.equal(last.provider_message_id, `ACmsg${String(messageSeq).padStart(4, "0")}`);
        assert.equal(last.to_phone, TO);
        assert.equal(last.direction, "outbound");
      }
    } finally {
      liveQuo(false);
      delete process.env.QUO_API_KEY;
    }
  });

  await check("reply route: dry-run names Quo and sends nothing; STOP is refused before Quo; a Quo refusal is a failed send in Quo's words", async () => {
    process.env.QUO_API_KEY = OASIS_KEY;
    try {
      calls.length = 0;
      quo = quoWith([numberRow(QUO_NUMBER)]);
      const dry = await reply(OASIS, { to_phone: TO, message: "Hello", provider: "texttorrent" });
      assert.equal(dry.status, 200);
      assert.deepEqual([dry.body.ok, dry.body.dry_run, dry.body.provider], [true, true, "quo"]);

      liveQuo(true);
      await db.execute({ sql: "INSERT INTO sunbiz_phone_suppressions (tenant_id, phone_last10) VALUES (?, ?)", args: [OASIS, "4165550199"] });
      const stopped = await reply(OASIS, { to_phone: TO, message: "Hello", provider: "texttorrent" });
      await db.execute({ sql: "DELETE FROM sunbiz_phone_suppressions WHERE tenant_id = ?", args: [OASIS] });
      assert.equal(stopped.status, 409);
      assert.equal(stopped.body.error, "opted_out");
      assert.equal(calls.length, 0, "nothing reached Quo");

      const before = (await quoRows(OASIS)).length;
      quo = (call) =>
        call.method === "GET"
          ? json(200, { data: [numberRow(QUO_NUMBER)] })
          : json(400, { title: "A2P Registration Not Approved", message: "Your organization's A2P registration is not approved.", status: 400 });
      const refused = await reply(OASIS, { to_phone: "+12125550100", message: "Hello", provider: "texttorrent" });
      assert.equal(refused.status, 502);
      assert.equal(refused.body.ok, false);
      assert.equal(refused.body.error, "quo_refused");
      assert.match(String(refused.body.message), /A2P Registration Not Approved/);
      assert.equal((await quoRows(OASIS)).length, before, "a refused text is not on the timeline as sent");
    } finally {
      liveQuo(false);
      delete process.env.QUO_API_KEY;
    }
  });

  await check("reply route: a client keeps its own provider, Quo or not; naming Quo uses only the client's own key; OASIS's key never sends for a client", async () => {
    process.env.QUO_API_KEY = OASIS_KEY;
    liveQuo(true);
    try {
      quo = quoWith([numberRow(QUO_NUMBER)]);
      calls.length = 0;
      for (const t of [CLIENT, CLIENT_OWN]) {
        const r = await reply(t, { to_phone: TO, message: "Hello", provider: "texttorrent" });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.equal(r.body.provider, "texttorrent", `${t}: keeps TextTorrent (still in dry-run)`);
        assert.equal(r.body.dry_run, true);
      }
      assert.equal(calls.length, 0, "no Quo call for a client's ordinary text");

      const own = await reply(CLIENT_OWN, { to_phone: TO, message: "Hello from the client", provider: "quo" });
      assert.equal(own.status, 200, JSON.stringify(own.body));
      assert.equal(own.body.provider, "quo");
      assert.ok(calls.length >= 1 && calls.every((c) => c.headers.get("authorization") === CLIENT_KEY), "the client's own key, and only it");

      calls.length = 0;
      const none = await reply(CLIENT, { to_phone: TO, message: "Hello", provider: "quo" });
      assert.equal(none.status, 400);
      assert.equal(none.body.error, "missing_credentials");
      assert.match(String(none.body.message), /Quo is not set up/);
      assert.equal(calls.length, 0, "OASIS's key never sends for a client");
    } finally {
      liveQuo(false);
      delete process.env.QUO_API_KEY;
    }
  });

  await check("reply route: OASIS without Quo keeps its old provider; with a saved key that cannot be read, nothing goes out through another provider", async () => {
    calls.length = 0;
    const plain = await reply(OASIS, { to_phone: TO, message: "Hello", provider: "texttorrent" });
    assert.equal(plain.status, 200);
    assert.deepEqual([plain.body.provider, plain.body.dry_run], ["texttorrent", true]);

    process.env.QUO_API_KEY = OASIS_KEY;
    try {
      const broken = await reply(OASIS_WEBDEV, { to_phone: TO, message: "Hello", provider: "texttorrent" });
      assert.equal(broken.status, 503);
      assert.equal(broken.body.error, "quo_unavailable");
      assert.match(String(broken.body.message), /could not read the saved Quo API key/);
    } finally {
      delete process.env.QUO_API_KEY;
    }
    assert.equal(calls.length, 0);
  });

  await check("no answer and no log line ever held a Quo key", () => {
    for (const k of KEYS) {
      for (const line of logged) assert.ok(!line.includes(k), `a log line held a key: ${line.slice(0, 160)}`);
      for (const a of answers) assert.ok(!a.includes(k), `a route answer held a key: ${a.slice(0, 160)}`);
    }
    assert.ok(answers.length >= 10, "anti-vacuity: the route answered");
  });

  finished = true;
  if (failures > 0) {
    console.log(`quo-connector: ${failures} failed, ${passed} passed`);
    process.exit(1);
  }
  console.log(`quo-connector: all passed (${passed} passed)`);
}

main().catch((err) => {
  process.stderr.write(`quo-connector: crashed\n${(err as Error)?.stack ?? String(err)}\n`);
  process.exit(1);
});
