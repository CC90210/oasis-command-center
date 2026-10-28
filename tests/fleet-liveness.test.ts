/**
 * tests/fleet-liveness.test.ts - Admin > Fleet: CC's four agents, one honest state each (2026-10-28).
 *
 * Pinned:
 *   1. fleetLiveness at every threshold edge: grey never seen; green a process within 5 minutes or a
 *      tick within 15; red a fresh process row that says down, or the computer silent 10 minutes;
 *      amber otherwise. fleetSignals counts fresh "down" rows.
 *   2. parseAgentTicks: at most four, house agents only, once each, known keys only, a sane clock,
 *      a whole count, a known health word; absent is [] and malformed is null.
 *   3. recordAgentTicks on real libSQL: forward only, and every write wipes working_memory and
 *      pending_actions (the old focus text goes with the first tick).
 *   4. POST /api/bridge/ping end to end: the agents owner's computer on OASIS's workspace records its
 *      ticks; another member's computer, a client workspace's owner and a malformed field are ignored,
 *      and the heartbeat itself still answers 200 every time.
 *
 * Run: node --conditions=react-server --import tsx tests/fleet-liveness.test.ts
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, type Client } from "@libsql/client";
import { NextRequest } from "next/server";

const dbFile = join(mkdtempSync(join(tmpdir(), "fleet-liveness-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
for (const k of ["TURSO_DATABASE_URL", "TURSO_DB_URL", "TURSO_AUTH_TOKEN", "BRAVO_SUPABASE_URL", "BRAVO_SUPABASE_SERVICE_ROLE_KEY"]) delete process.env[k];

const db: Client = createClient({ url: `file:${dbFile}` });
const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const OASIS = "tenant-oasis";
const CLIENT = "tenant-client";
const OWNER = "auth-owner";
const MEMBER = "auth-member";
const CLIENT_OWNER = "auth-client-owner";

let passed = 0;
let failed = 0;
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${name}\n        ${String((error as Error).stack || error).split("\n").slice(0, 6).join("\n        ")}`);
  }
}

async function schema(): Promise<void> {
  await db.executeMultiple(`
    CREATE TABLE tenants (id TEXT PRIMARY KEY, slug TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', custom_fields TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE "_supabase_auth_users" (id TEXT PRIMARY KEY, email TEXT NOT NULL,
      session_version INTEGER NOT NULL DEFAULT 0, banned_until TEXT, deleted_at TEXT, raw_user_meta_data TEXT);
    CREATE TABLE user_profiles (id TEXT PRIMARY KEY, auth_user_id TEXT, email TEXT, tenant_id TEXT,
      team_role TEXT, is_owner INTEGER DEFAULT 0, admin_access INTEGER DEFAULT 0, deactivated_at TEXT,
      full_name TEXT, display_name TEXT, onboarding_completed_at TEXT, updated_at TEXT);
    CREATE TABLE bridge_pairings (
      id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT, label TEXT NOT NULL, bridge_token_hash TEXT NOT NULL,
      machine_fingerprint TEXT, last_seen_at TEXT, last_seen_ip TEXT, revoked_at TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), tool_capabilities TEXT NOT NULL DEFAULT '[]',
      scope TEXT, paired_via TEXT, claim_protocols TEXT, claim_enabled_at TEXT, claim_enabled_by TEXT,
      claude_account_hash TEXT, previous_token_hash TEXT, token_rotated_at TEXT, last_poll_ok_at TEXT, claim_state_at TEXT,
      claim_capacity INTEGER, claim_in_flight INTEGER, claim_blocked_reason TEXT, claim_runtime_state TEXT);
    CREATE TABLE integrations_health (id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), tenant_id TEXT,
      profile_id TEXT, service TEXT NOT NULL, status TEXT NOT NULL, last_ping_at TEXT, last_error TEXT,
      metadata TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
    CREATE UNIQUE INDEX "integrations_health_profile_id_service_key" ON integrations_health (profile_id, service);
    CREATE TABLE "tenant_integration_credentials" ("id" TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))),
      "tenant_id" TEXT NOT NULL, "service" TEXT NOT NULL, "field_key" TEXT NOT NULL, "encrypted_value" TEXT NOT NULL,
      "last_tested_at" TEXT, "last_test_ok" INTEGER, "last_test_error" TEXT, "created_by" TEXT,
      "created_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      "updated_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), PRIMARY KEY ("id"));
    CREATE UNIQUE INDEX "tic_key" ON "tenant_integration_credentials" (tenant_id, service, field_key);
    CREATE TABLE workspace_agents_owner (tenant_id TEXT PRIMARY KEY, auth_user_id TEXT, revoked_at TEXT);
    -- agent_state_snapshot as the live database holds it (global: the house agents).
    CREATE TABLE agent_state_snapshot (
      id TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))) PRIMARY KEY, agent_name TEXT NOT NULL,
      tick_count INTEGER DEFAULT 0, last_tick_at TEXT, last_tick_id TEXT, working_memory TEXT DEFAULT '{}',
      pending_actions TEXT DEFAULT '[]', health_status TEXT DEFAULT 'ok',
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
    CREATE UNIQUE INDEX "agent_state_snapshot_agent_name_key" ON agent_state_snapshot (agent_name);
  `);
  await db.batch([
    { sql: "INSERT INTO tenants (id, slug) VALUES (?, 'oasis-ai-cc')", args: [OASIS] },
    { sql: "INSERT INTO tenants (id, slug) VALUES (?, 'acme-plumbing')", args: [CLIENT] },
    ...[[OWNER, OASIS, "owner"], [MEMBER, OASIS, "member"], [CLIENT_OWNER, CLIENT, "owner"]].flatMap(([user, tenant, role]) => [
      { sql: `INSERT INTO "_supabase_auth_users" (id, email) VALUES (?, ?)`, args: [user, `${user}@x.test`] },
      { sql: "INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, onboarding_completed_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", args: [`p-${user}`, user, `${user}@x.test`, tenant, role, role === "owner" ? 1 : 0, "2026-10-01T00:00:00Z", "2026-10-01T00:00:00Z"] },
    ]),
    { sql: "INSERT INTO workspace_agents_owner VALUES (?, ?, NULL)", args: [OASIS, OWNER] },
    { sql: "INSERT INTO workspace_agents_owner VALUES (?, ?, NULL)", args: [CLIENT, CLIENT_OWNER] },
    // Bravo's row carries the old focus text an earlier mirror left behind.
    { sql: `INSERT INTO agent_state_snapshot (agent_name, tick_count, last_tick_at, working_memory, health_status) VALUES ('bravo', 1388, '2026-10-22T09:20:53.819703+00:00', '{"focus":"secret plans"}', 'healthy')`, args: [] },
  ], "write");
}

async function computer(user: string, tenant: string) {
  const id = `pair-${user}`;
  const token = `oab_${user}_token`;
  await db.execute({
    sql: "INSERT INTO bridge_pairings (id, tenant_id, user_id, label, bridge_token_hash, scope, paired_via, claim_enabled_at) VALUES (?, ?, ?, 'Mac', ?, 'connector', 'pair_code', '2026-10-01T00:00:00Z')",
    args: [id, tenant, user, sha256(token)],
  });
  return token;
}

async function main(): Promise<void> {
  const fleet = await import("../components/os/landings/fleet-data");
  const ticks = await import("../lib/bridge/fleet-ticks");
  const NOW = Date.parse("2026-10-28T12:00:00.000Z");
  const ago = (ms: number) => new Date(NOW - ms).toISOString();
  const MIN = 60_000;
  const sig = (over: Record<string, unknown> = {}) =>
    ({ name: "bravo", live: false, processCount: 0, runningCount: 0, downCount: 0, lastSignalAt: null, lastTaskAt: null, tickCount: null, ...over }) as never;
  const mac = { label: "Mac", lastSeenAt: ago(1 * MIN) };

  await check("liveness at every edge", () => {
    assert.equal(fleet.fleetLiveness(null, mac, NOW), "grey");
    assert.equal(fleet.fleetLiveness(sig(), mac, NOW), "grey", "no process and no tick: never seen");
    assert.equal(fleet.fleetLiveness(sig({ live: true, processCount: 1, runningCount: 1 }), mac, NOW), "green");
    assert.equal(fleet.fleetLiveness(sig({ lastTaskAt: ago(14 * MIN) }), mac, NOW), "green", "a tick under 15 minutes");
    assert.equal(fleet.fleetLiveness(sig({ lastTaskAt: ago(15 * MIN) }), mac, NOW), "amber", "15 minutes is quiet");
    assert.equal(fleet.fleetLiveness(sig({ lastTaskAt: ago(60 * MIN), processCount: 1, downCount: 1 }), mac, NOW), "red", "a fresh row says down");
    assert.equal(fleet.fleetLiveness(sig({ lastTaskAt: ago(60 * MIN) }), { label: "Mac", lastSeenAt: ago(10 * MIN) }, NOW), "red", "the computer silent 10 minutes");
    assert.equal(fleet.fleetLiveness(sig({ lastTaskAt: ago(60 * MIN) }), { label: "Mac", lastSeenAt: ago(9 * MIN) }, NOW), "amber");
    assert.equal(fleet.fleetLiveness(sig({ lastTaskAt: ago(60 * MIN) }), { label: "Mac", lastSeenAt: null }, NOW), "red", "a computer that never checked in");
    assert.equal(fleet.fleetLiveness(sig({ lastTaskAt: ago(60 * MIN) }), null, NOW), "amber", "no computer to judge by");
    assert.equal(fleet.fleetLiveness(sig({ lastTaskAt: ago(60 * MIN) }), undefined, NOW), "amber", "a computer that could not be read");
  });

  await check("fleetSignals counts only fresh rows that say down", () => {
    const signals = fleet.fleetSignals(["maven"], [], [
      { service: "pm2.maven-telegram", last_ping_at: ago(2 * MIN), status: "down", metadata: "{}" },
      { service: "pm2.maven-worker", last_ping_at: ago(20 * MIN), status: "down", metadata: "{}" },
      { service: "pm2.maven-api", last_ping_at: ago(1 * MIN), status: "healthy", metadata: "{}" },
    ], NOW);
    const maven = signals.get("maven")!;
    assert.equal(maven.processCount, 3);
    assert.equal(maven.runningCount, 1);
    assert.equal(maven.downCount, 1, "a stale down row is not counted");
  });

  await check("parseAgentTicks accepts only well-formed house-agent ticks", () => {
    const good = { agent: "Bravo", last_tick_at: ago(1 * MIN), tick_count: 96, health: "green" };
    assert.deepEqual(ticks.parseAgentTicks(undefined, NOW), []);
    assert.deepEqual(ticks.parseAgentTicks([good], NOW), [{ agent: "bravo", lastTickAt: ago(1 * MIN), tickCount: 96, health: "healthy" }]);
    const bad: unknown[] = [
      "nope",
      Array(5).fill(good),
      [{ ...good, agent: "lex" }],
      [good, good],
      [{ ...good, current_focus: "x" }],
      [{ ...good, last_tick_at: "yesterday" }],
      [{ ...good, last_tick_at: new Date(NOW + 10 * MIN).toISOString() }],
      [{ ...good, tick_count: 1.5 }],
      [{ ...good, tick_count: -1 }],
      [{ ...good, health: "fine" }],
    ];
    for (const raw of bad) assert.equal(ticks.parseAgentTicks(raw, NOW), null, JSON.stringify(raw).slice(0, 80));
  });

  await schema();

  await check("recordAgentTicks: forward only, and every write wipes the working memory", async () => {
    const moved = await ticks.recordAgentTicks(db, [
      { agent: "bravo", lastTickAt: "2026-10-28T11:59:00.000Z", tickCount: 1389, health: "healthy" },
      { agent: "aura", lastTickAt: "2026-10-28T11:00:00.000Z", tickCount: 3, health: "degraded" },
    ], NOW);
    assert.equal(moved, 2);
    const bravo = (await db.execute("SELECT * FROM agent_state_snapshot WHERE agent_name = 'bravo'")).rows[0];
    assert.equal(bravo.tick_count, 1389);
    assert.equal(bravo.working_memory, "{}", "the old focus text is gone");
    const older = await ticks.recordAgentTicks(db, [{ agent: "bravo", lastTickAt: "2026-10-28T10:00:00.000Z", tickCount: 1, health: "down" }], NOW);
    assert.equal(older, 0, "an older report never overwrites a newer one");
    assert.equal((await db.execute("SELECT tick_count FROM agent_state_snapshot WHERE agent_name = 'bravo'")).rows[0].tick_count, 1389);
    assert.equal((await db.execute("SELECT health_status FROM agent_state_snapshot WHERE agent_name = 'aura'")).rows[0].health_status, "degraded");
  });

  const route = await import("../app/api/bridge/ping/route");
  const ping = async (token: string, extra: Record<string, unknown>) => {
    const res = await route.POST(
      new NextRequest("https://app.test/api/bridge/ping", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-forwarded-for": `10.0.0.${Math.floor(Math.random() * 200)}` },
        body: JSON.stringify({ services: {}, ...extra }),
      }),
    );
    return { status: res.status, json: (await res.json()) as { ok?: boolean; agent_ticks_recorded?: number; error?: string } };
  };
  const ownerToken = await computer(OWNER, OASIS);
  const memberToken = await computer(MEMBER, OASIS);
  const clientToken = await computer(CLIENT_OWNER, CLIENT);
  const tick = (agent: string, at: string, count: number) => ({ agent, last_tick_at: at, tick_count: count, health: "green" });

  await check("the ping: the agents owner's computer on OASIS records its ticks", async () => {
    const res = await ping(ownerToken, { agent_ticks: [tick("maven", new Date(Date.now() - MIN).toISOString(), 21)] });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(res.json.agent_ticks_recorded, 1);
    assert.equal((await db.execute("SELECT tick_count FROM agent_state_snapshot WHERE agent_name = 'maven'")).rows[0].tick_count, 21);
  });

  await check("the ping: anyone else's ticks, and a malformed field, are ignored; the heartbeat still answers", async () => {
    for (const token of [memberToken, clientToken]) {
      const res = await ping(token, { agent_ticks: [tick("atlas", new Date(Date.now() - MIN).toISOString(), 99)] });
      assert.equal(res.status, 200, JSON.stringify(res.json));
      assert.equal(res.json.agent_ticks_recorded, 0);
    }
    assert.equal((await db.execute("SELECT count(*) AS n FROM agent_state_snapshot WHERE agent_name = 'atlas'")).rows[0].n, 0);
    const malformed = await ping(ownerToken, { agent_ticks: [{ agent: "bravo", current_focus: "leak" }] });
    assert.equal(malformed.status, 200);
    assert.equal(malformed.json.agent_ticks_recorded, 0);
    const none = await ping(ownerToken, {});
    assert.equal(none.status, 200);
    assert.equal(none.json.agent_ticks_recorded, 0);
  });

  console.log(`fleet-liveness: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
