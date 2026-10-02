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
// Auth records live in Turso, as in production (the Slack job reads a
// teammate's AUTH email for the platform-operator check).
process.env.EMPIRE_AUTH_BACKEND = "turso";
process.env.AUTH_SESSION_SECRET = "slack-events-test-session-secret-long-enough-0001";
process.env.SLACK_SIGNING_SECRET = "slack-events-test-signing-secret-0001";
process.env.SLACK_CLIENT_ID = "1234.5678";
process.env.SLACK_CLIENT_SECRET = "slack-events-test-client-secret";
process.env.CONNECTIONS_OAUTH_STATE_SECRET = "slack-events-test-state-secret-long-enough-0001";
// Approved replies go out in this test (the executor path), unless a check clamps it.
process.env.LIVE_SEND_SLACK = "1";
delete process.env.BRAVO_FORCE_DRY_RUN;

// next/server's after() needs a live request scope; the interactivity route's
// work is collected here instead, so a test can prove it runs AFTER the answer.
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

type SlackUserFixture = { team_id: string; email?: string; name: string; is_restricted?: boolean; is_ultra_restricted?: boolean; is_bot?: boolean; is_stranger?: boolean };
const SLACK_USERS: Record<string, SlackUserFixture> = {
  // A member who is made a guest later (the day-long cache must not outlive that).
  UFLIP1: { team_id: TEAM_A, email: "flip@alpha.test", name: "Fay Flip" },
  // Slack Connect: Slack reports the connected team id but marks the user a stranger.
  USTRANGER1: { team_id: TEAM_A, email: "stranger@else.test", name: "Stan Stranger", is_stranger: true },
  // A bot user whose message carries no bot_id.
  UBOTUSER1: { team_id: TEAM_A, name: "Zap Bot", is_bot: true },
  UMEMBER1: { team_id: TEAM_A, email: "member@alpha.test", name: "Mia Member" },
  UOWNER1: { team_id: TEAM_A, email: "owner@alpha.test", name: "Olly Owner" },
  UGUEST1: { team_id: TEAM_A, email: "guest@elsewhere.test", name: "Gus Guest", is_restricted: true },
  UGUEST2: { team_id: TEAM_A, email: "single@elsewhere.test", name: "Sid Single", is_ultra_restricted: true },
  UEXT1: { team_id: "T0OTHERCO", email: "partner@other.test", name: "Pat Partner" },
  UBMEMBER: { team_id: TEAM_B, email: "someone@bravo.test", name: "Bea Bravo" },
  UOWNER2: { team_id: TEAM_A, email: "owner2@alpha.test", name: "Opal Owner" },
  UDEACT1: { team_id: TEAM_A, email: "gone@alpha.test", name: "Dee Parted" },
};
/** users.info answers HTTP 500 for this user: Slack is down for the lookup. */
const FLAKY_USER = "UFLAKY1";
const posts: Array<{ token: string; body: Record<string, unknown> }> = [];
const ephemerals: Array<{ token: string; body: Record<string, unknown> }> = [];
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
    if (id === FLAKY_USER) return json(500, { ok: false, error: "internal_error" });
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
        ...(u.is_stranger ? { is_stranger: true } : {}),
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
  if (method === "chat.postEphemeral") {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    ephemerals.push({ token, body });
    return json(200, { ok: true, message_ts: `${Math.floor(Date.now() / 1000)}.${String(ephemerals.length).padStart(6, "0")}` });
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
      session_version INTEGER NOT NULL DEFAULT 0, banned_until TEXT, deleted_at TEXT, raw_user_meta_data TEXT);
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
  // Each client workspace as OASIS provisions it (W4a: its manifest is the one
  // roster, so its Sales and Client Success leads answer because it binds them).
  const { buildProvisionedManifest } = await import("../lib/provisioning/manifest");
  const { DEFAULT_DEPARTMENTS } = await import("../lib/provisioning/team");
  const provisioned = (slug: string, name: string) =>
    JSON.stringify(buildProvisionedManifest({ slug, name, departments: DEFAULT_DEPARTMENTS, modules: [], now: stamp }));
  const BRAVO_CO_MANIFEST = provisioned("bravo-co", "Bravo Co");
  await db.batch(
    [
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'oasis-ai-cc', 'OASIS AI')", args: [OASIS] },
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'alpha-co', 'Alpha Co')", args: [ALPHA] },
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'bravo-co', 'Bravo Co')", args: [BRAVO_CO] },
      { sql: "INSERT INTO tenant_manifests VALUES ('m-alpha', ?, 'alpha-co', ?, 1, 1, ?, ?)", args: [ALPHA, provisioned("alpha-co", "Alpha Co"), stamp, stamp] },
      { sql: "INSERT INTO tenant_manifests VALUES ('m-bravo', ?, 'bravo-co', ?, 1, 1, ?, ?)", args: [BRAVO_CO, BRAVO_CO_MANIFEST, stamp, stamp] },
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
      { sql: "INSERT INTO _supabase_auth_users (id, email) VALUES ('auth-owner2-a', 'owner2@alpha.test')", args: [] },
      { sql: "INSERT INTO _supabase_auth_users (id, email) VALUES ('auth-gone-a', 'gone@alpha.test')", args: [] },
      {
        sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, onboarding_completed_at, updated_at)
              VALUES ('p-owner2-a', 'auth-owner2-a', 'owner2@alpha.test', ?, 'owner', 1, ?, ?)`,
        args: [ALPHA, stamp, stamp],
      },
      {
        // An admin who has left: deactivated before any Slack lookup.
        sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, onboarding_completed_at, updated_at, deactivated_at)
              VALUES ('p-gone-a', 'auth-gone-a', 'gone@alpha.test', ?, 'admin', 0, ?, ?, ?)`,
        args: [ALPHA, stamp, stamp, stamp],
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
  // ALPHA is a client, so it uses its OWN Slack app (lib/slack/own-app.ts
  // slackAppKindFor): saved here, its signing secret is the one this suite
  // signs with. BRAVO_CO saved none.
  const { setTenantIntegrationBundle } = await import("../lib/tenant-integration-store");
  const alphaApp = await setTenantIntegrationBundle({
    tenantId: ALPHA,
    service: "slack_app",
    bundle: { client_id: "1234.5678", client_secret: "alphaownappclientsecret00000001", signing_secret: process.env.SLACK_SIGNING_SECRET! },
  });
  if (!alphaApp.ok) throw new Error(`fixture: ALPHA's Slack app was not saved: ${alphaApp.error}`);
  /** ALPHA's own app: what slackRequestScope gives a request at ALPHA's own Request URLs. */
  const ALPHA_APP = { kind: "own", tenantId: ALPHA } as const;
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
  // Events checked as ALPHA's own app (its Request URL carries ?workspace=ALPHA);
  // they may act only for ALPHA. A check about another workspace says so.
  const deps = () => ({
    db,
    now,
    app: ALPHA_APP as { kind: "own"; tenantId: string },
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

  await check("the mirrored message shows on the linked client's Conversations thread (the client hub's own reader)", async () => {
    await db.executeMultiple(`CREATE TABLE IF NOT EXISTS lead_interactions (id TEXT PRIMARY KEY, tenant_id TEXT, lead_id TEXT, channel TEXT,
      direction TEXT, type TEXT, subject TEXT, content_preview TEXT, content TEXT, created_at TEXT, sent_at TEXT, agent_source TEXT,
      metadata TEXT, to_email TEXT, from_email TEXT, to_phone TEXT, from_phone TEXT);`);
    const { loadClientConversation } = await import("../lib/os/customers/conversations");
    const customer = { id: CUSTOMER_A, display_name: "Acme Plumbing", primary_email: null, primary_phone: null, source_lead_id: null };
    const convo = await loadClientConversation(db, ALPHA, customer, []);
    const slack = convo.messages.filter((m) => m.channel === "slack");
    const mirrored = (await slackRows(ALPHA)).filter((r) => r.meta.customer_id === CUSTOMER_A);
    assert.equal(slack.length, mirrored.length, "every mirrored #clients message is on the client's thread");
    const invoice = slack.find((m) => m.preview === "The invoice for is late & overdue");
    assert.ok(invoice, "the message is on the thread");
    assert.equal(invoice.direction, "inbound");
    assert.equal(invoice.subject, "Slack · Mia Member");
    // Another workspace asking for the same client id sees nothing of it.
    const other = await loadClientConversation(db, BRAVO_CO, customer, []);
    assert.equal(other.messages.filter((m) => m.channel === "slack").length, 0);
  });

  await check("the same channel id under ANOTHER team does not mirror into the first workspace", async () => {
    const before = (await slackRows()).length;
    // At Bravo's own Request URL (its own app), where team B's events arrive.
    const r = await events.handleSlackEvents(signed(eventBody(message("UBMEMBER", "C0CLIENTS", "bravo side"), { team: TEAM_B })), {
      ...deps(),
      app: { kind: "own", tenantId: BRAVO_CO },
    });
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
    const ephemeralsBefore = ephemerals.length;
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
    // ONE line in the thread, and no reply yet. Everyone in the channel reads
    // it (a client's single-channel guest too), so it carries NO draft text
    // and no Approve button: the draft is not in Slack until it is approved.
    assert.equal(posts.length, postsBefore + 1, "one line in the thread, and no reply yet");
    const notice = posts[posts.length - 1].body;
    assert.equal(notice.thread_ts, job.threadTs);
    const noticeAll = JSON.stringify(notice);
    assert.doesNotMatch(noticeAll, /invoice went out/, "the draft is not posted in the channel");
    assert.doesNotMatch(noticeAll, new RegExp(send.APPROVE_ACTION_ID), "no Approve button where everyone can see it");
    assert.doesNotMatch(noticeAll, new RegExp(approvalId), "no approval handle in the channel");
    assert.match(String(notice.text), /^Client Success drafted a reply for review in OASIS\. Nothing is posted in this thread unless someone approves it\.$/);
    // The person who asked is a member, not an owner or admin: nobody is sent the draft in Slack.
    assert.equal(ephemerals.length, ephemeralsBefore, "a member who asked is not sent the draft");
    assert.equal((out as { reviewSent: boolean }).reviewSent, false);
    // Department names only: no internal agent name ever reaches a client's Slack.
    for (const name of ["bravo", "maven", "atlas", "customer-support", "Conaugh"]) {
      assert.doesNotMatch(noticeAll.toLowerCase(), new RegExp(name.toLowerCase()), `the notice names "${name}"`);
    }
  });

  await check("an owner who asks gets the draft on a card only they can see; the channel still gets no draft", async () => {
    const body = eventBody(mention("UOWNER1", "C0CLIENTS", "Client Success draft a note to Acme about Friday"), { eventId: "EvMENTIONOWN1" });
    const r = await events.handleSlackEvents(signed(body), deps());
    assert.equal(r.body.dispatched, true, JSON.stringify(r.body));
    const job = dispatched[dispatched.length - 1];
    assert.equal(job.profileId, "p-owner-a", "the owner's Slack email links to their teammate");
    const postsBefore = posts.length;
    const ephemeralsBefore = ephemerals.length;
    const draft = "Hi Acme, we will be there on Friday at 9. Client Success";
    const out = await jobs.runSlackMentionJob(job, turnDeps(draft));
    assert.equal(out.outcome, "approval_created", JSON.stringify(out));
    assert.equal((out as { reviewSent: boolean }).reviewSent, true);
    const id = (out as { approvalId: string }).approvalId;
    const row = await approvalsStore.getApprovalInTenant(db, ALPHA, id);
    // Public: one draft-free line.
    assert.equal(posts.length, postsBefore + 1);
    const publicText = JSON.stringify(posts[posts.length - 1].body);
    assert.doesNotMatch(publicText, /Friday at 9/);
    assert.doesNotMatch(publicText, new RegExp(send.APPROVE_ACTION_ID));
    // Private: the draft and the Approve button bound to it, to the owner alone.
    assert.equal(ephemerals.length, ephemeralsBefore + 1);
    const card = ephemerals[ephemerals.length - 1].body;
    assert.equal(card.user, "UOWNER1", "only the owner who asked");
    assert.equal(card.channel, "C0CLIENTS");
    assert.equal(card.thread_ts, job.threadTs);
    const blocks = JSON.stringify(card.blocks);
    assert.match(blocks, /Friday at 9/);
    assert.match(blocks, new RegExp(`${id}\\|${row!.payload_hash}`));
    assert.match(blocks, /Only you can see this/);
    for (const name of ["bravo", "maven", "atlas", "customer-support", "Conaugh"]) {
      assert.doesNotMatch(blocks.toLowerCase(), new RegExp(name.toLowerCase()), `the card names "${name}"`);
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
    return interactivity.handleSlackInteractivity(signed(body), { db, now, app: ALPHA_APP });
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

  // W4a review R3: who leads a department is the workspace manifest now. A
  // read that fails must be retried, not answered from the empty seed a client
  // would get, which posts "<Department> is not set up" into its own Slack.
  await check("a manifest read that fails is retried (the job throws): no 'not set up' notice, no model call", async () => {
    let prepared = 0;
    const postsBefore = posts.length;
    const job = { ...dispatched[0], eventId: "EvMENTIONDB1", text: `<@${BOT_A}> Client Success, draft a reply to Acme`, channelDepartment: null };
    await db.execute("ALTER TABLE tenant_manifests RENAME TO tenant_manifests_offline");
    try {
      await assert.rejects(
        jobs.runSlackMentionJob(job, {
          db,
          now,
          prepare: (async () => {
            prepared += 1;
            return { ok: false, status: 500, error: "should_not_run" };
          }) as unknown as NonNullable<Parameters<typeof jobs.runSlackMentionJob>[1]["prepare"]>,
        }),
        /manifest_by_tenant_lookup_failed/,
      );
    } finally {
      await db.execute("ALTER TABLE tenant_manifests_offline RENAME TO tenant_manifests");
    }
    assert.equal(prepared, 0, "a turn was prepared on a roster nobody could read");
    assert.equal(posts.length, postsBefore, `a notice reached the client's Slack: ${String(posts[posts.length - 1]?.body.text ?? "")}`);
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

  await check("the department named after the mention wins, then the channel's, then the workspace's default", () => {
    assert.deepEqual(routing.departmentForMention({ text: "<@UBOT> Client Success, draft a reply", channelDepartment: "sales" }), {
      department: "client_success",
      question: "draft a reply",
      source: "named",
    });
    assert.equal(routing.departmentForMention({ text: "<@UBOT> @Chief of Staff what's next?", channelDepartment: "sales" }).department, "chief_of_staff");
    assert.equal(routing.departmentForMention({ text: "<@UBOT> what's next for sales?", channelDepartment: "marketing" }).department, "marketing");
    assert.equal(routing.departmentForMention({ text: "<@UBOT> salesforce import?", channelDepartment: null }).department, "chief_of_staff", "a label must end at a word boundary");
    // The workspace's default, when neither the text nor the channel names one.
    assert.equal(routing.departmentForMention({ text: "<@UBOT> where are we?", channelDepartment: null, defaultDepartment: "sales" }).department, "sales");
    assert.equal(routing.departmentForMention({ text: "<@UBOT> where are we?", channelDepartment: "client_success", defaultDepartment: "sales" }).department, "client_success");
  });

  await check("only departments with an AI teammate can answer: all six in OASIS, Sales and Client Success in a client workspace", async () => {
    // Who answers is the workspace manifest's roster (W4a), the web channels' own reader.
    const { parseManifest } = await import("../lib/manifest/schema");
    const { OASIS_AI_CC_SEED } = await import("../lib/manifest/seeds");
    const client = { oasis: false, manifest: parseManifest(JSON.parse(BRAVO_CO_MANIFEST)) };
    for (const oasis of [{ oasis: true }, { oasis: true, manifest: OASIS_AI_CC_SEED }]) {
      assert.deepEqual(routing.answeringDepartments(oasis), ["chief_of_staff", "sales", "marketing", "client_success", "finance", "operations"]);
      assert.equal(routing.defaultMentionDepartment(oasis), "chief_of_staff");
    }
    assert.deepEqual(routing.answeringDepartments(client), ["sales", "client_success"]);
    assert.equal(routing.defaultMentionDepartment(client), "sales", "a client workspace has no Chief of Staff teammate");
    // No manifest, nobody answers: a client is never handed a static lead.
    assert.deepEqual(routing.answeringDepartments({ oasis: false }), []);
    // The Settings page offers exactly these (source wiring: the page filters
    // OS_DEPARTMENTS by answeringDepartments, over the workspace manifest,
    // before rendering the map).
    const page = read("app/settings/chat-apps/page.tsx");
    assert.match(page, /answeringDepartments\(\{ oasis: viewer\.access\.oasisWorkspace, manifest \}\)/);
    assert.match(page, /departments=\{mappableDepartments\}/);
  });

  await check("in a client workspace, a mention that names no department in a general channel gets a draft, not a 'not set up' notice", async () => {
    const job = { ...dispatched[0], eventId: "EvMENTIONDEF1", text: `<@${BOT_A}> where are we with the Acme renovation?`, channelDepartment: null, customerId: null };
    const out = await jobs.runSlackMentionJob(job, turnDeps("We are on schedule; the next visit is booked."));
    assert.equal(out.outcome, "approval_created", JSON.stringify(out));
    const row = await approvalsStore.getApprovalInTenant(db, ALPHA, (out as { approvalId: string }).approvalId);
    assert.equal(row?.department_key, "sales", "the first department with a teammate");
  });

  // ── 4b. Where each department lives in Slack (AI Team, department tab) ────

  await check("the AI Team and department tab show the real Slack state, never 'Phase 2'", async () => {
    const status = await import("../lib/slack/status");
    const env = { SLACK_CLIENT_ID: "x", SLACK_CLIENT_SECRET: "y", SLACK_SIGNING_SECRET: "z", CONNECTIONS_OAUTH_STATE_SECRET: "w".repeat(40) };
    const alpha = await status.loadSlackPresence(db, ALPHA, env);
    assert.deepEqual(status.slackHomeFor(alpha, ["client_success"]), { kind: "channels", names: ["clients"] });
    assert.deepEqual(status.slackHomeFor(alpha, ["sales"]), { kind: "mention_only" });
    assert.deepEqual(status.slackHomeFor(await status.loadSlackPresence(db, OASIS, env), ["sales"]), { kind: "not_connected" });
    // OASIS's own workspace with OASIS's app not on the deployment: nothing can answer.
    assert.deepEqual(status.slackHomeFor(await status.loadSlackPresence(db, OASIS, {}), ["sales"]), { kind: "not_configured" });
    // A client is never served by OASIS's app: connected, but with no Slack app
    // of its own, nothing can answer, even with OASIS's app on the deployment.
    assert.deepEqual(status.slackHomeFor(await status.loadSlackPresence(db, BRAVO_CO, env), ["sales"]), { kind: "not_configured" });
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

  // ── 4c. Guards that must hold even when nothing else would catch them ─────

  await check("a users.info failure (Slack 5xx, or no answer) is 503 and writes no receipt, so Slack retries", async () => {
    const receipts = await count("SELECT COUNT(*) AS n FROM slack_event_receipts");
    const r = await events.handleSlackEvents(signed(eventBody(message(FLAKY_USER, "C0CLIENTS", "is anyone there"), { eventId: "EvFLAKY001" })), deps());
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.equal(r.body.error, "identity_unavailable");
    const timedOut = await events.handleSlackEvents(signed(eventBody(message("UNEWUSER1", "C0CLIENTS", "slow slack"), { eventId: "EvFLAKY002" })), {
      ...deps(),
      fetchImpl: (async () => {
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      }) as typeof fetch,
    });
    assert.equal(timedOut.status, 503);
    assert.equal(await count("SELECT COUNT(*) AS n FROM slack_event_receipts"), receipts, "no receipt: the retry is processed");
    assert.equal(await count("SELECT COUNT(*) AS n FROM slack_event_receipts WHERE event_id IN ('EvFLAKY001','EvFLAKY002')"), 0);
  });

  await check("a job whose Slack team now routes to another workspace is dropped: nothing drafted, no model called", async () => {
    let prepared = 0;
    const job = { ...dispatched[0], tenantId: BRAVO_CO, eventId: "EvWRONGTEN1" };
    const out = await jobs.runSlackMentionJob(job, {
      db,
      now,
      prepare: (async () => {
        prepared += 1;
        return { ok: false, status: 500, error: "should_not_run" };
      }) as unknown as NonNullable<Parameters<typeof jobs.runSlackMentionJob>[1]["prepare"]>,
    });
    assert.deepEqual(out, { outcome: "dropped", reason: "team_not_routed_here" });
    assert.equal(prepared, 0);
    assert.equal(await count("SELECT COUNT(*) AS n FROM approvals WHERE tenant_id = ?", [BRAVO_CO]), 0);
  });

  const pendingSlackApproval = async (eventId: string) => {
    const created = await jobs.runSlackMentionJob({ ...dispatched[0], eventId }, turnDeps(`draft for ${eventId}`));
    assert.equal(created.outcome, "approval_created", JSON.stringify(created));
    const id = (created as { approvalId: string }).approvalId;
    return { id, hash: (await approvalsStore.getApprovalInTenant(db, ALPHA, id))!.payload_hash };
  };

  await check("an owner deactivated after their Slack link was cached cannot approve from Slack", async () => {
    // The owner writes once: their Slack user is looked up and linked (cached a day).
    await events.handleSlackEvents(signed(eventBody(message("UOWNER2", "C0CLIENTS", "morning all"))), deps());
    const cached = (await db.execute("SELECT profile_id FROM external_identities WHERE external_user_id = 'UOWNER2'")).rows[0];
    assert.equal(cached?.profile_id, "p-owner2-a");
    await db.execute({ sql: "UPDATE user_profiles SET deactivated_at = ? WHERE id = 'p-owner2-a'", args: [new Date().toISOString()] });
    const { id, hash } = await pendingSlackApproval("EvDEACT0001");
    const postsBefore = posts.length;
    const r = await pressApprove("UOWNER2", `${id}|${hash}`);
    assert.match(String(r.replaced), /Only an owner or admin/);
    assert.equal(posts.length, postsBefore, "nothing posted");
    assert.equal((await approvalsStore.getApprovalInTenant(db, ALPHA, id))?.status, "pending");
  });

  await check("a deactivated teammate's Slack email never links to them on a fresh lookup", async () => {
    const identityMod = await import("../lib/slack/identity");
    const who = await identityMod.resolveSlackIdentity(db, { tenantId: ALPHA, teamId: TEAM_A, slackUserId: "UDEACT1", token: TOKEN_A, now: now() });
    assert.ok(who.ok);
    assert.equal(who.identity.profileId, null, "gone@alpha.test is deactivated");
    assert.equal(await identityMod.slackApproverProfile(db, ALPHA, "p-gone-a"), null);
    assert.equal((await identityMod.slackApproverProfile(db, ALPHA, "p-owner-a"))?.authUserId, "auth-owner-a");
    assert.equal(await identityMod.slackApproverProfile(db, ALPHA, "p-member-a"), null, "a member is not an approver");
  });

  await check("a guest (or another company's user) cannot approve, even when a stale row still links them to an owner", async () => {
    const stamp2 = new Date().toISOString();
    for (const [user, guest, external] of [["UGUESTLNK", 1, 0], ["UEXTLNK01", 0, 1]] as const) {
      await db.execute({
        sql: `INSERT INTO external_identities (id, tenant_id, provider, external_team_id, external_user_id, display_name, profile_id,
                is_guest, is_external, checked_at, created_at, updated_at)
              VALUES (?, ?, 'slack', ?, ?, 'Linked Once', 'p-owner-a', ?, ?, ?, ?, ?)`,
        args: [`ei-${user}`, ALPHA, TEAM_A, user, guest, external, stamp2, stamp2, stamp2],
      });
      const { id, hash } = await pendingSlackApproval(`Ev${user}`);
      const postsBefore = posts.length;
      const r = await pressApprove(user, `${id}|${hash}`);
      assert.match(String(r.replaced), /Only an owner or admin/, user);
      assert.equal(posts.length, postsBefore, `${user}: nothing posted`);
      assert.equal((await approvalsStore.getApprovalInTenant(db, ALPHA, id))?.status, "pending", user);
    }
  });

  await check("another workspace's route for the same channel is its own row: the first workspace's mapping is untouched", async () => {
    const before = await routing.getChannelRoute(db, ALPHA, TEAM_A, "C0CLIENTS");
    assert.equal(before?.department, "client_success");
    const other = await routing.saveChannelRoute(db, { tenantId: BRAVO_CO, teamId: TEAM_A, channelId: "C0CLIENTS", channelName: "clients", department: "sales", customerId: null, createdBy: null, now: now() });
    assert.ok(other.ok, JSON.stringify(other));
    assert.equal((other as { route: { tenant_id: string } }).route.tenant_id, BRAVO_CO);
    const after = await routing.getChannelRoute(db, ALPHA, TEAM_A, "C0CLIENTS");
    assert.deepEqual(
      { department: after?.department, customer_id: after?.customer_id, id: after?.id },
      { department: "client_success", customer_id: CUSTOMER_A, id: before?.id },
      "Alpha's row is not overwritten",
    );
    // Events for the team still reach Alpha's mapping only (the team routes to Alpha).
    const r = await events.handleSlackEvents(signed(eventBody(message("UMEMBER1", "C0CLIENTS", "still alpha's"))), deps());
    assert.equal(r.body.mirrored, true);
    const last = (await slackRows(ALPHA)).find((x) => x.meta.text === "still alpha's");
    assert.ok(last, "mirrored into Alpha");
    assert.equal(last.meta.department, "client_success");
    assert.equal((await slackRows(BRAVO_CO)).length, 0);
    await routing.deleteChannelRoute(db, BRAVO_CO, TEAM_A, "C0CLIENTS");
  });

  await check("a disconnect's Slack cleanup is empty (never a failing statement) where the Slack tables are not installed", async () => {
    const bare = createClient({ url: `file:${join(mkdtempSync(join(tmpdir(), "slack-bare-")), "bare.db")}` });
    assert.deepEqual(await routing.slackDisconnectStatements(bare, ALPHA, TEAM_A), []);
    const full = await routing.slackDisconnectStatements(db, ALPHA, TEAM_A);
    assert.equal(full.length, 2);
    bare.close();
  });

  await check("Slack installed but its tables missing reads as 'couldn't check', never 'by @mention'", async () => {
    const status = await import("../lib/slack/status");
    const bare = createClient({ url: `file:${join(mkdtempSync(join(tmpdir(), "slack-bare-")), "bare.db")}` });
    await bare.executeMultiple(read("database/turso/bravo__187_os_connections.sql"));
    await bare.execute({
      sql: `INSERT INTO tenant_connections (id, tenant_id, provider, scope_kind, auth_kind, external_account_id, external_account_label,
              status, last_health_verdict, last_health_at, connected_at, created_at, updated_at)
            VALUES ('conn-bare', ?, 'slack', 'tenant', 'app_install', ?, 'Alpha', 'connected', 'healthy', ?, ?, ?, ?)`,
      args: [ALPHA, TEAM_A, new Date().toISOString(), stamp, stamp, stamp],
    });
    const env = { SLACK_CLIENT_ID: "x", SLACK_CLIENT_SECRET: "y", SLACK_SIGNING_SECRET: "z", CONNECTIONS_OAUTH_STATE_SECRET: "w".repeat(40) };
    const presence = await status.loadSlackPresence(bare, ALPHA, env);
    assert.deepEqual(presence, { kind: "unknown" });
    assert.deepEqual(status.slackHomeFor(presence, ["sales"]), { kind: "unknown" });
    bare.close();
  });

  await check("a turn whose provider THROWS is logged with its cause (redacted) and returns a code, never a silent failure", async () => {
    const deptAgent = await import("../lib/os/department-agent");
    const secret = process.env.SLACK_SIGNING_SECRET!;
    const logged: unknown[][] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => void logged.push(args);
    let out;
    try {
      const boom = async function* (): AsyncGenerator<{ type: "delta"; text: string }> {
        if (secret) throw new Error(`socket hang up while sending with ${secret}`);
        yield { type: "delta", text: "" };
      };
      out = await deptAgent.runAgentTurnToText(
        { tenantId: ALPHA, agentSlug: "customer-support" } as unknown as Parameters<typeof deptAgent.runAgentTurnToText>[0],
        [{ role: "user", content: "hi" }],
        64,
        boom as unknown as Parameters<typeof deptAgent.runAgentTurnToText>[3],
      );
    } finally {
      console.error = realError;
    }
    assert.deepEqual(out, { ok: false, code: "stream_failed" });
    const entry = logged.find((a) => a[0] === "[department-agent.turn]");
    assert.ok(entry, "the failure is logged");
    const fields = entry![1] as { tenantId: string; error: string };
    assert.equal(fields.tenantId, ALPHA);
    assert.match(fields.error, /socket hang up/);
    assert.doesNotMatch(fields.error, new RegExp(secret), "the secret is redacted");
    assert.match(fields.error, /\[REDACTED:SLACK_SIGNING_SECRET\]/);
  });

  await check("who can approve, as every surface says it, is what the rules do: a department's own teammate in the Feed", async () => {
    const copy = await import("../lib/slack/copy");
    const connectors = await import("../lib/os/connectors");
    // A Sales rep (the sales seat) approves a Sales Slack reply in the Feed.
    const created = await approvalsStore.createApproval(
      db,
      {
        tenantId: ALPHA,
        departmentKey: "sales",
        requestedBy: { type: "agent", id: "sdr" },
        actionKind: "send_slack_message",
        title: "Slack reply in #sales",
        payload: { team_id: TEAM_A, channel_id: "C0SALES", thread_ts: "1727700000.000300", text: "Thanks, we will call you Monday." },
      },
      now(),
    );
    assert.ok(created.ok);
    const row = (created as { approval: { id: string; payload_hash: string } }).approval;
    const rep = rules.approvalScopeFor({ tenantId: ALPHA, userId: "auth-member-a", persona: "sales", canAct: true, openDepartments: new Set(["sales"] as const) });
    const decided = await approvalsStore.decideApproval(db, rep, row.id, { kind: "approve", payloadHash: row.payload_hash }, now());
    assert.equal(decided.ok, true, "the Feed lets the department's own teammate approve");
    // So no surface may promise "only an owner or admin" for the Feed.
    assert.match(copy.SLACK_APPROVAL_RULE, /someone who can approve for that department approves it in the Feed/);
    assert.match(copy.SLACK_APPROVAL_RULE, /An owner or admin who asks in Slack can also approve there/);
    const slack = connectors.connectorBySlug("slack")!;
    assert.ok(slack.does.includes(copy.SLACK_APPROVAL_RULE), "the Slack connector says it");
    const page = read("app/settings/chat-apps/page.tsx");
    assert.match(page, /\{SLACK_APPROVAL_RULE\}/, "Settings > Chat apps says it");
    for (const said of [slack.does.join(" "), page, send.approvalNoticeText("Sales")]) {
      assert.doesNotMatch(said, /until an owner or admin approves/i);
    }
  });

  await check("the channel map's writes never throw: a request that cannot reach OASIS is a note on the row", async () => {
    const actions = await import("../components/settings/slack-channel-map-actions");
    const offline = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as Parameters<typeof actions.saveChannelMapping>[1];
    const realError = console.error;
    console.error = () => undefined;
    try {
      assert.deepEqual(await actions.saveChannelMapping({ channelId: "C0CLIENTS", department: "sales", customerId: null }, offline), {
        ok: false,
        text: "Not saved: could not reach OASIS. Try again.",
      });
      assert.deepEqual(await actions.removeChannelMapping("C0CLIENTS", offline), { ok: false, text: "Not removed: could not reach OASIS. Try again." });
      const htmlError = (async () => new Response("<html>bad gateway</html>", { status: 502 })) as unknown as Parameters<typeof actions.saveChannelMapping>[1];
      assert.deepEqual(await actions.saveChannelMapping({ channelId: "C0CLIENTS", department: null, customerId: null }, htmlError), {
        ok: false,
        text: "Not saved (HTTP 502).",
      });
    } finally {
      console.error = realError;
    }
    const saved = await actions.saveChannelMapping(
      { channelId: "C0CLIENTS", department: "sales", customerId: null },
      (async () => new Response(JSON.stringify({ ok: true, route: { department: "sales", customer_id: null } }), { status: 200 })) as unknown as Parameters<
        typeof actions.saveChannelMapping
      >[1],
    );
    assert.deepEqual(saved, { ok: true, value: { department: "sales", customer_id: null } });
    const component = read("components/settings/SlackChannelMap.tsx");
    assert.match(component, /saveChannelMapping\(/);
    assert.match(component, /removeChannelMapping\(/);
    assert.doesNotMatch(component, /method: "(PUT|DELETE)"/, "the component makes no raw write that could throw");
  });

  await check("the Approve press is answered at once; the decision and the post run after the answer", async () => {
    const interactivityRoute = await import("../app/api/webhooks/slack/interactivity/route");
    const { id, hash } = await pendingSlackApproval("EvROUTE0001");
    const payload = {
      type: "block_actions",
      team: { id: TEAM_A },
      user: { id: "UOWNER1" },
      response_url: "https://hooks.slack.com/actions/T0ALPHA/9/route",
      actions: [{ action_id: send.APPROVE_ACTION_ID, value: `${id}|${hash}` }],
    };
    const body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
    // ALPHA is a client: its presses arrive at its own Interactivity URL.
    const req = (b: string, sig?: string) => {
      const s = signed(b);
      return new NextRequest(`https://oasisai.work/api/webhooks/slack/interactivity?workspace=${ALPHA}`, {
        method: "POST",
        body: b,
        headers: { "content-type": "application/x-www-form-urlencoded", "x-slack-request-timestamp": s.timestamp, "x-slack-signature": sig ?? s.signature },
      });
    };
    laterTasks.length = 0;
    const postsBefore = posts.length;
    const usersBefore = usersInfoCalls;
    const res = await interactivityRoute.POST(req(body));
    assert.equal(res.status, 200);
    assert.equal((await approvalsStore.getApprovalInTenant(db, ALPHA, id))?.status, "pending", "nothing decided before Slack has its answer");
    assert.equal(posts.length, postsBefore, "nothing posted before the answer");
    assert.equal(usersInfoCalls, usersBefore, "no Slack call before the answer");
    assert.equal(laterTasks.length, 1, "the press's work waits for after the answer");
    await laterTasks[0]();
    assert.equal((await approvalsStore.getApprovalInTenant(db, ALPHA, id))?.status, "executed");
    assert.equal(posts.length, postsBefore + 1, "the reply is posted once");
    assert.match(String(responses.at(-1)?.body.text), /Approved by Olly Owner in Slack/);
    // A forged press is refused in the answer itself, with no work left behind.
    laterTasks.length = 0;
    const forged = await interactivityRoute.POST(req(body, "v0=" + "0".repeat(64)));
    assert.equal(forged.status, 401);
    assert.equal(laterTasks.length, 0);
    // Work that throws after the answer still tells the presser.
    await interactivity.reportPressFailure("https://hooks.slack.com/actions/T0ALPHA/9/route");
    assert.equal(responses.at(-1)?.body.text, interactivity.PRESS_FAILED_COPY);
  });

  // ── 5. The queue consumer and the internal jobs route ─────────────────────

  await check("the queue consumer signs each job with the internal job key (no Slack app secret needed), acks a 2xx and retries anything else", async () => {
    const acked: string[] = [];
    const retried: string[] = [];
    const msg = (id: string) => ({ body: { id }, ack: () => acked.push(id), retry: () => retried.push(id) });
    const seen: Request[] = [];
    // Only OASIS's internal Connections secret: a workspace on its own Slack app
    // gets its mentions run even where OASIS's Slack app is not set up.
    const root = { CONNECTIONS_OAUTH_STATE_SECRET: process.env.CONNECTIONS_OAUTH_STATE_SECRET! };
    const jobKey = await jobSig.slackJobSecret(root);
    assert.ok(jobKey && jobKey !== SECRET, "the job key is derived, and is not the Slack signing secret");
    assert.notEqual(jobKey, root.CONNECTIONS_OAUTH_STATE_SECRET, "nor the Connections secret itself: one key per purpose");
    assert.equal(await jobSig.slackJobSecret({ CONNECTIONS_OAUTH_STATE_SECRET: "too-short" }), null, "a short root secret gives no job key");
    const res = await consumer.consumeSlackJobs(
      { messages: [msg("a"), msg("b")] },
      { ...root, PUBLIC_APP_URL: "https://oasisai.work" },
      async (request) => {
        seen.push(request);
        const body = await request.clone().text();
        const okSig = await jobSig.verifySlackJob({
          secret: jobKey,
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
    assert.deepEqual(none, { acked: 0, retried: 1 }, "no job key: nothing can be proven, so everything is retried");
    const slackOnly = await consumer.consumeSlackJobs({ messages: [msg("d")] }, { SLACK_SIGNING_SECRET: SECRET } as never, async () => new Response("{}"));
    assert.deepEqual(slackOnly, { acked: 0, retried: 1 }, "a Slack signing secret alone is not a job key");
  });

  await check("the jobs route takes only the internal job key: unsigned, Slack-signed, and a job signed with the Slack app secret are all refused", async () => {
    const body = JSON.stringify(dispatched[0]);
    const unsigned = await jobsRoute.POST(new NextRequest("https://oasisai.work/api/webhooks/slack/jobs", { method: "POST", body }));
    assert.equal(unsigned.status, 401);
    const ts = String(Math.floor(Date.now() / 1000));
    const post = (signature: string) =>
      jobsRoute.POST(
        new NextRequest("https://oasisai.work/api/webhooks/slack/jobs", {
          method: "POST",
          body,
          headers: { [jobSig.JOB_TIMESTAMP_HEADER]: ts, [jobSig.JOB_SIGNATURE_HEADER]: signature },
        }),
      );
    assert.equal((await post(verify.slackSignature(SECRET, ts, body))).status, 401, "a Slack request signature is not a job signature");
    assert.equal((await post(await jobSig.signSlackJob(SECRET, ts, body))).status, 401, "OASIS's Slack app secret cannot mint a job for any workspace");
    const jobKey = await jobSig.slackJobSecret({ CONNECTIONS_OAUTH_STATE_SECRET: process.env.CONNECTIONS_OAUTH_STATE_SECRET! });
    assert.notEqual((await post(await jobSig.signSlackJob(jobKey!, ts, body))).status, 401, "the internal job key is accepted");
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
        {
          // A Slack person not looked up again for 91 days: their name and teammate link age out.
          sql: `INSERT INTO external_identities (id, tenant_id, provider, external_team_id, external_user_id, display_name, profile_id,
                  is_guest, is_external, checked_at, created_at, updated_at)
                VALUES ('ei-old', ?, 'slack', ?, 'UOLDPERSON', 'Old Person', NULL, 0, 0, ?, ?, ?)`,
          args: [ALPHA, TEAM_A, old, old, old],
        },
      ],
      "write",
    );
    const identitiesBefore = await count("SELECT COUNT(*) AS n FROM external_identities");
    const r = await retention.purgeSlackRetention(db, new Date());
    assert.equal(r.messagesDeleted, 1);
    assert.ok(r.receiptsDeleted >= 1);
    assert.equal(r.notInstalled, false);
    const ids = (await db.execute("SELECT id FROM conversation_events WHERE id IN ('old-slack','recent-slack','old-email')")).rows.map((x) => String(x.id)).sort();
    assert.deepEqual(ids, ["old-email", "recent-slack"]);
    assert.equal(r.identitiesDeleted, 1);
    assert.equal(await count("SELECT COUNT(*) AS n FROM external_identities WHERE external_user_id = 'UOLDPERSON'"), 0);
    assert.equal(await count("SELECT COUNT(*) AS n FROM external_identities"), identitiesBefore - 1, "people looked up recently stay");
  });

  // ── 7. Independent verification (2026-09-30): guards no earlier check held ──

  await check("Slack's own time orders the mirror; a private-channel message and a future-dated request are refused", async () => {
    const ahead = await events.handleSlackEvents(signed(eventBody(message("UMEMBER1", "C0CLIENTS", "from the future")), Math.floor(Date.now() / 1000) + 6 * 60), deps());
    assert.equal(ahead.status, 401, "six minutes AHEAD is outside the window too");
    assert.equal(ahead.body.error, "stale_timestamp");
    const group = await events.handleSlackEvents(signed(eventBody(message("UMEMBER1", "C0CLIENTS", "private one", { channel_type: "group" }))), deps());
    assert.equal(group.body.ignored, "not_a_channel", "only public-channel messages (message.channels) are mirrored");
    const writtenSec = Math.floor(Date.now() / 1000) - 2 * 3600;
    const late = await events.handleSlackEvents(signed(eventBody(message("UMEMBER1", "C0CLIENTS", "written two hours ago", { ts: `${writtenSec}.000100` }))), deps());
    assert.equal(late.body.mirrored, true);
    const row = (
      await db.execute({
        sql: "SELECT created_at FROM conversation_events WHERE tenant_id = ? AND json_extract(metadata, '$.text') = 'written two hours ago'",
        args: [ALPHA],
      })
    ).rows[0];
    assert.equal(String(row?.created_at), new Date(writtenSec * 1000).toISOString(), "dated when it was written in Slack, not when OASIS got it");
  });

  await check("a person's Slack status is re-checked after a day: a member made a guest stops being mirrored", async () => {
    const first = await events.handleSlackEvents(signed(eventBody(message("UFLIP1", "C0CLIENTS", "flip one"))), deps());
    assert.equal(first.body.mirrored, true);
    SLACK_USERS.UFLIP1 = { ...SLACK_USERS.UFLIP1, is_restricted: true };
    const cachedAnswer = await events.handleSlackEvents(signed(eventBody(message("UFLIP1", "C0CLIENTS", "flip two"))), deps());
    assert.equal(cachedAnswer.body.mirrored, true, "inside a day the cached answer stands");
    await db.execute({ sql: "UPDATE external_identities SET checked_at = ? WHERE external_user_id = 'UFLIP1'", args: [new Date(Date.now() - 25 * 3_600_000).toISOString()] });
    const stale = await events.handleSlackEvents(signed(eventBody(message("UFLIP1", "C0CLIENTS", "flip three"))), deps());
    assert.equal(stale.body.dropped, "guest", "a day later Slack is asked again, and the guest is dropped");
  });

  await check("Slack's is_stranger marks another company's user even when the team id looks like ours", async () => {
    const r = await events.handleSlackEvents(signed(eventBody(message("USTRANGER1", "C0CLIENTS", "hello from outside"))), deps());
    assert.equal(r.body.dropped, "external_user");
  });

  await check("a bot user whose message has no bot_id is dropped every time, and never cached as a person", async () => {
    const before = (await slackRows()).length;
    for (const text of ["beep", "boop"]) {
      const r = await events.handleSlackEvents(signed(eventBody(message("UBOTUSER1", "C0CLIENTS", text))), deps());
      assert.equal(r.body.ignored, "bot", text);
    }
    const jobsBefore = dispatched.length;
    const m = await events.handleSlackEvents(signed(eventBody(mention("UBOTUSER1", "C0CLIENTS", "Client Success hi"))), deps());
    assert.equal(m.body.ignored, "bot");
    assert.equal(dispatched.length, jobsBefore, "a bot's mention starts no job");
    assert.equal((await slackRows()).length, before);
    assert.equal(await count("SELECT COUNT(*) AS n FROM external_identities WHERE external_user_id = 'UBOTUSER1'"), 0);
  });

  await check("a mention with nothing after it gets a one-line ask, and no model is called", async () => {
    let prepared = 0;
    const job = { ...dispatched[0], eventId: "EvEMPTYQ001", text: `<@${BOT_A}>`, channelDepartment: "client_success" as const };
    const out = await jobs.runSlackMentionJob(job, {
      db,
      now,
      prepare: (async () => {
        prepared += 1;
        return { ok: false, status: 500, error: "should_not_run" };
      }) as unknown as NonNullable<Parameters<typeof jobs.runSlackMentionJob>[1]["prepare"]>,
    });
    assert.deepEqual({ outcome: out.outcome, reason: (out as { reason: string }).reason }, { outcome: "notice", reason: "empty_question" });
    assert.equal(prepared, 0);
    assert.match(String(posts[posts.length - 1].body.text), /^Ask Client Success a question after the mention/);
  });

  await check("the owner's card shows a long draft in full and escaped; the approved reply is posted as exactly the words approved", async () => {
    const lines = Array.from({ length: 40 }, (_, i) => `Line ${i + 1}: invoice <#C0${i}> & terms > net 30, pay <https://pay.test|here> <!channel>`);
    const draft = lines.join("\n");
    assert.ok(draft.length > 3000 && draft.length <= rules.SLACK_TEXT_MAX, `a draft of ${draft.length} characters`);
    const r = await events.handleSlackEvents(signed(eventBody(mention("UOWNER1", "C0CLIENTS", "Client Success draft the long note"), { eventId: "EvLONGCARD1" })), deps());
    assert.equal(r.body.dispatched, true, JSON.stringify(r.body));
    const out = await jobs.runSlackMentionJob(dispatched[dispatched.length - 1], turnDeps(draft));
    assert.equal(out.outcome, "approval_created", JSON.stringify(out));
    const card = ephemerals[ephemerals.length - 1].body;
    assert.equal(card.user, "UOWNER1");
    const sections = (card.blocks as Array<{ type: string; text?: { text: string } }>).filter((b) => b.type === "section").map((b) => String(b.text?.text));
    for (const s of sections) assert.ok(s.length <= 3000, `Slack refuses a section of ${s.length} characters`);
    const unescape = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    const shown = sections
      .slice(1)
      .map((s) => s.split("\n").map((l) => unescape(l.replace(/^>/, ""))).join("\n"))
      .join("\n");
    assert.equal(shown, draft, "every word the Approve button binds to is on the card");
    assert.doesNotMatch(sections.join("\n"), /<!channel>|<https:|<#C/, "no live Slack markup on the card");

    const id = (out as { approvalId: string }).approvalId;
    const row = await approvalsStore.getApprovalInTenant(db, ALPHA, id);
    const postsBefore = posts.length;
    const pressed = await pressApprove("UOWNER1", `${id}|${row!.payload_hash}`);
    assert.match(String(pressed.replaced), /The reply is posted/);
    assert.equal(posts.length, postsBefore + 1);
    const posted = String(posts[posts.length - 1].body.text);
    assert.doesNotMatch(posted, /<!channel>|<https:|<#C/, "nothing in an approved draft pings the channel, mentions anyone or hides a link");
    assert.equal(unescape(posted), draft, "Slack shows exactly the approved words");
    const mirrored = (await slackRows(ALPHA)).filter((x) => x.meta.direction === "outbound").at(-1);
    assert.equal(mirrored?.meta.text, draft, "the conversation keeps the approved words as written");
  });

  await check("a posted reply needs a live token: an expired Slack connection posts nothing", async () => {
    await db.execute("UPDATE tenant_connections SET status = 'expired' WHERE id = 'conn-slack-a'");
    try {
      const postsBefore = posts.length;
      const out = await send.postSlackReply(db, { tenantId: ALPHA, teamId: TEAM_A, channelId: "C0CLIENTS", threadTs: "1727700000.000100", text: "x", department: "sales", approvalId: "x" });
      assert.equal(out.ok, false);
      assert.equal((out as { reason: string }).reason, "slack_token_rejected");
      assert.equal(posts.length, postsBefore);
    } finally {
      await db.execute("UPDATE tenant_connections SET status = 'connected' WHERE id = 'conn-slack-a'");
    }
  });

  await check("Jev's shadow is asked only about general channels, never about a department's or a message that @mentions OASIS", async () => {
    const seen: string[] = [];
    const d = { ...deps(), onGeneralMessage: (m: { text: string }) => void seen.push(m.text) };
    await events.handleSlackEvents(signed(eventBody(message("UMEMBER1", "C0GENERAL", "general chatter"))), d);
    await events.handleSlackEvents(signed(eventBody(message("UMEMBER1", "C0CLIENTS", "client chatter"))), d);
    await events.handleSlackEvents(signed(eventBody(message("UMEMBER1", "C0GENERAL", `<@${BOT_A}> Sales anyone?`))), d);
    assert.deepEqual(seen, ["general chatter"]);
  });

  await check("a channel can be linked only to one of this workspace's own clients", async () => {
    await db.execute({ sql: "INSERT INTO customers VALUES ('cust-bravo-1', ?, 'Bravo Client', NULL, NULL, ?, ?)", args: [BRAVO_CO, stamp, stamp] });
    const r = await routing.saveChannelRoute(db, { tenantId: ALPHA, teamId: TEAM_A, channelId: "C0OTHERCL", channelName: "other", department: null, customerId: "cust-bravo-1", createdBy: null, now: now() });
    assert.deepEqual(r, { ok: false, error: "unknown_customer" });
    assert.equal(await count("SELECT COUNT(*) AS n FROM slack_channel_routes WHERE channel_id = 'C0OTHERCL'"), 0);
  });

  await check("a press's response_url is used only when it is Slack's own", async () => {
    const client = await import("../lib/slack/client");
    assert.equal(client.isSlackResponseUrl("https://hooks.slack.com/actions/T0ALPHA/1/x"), true);
    for (const u of ["https://evil.test/hook", "http://hooks.slack.com/actions/x", "https://hooks.slack.com.evil.test/x"]) {
      assert.equal(client.isSlackResponseUrl(u), false, u);
    }
    assert.deepEqual(await client.respondToAction("https://evil.test/hook", { text: "x" }), { ok: false, error: "response_url_not_slack" });
    const { id, hash } = await pendingSlackApproval("EvRESPURL01");
    const payload = { type: "block_actions", team: { id: TEAM_A }, user: { id: "UOWNER1" }, response_url: "https://evil.test/collect", actions: [{ action_id: send.APPROVE_ACTION_ID, value: `${id}|${hash}` }] };
    const accepted = await interactivity.acceptSlackInteraction(signed(new URLSearchParams({ payload: JSON.stringify(payload) }).toString()), { db, now });
    assert.equal(accepted.responseUrl, null);
  });

  await check("a queued job's signature expires after a day", async () => {
    const stale = String(Math.floor(Date.now() / 1000) - 25 * 3600);
    assert.equal(await jobSig.verifySlackJob({ secret: SECRET, timestamp: stale, signature: await jobSig.signSlackJob(SECRET, stale, "{}"), body: "{}", nowMs: Date.now() }), false);
    const fresh = String(Math.floor(Date.now() / 1000) - 60);
    assert.equal(await jobSig.verifySlackJob({ secret: SECRET, timestamp: fresh, signature: await jobSig.signSlackJob(SECRET, fresh, "{}"), body: "{}", nowMs: Date.now() }), true);
  });

  await check("Chat apps reads the onboarding answer 'we use Slack', and only that shape of it", async () => {
    const settings = await import("../lib/slack/settings");
    const env = { SLACK_CLIENT_ID: "x", SLACK_CLIENT_SECRET: "y", SLACK_SIGNING_SECRET: "z", CONNECTIONS_OAUTH_STATE_SECRET: "w".repeat(40) };
    const asked = async (manifest: unknown) => {
      await db.execute({ sql: "UPDATE tenant_manifests SET manifest = ? WHERE tenant_id = ?", args: [JSON.stringify(manifest), BRAVO_CO] });
      return (await settings.loadSlackSettings(db, BRAVO_CO, { env, nowMs: Date.now() })).askedForSlack;
    };
    try {
      assert.equal(await asked({ integrations: { chat_apps: ["slack"], jev: "off" } }), true);
      assert.equal(await asked({ integrations: { chat_apps: ["telegram"] } }), false);
      assert.equal(await asked({ integrations: ["slack"] }), false, "the old array shape says nothing about chat apps");
      assert.equal(await asked({}), false);
    } finally {
      await db.execute({ sql: "UPDATE tenant_manifests SET manifest = ? WHERE tenant_id = ?", args: [BRAVO_CO_MANIFEST, BRAVO_CO] });
    }
  });

  await check("the Disconnect button's request never throws: a request that cannot reach OASIS is said, not swallowed", async () => {
    const action = await import("../components/settings/slack-disconnect-action");
    type F = Parameters<typeof action.disconnectSlack>[0];
    const realError = console.error;
    console.error = () => undefined;
    try {
      const offline = (async () => {
        throw new TypeError("Failed to fetch");
      }) as unknown as F;
      assert.deepEqual(await action.disconnectSlack(offline), { ok: false, text: "Not disconnected: could not reach OASIS. Try again." });
      assert.deepEqual(await action.disconnectSlack((async () => new Response("<html>bad gateway</html>", { status: 502 })) as unknown as F), {
        ok: false,
        text: "Not disconnected (HTTP 502).",
      });
    } finally {
      console.error = realError;
    }
    const refused = (async () => new Response(JSON.stringify({ ok: false, message: "Only an owner or admin can disconnect." }), { status: 403 })) as unknown as F;
    assert.deepEqual(await action.disconnectSlack(refused), { ok: false, text: "Only an owner or admin can disconnect." });
    const done = (async (url: string, init?: RequestInit) => {
      assert.equal(url, "/api/connections/slack/disconnect");
      assert.equal(init?.method, "POST");
      return new Response(JSON.stringify({ ok: true, disconnected: true }), { status: 200 });
    }) as unknown as F;
    assert.deepEqual(await action.disconnectSlack(done), { ok: true });
    const component = read("components/settings/SlackDisconnect.tsx");
    assert.match(component, /disconnectSlack\(\)/);
    assert.doesNotMatch(component, /fetch\(/, "the component makes no raw request that could reject unseen");
  });

  await check("the platform key in Slack follows the AUTH user's email, never a profile email set to the operator alias", async () => {
    // OASIS's Slack, routed to OASIS; CC (the operator) and another OASIS owner
    // whose PROFILE email was changed to CC's alias. The auth records say who is who.
    await connect(OASIS, "T0OASIS", "conn-slack-oasis", TOKEN_A, BOT_A);
    await db.batch(
      [
        { sql: "INSERT INTO tenant_manifests VALUES ('m-oasis', ?, 'oasis-ai-cc', '{}', 1, 1, ?, ?)", args: [OASIS, stamp, stamp] },
        { sql: "INSERT INTO _supabase_auth_users (id, email) VALUES ('auth-cc', 'conaugh@oasisai.work')", args: [] },
        { sql: "INSERT INTO _supabase_auth_users (id, email) VALUES ('auth-squat', 'squat@oasis.test')", args: [] },
        {
          sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, onboarding_completed_at, updated_at)
                VALUES ('p-cc', 'auth-cc', 'conaugh@oasisai.work', ?, 'owner', 1, ?, ?)`,
          args: [OASIS, stamp, stamp],
        },
        {
          sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, onboarding_completed_at, updated_at)
                VALUES ('p-squat', 'auth-squat', 'conaugh@oasisai.work', ?, 'owner', 1, ?, ?)`,
          args: [OASIS, stamp, stamp],
        },
      ],
      "write",
    );
    const savedKey = process.env.PLATFORM_DEFAULT_OPENROUTER_API_KEY;
    process.env.PLATFORM_DEFAULT_OPENROUTER_API_KEY = "slack-events-test-not-a-platform-key";
    const realError = console.error;
    console.error = () => undefined;
    try {
      const fallbackFor = async (profileId: string, eventId: string) => {
        let seen: unknown = "not called";
        const job = { ...dispatched[0], tenantId: OASIS, teamId: "T0OASIS", channelId: "C0OASIS1", channelName: null, eventId, profileId, text: `<@${BOT_A}> Client Success hi`, channelDepartment: null, customerId: null };
        await jobs.runSlackMentionJob(job, {
          db,
          now,
          prepare: (async (req: { platformFallback: unknown }) => {
            seen = req.platformFallback;
            return { ok: false, status: 412, error: "agent_not_configured" };
          }) as unknown as NonNullable<Parameters<typeof jobs.runSlackMentionJob>[1]["prepare"]>,
        });
        return seen;
      };
      const cc = await fallbackFor("p-cc", "EvOPERCC001");
      assert.ok(cc && typeof cc === "object", "CC, the verified operator, gets the platform key");
      assert.equal(await fallbackFor("p-squat", "EvOPERSQ001"), null, "a profile email set to the alias is not the operator");
    } finally {
      console.error = realError;
      if (savedKey === undefined) delete process.env.PLATFORM_DEFAULT_OPENROUTER_API_KEY;
      else process.env.PLATFORM_DEFAULT_OPENROUTER_API_KEY = savedKey;
    }
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
