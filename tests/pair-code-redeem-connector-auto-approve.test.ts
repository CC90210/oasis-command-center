/**
 * pair-code-redeem-connector-auto-approve.test.ts - D0: a connector-purpose
 * pair code is ALWAYS redeemed by the same person who minted it (the
 * pairing's user_id is the code's auth_user_id, never a different person --
 * a connector code never changes hands before redeem). Requiring a second,
 * separate "Approve" click after that is friction with no security purpose:
 * nobody but that same person could ever have clicked it.
 *
 * Fix (lib/turso-rpc-shim.ts redeem_pair_code): when the redeemed code's
 * scope is 'connector', the pairing insert/rotate stamps
 * claim_enabled_at/claim_enabled_by in the SAME statement, instead of
 * leaving them NULL for a later POST /api/devices/[id]/approve call.
 * Daemon-scope and legacy (NULL-scope) pairings are untouched -- they keep
 * the explicit Approve click, same as before this fix.
 *
 * Schema and fixture style copied from the proven
 * tests/pair-code-redeem-rotation.test.ts (same production DDL, same route,
 * same real redeem_pair_code RPC, no stand-in for the data layer).
 *
 * Run: node --conditions=react-server --import tsx tests/pair-code-redeem-connector-auto-approve.test.ts
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createClient, type Client } from "@libsql/client";
import { NextRequest } from "next/server";

const dbFile = join(mkdtempSync(join(tmpdir(), "pair-code-redeem-connector-auto-approve-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
for (const k of ["TURSO_DATABASE_URL", "TURSO_DB_URL", "TURSO_AUTH_TOKEN", "BRAVO_SUPABASE_URL", "BRAVO_SUPABASE_SERVICE_ROLE_KEY", "BRAVO_DASHBOARD_URL"]) {
  delete process.env[k];
}

// lib/supabase-server imports next/headers; nothing here reads a cookie.
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
      cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false, set: () => undefined }),
      headers: async () => new Headers(),
      draftMode: async () => ({ isEnabled: false }),
    },
  } as unknown as NodeModule;
}

const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();
const db: Client = createClient({ url: `file:${dbFile}` });

const TENANT = "b0000000-0000-4000-8000-0000000000b1";
const AUTH_ME = "auth-connector-me";
const AUTH_ADMIN = "auth-daemon-admin";
const CONNECTOR_FP = "connector-fp-0000000000000000000001";
const DAEMON_FP = "daemon-fp-00000000000000000000001";
const CONNECTOR_FP_ROTATE = "connector-fp-rotate-00000000000001";

async function createSchema() {
  // Same bridge_pairings / bridge_pair_codes DDL as
  // tests/pair-code-redeem-rotation.test.ts, which copies production's
  // columns verbatim (turso_sql.mjs --db bravo-empire, sqlite_master).
  await db.executeMultiple(`
    CREATE TABLE user_profiles (id TEXT NOT NULL PRIMARY KEY, auth_user_id TEXT, email TEXT);
    -- As production (turso_tool schema pair_attempts): an INTEGER key that only
    -- grows, which claimCappedSlot's place in line counts on.
    CREATE TABLE pair_attempts (
      id INTEGER PRIMARY KEY,
      profile_id TEXT NOT NULL, outcome TEXT NOT NULL, ip TEXT,
      attempted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
    CREATE TABLE bridge_pairings (
      id TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))) PRIMARY KEY,
      tenant_id TEXT NOT NULL, user_id TEXT, label TEXT NOT NULL, bridge_token_hash TEXT NOT NULL,
      machine_fingerprint TEXT, last_seen_at TEXT, revoked_at TEXT, scope TEXT, paired_via TEXT,
      previous_token_hash TEXT, token_rotated_at TEXT, claim_enabled_at TEXT, claim_enabled_by TEXT,
      claude_account_hash TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
    CREATE UNIQUE INDEX idx_bridge_pairings_unique_live_machine
      ON bridge_pairings (tenant_id, machine_fingerprint) WHERE ((revoked_at IS NULL) AND (machine_fingerprint IS NOT NULL));
    CREATE TABLE bridge_pair_codes (
      id TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))) PRIMARY KEY,
      code TEXT NOT NULL, tenant_id TEXT NOT NULL, auth_user_id TEXT NOT NULL,
      expires_at TEXT NOT NULL, consumed_at TEXT, consumed_by_pairing_id TEXT,
      purpose TEXT NOT NULL DEFAULT 'desktop', scope TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
    CREATE UNIQUE INDEX idx_bridge_pair_codes_code ON bridge_pair_codes (code);
  `);
}

async function seed() {
  for (const t of ["user_profiles", "pair_attempts", "bridge_pairings", "bridge_pair_codes"]) {
    await db.execute(`DELETE FROM ${t}`);
  }
  await db.execute({
    sql: "INSERT INTO user_profiles (id, auth_user_id, email) VALUES (?, ?, ?)",
    args: [randomUUID(), AUTH_ME, "me@connector-test.test"],
  });
  await db.execute({
    sql: "INSERT INTO user_profiles (id, auth_user_id, email) VALUES (?, ?, ?)",
    args: [randomUUID(), AUTH_ADMIN, "admin@connector-test.test"],
  });
}

/** Mirrors how POST /api/auth/pair-code mints a code: purpose decides scope ('connector' purpose is always scope 'connector'; a 'desktop' purpose minted for an admin is scope 'daemon'). */
function mintCode(code: string, authUserId: string, purpose: "connector" | "desktop", scope: "connector" | "daemon"): Promise<unknown> {
  return db.execute({
    sql: "INSERT INTO bridge_pair_codes (code, tenant_id, auth_user_id, expires_at, purpose, scope) VALUES (?, ?, ?, ?, ?, ?)",
    args: [code, TENANT, authUserId, inMinutes(15), purpose, scope],
  });
}

function redeemRequest(code: string, fingerprint: string): NextRequest {
  return new NextRequest("https://oasisai.work/api/auth/pair-code/redeem", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, machine: { label: "Test box", fingerprint } }),
  });
}

async function liveRow(fingerprint: string) {
  const r = await db.execute({
    sql: "SELECT id, user_id, scope, claim_enabled_at, claim_enabled_by, revoked_at FROM bridge_pairings WHERE tenant_id = ? AND machine_fingerprint = ? AND revoked_at IS NULL",
    args: [TENANT, fingerprint],
  });
  return r.rows as unknown as Array<{
    id: string;
    user_id: string | null;
    scope: string | null;
    claim_enabled_at: string | null;
    claim_enabled_by: string | null;
    revoked_at: string | null;
  }>;
}

// ── Mutation-checked assertion: proven against a synthetic good row and a
// synthetic bad row BEFORE it is trusted against the real redeemed rows
// below -- the same discipline tests/dv1-connector-and-status.test.ts uses
// for its own guard-matchers (prove the matcher first, then apply it).
function assertConnectorAutoApproved(row: { claim_enabled_at: string | null; claim_enabled_by: string | null }, ownerId: string): void {
  assert.ok(row.claim_enabled_at, "a connector pairing redeemed by its own minter must be approved on redeem, not left for a second click");
  assert.equal(row.claim_enabled_by, ownerId, "claim_enabled_by must be the same person who minted and redeemed the connector code");
}

let failures = 0;
async function check(name: string, fn: () => Promise<void>) {
  try {
    await seed();
    await fn();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`  FAIL ${name}`);
    console.error(error);
  }
}

async function main() {
  await createSchema();
  const { POST } = await import("../app/api/auth/pair-code/redeem/route");

  console.log("pair-code-redeem-connector-auto-approve:");

  await check("mutation check: assertConnectorAutoApproved fails on a NOT-approved synthetic row and passes on an approved one", async () => {
    assert.throws(() => assertConnectorAutoApproved({ claim_enabled_at: null, claim_enabled_by: null }, AUTH_ME), /must be approved on redeem/);
    assert.throws(
      () => assertConnectorAutoApproved({ claim_enabled_at: "2026-10-12T00:00:00Z", claim_enabled_by: "someone-else" }, AUTH_ME),
      /must be the same person/,
    );
    assert.doesNotThrow(() => assertConnectorAutoApproved({ claim_enabled_at: "2026-10-12T00:00:00Z", claim_enabled_by: AUTH_ME }, AUTH_ME));
  });

  await check("redeeming a connector-purpose code approves it immediately -- no second Approve click needed", async () => {
    await mintCode("BBB-BBB-001", AUTH_ME, "connector", "connector");
    const res = await POST(redeemRequest("BBB-BBB-001", CONNECTOR_FP));
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.ok, true);
    const rows = await liveRow(CONNECTOR_FP);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].scope, "connector");
    assertConnectorAutoApproved(rows[0], AUTH_ME);
  });

  await check("redeeming a daemon-scope code (minted for an admin's full install) stays unapproved -- the explicit Approve click is unchanged", async () => {
    await mintCode("BBB-BBB-002", AUTH_ADMIN, "desktop", "daemon");
    const res = await POST(redeemRequest("BBB-BBB-002", DAEMON_FP));
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    const rows = await liveRow(DAEMON_FP);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].scope, "daemon");
    assert.equal(rows[0].claim_enabled_at, null, "a daemon-scope pairing must NOT be auto-approved at redeem time");
    assert.equal(rows[0].claim_enabled_by, null);
  });

  await check("re-pairing (rotating) the SAME connector computer stays approved -- a token rotation must not silently demand a second manual approval", async () => {
    await mintCode("BBB-BBB-003", AUTH_ME, "connector", "connector");
    const first = await POST(redeemRequest("BBB-BBB-003", CONNECTOR_FP_ROTATE));
    assert.equal((await first.json()).ok, true);
    const afterFirst = await liveRow(CONNECTOR_FP_ROTATE);
    assertConnectorAutoApproved(afterFirst[0], AUTH_ME);

    await mintCode("BBB-BBB-004", AUTH_ME, "connector", "connector");
    const second = await POST(redeemRequest("BBB-BBB-004", CONNECTOR_FP_ROTATE));
    const secondBody = await second.json();
    assert.equal(secondBody.ok, true, JSON.stringify(secondBody));
    const afterSecond = await liveRow(CONNECTOR_FP_ROTATE);
    assert.equal(afterSecond.length, 1, "still exactly one live row for this fingerprint");
    assert.equal(afterSecond[0].id, afterFirst[0].id, "the SAME row is rotated, not a second one minted");
    assertConnectorAutoApproved(afterSecond[0], AUTH_ME);
  });

  if (failures) {
    console.error(`pair-code-redeem-connector-auto-approve: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log("pair-code-redeem-connector-auto-approve: ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
