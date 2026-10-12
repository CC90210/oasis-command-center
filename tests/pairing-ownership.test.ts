/**
 * tests/pairing-ownership.test.ts — a computer takes work only after ITS
 * OWNER approves it; a 'daemon' pairing only when that owner is the
 * workspace's agents owner; a 'signup_secret' pairing never (O3a).
 *
 * Also pins:
 *   - token rotation's 60-second grace, and the reuse-after-grace refusal
 *     that revokes the pairing and raises an attention item;
 *   - /api/devices owner semantics (your own computers always; an owner or
 *     admin also sees the team's) and the audited admin disconnect.
 *
 * Run: node --conditions=react-server --import tsx tests/pairing-ownership.test.ts
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createClient, type Client } from "@libsql/client";
import { NextRequest } from "next/server";

const dbFile = join(mkdtempSync(join(tmpdir(), "pairing-ownership-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
process.env.AUTH_SESSION_SECRET = "pairing-ownership-test-secret-long-enough-001";
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

const TENANT = "d2d2d2d2-0000-4000-8000-0000000000d2";
const OWNER_ID = "auth-ownr-0001"; // the workspace's AGENTS OWNER, and an owner-role seat
const MEMBER_ID = "auth-memb-0001"; // a plain member, owns a connector computer
const OTHER_ID = "auth-othr-0001"; // another member — owns nothing in these checks
const stamp = "2026-10-11T00:00:00.000Z";

async function createSchema() {
  await db.executeMultiple(`
    CREATE TABLE tenants (id TEXT PRIMARY KEY, slug TEXT NOT NULL, name TEXT NOT NULL, custom_fields TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE "_supabase_auth_users" (id TEXT PRIMARY KEY, email TEXT NOT NULL,
      session_version INTEGER NOT NULL DEFAULT 0, banned_until TEXT, deleted_at TEXT);
    CREATE TABLE user_profiles (id TEXT PRIMARY KEY, auth_user_id TEXT, email TEXT, tenant_id TEXT,
      team_role TEXT, is_owner INTEGER DEFAULT 0, admin_access INTEGER DEFAULT 0, deactivated_at TEXT,
      full_name TEXT, display_name TEXT, onboarding_completed_at TEXT, updated_at TEXT);
    CREATE TABLE workspace_agents_owner (
      tenant_id TEXT PRIMARY KEY, auth_user_id TEXT NOT NULL, set_by TEXT NOT NULL,
      set_at TEXT NOT NULL, note TEXT, revoked_at TEXT);
    CREATE TABLE bridge_pairings (
      id TEXT NOT NULL PRIMARY KEY,
      tenant_id TEXT NOT NULL, user_id TEXT, label TEXT NOT NULL, bridge_token_hash TEXT NOT NULL,
      machine_fingerprint TEXT, last_seen_at TEXT, last_seen_ip TEXT, revoked_at TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      tool_capabilities TEXT NOT NULL DEFAULT '[]',
      scope TEXT, paired_via TEXT, claim_protocols TEXT, claim_enabled_at TEXT, claim_enabled_by TEXT,
      claude_account_hash TEXT, claim_state_at TEXT, claim_capacity INTEGER, claim_in_flight INTEGER,
      claim_blocked_reason TEXT, last_claim_ip TEXT, previous_token_hash TEXT, token_rotated_at TEXT,
      last_poll_ok_at TEXT);
    CREATE TABLE bridge_pair_codes (
      code TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, auth_user_id TEXT NOT NULL, email TEXT,
      expires_at TEXT NOT NULL, consumed_at TEXT, consumed_by_pairing_id TEXT,
      purpose TEXT NOT NULL DEFAULT 'desktop', scope TEXT, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
    CREATE TABLE agent_events (id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      event_type TEXT, publisher_agent TEXT, severity TEXT, payload TEXT, correlation_id TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
    CREATE TABLE tenant_audit_log (
      id TEXT PRIMARY KEY, tenant_id TEXT, actor_user_id TEXT, actor_email TEXT,
      action_type TEXT NOT NULL, target_table TEXT, target_id TEXT, before TEXT,
      after TEXT, ip_hash TEXT, user_agent TEXT, metadata TEXT, created_at TEXT);
  `);
}

async function seed() {
  for (const t of ["tenants", "_supabase_auth_users", "user_profiles", "workspace_agents_owner", "bridge_pairings", "bridge_pair_codes", "agent_events", "tenant_audit_log"]) {
    await db.execute(`DELETE FROM ${t}`);
  }
  await db.batch(
    [
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'oasis-ai-cc', 'OASIS AI Solutions')", args: [TENANT] },
      ...[
        [OWNER_ID, "owner@client-y.test"],
        [MEMBER_ID, "member@client-y.test"],
        [OTHER_ID, "other@client-y.test"],
      ].map(([id, email]) => ({ sql: `INSERT INTO "_supabase_auth_users" (id, email) VALUES (?, ?)`, args: [id, email] })),
      {
        sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, full_name, onboarding_completed_at, updated_at)
              VALUES ('p-owner', ?, 'owner@client-y.test', ?, 'owner', 1, 'Owner', ?, ?)`,
        args: [OWNER_ID, TENANT, stamp, stamp],
      },
      {
        sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, full_name, onboarding_completed_at, updated_at)
              VALUES ('p-member', ?, 'member@client-y.test', ?, 'member', 0, 'Member', ?, ?)`,
        args: [MEMBER_ID, TENANT, stamp, stamp],
      },
      {
        sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, full_name, onboarding_completed_at, updated_at)
              VALUES ('p-other', ?, 'other@client-y.test', ?, 'member', 0, 'Other', ?, ?)`,
        args: [OTHER_ID, TENANT, stamp, stamp],
      },
      {
        sql: `INSERT INTO workspace_agents_owner (tenant_id, auth_user_id, set_by, set_at) VALUES (?, ?, 'test', ?)`,
        args: [TENANT, OWNER_ID, stamp],
      },
    ],
    "write",
  );
}

async function login(authUserId: string, email: string) {
  const { signSession } = await import("../lib/turso-auth");
  sessionCookie = signSession({ sub: authUserId, email, exp: Math.floor(Date.now() / 1000) + 3600, ver: 0 });
}

function pairing(opts: {
  id: string;
  userId: string | null;
  label: string;
  token: string;
  scope: string | null;
  pairedVia: string | null;
}): Promise<unknown> {
  return db.execute({
    sql: `INSERT INTO bridge_pairings (id, tenant_id, user_id, label, bridge_token_hash, scope, paired_via)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [opts.id, TENANT, opts.userId, opts.label, sha256(opts.token), opts.scope, opts.pairedVia],
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
  const approveRoute = await import("../app/api/devices/[id]/approve/route");
  const devicesRoute = await import("../app/api/devices/route");
  const pairCodeRoute = await import("../app/api/auth/pair-code/route");
  const rotateRoute = await import("../app/api/bridge/pairing/rotate/route");
  const { resolvePairingFromBearer, pairingCanClaim } = await import("../lib/bridge/pairing-auth");

  const approveReq = (id: string, body: unknown = {}) =>
    approveRoute.POST(
      new NextRequest(`https://oasisai.work/api/devices/${id}/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id }) },
    );
  const bearerReq = (token: string) =>
    new NextRequest("https://oasisai.work/api/bridge/pairing/rotate", { method: "POST", headers: { authorization: `Bearer ${token}` } });

  console.log("pairing-ownership:");

  await check("an OASIS member can mint a connector code for their own computer, but not a daemon desktop code", async () => {
    await login(MEMBER_ID, "member@client-y.test");
    const connector = await jsonOf(
      await pairCodeRoute.POST(
        new NextRequest("https://oasisai.work/api/auth/pair-code", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ purpose: "connector" }),
        }),
      ),
    );
    assert.equal(connector.status, 200, JSON.stringify(connector.body));
    assert.equal(connector.body.scope, "connector");
    const desktop = await jsonOf(
      await pairCodeRoute.POST(
        new NextRequest("https://oasisai.work/api/auth/pair-code", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ purpose: "desktop" }),
        }),
      ),
    );
    assert.equal(desktop.status, 403, JSON.stringify(desktop.body));
  });

  await check("pair-code status correlates a re-paired computer by consumed_by_pairing_id, never created_at", async () => {
    await pairing({ id: "bp-member-connector", userId: MEMBER_ID, label: "Member laptop", token: "t-member-connector", scope: "connector", pairedVia: "pair_code" });
    await db.execute({
      sql: `INSERT INTO bridge_pair_codes (code, tenant_id, auth_user_id, email, expires_at, consumed_at, consumed_by_pairing_id, purpose, scope)
            VALUES ('ABC-DEF-GHJ', ?, ?, 'member@client-y.test', '2099-01-01T00:00:00.000Z', ?, 'bp-member-connector', 'connector', 'connector')`,
      args: [TENANT, MEMBER_ID, stamp],
    });
    await login(MEMBER_ID, "member@client-y.test");
    const mine = await jsonOf(await pairCodeRoute.GET(new NextRequest("https://oasisai.work/api/auth/pair-code?code=ABC-DEF-GHJ")));
    assert.equal(mine.status, 200, JSON.stringify(mine.body));
    assert.equal(mine.body.status, "connected");
    assert.deepEqual(mine.body.pairing, { id: "bp-member-connector", label: "Member laptop", claim_enabled_at: null });
    await login(OTHER_ID, "other@client-y.test");
    const other = await jsonOf(await pairCodeRoute.GET(new NextRequest("https://oasisai.work/api/auth/pair-code?code=ABC-DEF-GHJ")));
    assert.equal(other.status, 404, JSON.stringify(other.body));
  });

  // ── Who can approve what ─────────────────────────────────────────────────
  await check("the pairing's own member approves their own connector computer", async () => {
    await pairing({ id: "bp-member-connector", userId: MEMBER_ID, label: "Member laptop", token: "t-member-connector", scope: "connector", pairedVia: "pair_code" });
    await login(MEMBER_ID, "member@client-y.test");
    const { status, body } = await jsonOf(await approveReq("bp-member-connector"));
    assert.equal(status, 200, JSON.stringify(body));
    const row = await db.execute({ sql: "SELECT claim_enabled_at, claim_enabled_by FROM bridge_pairings WHERE id = 'bp-member-connector'" });
    assert.ok(row.rows[0].claim_enabled_at);
    assert.equal(row.rows[0].claim_enabled_by, MEMBER_ID);
    assert.equal(pairingCanClaim({ claimEnabledAt: row.rows[0].claim_enabled_at as string, pairedVia: "pair_code" }), true);
  });

  await check("an unapproved computer cannot claim (pairingCanClaim is false before approval)", async () => {
    await pairing({ id: "bp-unapproved", userId: MEMBER_ID, label: "Unapproved", token: "t-unapproved", scope: "connector", pairedVia: "pair_code" });
    assert.equal(pairingCanClaim({ claimEnabledAt: null, pairedVia: "pair_code" }), false);
  });

  await check("approval by anyone but the owner is refused — a teammate", async () => {
    await pairing({ id: "bp-member-connector", userId: MEMBER_ID, label: "Member laptop", token: "t-member-connector", scope: "connector", pairedVia: "pair_code" });
    await login(OTHER_ID, "other@client-y.test");
    const { status, body } = await jsonOf(await approveReq("bp-member-connector"));
    assert.equal(status, 403, JSON.stringify(body));
    assert.equal(body.error, "not_your_computer");
  });

  await check("approval by anyone but the owner is refused — even the workspace OWNER/admin", async () => {
    await pairing({ id: "bp-member-connector", userId: MEMBER_ID, label: "Member laptop", token: "t-member-connector", scope: "connector", pairedVia: "pair_code" });
    await login(OWNER_ID, "owner@client-y.test");
    const { status, body } = await jsonOf(await approveReq("bp-member-connector"));
    assert.equal(status, 403, JSON.stringify(body));
    assert.equal(body.error, "not_your_computer", "team-admin power is not the same as holding the computer");
  });

  await check("a daemon pairing can be approved only by the agents owner — a member's own daemon row is refused", async () => {
    await pairing({ id: "bp-member-daemon", userId: MEMBER_ID, label: "Member desktop", token: "t-member-daemon", scope: "daemon", pairedVia: "hmac" });
    await login(MEMBER_ID, "member@client-y.test");
    const { status, body } = await jsonOf(await approveReq("bp-member-daemon"));
    assert.equal(status, 403, JSON.stringify(body));
    assert.equal(body.error, "daemon_pairing_requires_agents_owner");
  });

  await check("a daemon pairing owned by the agents owner is approved", async () => {
    await pairing({ id: "bp-owner-daemon", userId: OWNER_ID, label: "CCPC (Windows)", token: "t-owner-daemon", scope: "daemon", pairedVia: "hmac" });
    await login(OWNER_ID, "owner@client-y.test");
    const { status, body } = await jsonOf(await approveReq("bp-owner-daemon"));
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.scope, "daemon");
  });

  await check("a signup_secret pairing can never be approved, even by its own owner", async () => {
    await pairing({ id: "bp-signup", userId: OWNER_ID, label: "Fresh install", token: "t-signup", scope: null, pairedVia: "signup_secret" });
    await login(OWNER_ID, "owner@client-y.test");
    const { status, body } = await jsonOf(await approveReq("bp-signup"));
    assert.equal(status, 403, JSON.stringify(body));
    assert.equal(body.error, "signup_secret_pairing_cannot_be_approved");
  });

  await check("a pairing with no recorded owner can never be approved", async () => {
    await pairing({ id: "bp-no-owner", userId: null, label: "Shared office PC", token: "t-no-owner", scope: "daemon", pairedVia: null });
    await login(OWNER_ID, "owner@client-y.test");
    const { status, body } = await jsonOf(await approveReq("bp-no-owner"));
    assert.equal(status, 409, JSON.stringify(body));
    assert.equal(body.error, "pairing_has_no_owner");
  });

  await check("a Claude account hash already approved for someone else in the same workspace is refused", async () => {
    await pairing({ id: "bp-member-connector", userId: MEMBER_ID, label: "Member laptop", token: "t-member-connector", scope: "connector", pairedVia: "pair_code" });
    await pairing({ id: "bp-other-connector", userId: OTHER_ID, label: "Other laptop", token: "t-other-connector", scope: "connector", pairedVia: "pair_code" });
    const HASH = "a".repeat(64);
    await login(MEMBER_ID, "member@client-y.test");
    assert.equal((await jsonOf(await approveReq("bp-member-connector", { claude_account_hash: HASH }))).status, 200);
    await login(OTHER_ID, "other@client-y.test");
    const { status, body } = await jsonOf(await approveReq("bp-other-connector", { claude_account_hash: HASH }));
    assert.equal(status, 409, JSON.stringify(body));
    assert.equal(body.error, "claude_account_shared");
  });

  // ── Token rotation: 60s grace, then revoke + attention item ──────────────
  await check("a rotated token's PRIOR value still answers within the grace window", async () => {
    await pairing({ id: "bp-rotate", userId: OWNER_ID, label: "Rotator", token: "t-old", scope: "daemon", pairedVia: "hmac" });
    const rotated = await jsonOf(await rotateRoute.POST(bearerReq("t-old")));
    assert.equal(rotated.status, 200, JSON.stringify(rotated.body));
    const newToken = String(rotated.body.token);
    assert.notEqual(newToken, "t-old");

    const oldStillWorks = await resolvePairingFromBearer(
      new NextRequest("https://oasisai.work/api/bridge/ping", { headers: { authorization: "Bearer t-old" } }),
    );
    assert.equal(oldStillWorks.ok, true, "the prior token answers inside the 60s grace");
    const newWorks = await resolvePairingFromBearer(
      new NextRequest("https://oasisai.work/api/bridge/ping", { headers: { authorization: `Bearer ${newToken}` } }),
    );
    assert.equal(newWorks.ok, true);
  });

  await check("only the CURRENT token may rotate — a stale-but-in-grace token cannot mint a second fresh token", async () => {
    await pairing({ id: "bp-rotate3", userId: OWNER_ID, label: "Rotator3", token: "t-gen1", scope: "daemon", pairedVia: "hmac" });
    const first = await jsonOf(await rotateRoute.POST(bearerReq("t-gen1")));
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const gen2 = String(first.body.token);

    // t-gen1 is now the PRIOR token, still inside its 60s grace — it still
    // answers ping/poll, but rotating again with it must be refused: that
    // would mint a THIRD token off a credential that was already replaced.
    const second = await jsonOf(await rotateRoute.POST(bearerReq("t-gen1")));
    assert.equal(second.status, 409, JSON.stringify(second.body));
    assert.equal(second.body.token, undefined, "no new token is handed out for a stale bearer");

    // The legitimate holder of gen2 is unaffected: it still rotates cleanly.
    const third = await jsonOf(await rotateRoute.POST(bearerReq(gen2)));
    assert.equal(third.status, 200, JSON.stringify(third.body));
    const gen3 = String(third.body.token);
    assert.notEqual(gen3, gen2);

    const row = await db.execute({ sql: "SELECT bridge_token_hash, previous_token_hash FROM bridge_pairings WHERE id = 'bp-rotate3'" });
    assert.equal(row.rows[0].bridge_token_hash, sha256(gen3));
    assert.equal(row.rows[0].previous_token_hash, sha256(gen2), "gen1 never became a recorded previous token a second time");
  });

  await check("using the PRIOR token after the grace revokes the pairing and raises an attention item", async () => {
    await pairing({ id: "bp-rotate2", userId: OWNER_ID, label: "Rotator2", token: "t-old2", scope: "daemon", pairedVia: "hmac" });
    await rotateRoute.POST(bearerReq("t-old2"));
    // Simulate the grace having elapsed without a real 60s sleep.
    await db.execute({
      sql: "UPDATE bridge_pairings SET token_rotated_at = ? WHERE id = 'bp-rotate2'",
      args: [new Date(Date.now() - 61_000).toISOString()],
    });
    const result = await resolvePairingFromBearer(
      new NextRequest("https://oasisai.work/api/bridge/ping", { headers: { authorization: "Bearer t-old2" } }),
    );
    assert.deepEqual(result, { ok: false, status: 403, error: "token_reused_after_rotation" });
    const row = await db.execute({ sql: "SELECT revoked_at FROM bridge_pairings WHERE id = 'bp-rotate2'" });
    assert.ok(row.rows[0].revoked_at, "the computer is revoked");
    const events = await db.execute({ sql: "SELECT event_type, severity, correlation_id FROM agent_events WHERE event_type = 'pairing_token_reused'" });
    assert.equal(events.rows.length, 1, "an attention item was raised");
    assert.equal(events.rows[0].severity, "warn");
    assert.equal(events.rows[0].correlation_id, TENANT);
  });

  // ── /api/devices owner semantics + audited admin disconnect ─────────────
  await check("GET /api/devices: a member sees only their own computer", async () => {
    await pairing({ id: "bp-member-connector", userId: MEMBER_ID, label: "Member laptop", token: "t-m", scope: "connector", pairedVia: "pair_code" });
    await pairing({ id: "bp-owner-daemon", userId: OWNER_ID, label: "CCPC (Windows)", token: "t-o", scope: "daemon", pairedVia: "hmac" });
    await login(MEMBER_ID, "member@client-y.test");
    const { status, body } = await jsonOf(await devicesRoute.GET());
    assert.equal(status, 200, JSON.stringify(body));
    const devices = body.devices as Array<{ id: string; mine: boolean }>;
    assert.deepEqual(devices.map((d) => d.id), ["bp-member-connector"]);
    assert.equal(devices[0].mine, true);
  });

  await check("GET /api/devices: the owner/admin also sees the team's computers", async () => {
    await pairing({ id: "bp-member-connector", userId: MEMBER_ID, label: "Member laptop", token: "t-m", scope: "connector", pairedVia: "pair_code" });
    await pairing({ id: "bp-owner-daemon", userId: OWNER_ID, label: "CCPC (Windows)", token: "t-o", scope: "daemon", pairedVia: "hmac" });
    await login(OWNER_ID, "owner@client-y.test");
    const { status, body } = await jsonOf(await devicesRoute.GET());
    assert.equal(status, 200, JSON.stringify(body));
    const devices = body.devices as Array<{ id: string; mine: boolean }>;
    assert.deepEqual(devices.map((d) => d.id).sort(), ["bp-member-connector", "bp-owner-daemon"]);
    assert.deepEqual(devices.find((d) => d.id === "bp-owner-daemon")?.mine, true);
    assert.deepEqual(devices.find((d) => d.id === "bp-member-connector")?.mine, false);
  });

  await check("DELETE /api/devices: a member always disconnects their own computer, no confirm needed", async () => {
    await pairing({ id: "bp-member-connector", userId: MEMBER_ID, label: "Member laptop", token: "t-m", scope: "connector", pairedVia: "pair_code" });
    await login(MEMBER_ID, "member@client-y.test");
    const res = await devicesRoute.DELETE(new NextRequest("https://oasisai.work/api/devices?id=bp-member-connector", { method: "DELETE" }));
    assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
    const row = await db.execute({ sql: "SELECT revoked_at FROM bridge_pairings WHERE id = 'bp-member-connector'" });
    assert.ok(row.rows[0].revoked_at);
  });

  await check("DELETE /api/devices: a non-admin cannot disconnect someone else's computer", async () => {
    await pairing({ id: "bp-owner-daemon", userId: OWNER_ID, label: "CCPC (Windows)", token: "t-o", scope: "daemon", pairedVia: "hmac" });
    await login(MEMBER_ID, "member@client-y.test");
    const res = await devicesRoute.DELETE(new NextRequest("https://oasisai.work/api/devices?id=bp-owner-daemon", { method: "DELETE" }));
    assert.equal(res.status, 403, JSON.stringify(await res.clone().json()));
    const row = await db.execute({ sql: "SELECT revoked_at FROM bridge_pairings WHERE id = 'bp-owner-daemon'" });
    assert.equal(row.rows[0].revoked_at, null);
  });

  await check("DELETE /api/devices: an admin disconnecting someone else's computer needs confirm=true, then writes an audit row", async () => {
    await pairing({ id: "bp-member-connector", userId: MEMBER_ID, label: "Member laptop", token: "t-m", scope: "connector", pairedVia: "pair_code" });
    await login(OWNER_ID, "owner@client-y.test");
    const noConfirm = await devicesRoute.DELETE(new NextRequest("https://oasisai.work/api/devices?id=bp-member-connector", { method: "DELETE" }));
    assert.equal(noConfirm.status, 409, JSON.stringify(await noConfirm.clone().json()));
    const stillLive = await db.execute({ sql: "SELECT revoked_at FROM bridge_pairings WHERE id = 'bp-member-connector'" });
    assert.equal(stillLive.rows[0].revoked_at, null, "no confirm means no disconnect");

    const confirmed = await devicesRoute.DELETE(
      new NextRequest("https://oasisai.work/api/devices?id=bp-member-connector&confirm=true", { method: "DELETE" }),
    );
    assert.equal(confirmed.status, 200, JSON.stringify(await confirmed.clone().json()));
    const revoked = await db.execute({ sql: "SELECT revoked_at FROM bridge_pairings WHERE id = 'bp-member-connector'" });
    assert.ok(revoked.rows[0].revoked_at);

    const audit = await db.execute({
      sql: "SELECT action_type, target_id, metadata FROM tenant_audit_log WHERE action_type = 'device.admin_disconnect'",
    });
    assert.equal(audit.rows.length, 1, "the admin disconnect is read back through log_tenant_event");
    assert.equal(audit.rows[0].target_id, "bp-member-connector");
    assert.equal((JSON.parse(String(audit.rows[0].metadata)) as { actor_user_id: string }).actor_user_id, OWNER_ID);
  });

  if (failures > 0) {
    console.log(`pairing-ownership: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log("pairing-ownership: all passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
