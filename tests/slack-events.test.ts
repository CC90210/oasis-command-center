/**
 * slack-events.test.ts - Slack as a two-way channel: the Events API, the
 * mention job, the approval card, the Approve button and the retention sweep.
 *
 * WHY. Slack is where a client's team talks, so every failure here is either a
 * leak or a lie: a message mirrored into the wrong workspace, a guest or
 * another company's user answered, a Slack retry drafting (or posting) twice,
 * an agent posting without a person's yes, an internal agent name in a
 * client's channel, a forged request accepted. Each is pinned here.
 *
 * Real everything against a local libSQL file: the real migrations (bravo__186
 * approvals, __187 connections, __190 ledger, __191 turn outcomes, __197
 * Slack/Jev), the real encrypted token store, signature check, events handler,
 * mention job, approval store, executor and interactivity handler. Stand-ins:
 * Slack's Web API at the fetch boundary (every other host fails the test) and
 * the model turn (prepare/runText), so no model is called.
 *
 * Run: node --conditions=react-server --import tsx tests/slack-events.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createClient } from "@libsql/client";

const dbFile = join(mkdtempSync(join(tmpdir(), "slack-events-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
process.env.BRAVO_FIELD_ENCRYPTION_KEY = "slack-events-test-field-encryption-passphrase";
process.env.PUBLIC_APP_URL = "https://oasisai.work";
process.env.SLACK_SIGNING_SECRET = "slack-events-test-signing-secret-0001";
process.env.SLACK_CLIENT_ID = "1234.5678";
process.env.SLACK_CLIENT_SECRET = "slack-events-test-client-secret";
process.env.CONNECTIONS_OAUTH_STATE_SECRET = "slack-events-test-state-secret-long-enough-0001";
// Approved replies go out in this test (the executor path), unless a check clamps it.
process.env.LIVE_SEND_SLACK = "1";
delete process.env.BRAVO_FORCE_DRY_RUN;

const OASIS = "ef8d389e-3f15-43f2-ae00-3660f69a1452";
const ALPHA = "a1a1a1a1-0000-4000-8000-0000000000a1";
const BRAVO_CO = "b2b2b2b2-0000-4000-8000-0000000000b2";
const TEAM_A = "T0ALPHA";
const TEAM_B = "T0BRAVO";
const BOT_A = "UBOTALPHA";
const TOKEN_A = "xoxb-test-alpha-token";
const TOKEN_B = "xoxb-test-bravo-token";
const CUSTOMER_A = "cust-alpha-1";

// ── Slack, mocked at the fetch boundary ─────────────────────────────────────

type SlackUserFixture = { team_id: string; email?: string; name: string; is_restricted?: boolean; is_ultra_restricted?: boolean; is_bot?: boolean };
const SLACK_USERS: Record<string, SlackUserFixture> = {
  UMEMBER1: { team_id: TEAM_A, email: "member@alpha.test", name: "Mia Member" },
  UOWNER1: { team_id: TEAM_A, email: "owner@alpha.test", name: "Olly Owner" },
  UGUEST1: { team_id: TEAM_A, email: "guest@elsewhere.test", name: "Gus Guest", is_restricted: true },
  UGUEST2: { team_id: TEAM_A, email: "single@elsewhere.test", name: "Sid Single", is_ultra_restricted: true },
  UEXT1: { team_id: "T0OTHERCO", email: "partner@other.test", name: "Pat Partner" },
  UBMEMBER: { team_id: TEAM_B, email: "someone@bravo.test", name: "Bea Bravo" },
};
const posts: Array<{ token: string; body: Record<string, unknown> }> = [];
const responses: Array<{ url: string; body: Record<string, unknown> }> = [];
let usersInfoCalls = 0;
let postFails: string | null = null;

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(href);
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (url.hostname === "hooks.slack.com") {
    responses.push({ url: href, body: JSON.parse(String(init?.body ?? "{}")) });
    return new Response("ok", { status: 200 });
  }
  if (url.hostname !== "slack.com") throw new Error(`unexpected network call in test: ${href}`);
  const token = (new Headers(init?.headers).get("authorization") || "").replace(/^Bearer /, "");
  if (token !== TOKEN_A && token !== TOKEN_B) return json(200, { ok: false, error: "invalid_auth" });
  const method = url.pathname.replace("/api/", "");
  if (method === "users.info") {
    usersInfoCalls += 1;
    const id = new URLSearchParams(String(init?.body ?? "")).get("user") ?? "";
    const u = SLACK_USERS[id];
    if (!u) return json(200, { ok: false, error: "user_not_found" });
    return json(200, {
      ok: true,
      user: {
        id,
        team_id: u.team_id,
        name: u.name.toLowerCase(),
        real_name: u.name,
        is_bot: u.is_bot === true,
        is_restricted: u.is_restricted === true,
        is_ultra_restricted: u.is_ultra_restricted === true,
        profile: { email: u.email, display_name: u.name, real_name: u.name },
      },
    });
  }
  if (method === "auth.test") return json(200, { ok: true, team_id: token === TOKEN_A ? TEAM_A : TEAM_B, team: token === TOKEN_A ? "Alpha" : "Bravo" });
  if (method === "chat.postMessage") {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    if (postFails) return json(200, { ok: false, error: postFails });
    posts.push({ token, body });
    return json(200, { ok: true, channel: body.channel, ts: `${Math.floor(Date.now() / 1000)}.${String(posts.length).padStart(6, "0")}` });
  }
  return json(200, { ok: false, error: "unknown_method" });
}) as typeof fetch;

// ── Harness ────────────────────────────────────────────────────────────────

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

function splitSql(sql: string): string[] {
  const out: string[] = [];
  let buf: string[] = [];
  for (const line of sql.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("--")) continue;
    buf.push(line);
    if (t.endsWith(";")) {
      out.push(buf.join("\n").trim().replace(/;$/, ""));
      buf = [];
    }
  }
  if (buf.join("").trim()) out.push(buf.join("\n").trim());
  return out;
}

async function main() {
  const db = createClient({ url: `file:${dbFile}` });
  await db.executeMultiple(`
    CREATE TABLE "_supabase_auth_users" (id TEXT PRIMARY KEY, email TEXT NOT NULL,
      session_version INTEGER NOT NULL DEFAULT 0, banned_until TEXT, deleted_at TEXT);
    CREATE TABLE user_profiles (id TEXT PRIMARY KEY, auth_user_id TEXT, email TEXT, tenant_id TEXT,
      team_role TEXT, is_owner INTEGER DEFAULT 0, admin_access INTEGER DEFAULT 0,
      onboarding_completed_at TEXT, full_name TEXT, display_name TEXT, updated_at TEXT, deactivated_at TEXT);
    CREATE TABLE tenants (id TEXT PRIMARY KEY, slug TEXT, name TEXT, custom_fields TEXT);
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
    CREATE TABLE agent_events (id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), event_type TEXT, publisher_agent TEXT,
      source_agent TEXT, target_agent TEXT, severity TEXT, correlation_id TEXT, payload TEXT, published_at TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), status TEXT);
    CREATE TABLE "tenant_audit_log" (
      "id" TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))),
      "tenant_id" TEXT NOT NULL, "actor_user_id" TEXT, "actor_email" TEXT, "action_type" TEXT NOT NULL,
      "target_table" TEXT, "target_id" TEXT, "before" TEXT, "after" TEXT, "ip_hash" TEXT, "user_agent" TEXT,
      "metadata" TEXT NOT NULL DEFAULT '{}',
      "created_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), PRIMARY KEY ("id"));
    -- Live DDL (schema export 2026-09-30), foreign keys dropped.
    CREATE TABLE "conversation_events" (
      "id" TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))),
      "tenant_id" TEXT NOT NULL, "thread_id" TEXT, "lead_id" TEXT, "event_type" TEXT NOT NULL,
      "actor_user_id" TEXT, "metadata" TEXT NOT NULL DEFAULT '{}',
      "created_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), PRIMARY KEY ("id"));
    CREATE TABLE customers (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, display_name TEXT NOT NULL,
      primary_email TEXT, archived_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  `);
  await db.executeMultiple(read("database/turso/bravo__187_os_connections.sql"));
  for (const stmt of splitSql(read("database/turso/bravo__186_os_approvals.sql"))) await db.execute(stmt);
  await db.executeMultiple(read("database/turso/bravo__190_ledger_core.sql"));
  await db.executeMultiple(read("database/turso/bravo__191_agent_turn_outcomes.sql"));
  await db.executeMultiple(read("database/turso/bravo__197_slack_jev.sql"));

  const stamp = "2026-09-01T00:00:00.000Z";
  await db.batch(
    [
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'oasis-ai-cc', 'OASIS AI')", args: [OASIS] },
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'alpha-co', 'Alpha Co')", args: [ALPHA] },
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'bravo-co', 'Bravo Co')", args: [BRAVO_CO] },
      { sql: "INSERT INTO tenant_manifests VALUES ('m-alpha', ?, 'alpha-co', '{}', 1, 1, ?, ?)", args: [ALPHA, stamp, stamp] },
      { sql: "INSERT INTO tenant_manifests VALUES ('m-bravo', ?, 'bravo-co', '{}', 1, 1, ?, ?)", args: [BRAVO_CO, stamp, stamp] },
      { sql: "INSERT INTO _supabase_auth_users (id, email) VALUES ('auth-owner-a', 'owner@alpha.test')", args: [] },
      { sql: "INSERT INTO _supabase_auth_users (id, email) VALUES ('auth-member-a', 'member@alpha.test')", args: [] },
      {
        sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, onboarding_completed_at, updated_at)
              VALUES ('p-owner-a', 'auth-owner-a', 'owner@alpha.test', ?, 'owner', 1, ?, ?)`,
        args: [ALPHA, stamp, stamp],
      },
      {
        sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, onboarding_completed_at, updated_at)
              VALUES ('p-member-a', 'auth-member-a', 'member@alpha.test', ?, 'member', 0, ?, ?)`,
        args: [ALPHA, stamp, stamp],
      },
      { sql: "INSERT INTO customers VALUES (?, ?, 'Acme Plumbing', NULL, NULL, ?, ?)", args: [CUSTOMER_A, ALPHA, stamp, stamp] },
    ],
    "write",
  );

  const { NextRequest } = await import("next/server");
  const verify = await import("../lib/slack/verify");
  const events = await import("../lib/slack/events");
  const jobs = await import("../lib/slack/jobs");
  const routing = await import("../lib/slack/routing");
  const send = await import("../lib/slack/send");
  const interactivity = await import("../lib/slack/interactivity");
  const retention = await import("../lib/slack/retention");
  const consumer = await import("../lib/slack/queue-consumer");
  const jobSig = await import("../lib/slack/job-signature");
  const jobsRoute = await import("../app/api/webhooks/slack/jobs/route");
  const tokens = await import("../lib/connections/token-store");
  const approvalsStore = await import("../lib/os/approvals/store");
  const executors = await import("../lib/os/approvals/executors");
  const rules = await import("../lib/os/approvals/rules");

  // Connected Slack workspaces: ALPHA on team T0ALPHA, BRAVO_CO on T0BRAVO.
  const connect = async (tenantId: string, team: string, conn: string, token: string, bot: string) => {
    await db.batch(
      [
        {
          sql: `INSERT INTO tenant_connections (id, tenant_id, provider, scope_kind, auth_kind, external_account_id, external_account_label,
                  status, last_health_verdict, last_health_at, connected_at, created_at, updated_at)
                VALUES (?, ?, 'slack', 'tenant', 'app_install', ?, ?, 'connected', 'healthy', ?, ?, ?, ?)`,
          args: [conn, tenantId, team, `${team} workspace`, new Date().toISOString(), stamp, stamp, stamp],
        },
        {
          sql: "INSERT INTO provider_webhook_routes (id, tenant_id, provider, external_key, connection_id, created_at) VALUES (?, ?, 'slack', ?, ?, ?)",
          args: [`route-${conn}`, tenantId, team, conn, stamp],
        },
      ],
      "write",
    );
    await tokens.saveBotToken(tenantId, conn, { bot_token: token, bot_user_id: bot });
  };
  await connect(ALPHA, TEAM_A, "conn-slack-a", TOKEN_A, BOT_A);
  await connect(BRAVO_CO, TEAM_B, "conn-slack-b", TOKEN_B, "UBOTBRAVO");
  const now = () => new Date();
  await routing.saveChannelRoute(db, { tenantId: ALPHA, teamId: TEAM_A, channelId: "C0CLIENTS", channelName: "clients", department: "client_success", customerId: CUSTOMER_A, createdBy: null, now: now() });
  await routing.saveChannelRoute(db, { tenantId: ALPHA, teamId: TEAM_A, channelId: "C0GENERAL", channelName: "general", department: null, customerId: null, createdBy: null, now: now() });

  // ── Request helpers ────────────────────────────────────────────────────────
  const SECRET = process.env.SLACK_SIGNING_SECRET!;
  const signed = (body: string, tsSec = Math.floor(Date.now() / 1000)) => ({
    rawBody: body,
    timestamp: String(tsSec),
    signature: verify.slackSignature(SECRET, String(tsSec), body),
  });
  let evSeq = 0;
  const eventBody = (event: Record<string, unknown>, opts: { team?: string; eventId?: string; shared?: boolean } = {}) =>
    JSON.stringify({
      type: "event_callback",
      team_id: opts.team ?? TEAM_A,
      event_id: opts.eventId ?? `Ev${String(++evSeq).padStart(8, "0")}`,
      is_ext_shared_channel: opts.shared === true,
      event,
    });
  const message = (user: string, channel: string, text: string, extra: Record<string, unknown> = {}) => ({
    type: "message",
    channel_type: "channel",
    user,
    channel,
    text,
    // Slack's ts is the message's own time: now, like a real message.
    ts: `${Math.floor(Date.now() / 1000)}.${String(evSeq).padStart(6, "0")}`,
    ...extra,
  });
  const mention = (user: string, channel: string, text: string) => ({
    type: "app_mention",
    user,
    channel,
    text: `<@${BOT_A}> ${text}`,
    ts: `${Math.floor(Date.now() / 1000)}.${String(evSeq).padStart(6, "0")}`,
  });
  const dispatched: Array<Parameters<typeof jobs.runSlackMentionJob>[0]> = [];
  let dispatchThrows = false;
  const deps = () => ({
    db,
    now,
    dispatchMention: async (job: Parameters<typeof jobs.runSlackMentionJob>[0]) => {
      if (dispatchThrows) throw new Error("queue down");
      dispatched.push(job);
    },
  });
  const slackRows = async (tenantId?: string) =>
    (
      await db.execute({
        sql: `SELECT tenant_id, event_type, metadata FROM conversation_events WHERE event_type = 'slack_message'${tenantId ? " AND tenant_id = ?" : ""} ORDER BY created_at`,
        args: tenantId ? [tenantId] : [],
      })
    ).rows.map((r) => ({ tenant: String(r.tenant_id), meta: JSON.parse(String(r.metadata)) as Record<string, unknown> }));
  const count = async (sql: string, args: unknown[] = []) => Number((await db.execute({ sql, args: args as never })).rows[0].n);

  console.log("slack-events:");

  // ── 1. Signature, replay window, url_verification ────────────────────────

  await check("a bad signature is 401 and nothing is processed", async () => {
    const body = eventBody(message("UMEMBER1", "C0CLIENTS", "hello"));
    const r = await events.handleSlackEvents({ ...signed(body), signature: "v0=" + "0".repeat(64) }, deps());
    assert.equal(r.status, 401);
    assert.equal(r.body.error, "bad_signature");
    // Same signature over a different body: still refused.
    const good = signed(body);
    const r2 = await events.handleSlackEvents({ ...good, rawBody: body.replace("hello", "hullo") }, deps());
    assert.equal(r2.status, 401);
    assert.equal((await slackRows()).length, 0);
  });

  await check("a timestamp older than five minutes is 401, even with a valid signature for it", async () => {
    const body = eventBody(message("UMEMBER1", "C0CLIENTS", "late"));
    const r = await events.handleSlackEvents(signed(body, Math.floor(Date.now() / 1000) - 6 * 60), deps());
    assert.equal(r.status, 401);
    assert.equal(r.body.error, "stale_timestamp");
    const r2 = await events.handleSlackEvents(signed(body, Math.floor(Date.now() / 1000) - 4 * 60), deps());
    assert.equal(r2.status, 200, "four minutes old is inside the window");
  });

  await check("no signing secret on the deployment is 503: nothing is processed, and there is no fallback key", async () => {
    const body = eventBody(message("UMEMBER1", "C0CLIENTS", "x"));
    const r = await events.handleSlackEvents(signed(body), { ...deps(), env: { BRAVO_FIELD_ENCRYPTION_KEY: "present-but-not-the-signing-secret" } });
    assert.equal(r.status, 503);
    assert.equal(r.body.error, "slack_not_configured");
  });

  await check("url_verification answers Slack's challenge (signed)", async () => {
    const body = JSON.stringify({ type: "url_verification", challenge: "abc123challenge", token: "legacy" });
    const r = await events.handleSlackEvents(signed(body), deps());
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { challenge: "abc123challenge" });
  });

  // ── 2. Tenant resolution and the mirror ────────────────────────────────────

  await check("team_id resolves to its workspace; an unknown team is acknowledged and dropped", async () => {
    const before = (await slackRows()).length;
    const r = await events.handleSlackEvents(signed(eventBody(message("UMEMBER1", "C0CLIENTS", "who am I"), { team: "T0NOBODY" })), deps());
    assert.equal(r.status, 200);
    assert.equal(r.body.dropped, "unknown_team");
    assert.equal((await slackRows()).length, before);
  });

  await check("a message in a mapped channel lands in conversation_events for THAT workspace only, linked to its client", async () => {
    const r = await events.handleSlackEvents(signed(eventBody(message("UMEMBER1", "C0CLIENTS", "The invoice for <@UOWNER1> is late &amp; overdue"))), deps());
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.mirrored, true);
    const rows = (await slackRows()).filter((x) => String(x.meta.text).startsWith("The invoice"));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].tenant, ALPHA);
    assert.equal(rows[0].meta.channel, "slack");
    assert.equal(rows[0].meta.direction, "inbound");
    assert.equal(rows[0].meta.customer_id, CUSTOMER_A, "the channel's client");
    assert.equal(rows[0].meta.department, "client_success");
    assert.equal(rows[0].meta.author_name, "Mia Member");
    assert.equal(rows[0].meta.text, "The invoice for is late & overdue");
    assert.match(String(rows[0].meta.thread_key), /^slack:T0ALPHA:C0CLIENTS:\d+\.\d+$/);
    assert.equal((await slackRows(BRAVO_CO)).length, 0, "nothing in the other workspace");
  });

  await check("the same channel id under ANOTHER team does not mirror into the first workspace", async () => {
    const before = (await slackRows()).length;
    const r = await events.handleSlackEvents(signed(eventBody(message("UBMEMBER", "C0CLIENTS", "bravo side"), { team: TEAM_B })), deps());
    assert.equal(r.status, 200);
    assert.equal(r.body.ignored, "channel_not_mapped", "Bravo never mapped C0CLIENTS");
    assert.equal((await slackRows()).length, before);
  });

  await check("a message in an unmapped channel is not mirrored", async () => {
    const before = (await slackRows()).length;
    const r = await events.handleSlackEvents(signed(eventBody(message("UMEMBER1", "C0RANDOM", "off the map"))), deps());
    assert.equal(r.body.ignored, "channel_not_mapped");
    assert.equal((await slackRows()).length, before);
  });

  await check("a duplicate event_id (a Slack retry) is processed once", async () => {
    const before = (await slackRows()).length;
    const body = eventBody(message("UMEMBER1", "C0CLIENTS", "only once please"), { eventId: "EvDUPLICATE1" });
    const first = await events.handleSlackEvents(signed(body), deps());
    const second = await events.handleSlackEvents(signed(body), deps());
    const [third, fourth] = await Promise.all([events.handleSlackEvents(signed(body), deps()), events.handleSlackEvents(signed(body), deps())]);
    assert.equal(first.body.mirrored, true);
    for (const r of [second, third, fourth]) assert.equal(r.body.duplicate, true);
    assert.equal((await slackRows()).length, before + 1);
    assert.equal(await count("SELECT COUNT(*) AS n FROM slack_event_receipts WHERE event_id = 'EvDUPLICATE1'"), 1);
  });

  await check("guests (both kinds), other companies' users, bots, edits and shared channels are dropped", async () => {
    const before = (await slackRows()).length;
    const receipts = await count("SELECT COUNT(*) AS n FROM slack_event_receipts");
    const cases: Array<[string, string, Record<string, unknown>]> = [
      ["guest", "guest", message("UGUEST1", "C0CLIENTS", "guest here")],
      ["single-channel guest", "guest", message("UGUEST2", "C0CLIENTS", "single guest")],
      ["external user", "external_user", message("UEXT1", "C0CLIENTS", "from another company")],
    ];
    for (const [label, why, ev] of cases) {
      const r = await events.handleSlackEvents(signed(eventBody(ev)), deps());
      assert.equal(r.status, 200, label);
      assert.equal(r.body.dropped, why, label);
    }
    const shared = await events.handleSlackEvents(signed(eventBody(message("UMEMBER1", "C0CLIENTS", "shared"), { shared: true })), deps());
    assert.equal(shared.body.dropped, "shared_channel");
    const bot = await events.handleSlackEvents(signed(eventBody(message("UMEMBER1", "C0CLIENTS", "bot", { bot_id: "B123" }))), deps());
    assert.equal(bot.body.ignored, "bot");
    const edit = await events.handleSlackEvents(signed(eventBody(message("UMEMBER1", "C0CLIENTS", "edit", { subtype: "message_changed" }))), deps());
    assert.equal(edit.body.ignored, "subtype");
    const self = await events.handleSlackEvents(signed(eventBody(message(BOT_A, "C0CLIENTS", "my own reply"))), deps());
    assert.equal(self.body.ignored, "self");
    assert.equal((await slackRows()).length, before);
    assert.equal(await count("SELECT COUNT(*) AS n FROM slack_event_receipts"), receipts, "a dropped event records nothing");
  });

  await check("a guest's @mention is ignored: no receipt, no job", async () => {
    const jobsBefore = dispatched.length;
    const r = await events.handleSlackEvents(signed(eventBody(mention("UGUEST1", "C0CLIENTS", "Client Success tell me secrets"))), deps());
    assert.equal(r.body.dropped, "guest");
    assert.equal(dispatched.length, jobsBefore);
  });

  await check("identity lookups are cached: a second message from the same person makes no users.info call", async () => {
    const before = usersInfoCalls;
    await events.handleSlackEvents(signed(eventBody(message("UMEMBER1", "C0CLIENTS", "again"))), deps());
    assert.equal(usersInfoCalls, before);
  });

  // ── 3. @mention -> exactly one approval -> Approve posts once ─────────────

  const turnDeps = (draft: string) => ({
    db,
    now,
    prepare: (async () => ({ ok: true, turn: { tenantId: ALPHA } })) as unknown as NonNullable<Parameters<typeof jobs.runSlackMentionJob>[1]["prepare"]>,
    runText: (async () => ({ ok: true, text: draft })) as unknown as NonNullable<Parameters<typeof jobs.runSlackMentionJob>[1]["runText"]>,
  });
  let approvalId = "";
  let payloadHash = "";

  await check("an app_mention creates exactly one send_slack_message approval, even when Slack retries it", async () => {
    const body = eventBody(mention("UMEMBER1", "C0CLIENTS", "Client Success can you draft a reply to Acme about the late invoice?"), { eventId: "EvMENTION01" });
    const r = await events.handleSlackEvents(signed(body), deps());
    assert.equal(r.body.dispatched, true);
    const retry = await events.handleSlackEvents(signed(body), deps());
    assert.equal(retry.body.duplicate, true);
    assert.equal(dispatched.length, 1, "one job for one event");
    const job = dispatched[0];
    assert.equal(job.tenantId, ALPHA);
    assert.equal(job.channelDepartment, "client_success");
    assert.equal(job.customerId, CUSTOMER_A);

    const postsBefore = posts.length;
    const out = await jobs.runSlackMentionJob(job, turnDeps("Hi Acme, the invoice went out today. Client Success"));
    assert.equal(out.outcome, "approval_created", JSON.stringify(out));
    // The queue retrying the same job never drafts a second approval.
    const again = await jobs.runSlackMentionJob(job, turnDeps("a different draft"));
    assert.equal(again.outcome, "duplicate");
    const rows = (await db.execute({ sql: "SELECT id, action_kind, department_key, status, payload_json, payload_hash, target_ref FROM approvals WHERE tenant_id = ?", args: [ALPHA] })).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].action_kind, "send_slack_message");
    assert.equal(rows[0].department_key, "client_success");
    assert.equal(rows[0].status, "pending");
    assert.equal(rows[0].target_ref, `customer:${CUSTOMER_A}`);
    const payload = JSON.parse(String(rows[0].payload_json)) as Record<string, unknown>;
    assert.equal(payload.team_id, TEAM_A);
    assert.equal(payload.channel_id, "C0CLIENTS");
    assert.equal(payload.thread_ts, job.threadTs);
    approvalId = String(rows[0].id);
    payloadHash = String(rows[0].payload_hash);
    // The card was posted once, in the thread, with the Approve button bound to this exact draft.
    assert.equal(posts.length, postsBefore + 1, "one card, and no reply yet");
    const card = posts[posts.length - 1].body;
    assert.equal(card.thread_ts, job.threadTs);
    const blocks = JSON.stringify(card.blocks);
    assert.match(blocks, new RegExp(`${approvalId}\\|${payloadHash}`));
    assert.match(blocks, /Client Success/);
    // Department names only: no internal agent name ever reaches a client's Slack.
    for (const name of ["bravo", "maven", "atlas", "customer-support", "Conaugh"]) {
      assert.doesNotMatch(blocks.toLowerCase(), new RegExp(name.toLowerCase()), `the card names "${name}"`);
      assert.doesNotMatch(String(card.text).toLowerCase(), new RegExp(name.toLowerCase()));
    }
  });

  const pressApprove = async (slackUser: string, value = `${approvalId}|${payloadHash}`) => {
    const payload = {
      type: "block_actions",
      team: { id: TEAM_A },
      user: { id: slackUser },
      response_url: "https://hooks.slack.com/actions/T0ALPHA/1/abc",
      actions: [{ action_id: send.APPROVE_ACTION_ID, value }],
    };
    const body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
    return interactivity.handleSlackInteractivity(signed(body), { db, now });
  };

  await check("a teammate who is not an owner or admin cannot approve from Slack; nothing is posted", async () => {
    const postsBefore = posts.length;
    const r = await pressApprove("UMEMBER1");
    assert.equal(r.status, 200);
    assert.match(String(r.replaced), /Only an owner or admin/);
    assert.equal(posts.length, postsBefore);
    assert.equal((await approvalsStore.getApprovalInTenant(db, ALPHA, approvalId))?.status, "pending");
  });

  await check("a forged button press (bad signature) is 401 and decides nothing", async () => {
    const payload = { type: "block_actions", team: { id: TEAM_A }, user: { id: "UOWNER1" }, actions: [{ action_id: send.APPROVE_ACTION_ID, value: `${approvalId}|${payloadHash}` }] };
    const body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
    const r = await interactivity.handleSlackInteractivity({ ...signed(body), signature: "v0=deadbeef" }, { db, now });
    assert.equal(r.status, 401);
    assert.equal((await approvalsStore.getApprovalInTenant(db, ALPHA, approvalId))?.status, "pending");
  });

  await check("approving twice posts once: the owner's press posts the reply in the thread; the second press posts nothing", async () => {
    const postsBefore = posts.length;
    const first = await pressApprove("UOWNER1");
    assert.equal(first.status, 200);
    assert.match(String(first.replaced), /Approved by Olly Owner in Slack\. The reply is posted/);
    assert.equal(posts.length, postsBefore + 1, "one reply posted");
    const reply = posts[posts.length - 1].body;
    assert.equal(reply.channel, "C0CLIENTS");
    assert.equal(reply.text, "Hi Acme, the invoice went out today. Client Success");
    assert.ok(reply.thread_ts, "in the thread");
    const second = await pressApprove("UOWNER1");
    assert.match(String(second.replaced), /already decided/);
    const [third, fourth] = await Promise.all([pressApprove("UOWNER1"), pressApprove("UOWNER1")]);
    assert.ok(third.status === 200 && fourth.status === 200);
    assert.equal(posts.length, postsBefore + 1, "never a second post");
    const row = await approvalsStore.getApprovalInTenant(db, ALPHA, approvalId);
    assert.equal(row?.status, "executed");
    assert.equal(row?.decided_via, "slack");
    assert.equal(row?.decided_by, "auth-owner-a");
    assert.equal((row?.execution_result as { outcome: string }).outcome, "sent");
    // The posted reply joins the client's conversation, as outbound, under the department.
    const out = (await slackRows(ALPHA)).filter((x) => x.meta.direction === "outbound");
    assert.equal(out.length, 1);
    assert.equal(out[0].meta.customer_id, CUSTOMER_A);
    assert.equal(out[0].meta.author_name, "Client Success");
  });

  await check("a button carrying another draft's hash approves nothing (the yes binds to the words shown)", async () => {
    const job = { ...dispatched[0], eventId: "EvMENTION02" };
    const created = await jobs.runSlackMentionJob(job, turnDeps("second draft"));
    assert.equal(created.outcome, "approval_created");
    const id = (created as { approvalId: string }).approvalId;
    const postsBefore = posts.length;
    const r = await pressApprove("UOWNER1", `${id}|${"a".repeat(64)}`);
    assert.match(String(r.replaced), /changed after the card was posted/);
    assert.equal(posts.length, postsBefore);
    assert.equal((await approvalsStore.getApprovalInTenant(db, ALPHA, id))?.status, "pending");
  });

  await check("the executor refuses a Slack team this workspace does not hold, and a dry run posts nothing", async () => {
    const created = await approvalsStore.createApproval(
      db,
      {
        tenantId: ALPHA,
        departmentKey: "sales",
        requestedBy: { type: "agent", id: "sdr" },
        actionKind: "send_slack_message",
        title: "Slack reply in #elsewhere",
        payload: { team_id: TEAM_B, channel_id: "C0ELSEWHERE", thread_ts: "1727700000.000100", text: "hello bravo" },
      },
      now(),
    );
    assert.ok(created.ok);
    const postsBefore = posts.length;
    const out = await send.postSlackReply(db, { tenantId: ALPHA, teamId: TEAM_B, channelId: "C0ELSEWHERE", threadTs: "1727700000.000100", text: "hello bravo", department: "sales", approvalId: "x" });
    assert.equal(out.ok, false);
    assert.equal((out as { reason: string }).reason, "slack_team_mismatch");
    assert.equal(posts.length, postsBefore);
    // Dry run: the executor records what it would post, and posts nothing.
    process.env.LIVE_SEND_SLACK = "0";
    try {
      const deps = { ...executors.defaultExecutorDeps(), publishEvent: async () => undefined };
      const exec = executors.EXECUTORS.send_slack_message!;
      const row = (created as { approval: Parameters<typeof exec.run>[0]["approval"] }).approval;
      const r = await exec.run({ db, approval: row, payload: approvalsStore.parsePayload(row), tenant: { id: ALPHA, slug: "alpha-co" }, approver: null, deps });
      assert.equal(r.ok, true);
      assert.equal((r as { result: { outcome: string } }).result.outcome, "dry_run");
      assert.equal(posts.length, postsBefore);
    } finally {
      process.env.LIVE_SEND_SLACK = "1";
    }
  });

  await check("a reply Slack refuses is a FAILED approval with Slack's reason, never 'posted'", async () => {
    const job = { ...dispatched[0], eventId: "EvMENTION04" };
    const created = await jobs.runSlackMentionJob(job, turnDeps("reply that will bounce"));
    assert.equal(created.outcome, "approval_created");
    const id = (created as { approvalId: string }).approvalId;
    const row = await approvalsStore.getApprovalInTenant(db, ALPHA, id);
    postFails = "not_in_channel";
    try {
      const r = await pressApprove("UOWNER1", `${id}|${row!.payload_hash}`);
      assert.match(String(r.replaced), /but not posted: OASIS's Slack app is not in that channel any more/);
    } finally {
      postFails = null;
    }
    const after = await approvalsStore.getApprovalInTenant(db, ALPHA, id);
    assert.equal(after?.status, "failed");
    assert.equal((after?.execution_result as { reason: string }).reason, "slack_not_in_channel");
  });

  await check("send_slack_message payloads are validated: ids, thread, length", () => {
    const ok = rules.validateSendSlackMessagePayload({ team_id: TEAM_A, channel_id: "C0CLIENTS", thread_ts: "1727700000.000100", text: " hi " });
    assert.ok(ok.ok && ok.value.text === "hi");
    for (const bad of [
      { team_id: "nope", channel_id: "C0CLIENTS", thread_ts: "1.2", text: "x" },
      { team_id: TEAM_A, channel_id: "D0DIRECT", thread_ts: "1.2", text: "x" },
      { team_id: TEAM_A, channel_id: "C0CLIENTS", thread_ts: "yesterday", text: "x" },
      { team_id: TEAM_A, channel_id: "C0CLIENTS", thread_ts: "1.2", text: "   " },
      { team_id: TEAM_A, channel_id: "C0CLIENTS", thread_ts: "1.2", text: "x".repeat(rules.SLACK_TEXT_MAX + 1) },
    ]) {
      assert.equal(rules.validateSendSlackMessagePayload(bad).ok, false, JSON.stringify(bad).slice(0, 80));
    }
    assert.ok((executors.EXECUTORS as Record<string, unknown>).send_slack_message, "the kind has an executor");
  });

  await check("a department not set up in a client workspace gets a notice, and no model is called", async () => {
    let prepared = 0;
    const job = { ...dispatched[0], eventId: "EvMENTION03", text: `<@${BOT_A}> Finance what is our cash?`, channelDepartment: null };
    const out = await jobs.runSlackMentionJob(job, {
      db,
      now,
      prepare: (async () => {
        prepared += 1;
        return { ok: false, status: 500, error: "should_not_run" };
      }) as unknown as NonNullable<Parameters<typeof jobs.runSlackMentionJob>[1]["prepare"]>,
    });
    assert.equal(out.outcome, "notice");
    assert.equal((out as { reason: string }).reason, "department_not_set_up");
    assert.equal(prepared, 0);
    assert.match(String(posts[posts.length - 1].body.text), /^Finance is not set up in this workspace yet/);
  });

  await check("a hand-off that fails removes the receipt and answers 500, so Slack's retry runs it", async () => {
    dispatchThrows = true;
    const body = eventBody(mention("UMEMBER1", "C0CLIENTS", "retry me"), { eventId: "EvDISPATCH1" });
    try {
      const r = await events.handleSlackEvents(signed(body), deps());
      assert.equal(r.status, 500);
      assert.equal(await count("SELECT COUNT(*) AS n FROM slack_event_receipts WHERE event_id = 'EvDISPATCH1'"), 0);
    } finally {
      dispatchThrows = false;
    }
    const again = await events.handleSlackEvents(signed(body), deps());
    assert.equal(again.body.dispatched, true);
  });

  // ── 4. Routing words ─────────────────────────────────────────────────────

  await check("the department named after the mention wins, then the channel's, then Chief of Staff", () => {
    assert.deepEqual(routing.departmentForMention({ text: "<@UBOT> Client Success, draft a reply", channelDepartment: "sales" }), {
      department: "client_success",
      question: "draft a reply",
      source: "named",
    });
    assert.equal(routing.departmentForMention({ text: "<@UBOT> @Chief of Staff what's next?", channelDepartment: "sales" }).department, "chief_of_staff");
    assert.equal(routing.departmentForMention({ text: "<@UBOT> what's next for sales?", channelDepartment: "marketing" }).department, "marketing");
    assert.equal(routing.departmentForMention({ text: "<@UBOT> salesforce import?", channelDepartment: null }).department, "chief_of_staff", "a label must end at a word boundary");
  });

  // ── 4b. Where each department lives in Slack (AI Team, department tab) ────

  await check("the AI Team and department tab show the real Slack state, never 'Phase 2'", async () => {
    const status = await import("../lib/slack/status");
    const env = { SLACK_CLIENT_ID: "x", SLACK_CLIENT_SECRET: "y", SLACK_SIGNING_SECRET: "z", CONNECTIONS_OAUTH_STATE_SECRET: "w".repeat(40) };
    const alpha = await status.loadSlackPresence(db, ALPHA, env);
    assert.deepEqual(status.slackHomeFor(alpha, ["client_success"]), { kind: "channels", names: ["clients"] });
    assert.deepEqual(status.slackHomeFor(alpha, ["sales"]), { kind: "mention_only" });
    assert.deepEqual(status.slackHomeFor(await status.loadSlackPresence(db, OASIS, env), ["sales"]), { kind: "not_connected" });
    assert.deepEqual(status.slackHomeFor(await status.loadSlackPresence(db, ALPHA, {}), ["sales"]), { kind: "not_configured" });
    assert.deepEqual(status.slackHomeFor(await status.loadSlackPresence(null, ALPHA, env), ["sales"]), { kind: "unknown" });

    const React = await import("react");
    (globalThis as unknown as { React: typeof React }).React = React;
    // next/link needs the client router context, which react-server lacks; the row only needs an <a>.
    const linkPath = require.resolve("next/link");
    require.cache[linkPath] = {
      id: linkPath,
      filename: linkPath,
      path: dirname(linkPath),
      loaded: true,
      children: [],
      paths: [],
      exports: { __esModule: true, default: ({ href, children }: { href: string; children?: unknown }) => React.createElement("a", { href }, children as never) },
    } as unknown as NodeModule;
    const { Homes } = await import("../components/os/aiteam/TeammateRow");
    const text = (node: unknown): string => {
      if (node === null || node === undefined || typeof node === "boolean") return "";
      if (typeof node === "string" || typeof node === "number") return String(node);
      if (Array.isArray(node)) return node.map(text).join(" ");
      const el = node as { props?: { children?: unknown } };
      return el.props ? text(el.props.children) : "";
    };
    const rendered = text(Homes({ web: "ready", slack: status.slackHomeFor(alpha, ["client_success"]) }));
    assert.match(rendered, /Slack · #clients/);
    assert.doesNotMatch(rendered, /Slack · Phase 2/);
    assert.match(text(Homes({ web: "ready", slack: { kind: "not_configured" } })), /Slack · app not set up/);
    assert.doesNotMatch(text(Homes({ web: "ready" })), /Slack/, "a custom teammate does not live in Slack");
  });

  // ── 5. The queue consumer and the internal jobs route ─────────────────────

  await check("the queue consumer signs each job for the app, acks a 2xx and retries anything else", async () => {
    const acked: string[] = [];
    const retried: string[] = [];
    const msg = (id: string) => ({ body: { id }, ack: () => acked.push(id), retry: () => retried.push(id) });
    const seen: Request[] = [];
    const res = await consumer.consumeSlackJobs(
      { messages: [msg("a"), msg("b")] },
      { SLACK_SIGNING_SECRET: SECRET, PUBLIC_APP_URL: "https://oasisai.work" },
      async (request) => {
        seen.push(request);
        const body = await request.clone().text();
        const okSig = await jobSig.verifySlackJob({
          secret: SECRET,
          timestamp: request.headers.get(jobSig.JOB_TIMESTAMP_HEADER),
          signature: request.headers.get(jobSig.JOB_SIGNATURE_HEADER),
          body,
          nowMs: Date.now(),
        });
        assert.ok(okSig, "the job is signed");
        return new Response("{}", { status: JSON.parse(body).id === "a" ? 200 : 500 });
      },
    );
    assert.deepEqual(res, { acked: 1, retried: 1 });
    assert.deepEqual(acked, ["a"]);
    assert.deepEqual(retried, ["b"]);
    assert.equal(new URL(seen[0].url).pathname, "/api/webhooks/slack/jobs");
    const none = await consumer.consumeSlackJobs({ messages: [msg("c")] }, {}, async () => new Response("{}"));
    assert.deepEqual(none, { acked: 0, retried: 1 }, "no secret: nothing can be proven, so everything is retried");
  });

  await check("the jobs route refuses an unsigned or Slack-signed body (a Slack signature is not a job signature)", async () => {
    const body = JSON.stringify(dispatched[0]);
    const unsigned = await jobsRoute.POST(new NextRequest("https://oasisai.work/api/webhooks/slack/jobs", { method: "POST", body }));
    assert.equal(unsigned.status, 401);
    const ts = String(Math.floor(Date.now() / 1000));
    const slackSigned = await jobsRoute.POST(
      new NextRequest("https://oasisai.work/api/webhooks/slack/jobs", {
        method: "POST",
        body,
        headers: { [jobSig.JOB_TIMESTAMP_HEADER]: ts, [jobSig.JOB_SIGNATURE_HEADER]: verify.slackSignature(SECRET, ts, body) },
      }),
    );
    assert.equal(slackSigned.status, 401);
  });

  // ── 6. Retention ────────────────────────────────────────────────────────

  await check("retention deletes Slack text older than 90 days and old receipts, and nothing else", async () => {
    const old = new Date(Date.now() - 91 * 86_400_000).toISOString();
    const recent = new Date(Date.now() - 10 * 86_400_000).toISOString();
    await db.batch(
      [
        { sql: "INSERT INTO conversation_events (id, tenant_id, event_type, metadata, created_at) VALUES ('old-slack', ?, 'slack_message', '{}', ?)", args: [ALPHA, old] },
        { sql: "INSERT INTO conversation_events (id, tenant_id, event_type, metadata, created_at) VALUES ('recent-slack', ?, 'slack_message', '{}', ?)", args: [ALPHA, recent] },
        { sql: "INSERT INTO conversation_events (id, tenant_id, event_type, metadata, created_at) VALUES ('old-email', ?, 'email_sent', '{}', ?)", args: [ALPHA, old] },
        { sql: "INSERT INTO slack_event_receipts VALUES ('EvOLDRECEIPT', ?, ?, 'message', ?)", args: [ALPHA, TEAM_A, old] },
      ],
      "write",
    );
    const r = await retention.purgeSlackRetention(db, new Date());
    assert.equal(r.messagesDeleted, 1);
    assert.ok(r.receiptsDeleted >= 1);
    assert.equal(r.notInstalled, false);
    const ids = (await db.execute("SELECT id FROM conversation_events WHERE id IN ('old-slack','recent-slack','old-email')")).rows.map((x) => String(x.id)).sort();
    assert.deepEqual(ids, ["old-email", "recent-slack"]);
  });

  // Anti-vacuity: the real network is still not reachable from here.
  await check("the fetch mock refuses any host that is not Slack's", async () => {
    await assert.rejects(() => fetch("https://example.com/"), /unexpected network call/);
  });

  globalThis.fetch = realFetch;
  console.log(`\n${passed} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
