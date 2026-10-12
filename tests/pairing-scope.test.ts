/**
 * tests/pairing-scope.test.ts — a pairing's SCOPE decides what it may do
 * (O3a security rule 3): 'connector' reaches ping, claim, canary, rotate and
 * events only; 'daemon' also polls cron jobs and writes records. A legacy
 * row (scope NULL, every pairing that predates this migration) reads as
 * 'daemon' — CCPC and CC's Mac must keep working with zero re-approval.
 *
 * Also pins the pair-code mint/redeem rules this scope depends on:
 *   - a desktop code minted by a member yields 'connector'; minted by an
 *     owner/admin yields 'daemon';
 *   - a connector code always yields 'connector', mints NO sign-in link,
 *     names the workspace and a masked account, and expires in 5 minutes
 *     (not the desktop code's 15);
 *   - ping never lets a connector-scope pairing widen the operator chat's
 *     tool_capabilities, but still records claim_protocols for any scope.
 *
 * Run: node --conditions=react-server --import tsx tests/pairing-scope.test.ts
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createClient, type Client } from "@libsql/client";
import { NextRequest } from "next/server";

const dbFile = join(mkdtempSync(join(tmpdir(), "pairing-scope-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
process.env.AUTH_SESSION_SECRET = "pairing-scope-test-secret-long-enough-0000001";
process.env.EMPIRE_AUTH_BACKEND = "turso";
for (const k of ["TURSO_DATABASE_URL", "TURSO_DB_URL", "TURSO_AUTH_TOKEN", "BRAVO_SUPABASE_URL", "BRAVO_SUPABASE_SERVICE_ROLE_KEY", "BRAVO_DASHBOARD_URL"]) {
  delete process.env[k];
}

const SESSION_COOKIE_NAME = "oasis_session";
let sessionCookie: string | undefined;
{
  const p = require.resolve("next/headers");
  require.cache[p] = {
    id: p,
    filename: p,
    path: dirname(p),
    loaded: true,
    children: [],
    paths: [],
    exports: {
      cookies: async () => ({
        get: (name: string) => (name === SESSION_COOKIE_NAME && sessionCookie ? { name, value: sessionCookie } : undefined),
        getAll: () => (sessionCookie ? [{ name: SESSION_COOKIE_NAME, value: sessionCookie }] : []),
        has: (name: string) => name === SESSION_COOKIE_NAME && Boolean(sessionCookie),
        set: () => undefined,
      }),
      headers: async () => new Headers(),
      draftMode: async () => ({ isEnabled: false }),
    },
  } as unknown as NodeModule;
}

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const db: Client = createClient({ url: `file:${dbFile}` });

// Neither prefix matches EXPECTED_EXECUTOR_BY_TENANT_PREFIX, so the poll
// route's per-tenant executor gate never interferes with this file's checks.
const TENANT = "c1c1c1c1-0000-4000-8000-0000000000c1";
const OWNER_ID = "auth-owner-0001";
const REPAIR_OWNER_ID = "auth-owner-repair-0001";
const MEMBER_ID = "auth-member-0001"; // read_only
const stamp = "2026-10-11T00:00:00.000Z";

async function createSchema() {
  await db.executeMultiple(`
    CREATE TABLE tenants (id TEXT PRIMARY KEY, slug TEXT NOT NULL, name TEXT NOT NULL, custom_fields TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE "_supabase_auth_users" (id TEXT PRIMARY KEY, email TEXT NOT NULL,
      session_version INTEGER NOT NULL DEFAULT 0, banned_until TEXT, deleted_at TEXT, raw_user_meta_data TEXT);
    CREATE TABLE user_profiles (id TEXT PRIMARY KEY, auth_user_id TEXT, email TEXT, tenant_id TEXT,
      team_role TEXT, is_owner INTEGER DEFAULT 0, admin_access INTEGER DEFAULT 0, deactivated_at TEXT,
      full_name TEXT, display_name TEXT, onboarding_completed_at TEXT, updated_at TEXT);
    CREATE TABLE bridge_pairings (
      id TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))) PRIMARY KEY,
      tenant_id TEXT NOT NULL, user_id TEXT, label TEXT NOT NULL, bridge_token_hash TEXT NOT NULL,
      machine_fingerprint TEXT, last_seen_at TEXT, last_seen_ip TEXT, revoked_at TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      tool_capabilities TEXT NOT NULL DEFAULT '[]',
      scope TEXT, paired_via TEXT, claim_protocols TEXT, claim_enabled_at TEXT, claim_enabled_by TEXT,
      claude_account_hash TEXT, previous_token_hash TEXT, token_rotated_at TEXT,
      last_poll_ok_at TEXT, claim_state_at TEXT, claim_capacity INTEGER,
      claim_in_flight INTEGER, claim_blocked_reason TEXT, claim_runtime_state TEXT);
    CREATE UNIQUE INDEX idx_bridge_pairings_unique_live_machine
      ON bridge_pairings (tenant_id, machine_fingerprint) WHERE ((revoked_at IS NULL) AND (machine_fingerprint IS NOT NULL));
    CREATE TABLE bridge_pair_codes (
      id TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))) PRIMARY KEY,
      code TEXT NOT NULL, tenant_id TEXT NOT NULL, auth_user_id TEXT NOT NULL, email TEXT,
      expires_at TEXT NOT NULL, consumed_at TEXT, consumed_by_pairing_id TEXT,
      purpose TEXT NOT NULL DEFAULT 'desktop', scope TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
    CREATE UNIQUE INDEX idx_bridge_pair_codes_code ON bridge_pair_codes (code);
    CREATE TABLE tenant_cron_jobs (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, agent_key TEXT NOT NULL DEFAULT 'bravo',
      name TEXT NOT NULL, description TEXT, schedule TEXT NOT NULL, action_type TEXT NOT NULL,
      action_payload TEXT NOT NULL DEFAULT '{}', enabled INTEGER NOT NULL DEFAULT 1,
      last_run_at TEXT, last_run_status TEXT, last_run_output TEXT, last_run_error TEXT,
      run_count INTEGER NOT NULL DEFAULT 0, created_by TEXT,
      owner_user_id TEXT, last_scheduled_for TEXT, tz TEXT,
      created_at TEXT NOT NULL, updated_at TEXT);
    CREATE TABLE tenant_records (id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      tenant_id TEXT NOT NULL, entity_type TEXT NOT NULL, data TEXT,
      created_at TEXT, updated_at TEXT);
    CREATE TABLE integrations_health (id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), tenant_id TEXT,
      profile_id TEXT, service TEXT NOT NULL, status TEXT NOT NULL, last_ping_at TEXT, last_error TEXT,
      metadata TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
    CREATE UNIQUE INDEX "integrations_health_profile_id_service_key" ON integrations_health (profile_id, service);
  `);
}

async function seed() {
  for (const t of ["tenants", "_supabase_auth_users", "user_profiles", "bridge_pairings", "bridge_pair_codes", "tenant_cron_jobs", "tenant_records", "integrations_health"]) {
    await db.execute(`DELETE FROM ${t}`);
  }
  await db.batch(
    [
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'client-x', 'Client X Plumbing')", args: [TENANT] },
      { sql: `INSERT INTO "_supabase_auth_users" (id, email) VALUES (?, ?)`, args: [OWNER_ID, "owner@client-x.test"] },
      { sql: `INSERT INTO "_supabase_auth_users" (id, email) VALUES (?, ?)`, args: [REPAIR_OWNER_ID, "repair-owner@client-x.test"] },
      { sql: `INSERT INTO "_supabase_auth_users" (id, email) VALUES (?, ?)`, args: [MEMBER_ID, "member@client-x.test"] },
      {
        sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, full_name, onboarding_completed_at, updated_at)
              VALUES ('p-repair-owner', ?, 'repair-owner@client-x.test', ?, 'owner', 1, 'Repair Owner', ?, ?)`,
        args: [REPAIR_OWNER_ID, TENANT, stamp, stamp],
      },
      {
        sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, full_name, onboarding_completed_at, updated_at)
              VALUES ('p-owner', ?, 'owner@client-x.test', ?, 'owner', 1, 'Owner', ?, ?)`,
        args: [OWNER_ID, TENANT, stamp, stamp],
      },
      {
        sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, full_name, onboarding_completed_at, updated_at)
              VALUES ('p-member', ?, 'member@client-x.test', ?, 'read_only', 0, 'Member', ?, ?)`,
        args: [MEMBER_ID, TENANT, stamp, stamp],
      },
    ],
    "write",
  );
}

async function login(authUserId: string, email: string) {
  const { signSession } = await import("../lib/turso-auth");
  sessionCookie = signSession({ sub: authUserId, email, exp: Math.floor(Date.now() / 1000) + 3600, ver: 0 });
}
function logout() {
  sessionCookie = undefined;
}

function pairingRow(opts: {
  id: string;
  userId: string | null;
  label: string;
  token: string;
  scope: string | null;
  pairedVia?: string | null;
  fingerprint?: string | null;
}): Promise<unknown> {
  return db.execute({
    sql: `INSERT INTO bridge_pairings (id, tenant_id, user_id, label, bridge_token_hash, machine_fingerprint, scope, paired_via)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [opts.id, TENANT, opts.userId, opts.label, sha256(opts.token), opts.fingerprint ?? null, opts.scope, opts.pairedVia ?? null],
  });
}

let failures = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await seed();
    await fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${(e as Error).stack?.split("\n").slice(0, 8).join("\n        ")}`);
  }
}

async function jsonOf(res: Response) {
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

async function main() {
  await createSchema();
  const mintRoute = await import("../app/api/auth/pair-code/route");
  const redeemRoute = await import("../app/api/auth/pair-code/redeem/route");
  const pingRoute = await import("../app/api/bridge/ping/route");
  const pollRoute = await import("../app/api/cron-jobs/poll/route");
  const recordsRoute = await import("../app/api/bridge/records/[entity]/route");

  const mintReq = (body: unknown = {}) =>
    new NextRequest("https://oasisai.work/api/auth/pair-code", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const redeemReq = (code: string, fingerprint = `fp-${code}`) =>
    new NextRequest("https://oasisai.work/api/auth/pair-code/redeem", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, machine: { label: "Test box", fingerprint } }),
    });
  const pingReq = (token: string, body: Record<string, unknown>) =>
    new NextRequest("https://oasisai.work/api/bridge/ping", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  const pollGet = (token: string) =>
    new NextRequest("https://oasisai.work/api/cron-jobs/poll", { headers: { authorization: `Bearer ${token}` } });
  const recordsPost = (token: string) =>
    new NextRequest("https://oasisai.work/api/bridge/records/widget", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ data: { name: "x" } }),
    });
  const recordsEntityCtx = { params: Promise.resolve({ entity: "widget" }) };

  console.log("pairing-scope:");

  // ── Pair-code mint: scope decided by purpose + minter role ──────────────
  await check("a desktop code minted by a MEMBER yields a connector pairing", async () => {
    await login(MEMBER_ID, "member@client-x.test");
    const { status, body } = await jsonOf(await mintRoute.POST(mintReq()));
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.purpose, "desktop");
    assert.equal(body.scope, "connector");
    assert.equal(body.ttl_minutes, 15);
  });

  await check("a desktop code minted by the OWNER yields a daemon pairing", async () => {
    await login(OWNER_ID, "owner@client-x.test");
    const { status, body } = await jsonOf(await mintRoute.POST(mintReq()));
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.purpose, "desktop");
    assert.equal(body.scope, "daemon");
  });

  await check("a connector-purpose code is ALWAYS scope connector, even minted by the owner, and lives 5 minutes", async () => {
    await login(OWNER_ID, "owner@client-x.test");
    const { status, body } = await jsonOf(await mintRoute.POST(mintReq({ purpose: "connector" })));
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.purpose, "connector");
    assert.equal(body.scope, "connector");
    assert.equal(body.ttl_minutes, 5);
    const ttlMs = Date.parse(String(body.expires_at)) - Date.now();
    assert.ok(ttlMs > 4 * 60_000 && ttlMs <= 5 * 60_000 + 2000, `expected ~5 min, got ${ttlMs}ms`);
  });

  // ── Redeem: connector mints no sign-in link, names the workspace ────────
  await check("redeeming a connector code: no sign-in link, workspace + masked account named, pairing scope connector", async () => {
    await login(OWNER_ID, "owner@client-x.test");
    const mint = (await jsonOf(await mintRoute.POST(mintReq({ purpose: "connector" })))).body as { code: string };
    logout();
    const { status, body } = await jsonOf(await redeemRoute.POST(redeemReq(mint.code)));
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.session, null, "a connector redeem never gets a sign-in link");
    assert.deepEqual(body.workspace, { tenant_id: TENANT, slug: "client-x", name: "Client X Plumbing" });
    assert.equal((body.account as { email_masked: string }).email_masked, "o***@client-x.test");
    const row = await db.execute({ sql: "SELECT scope, paired_via FROM bridge_pairings WHERE id = ?", args: [(body.bridge as { pairing_id: string }).pairing_id] });
    assert.equal(row.rows[0].scope, "connector");
    assert.equal(row.rows[0].paired_via, "pair_code");
  });

  await check("redeeming a desktop code minted by the owner: a sign-in link, no workspace/account fields, pairing scope daemon", async () => {
    await login(OWNER_ID, "owner@client-x.test");
    const mint = (await jsonOf(await mintRoute.POST(mintReq()))).body as { code: string };
    logout();
    const { status, body } = await jsonOf(await redeemRoute.POST(redeemReq(mint.code)));
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.workspace, undefined, "the desktop path names no workspace object");
    assert.equal(body.account, undefined, "the desktop path names no account object");
    const row = await db.execute({ sql: "SELECT scope FROM bridge_pairings WHERE id = ?", args: [(body.bridge as { pairing_id: string }).pairing_id] });
    assert.equal(row.rows[0].scope, "daemon");
  });

  await check("a connector code redeemed after its 5-minute window is refused like any expired code", async () => {
    await login(OWNER_ID, "owner@client-x.test");
    const mint = (await jsonOf(await mintRoute.POST(mintReq({ purpose: "connector" })))).body as { code: string };
    logout();
    await db.execute({ sql: "UPDATE bridge_pair_codes SET expires_at = ? WHERE code = ?", args: ["2020-01-01T00:00:00.000Z", mint.code] });
    const { status, body } = await jsonOf(await redeemRoute.POST(redeemReq(mint.code)));
    assert.equal(status, 404, JSON.stringify(body));
  });

  // ── Scope enforcement on daemon-only endpoints ───────────────────────────
  await check("LEGACY COMPATIBILITY: a pairing with scope NULL (predates this migration) still polls and writes records as a daemon", async () => {
    await pairingRow({ id: "bp-legacy", userId: OWNER_ID, label: "CCPC (Windows)", token: "legacy-token", scope: null, fingerprint: "legacy-fp" });
    assert.equal((await pollRoute.GET(pollGet("legacy-token"))).status, 200, "legacy NULL scope polls as daemon");
    const recordsRes = await recordsRoute.POST(recordsPost("legacy-token"), recordsEntityCtx);
    assert.equal(recordsRes.status, 200, JSON.stringify(await recordsRes.clone().json()));
  });

  await check("a connector-scope pairing (read_only member) gets 403 from the job feed and 403 on records POST/PATCH", async () => {
    await pairingRow({ id: "bp-connector", userId: MEMBER_ID, label: "Member laptop", token: "connector-token", scope: "connector", fingerprint: "connector-fp" });
    const pollRes = await pollRoute.GET(pollGet("connector-token"));
    assert.equal(pollRes.status, 403, JSON.stringify(await pollRes.clone().json()));
    const postRes = await recordsRoute.POST(recordsPost("connector-token"), recordsEntityCtx);
    assert.equal(postRes.status, 403, JSON.stringify(await postRes.clone().json()));
    const patchReq = new NextRequest("https://oasisai.work/api/bridge/records/widget?id=x", {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: "Bearer connector-token" },
      body: JSON.stringify({ patch: { name: "y" } }),
    });
    const patchRes = await recordsRoute.PATCH(patchReq, recordsEntityCtx);
    assert.equal(patchRes.status, 403, JSON.stringify(await patchRes.clone().json()));
  });

  await check("a daemon-scope pairing polls jobs and writes records", async () => {
    await pairingRow({ id: "bp-daemon", userId: OWNER_ID, label: "Owner desktop", token: "daemon-token", scope: "daemon", fingerprint: "daemon-fp" });
    assert.equal((await pollRoute.GET(pollGet("daemon-token"))).status, 200);
    const postRes = await recordsRoute.POST(recordsPost("daemon-token"), recordsEntityCtx);
    assert.equal(postRes.status, 200, JSON.stringify(await postRes.clone().json()));
  });

  // ── Ping: claim_protocols own column, connector never widens tool list ──
  await check("ping stores claim_protocols in its own column for either scope, and never folds it into tool_capabilities", async () => {
    await pairingRow({ id: "bp-ping-daemon", userId: OWNER_ID, label: "Owner desktop", token: "ping-daemon-token", scope: "daemon", fingerprint: "ping-daemon-fp" });
    const res = await pingRoute.POST(pingReq("ping-daemon-token", { services: {}, claim_protocols: ["department_task_v1"] }));
    assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
    const row = await db.execute({ sql: "SELECT claim_protocols, tool_capabilities FROM bridge_pairings WHERE id = 'bp-ping-daemon'" });
    assert.deepEqual(JSON.parse(String(row.rows[0].claim_protocols)), ["department_task_v1"]);
  });

  await check("ping persists the connector's truthful busy and idle execution state", async () => {
    await pairingRow({ id: "bp-ping-load", userId: OWNER_ID, label: "Busy connector", token: "ping-load-token", scope: "connector", fingerprint: "ping-load-fp" });
    const busy = await pingRoute.POST(pingReq("ping-load-token", {
      services: {},
      capacity: 0,
      in_flight: 1,
      blocked_reason: null,
    }));
    assert.equal(busy.status, 200, JSON.stringify(await busy.clone().json()));
    let row = (await db.execute({
      sql: "SELECT claim_state_at, claim_capacity, claim_in_flight, claim_blocked_reason FROM bridge_pairings WHERE id = 'bp-ping-load'",
    })).rows[0];
    assert.ok(row.claim_state_at);
    assert.equal(row.claim_capacity, 0);
    assert.equal(row.claim_in_flight, 1);
    assert.equal(row.claim_blocked_reason, null);

    const idle = await pingRoute.POST(pingReq("ping-load-token", {
      services: {},
      capacity: 1,
      in_flight: 0,
      blocked_reason: null,
    }));
    assert.equal(idle.status, 200, JSON.stringify(await idle.clone().json()));
    row = (await db.execute({
      sql: "SELECT claim_capacity, claim_in_flight FROM bridge_pairings WHERE id = 'bp-ping-load'",
    })).rows[0];
    assert.equal(row.claim_capacity, 1);
    assert.equal(row.claim_in_flight, 0);
  });

  await check("ping rejects partial or malformed execution state without changing the pairing", async () => {
    await pairingRow({ id: "bp-ping-invalid-load", userId: OWNER_ID, label: "Connector", token: "ping-invalid-load-token", scope: "connector", fingerprint: "ping-invalid-load-fp" });
    const partial = await pingRoute.POST(pingReq("ping-invalid-load-token", { capacity: 0, in_flight: 1 }));
    assert.equal(partial.status, 400);
    const malformed = await pingRoute.POST(pingReq("ping-invalid-load-token", {
      capacity: 1,
      in_flight: 0,
      blocked_reason: "../../bad",
    }));
    assert.equal(malformed.status, 400);
    const row = (await db.execute({
      sql: "SELECT claim_state_at, claim_capacity, claim_in_flight FROM bridge_pairings WHERE id = 'bp-ping-invalid-load'",
    })).rows[0];
    assert.deepEqual([row.claim_state_at, row.claim_capacity, row.claim_in_flight], [null, null, null]);
  });

  await check("a connector ping that sends tool_capabilities does not change the operator chat's bridge tool list", async () => {
    await pairingRow({ id: "bp-ping-connector", userId: OWNER_ID, label: "Connector box", token: "ping-connector-token", scope: "connector", fingerprint: "ping-connector-fp" });
    const before = await db.execute({ sql: "SELECT tool_capabilities FROM bridge_pairings WHERE id = 'bp-ping-connector'" });
    const res = await pingRoute.POST(
      pingReq("ping-connector-token", { services: {}, tool_capabilities: ["read_file", "write_file"] }),
    );
    assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
    const after = await db.execute({ sql: "SELECT tool_capabilities FROM bridge_pairings WHERE id = 'bp-ping-connector'" });
    assert.equal(after.rows[0].tool_capabilities, before.rows[0].tool_capabilities, "a connector's reported tools never land");
  });

  // Codex review (O3a P1): the workspace's bridge status (and so /api/chat's
  // tool palette) must answer from daemon pairings only. A fresh connector
  // heartbeat must not make an offline daemon read as online.
  await check("the workspace bridge status ignores a fresher connector heartbeat: daemon offline stays offline", async () => {
    const { getTenantBridgeStatus } = await import("../lib/queries");
    await pairingRow({ id: "bp-status-daemon", userId: OWNER_ID, label: "Owner desktop", token: "status-daemon-token", scope: "daemon", fingerprint: "status-daemon-fp" });
    await pairingRow({ id: "bp-status-connector", userId: OWNER_ID, label: "Connector box", token: "status-connector-token", scope: "connector", fingerprint: "status-connector-fp" });
    await db.execute({ sql: "UPDATE bridge_pairings SET last_seen_at = ? WHERE id = 'bp-status-daemon'", args: ["2020-01-01T00:00:00.000Z"] });
    await db.execute({ sql: "UPDATE bridge_pairings SET last_seen_at = ? WHERE id = 'bp-status-connector'", args: [new Date().toISOString()] });
    assert.equal((await getTenantBridgeStatus(TENANT)).online, false, "a connector's heartbeat never stands in for the daemon");
    await db.execute({ sql: "UPDATE bridge_pairings SET last_seen_at = ? WHERE id = 'bp-status-daemon'", args: [new Date().toISOString()] });
    assert.equal((await getTenantBridgeStatus(TENANT)).online, true, "the daemon's own heartbeat still counts");
  });

  // Codex review (O3a P1): a re-pair starts a fresh token history and a fresh
  // approval. A connector token replaced just before the re-pair must not
  // answer for the new daemon pairing (nor revoke it later).
  await check("re-pairing a computer clears the previous token and the approval: the old in-grace token answers nothing", async () => {
    const { sha256 } = await import("../lib/api-helpers");
    const fp = "repair-fp";
    await login(REPAIR_OWNER_ID, "repair-owner@client-x.test");
    const first = (await jsonOf(await mintRoute.POST(mintReq({ purpose: "connector" })))).body as { code: string };
    logout();
    const r1 = await jsonOf(await redeemRoute.POST(redeemReq(first.code, fp)));
    assert.equal(r1.status, 200, JSON.stringify(r1.body));
    const pairingId = (r1.body.bridge as { pairing_id: string }).pairing_id;
    const nowIso = new Date().toISOString();
    await db.execute({
      sql: "UPDATE bridge_pairings SET previous_token_hash = ?, token_rotated_at = ?, claim_enabled_at = ?, claim_enabled_by = ? WHERE id = ?",
      args: [sha256("old-connector-token"), nowIso, nowIso, REPAIR_OWNER_ID, pairingId],
    });
    await login(REPAIR_OWNER_ID, "repair-owner@client-x.test");
    const second = (await jsonOf(await mintRoute.POST(mintReq()))).body as { code: string };
    logout();
    const r2 = await jsonOf(await redeemRoute.POST(redeemReq(second.code, fp)));
    assert.equal(r2.status, 200, JSON.stringify(r2.body));
    const row = (await db.execute({ sql: "SELECT scope, previous_token_hash, token_rotated_at, claim_enabled_at, revoked_at FROM bridge_pairings WHERE id = ?", args: [pairingId] })).rows[0];
    assert.equal(row.scope, "daemon");
    assert.equal(row.previous_token_hash, null, "the replaced token is forgotten on re-pair");
    assert.equal(row.token_rotated_at, null);
    assert.equal(row.claim_enabled_at, null, "an approval never carries over to a re-pair");
    const oldPoll = await pollRoute.GET(pollGet("old-connector-token"));
    assert.equal(oldPoll.status, 401, "the old connector token answers nothing");
    const after = (await db.execute({ sql: "SELECT revoked_at FROM bridge_pairings WHERE id = ?", args: [pairingId] })).rows[0];
    assert.equal(after.revoked_at, null, "and presenting it does not revoke the new pairing");
  });

  if (failures > 0) {
    console.log(`pairing-scope: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log("pairing-scope: all passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
