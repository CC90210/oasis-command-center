/**
 * jev-client.test.ts - Jev (TypeSafe System One) as OASIS uses it: the
 * client's wire contract and limits, the shadow mode, the telemetry, and the
 * pasted-key connection.
 *
 * WHY. Jev is a third-party model that sees workspace text, so the failures
 * that matter are: a slow Jev holding a request (it must give up at 2 s), a
 * retry storm, an answer that is quietly wrong in shape, shadow mode that
 * CHANGES what OASIS decided, message text written into telemetry, a client
 * workspace that shadows without anyone choosing it, and a key saved without
 * TypeSafe accepting it.
 *
 * The client runs against a fake fetch that speaks the wire format read from
 * the installed typesafe-sdk 0.7.1 (constants.py, endpoints.py,
 * _schemas/models.py). The connection runs the real route, session, store and
 * encryption on a local libSQL file. No request leaves the process.
 *
 * Run: node --conditions=react-server --import tsx tests/jev-client.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createClient } from "@libsql/client";

const dbFile = join(mkdtempSync(join(tmpdir(), "jev-client-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
process.env.EMPIRE_AUTH_BACKEND = "turso";
process.env.AUTH_SESSION_SECRET = "jev-client-test-session-secret-long-enough-000001";
process.env.BRAVO_FIELD_ENCRYPTION_KEY = "jev-client-test-field-encryption-passphrase";

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

const OASIS = "ef8d389e-3f15-43f2-ae00-3660f69a1452";
const CLIENT = "c3c3c3c3-0000-4000-8000-0000000000c3";
const GOOD_KEY = "ts_live_0123456789abcdefGOOD";
const DEAD_KEY = "ts_live_0123456789abcdefDEAD";
const OWNER = { id: "0e000000-0000-4000-8000-000000000001", email: "owner@client.test" };

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

type Call = { url: string; method: string; headers: Headers; body: Record<string, unknown> | null };
/** A fake TypeSafe: each call gets the next scripted answer. */
function fakeJev(script: Array<(call: Call, signal: AbortSignal | undefined) => Promise<Response> | Response>) {
  const calls: Call[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const call: Call = { url, method: (init?.method || "GET").toUpperCase(), headers: new Headers(init?.headers), body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null };
    calls.push(call);
    const next = script[Math.min(calls.length - 1, script.length - 1)];
    return next(call, init?.signal ?? undefined);
  }) as typeof fetch;
  return { impl, calls };
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const hang = (_c: Call, signal: AbortSignal | undefined) =>
  new Promise<Response>((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
  });
const QUESTIONS = {
  priority: { type: "choice" as const, instructions: "How urgent?", criteria: { low: "Can wait", high: "Today" } },
};
const answer = (choice: string) =>
  json(200, { model: "jev-2026-09-15", answers: { priority: { type: "choice", choice, confidence: 0.91, probabilities: { low: 0.09, high: 0.91 } } }, usage: { input_tokens: 42, output_tokens: 3 } });

async function main() {
  const jev = await import("../lib/jev/client");
  const mode = await import("../lib/jev/mode");

  console.log("jev-client:");

  // ── 1. The wire contract ────────────────────────────────────────────────

  await check("classify posts the SDK's request to /v1/systemone with a Bearer key and reads the typed answer", async () => {
    const f = fakeJev([() => answer("high")]);
    const r = await jev.classify({ apiKey: GOOD_KEY, state: "the site is down", questions: QUESTIONS }, { fetchImpl: f.impl });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].url, "https://api.typesafe.ai/v1/systemone");
    assert.equal(f.calls[0].method, "POST");
    assert.equal(f.calls[0].headers.get("authorization"), `Bearer ${GOOD_KEY}`);
    assert.deepEqual(f.calls[0].body, { state: "the site is down", model: "jev-latest", questions: QUESTIONS });
    if (r.ok) {
      assert.deepEqual(r.answers.priority, { type: "choice", choice: "high", confidence: 0.91, probabilities: { low: 0.09, high: 0.91 } });
      assert.deepEqual(r.usage, { inputTokens: 42, outputTokens: 3 });
    }
    // The constants are the SDK's (typesafe_sdk/constants.py, _core/constants.py).
    assert.equal(jev.JEV_BASE_URL, "https://api.typesafe.ai");
    assert.equal(jev.JEV_SYSTEM_ONE_PATH, "/v1/systemone");
    assert.equal(jev.JEV_MODELS_PATH, "/v1/models");
    assert.equal(jev.JEV_DEFAULT_MODEL, "jev-latest");
  });

  await check("the client times out at 2 s and returns a structured failure, never a throw", async () => {
    assert.equal(jev.JEV_TIMEOUT_MS, 2_000);
    const f = fakeJev([hang]);
    const started = Date.now();
    const r = await jev.classify({ apiKey: GOOD_KEY, state: "slow", questions: QUESTIONS }, { fetchImpl: f.impl });
    const took = Date.now() - started;
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.failure, "timeout");
    assert.ok(took >= 1_900 && took < 3_500, `gave up after ${took} ms`);
    assert.equal(f.calls.length, 1, "a timeout is not retried");
  });

  await check("429 and 5xx are retried once (inside the budget); 4xx, timeouts and network errors are not", async () => {
    const waits: number[] = [];
    const sleep = async (ms: number) => void waits.push(ms);
    const retried = fakeJev([() => json(429, { detail: "slow down" }, { "retry-after-ms": "100" }), () => answer("low")]);
    const ok = await jev.classify({ apiKey: GOOD_KEY, state: "x", questions: QUESTIONS }, { fetchImpl: retried.impl, sleep });
    assert.equal(ok.ok, true);
    assert.equal(retried.calls.length, 2);
    assert.deepEqual(waits, [100]);

    const twice = fakeJev([() => json(503, {}), () => json(503, {}), () => answer("low")]);
    const down = await jev.classify({ apiKey: GOOD_KEY, state: "x", questions: QUESTIONS }, { fetchImpl: twice.impl, sleep });
    assert.equal(down.ok, false);
    if (!down.ok) assert.equal(down.failure, "server_error");
    assert.equal(twice.calls.length, 2, "one retry at most");

    const bad = fakeJev([() => json(422, { detail: [] })]);
    const r422 = await jev.classify({ apiKey: GOOD_KEY, state: "x", questions: QUESTIONS }, { fetchImpl: bad.impl, sleep });
    assert.equal(!r422.ok && r422.failure, "bad_request");
    assert.equal(bad.calls.length, 1);

    const auth = fakeJev([() => json(401, { detail: "bad key" })]);
    const r401 = await jev.classify({ apiKey: DEAD_KEY, state: "x", questions: QUESTIONS }, { fetchImpl: auth.impl, sleep });
    assert.equal(!r401.ok && r401.failure, "auth_failed");
    assert.equal(auth.calls.length, 1);

    const net = fakeJev([() => Promise.reject(new TypeError("fetch failed"))]);
    const rNet = await jev.classify({ apiKey: GOOD_KEY, state: "x", questions: QUESTIONS }, { fetchImpl: net.impl, sleep });
    assert.equal(!rNet.ok && rNet.failure, "network_error");
    assert.equal(net.calls.length, 1);

    // A Retry-After longer than the call's budget is not slept.
    const long = fakeJev([() => json(429, {}, { "retry-after": "30" }), () => answer("low")]);
    const rLong = await jev.classify({ apiKey: GOOD_KEY, state: "x", questions: QUESTIONS }, { fetchImpl: long.impl, sleep });
    assert.equal(!rLong.ok && rLong.failure, "rate_limited");
    assert.equal(long.calls.length, 1);
  });

  await check("an answer outside the labels, a missing answer or a wrong type is schema_mismatch, never a guess", async () => {
    for (const body of [
      { model: "m", answers: { priority: { type: "choice", choice: "urgent", confidence: 0.9, probabilities: {} } }, usage: {} },
      { model: "m", answers: {}, usage: {} },
      { model: "m", answers: { priority: { type: "score", score: 1, confidence: 0.9, probabilities: {} } }, usage: {} },
      { answers: { priority: { type: "choice", choice: "low", confidence: 0.9, probabilities: {} } } },
    ]) {
      const f = fakeJev([() => json(200, body)]);
      const r = await jev.classify({ apiKey: GOOD_KEY, state: "x", questions: QUESTIONS }, { fetchImpl: f.impl });
      assert.equal(!r.ok && r.failure, "schema_mismatch", JSON.stringify(body).slice(0, 60));
    }
  });

  await check("bad input is refused before anything is sent", async () => {
    const f = fakeJev([() => answer("low")]);
    for (const input of [
      { apiKey: "", state: "x", questions: QUESTIONS },
      { apiKey: GOOD_KEY, state: "   ", questions: QUESTIONS },
      { apiKey: GOOD_KEY, state: "x", questions: {} },
      { apiKey: GOOD_KEY, state: "x", questions: { one: { type: "choice" as const, criteria: { only: null } } } },
    ]) {
      const r = await jev.classify(input, { fetchImpl: f.impl });
      assert.equal(!r.ok && r.failure, "invalid_input");
    }
    assert.equal(f.calls.length, 0);
  });

  await check("the key probe lists models (GET /v1/models, no data sent): 200 healthy, 401 refused, 5xx inconclusive", async () => {
    const ok = fakeJev([() => json(200, { models: [{ name: "jev-latest", description: "x", release_date: "2026-09-15" }] })]);
    const p = await jev.probeJevKey(GOOD_KEY, { fetchImpl: ok.impl });
    assert.equal(p.verdict, "healthy");
    assert.deepEqual(p.models, ["jev-latest"]);
    assert.equal(ok.calls[0].method, "GET");
    assert.equal(ok.calls[0].url, "https://api.typesafe.ai/v1/models");
    assert.equal(ok.calls[0].body, null);
    assert.equal((await jev.probeJevKey(DEAD_KEY, { fetchImpl: fakeJev([() => json(401, {})]).impl })).code, "key_rejected");
    assert.equal((await jev.probeJevKey(GOOD_KEY, { fetchImpl: fakeJev([() => json(502, {})]).impl })).verdict, "unknown");
  });

  // ── 2. Mode and shadow ─────────────────────────────────────────────────────

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
  `);
  const root = join(__dirname, "..");
  await db.executeMultiple(readFileSync(join(root, "database/turso/bravo__187_os_connections.sql"), "utf8"));
  await db.executeMultiple(readFileSync(join(root, "database/turso/bravo__197_slack_jev.sql"), "utf8"));
  await db.batch(
    [
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'oasis-ai-cc', 'OASIS AI')", args: [OASIS] },
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'client-co', 'Client Co')", args: [CLIENT] },
      { sql: `INSERT INTO "_supabase_auth_users" (id, email) VALUES (?, ?)`, args: [OWNER.id, OWNER.email] },
      {
        sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, onboarding_completed_at, updated_at)
              VALUES ('p-owner', ?, ?, ?, 'owner', 1, '2026-09-01', '2026-09-01')`,
        args: [OWNER.id, OWNER.email, CLIENT],
      },
    ],
    "write",
  );

  await check("mode: OASIS defaults to shadow, a client to off; only a manifest object with a known value changes it", () => {
    assert.deepEqual(mode.resolveJevMode(OASIS, undefined), { mode: "shadow", source: "default" });
    assert.deepEqual(mode.resolveJevMode(CLIENT, undefined), { mode: "off", source: "default" });
    assert.deepEqual(mode.resolveJevMode(CLIENT, [{ key: "stripe" }]), { mode: "off", source: "default" }, "the old array shape has no value");
    assert.deepEqual(mode.resolveJevMode(CLIENT, { jev: "shadow" }), { mode: "shadow", source: "manifest" });
    assert.deepEqual(mode.resolveJevMode(OASIS, { jev: "off" }), { mode: "off", source: "manifest" });
    assert.deepEqual(mode.resolveJevMode(CLIENT, { jev: "yes please" }), { mode: "off", source: "default" });
    assert.deepEqual(mode.chatAppsFrom({ chat_apps: ["slack", "email"] }), ["slack", "email"]);
    assert.deepEqual(mode.chatAppsFrom([{ key: "x" }]), []);
  });

  const MARKER = "CUSTOMER-SECRET-MARKER-7731";
  await check("shadow never changes the decided value, and jev_calls holds no message text", async () => {
    // Jev disagrees with what the requester chose.
    let asked = 0;
    const classifyImpl = async () => {
      asked += 1;
      return {
        ok: true as const,
        model: "jev-2026-09-15",
        answers: {
          q0: { type: "choice" as const, choice: "critical", confidence: 0.8, probabilities: {} },
          q1: { type: "choice" as const, choice: "billing", confidence: 0.7, probabilities: {} },
        },
        usage: { inputTokens: 77, outputTokens: 2 },
        latencyMs: 123,
        attempts: 1,
      };
    };
    const ticket = { tenantId: CLIENT, title: `Refund ${MARKER}`, description: `Card 4242 ${MARKER}`, category: "question", severity: "low", now: new Date() };
    const before = JSON.stringify(ticket);
    const r = await mode.shadowSupportTriage(db, ticket, { mode: { mode: "shadow", source: "manifest" }, apiKey: GOOD_KEY, classifyImpl });
    assert.deepEqual(r, { asked: true, rows: 2, reason: "asked" });
    assert.equal(JSON.stringify(ticket), before, "the decided values are untouched");
    assert.equal(asked, 1);
    const rows = (await db.execute("SELECT * FROM jev_calls ORDER BY surface")).rows;
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((x) => [x.surface, Number(x.agreed), x.outcome, x.mode]), [
      ["support_intake.category", 0, "ok", "shadow"],
      ["support_intake.priority", 0, "ok", "shadow"],
    ]);
    // No text of any kind: not the ticket, not Jev's answer.
    const dump = JSON.stringify(rows);
    for (const needle of [MARKER, "Refund", "4242", "critical", "billing", GOOD_KEY]) assert.ok(!dump.includes(needle), `jev_calls holds "${needle}"`);
    const cols = (await db.execute("PRAGMA table_info(jev_calls)")).rows.map((c) => String(c.name)).sort();
    assert.deepEqual(cols, ["agreed", "created_at", "id", "input_tokens", "latency_ms", "mode", "outcome", "surface", "tenant_id"]);
  });

  await check("an agreeing answer records agreed = 1; a failed call records its failure and agreed NULL (unknown is not 0)", async () => {
    await db.execute("DELETE FROM jev_calls");
    const agree = async () => ({ ok: true as const, model: "m", answers: { q0: { type: "choice" as const, choice: "general", confidence: 0.9, probabilities: {} } }, usage: { inputTokens: 5, outputTokens: 1 }, latencyMs: 10, attempts: 1 });
    await mode.shadowGeneralChannelRouting(db, { tenantId: OASIS, text: "lunch is here", now: new Date() }, { mode: { mode: "shadow", source: "default" }, apiKey: GOOD_KEY, classifyImpl: agree });
    const fail = async () => ({ ok: false as const, failure: "timeout" as const, status: null, latencyMs: 2000, attempts: 1 });
    await mode.shadowGeneralChannelRouting(db, { tenantId: OASIS, text: "another", now: new Date() }, { mode: { mode: "shadow", source: "default" }, apiKey: GOOD_KEY, classifyImpl: fail });
    const rows = (await db.execute("SELECT outcome, agreed, latency_ms FROM jev_calls ORDER BY created_at, outcome")).rows.map((x) => [x.outcome, x.agreed === null ? null : Number(x.agreed), Number(x.latency_ms)]);
    assert.deepEqual(rows.sort(), [["ok", 1, 10], ["timeout", null, 2000]].sort());
    const stats = await mode.jevStats(db, OASIS, new Date());
    assert.equal(stats.calls, 2);
    assert.equal(stats.answered, 1);
    assert.equal(stats.agreementPct, 100);
    assert.equal(stats.failed, 1);
  });

  await check("off sends nothing; shadow without a key sends nothing", async () => {
    let calls = 0;
    const spy = async () => {
      calls += 1;
      return { ok: false as const, failure: "timeout" as const, status: null, latencyMs: 0, attempts: 1 };
    };
    const off = await mode.shadowGeneralChannelRouting(db, { tenantId: CLIENT, text: "hi", now: new Date() }, { mode: { mode: "off", source: "default" }, apiKey: GOOD_KEY, classifyImpl: spy });
    assert.equal(off.reason, "off");
    const noKey = await mode.shadowGeneralChannelRouting(db, { tenantId: OASIS, text: "hi", now: new Date() }, { mode: { mode: "shadow", source: "default" }, apiKey: null, classifyImpl: spy });
    assert.equal(noKey.reason, "no_key");
    // The real key lookup: this workspace has no Jev connection.
    const real = await mode.shadowGeneralChannelRouting(db, { tenantId: OASIS, text: "hi", now: new Date() }, { mode: { mode: "shadow", source: "default" }, classifyImpl: spy });
    assert.equal(real.reason, "no_key");
    assert.equal(calls, 0);
  });

  await check("the support intake keeps what the requester chose: the shadow runs after the ticket and its result is never assigned", () => {
    const src = readFileSync(join(root, "lib/delivery/support-intake.ts"), "utf8");
    assert.match(src, /category: sub\.category,\s*severity: sub\.severity,/, "the ticket is created from the requester's own choice");
    const createdAt = src.indexOf("createTicketFromSubmission(db, desk,");
    const shadowAt = src.indexOf("await shadowSupportTriage(");
    assert.ok(createdAt > 0 && shadowAt > createdAt, "the shadow runs after the ticket exists");
    assert.doesNotMatch(src, /=\s*await shadowSupportTriage\(/, "nothing reads the shadow's result");
  });

  // ── 3. The pasted-key connection ─────────────────────────────────────────

  await check("connecting Jev probes the key, stores it encrypted, and never echoes it; a refused key stores nothing", async () => {
    const { signSession } = await import("../lib/turso-auth");
    sessionCookie = signSession({ sub: OWNER.id, email: OWNER.email, exp: Math.floor(Date.now() / 1000) + 3600, ver: 0 });
    const { NextRequest } = await import("next/server");
    const route = await import("../app/api/connections/[provider]/connect/route");
    const realFetch = globalThis.fetch;
    const probes: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!url.startsWith("https://api.typesafe.ai/")) throw new Error(`unexpected network call: ${url}`);
      probes.push(`${(init?.method || "GET").toUpperCase()} ${new URL(url).pathname}`);
      const key = (new Headers(init?.headers).get("authorization") || "").replace(/^Bearer /, "");
      return key === GOOD_KEY ? json(200, { models: [{ name: "jev-latest", description: "x", release_date: "2026-09-15" }] }) : json(401, {});
    }) as typeof fetch;
    try {
      const post = async (key: unknown) => {
        const r = await route.POST(
          new NextRequest("https://oasisai.work/api/connections/jev/connect", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key }) }),
          { params: Promise.resolve({ provider: "jev" }) },
        );
        const text = await r.text();
        return { status: r.status, text, body: JSON.parse(text) as Record<string, unknown> };
      };
      const bad = await post("has spaces in it which no key has");
      assert.equal(bad.status, 422);
      assert.equal(bad.body.error, "format_invalid");
      const dead = await post(DEAD_KEY);
      assert.equal(dead.status, 422);
      assert.equal(dead.body.error, "key_rejected");
      assert.equal(Number((await db.execute("SELECT COUNT(*) AS n FROM tenant_connections")).rows[0].n), 0);
      assert.equal(Number((await db.execute("SELECT COUNT(*) AS n FROM tenant_integration_credentials")).rows[0].n), 0);
      const ok = await post(GOOD_KEY);
      assert.equal(ok.status, 200, ok.text);
      assert.ok(!ok.text.includes(GOOD_KEY) && !dead.text.includes(DEAD_KEY), "a key is never echoed");
      const conn = (await db.execute("SELECT id, provider, status, external_account_id FROM tenant_connections WHERE tenant_id = ?", [CLIENT])).rows[0];
      assert.equal(conn.provider, "jev");
      assert.equal(conn.status, "connected");
      assert.match(String(conn.external_account_id), /^key:[0-9a-f]{16}$/, "pinned to a fingerprint, never the key");
      const stored = (await db.execute("SELECT encrypted_value FROM tenant_integration_credentials WHERE service = ?", [`connection:${conn.id}`])).rows[0];
      assert.notEqual(String(stored.encrypted_value), GOOD_KEY);
      assert.ok(probes.every((p) => p === "GET /v1/models"), `the probe sends no data: ${probes.join(", ")}`);
      // The shadow now finds the key through the connection.
      assert.equal(await mode.jevKeyFor(db, CLIENT), GOOD_KEY);
    } finally {
      globalThis.fetch = realFetch;
      sessionCookie = undefined;
    }
  });

  console.log(`\n${passed} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
