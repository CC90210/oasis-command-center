/**
 * POST /api/auth/pair-code/redeem — redeeming a code for a machine that
 * already has a LIVE pairing in this tenant (O0 correctness review, MEDIUM).
 * Run: node --conditions=react-server --import tsx tests/pair-code-redeem-rotation.test.ts
 *
 * WHY. redeem_pair_code only ever INSERTed. idx_bridge_pairings_unique_live_machine
 * (migration 030) means redeeming a code from a machine that already has a live
 * row in this tenant throws a raw SQLITE_CONSTRAINT, which surfaced to the caller
 * as a bare 500 and left the code unconsumed — so an already-paired operator who
 * lost ~/.oasis/bridge_token (or CEO-Agent's wizard, which tries a pair code before
 * the legacy signup-secret path) had no way back in with a code at all.
 *
 * What this pins, through the real route, the real redeem_pair_code RPC and a
 * local libSQL file (no stand-in for the data layer):
 *   - redeeming a code with no existing live row for that fingerprint inserts,
 *     same as before this fix (regression guard on the base case);
 *   - redeeming a code whose auth_user_id matches the fingerprint's existing
 *     live row ROTATES that row (same pairing_id, new token, code consumed) —
 *     no second row, no 500;
 *   - redeeming a code for a fingerprint already live under a DIFFERENT person
 *     gets a named 409, and the code stays unconsumed (a legitimate retry,
 *     after disconnecting the computer, can still use it).
 *
 * ATOMICITY (O0 security review: "atomicity / fail-open state drift" — the
 * first fix above read the conflicting row, then wrote, in two separate
 * steps). Both the pairing write and the code-consume now live in ONE
 * client.batch('write'), so this also pins:
 *   - two concurrent redeems of the SAME code: exactly one succeeds, the
 *     other sees the code already consumed — never both, never neither;
 *   - a forced failure partway through the batch (a trigger that fires on
 *     the code-consume statement, by which point the pairing statement has
 *     already appeared to apply within the uncommitted transaction) leaves
 *     BOTH the pairing row and the code exactly as they were — proving the
 *     whole batch rolled back, not just its last statement.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createClient, type Client } from "@libsql/client";
import { NextRequest } from "next/server";

const dbFile = join(mkdtempSync(join(tmpdir(), "pair-code-redeem-rotation-")), "test.db");
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

const LONG_AGO = "2026-01-05T12:00:00.000Z";
const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();
const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const db: Client = createClient({ url: `file:${dbFile}` });

const TENANT = "a0000000-0000-4000-8000-0000000000a1";
const AUTH_ME = "auth-me";
const AUTH_OTHER = "auth-other";
const MY_EXISTING_FP = "my-pc-fp-000000000000000000000001";
const OTHERS_FP = "others-pc-fp-00000000000000000001";
const FRESH_FP = "fresh-pc-fp-000000000000000000001";
const MY_EXISTING_TOKEN_HASH = "my-existing-token-hash";
const OTHERS_TOKEN_HASH = "others-token-hash";
const CONCURRENT_FP = "concurrent-pc-fp-0000000000000001";
// A sentinel tenant used ONLY by the forced-mid-batch-failure check below. A
// BEFORE UPDATE trigger aborts the code-consume statement whenever it fires
// for this tenant, so the test can prove the WHOLE batch rolls back — not
// just its last statement — without reaching into the driver.
const FORCE_FAIL_TENANT = "ffffffff-0000-4000-8000-00000000ff01";
const AUTH_FORCE = "auth-force";
const FORCE_FAIL_FP = "force-fail-pc-fp-00000000000001";
const FORCE_FAIL_OLD_TOKEN_HASH = "force-fail-old-token-hash";

async function createSchema() {
  await db.executeMultiple(`
    CREATE TABLE user_profiles (id TEXT NOT NULL PRIMARY KEY, auth_user_id TEXT, email TEXT);
    CREATE TABLE pair_attempts (
      id TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))) PRIMARY KEY,
      profile_id TEXT NOT NULL, outcome TEXT NOT NULL, ip TEXT,
      attempted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
    CREATE TABLE bridge_pairings (
      id TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))) PRIMARY KEY,
      tenant_id TEXT NOT NULL, user_id TEXT, label TEXT NOT NULL, bridge_token_hash TEXT NOT NULL,
      machine_fingerprint TEXT, last_seen_at TEXT, revoked_at TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
    CREATE UNIQUE INDEX idx_bridge_pairings_unique_live_machine
      ON bridge_pairings (tenant_id, machine_fingerprint) WHERE revoked_at IS NULL;
    CREATE TABLE bridge_pair_codes (
      id TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))) PRIMARY KEY,
      code TEXT NOT NULL, tenant_id TEXT NOT NULL, auth_user_id TEXT NOT NULL,
      expires_at TEXT NOT NULL, consumed_at TEXT, consumed_by_pairing_id TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
    CREATE UNIQUE INDEX idx_bridge_pair_codes_code ON bridge_pair_codes (code);
    CREATE TRIGGER force_fail_on_consume
      BEFORE UPDATE ON bridge_pair_codes
      WHEN NEW.tenant_id = '${FORCE_FAIL_TENANT}' AND NEW.consumed_at IS NOT NULL
    BEGIN
      SELECT RAISE(ABORT, 'forced_failure_for_test');
    END;
  `);
}

/** Every check starts from the same database. */
async function seed() {
  for (const t of ["user_profiles", "pair_attempts", "bridge_pairings", "bridge_pair_codes"]) {
    await db.execute(`DELETE FROM ${t}`);
  }
  await db.execute({
    sql: "INSERT INTO user_profiles (id, auth_user_id, email) VALUES (?, ?, ?)",
    args: [randomUUID(), AUTH_ME, "me@ws-a.test"],
  });
  // My own live computer, under my own auth id.
  await db.execute({
    sql: `INSERT INTO bridge_pairings (id, tenant_id, user_id, label, bridge_token_hash, machine_fingerprint, last_seen_at)
          VALUES ('bp-mine', ?, ?, 'My laptop (Windows)', ?, ?, ?)`,
    args: [TENANT, AUTH_ME, MY_EXISTING_TOKEN_HASH, MY_EXISTING_FP, LONG_AGO],
  });
  // Someone else's live computer.
  await db.execute({
    sql: `INSERT INTO bridge_pairings (id, tenant_id, user_id, label, bridge_token_hash, machine_fingerprint, last_seen_at)
          VALUES ('bp-other', ?, ?, 'Others laptop (Mac)', ?, ?, ?)`,
    args: [TENANT, AUTH_OTHER, OTHERS_TOKEN_HASH, OTHERS_FP, LONG_AGO],
  });
  // Fixture for the forced-mid-batch-failure check only.
  await db.execute({
    sql: `INSERT INTO bridge_pairings (id, tenant_id, user_id, label, bridge_token_hash, machine_fingerprint, last_seen_at)
          VALUES ('bp-force', ?, ?, 'Force-fail laptop', ?, ?, ?)`,
    args: [FORCE_FAIL_TENANT, AUTH_FORCE, FORCE_FAIL_OLD_TOKEN_HASH, FORCE_FAIL_FP, LONG_AGO],
  });
}

function mintCode(code: string, authUserId: string, tenantId: string = TENANT): Promise<unknown> {
  return db.execute({
    sql: "INSERT INTO bridge_pair_codes (code, tenant_id, auth_user_id, expires_at) VALUES (?, ?, ?, ?)",
    args: [code, tenantId, authUserId, inMinutes(15)],
  });
}

function redeemRequest(code: string, fingerprint: string): NextRequest {
  return new NextRequest("https://oasisai.work/api/auth/pair-code/redeem", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, machine: { label: "Test box", fingerprint } }),
  });
}

async function liveRow(fingerprint: string, tenantId: string = TENANT) {
  const r = await db.execute({
    sql: "SELECT id, user_id, bridge_token_hash, revoked_at FROM bridge_pairings WHERE tenant_id = ? AND machine_fingerprint = ? AND revoked_at IS NULL",
    args: [tenantId, fingerprint],
  });
  return r.rows as unknown as Array<{ id: string; user_id: string | null; bridge_token_hash: string; revoked_at: string | null }>;
}

async function codeRow(code: string) {
  const r = await db.execute({ sql: "SELECT consumed_at, consumed_by_pairing_id FROM bridge_pair_codes WHERE code = ?", args: [code] });
  return r.rows[0] as unknown as { consumed_at: string | null; consumed_by_pairing_id: string | null } | undefined;
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

  await check("a code for a fingerprint with no existing live row inserts a fresh pairing", async () => {
    await mintCode("AAA-AAA-001", AUTH_ME);
    const res = await POST(redeemRequest("AAA-AAA-001", FRESH_FP));
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.ok, true);
    assert.equal(body.tenant_id, TENANT);
    assert.match(body.bridge.token, /^oab_[0-9a-f]{64}$/);
    const rows = await liveRow(FRESH_FP);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].user_id, AUTH_ME);
    assert.equal(rows[0].bridge_token_hash, sha256(body.bridge.token));
    const c = await codeRow("AAA-AAA-001");
    assert.ok(c?.consumed_at, "the code is consumed");
    assert.equal(c?.consumed_by_pairing_id, rows[0].id);
  });

  await check("redeeming a code for MY OWN already-live fingerprint rotates that row instead of a raw 500", async () => {
    await mintCode("AAA-AAA-002", AUTH_ME);
    const res = await POST(redeemRequest("AAA-AAA-002", MY_EXISTING_FP));
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.ok, true);
    assert.equal(body.bridge.pairing_id, "bp-mine", "the SAME row is rotated, not a second one minted");
    assert.match(body.bridge.token, /^oab_[0-9a-f]{64}$/);
    const rows = await liveRow(MY_EXISTING_FP);
    assert.equal(rows.length, 1, "still exactly one live row for this fingerprint");
    assert.equal(rows[0].id, "bp-mine");
    assert.equal(rows[0].bridge_token_hash, sha256(body.bridge.token), "only the newest token works");
    assert.notEqual(rows[0].bridge_token_hash, MY_EXISTING_TOKEN_HASH, "the old token is dead");
    const c = await codeRow("AAA-AAA-002");
    assert.ok(c?.consumed_at, "the code is consumed");
    assert.equal(c?.consumed_by_pairing_id, "bp-mine");
  });

  await check("redeeming a code for a fingerprint already live under a DIFFERENT person is refused (409), and the code stays unconsumed", async () => {
    await mintCode("AAA-AAA-003", AUTH_ME);
    const res = await POST(redeemRequest("AAA-AAA-003", OTHERS_FP));
    const body = await res.json();
    assert.equal(res.status, 409, JSON.stringify(body));
    assert.equal(body.ok, false);
    assert.match(String(body.error), /^machine_paired_to_another_person\b/);
    assert.equal(body.bridge, undefined, "no token is handed out");
    const rows = await liveRow(OTHERS_FP);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, "bp-other");
    assert.equal(rows[0].user_id, AUTH_OTHER, "still the other person's");
    assert.equal(rows[0].bridge_token_hash, OTHERS_TOKEN_HASH, "untouched");
    const c = await codeRow("AAA-AAA-003");
    assert.equal(c?.consumed_at, null, "a code that can never succeed against this fingerprint is not burned");
  });

  await check("two concurrent redeems of the SAME code: exactly one succeeds", async () => {
    await mintCode("AAA-AAA-004", AUTH_ME);
    const [a, b] = await Promise.all([
      POST(redeemRequest("AAA-AAA-004", CONCURRENT_FP)),
      POST(redeemRequest("AAA-AAA-004", CONCURRENT_FP)),
    ]);
    const bodies = await Promise.all([a.json(), b.json()]);
    const statuses = [a.status, b.status].sort();
    const oks = bodies.filter((b) => b.ok === true);
    console.log(`    OBSERVED statuses=${JSON.stringify(statuses)} bodies=${JSON.stringify(bodies)}`);
    assert.equal(oks.length, 1, "exactly one of the two concurrent redeems succeeds");
    // The loser sees the code already consumed, not a 500 or a second pairing.
    const loserBody = bodies.find((b) => b.ok !== true);
    assert.match(String(loserBody?.error), /^code already redeemed$|code_consumed/i, JSON.stringify(loserBody));
    const rows = await liveRow(CONCURRENT_FP);
    assert.equal(rows.length, 1, "exactly one pairing row, never two, never zero");
    const c = await codeRow("AAA-AAA-004");
    assert.ok(c?.consumed_at, "the code ends up consumed exactly once");
    assert.equal(c?.consumed_by_pairing_id, rows[0].id);
  });

  await check("a forced failure mid-batch leaves BOTH the pairing row and the code exactly as they were", async () => {
    await mintCode("AAA-AAA-005", AUTH_FORCE, FORCE_FAIL_TENANT);
    let res: Awaited<ReturnType<typeof POST>> | null = null;
    let threw: unknown = null;
    try {
      res = await POST(redeemRequest("AAA-AAA-005", FORCE_FAIL_FP));
    } catch (e) {
      threw = e;
    }
    // Whether the route surfaces the driver error as a non-200 response or
    // lets it escape as a rejection, SOMETHING must signal failure — a
    // silent 200 would mean the forced abort did not roll the batch back.
    if (threw === null) {
      assert.ok(res, "neither threw nor returned a response");
      const body = await res!.json();
      console.log(`    OBSERVED status=${res!.status} body=${JSON.stringify(body)}`);
      assert.notEqual(res!.status, 200, "a forced mid-batch failure must never read as success");
    } else {
      console.log(`    OBSERVED throw=${threw instanceof Error ? threw.message : String(threw)}`);
    }
    const rows = await liveRow(FORCE_FAIL_FP, FORCE_FAIL_TENANT);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, "bp-force", "no second row was minted");
    assert.equal(
      rows[0].bridge_token_hash,
      FORCE_FAIL_OLD_TOKEN_HASH,
      "the in-flight rotate was rolled back along with everything else in the batch",
    );
    const c = await codeRow("AAA-AAA-005");
    assert.equal(c?.consumed_at, null, "the code was never marked used");
    assert.equal(c?.consumed_by_pairing_id, null);
  });

  if (failures) {
    console.error(`pair-code-redeem-rotation: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log("pair-code-redeem-rotation: ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
