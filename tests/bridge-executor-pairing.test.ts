/**
 * tests/bridge-executor-pairing.test.ts — a machine that runs one tenant's
 * crons cannot be paired into another tenant.
 *
 * WHY THIS EXISTS
 * ---------------
 * On 2026-08-31 SunBiz's VPS ("srv1723601 (Linux)") was paired into the OASIS
 * tenant. The cron poll gate already refused to hand it OASIS jobs, but the
 * pairing itself went through, so an OASIS bridge credential ended up on
 * SunBiz's machine. It was the second time the box landed on the wrong tenant.
 *
 * Both pairing doors are exercised for real (/api/auth/pair and
 * /api/auth/pair-code/redeem) against an on-disk libSQL file, and the poll
 * route is held to the same single map.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { NextRequest } from "next/server";

const SUNBIZ = "aa04fa1f-ad6a-44b0-ac4b-2ff5d1067110";
const OASIS = "ef8d389e-3f15-43f2-ae00-3660f69a1452";
const VPS = "srv1723601 (Linux)";
const CCPC = "CCPC (Windows)";
const MAC = "192.168.11.27 (Mac)"; // sanctioned OASIS device, not an executor
const SECRET = "cli-signup-test-secret-0001";

const dbFile = join(mkdtempSync(join(tmpdir(), "bridge-pairing-")), "pairing.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
delete process.env.EMPIRE_AUTH_BACKEND;
process.env.CLI_SIGNUP_SECRET = SECRET;

const seed = createClient({ url: `file:${dbFile}` });

async function pairingsFor(tenant: string, label: string): Promise<number> {
  const r = await seed.execute({
    sql: "SELECT count(*) AS n FROM bridge_pairings WHERE tenant_id = ? AND label = ?",
    args: [tenant, label],
  });
  return Number(r.rows[0].n);
}

async function main() {
  // ── The shared map: pure checks ──────────────────────────────────────────
  const lib = await import("../lib/bridge-executors");
  assert.equal(lib.executorHomeElsewhere(OASIS, VPS), "aa04fa1f", "the VPS belongs to SunBiz");
  assert.equal(lib.executorHomeElsewhere(SUNBIZ, VPS), null, "the VPS may pair into SunBiz");
  assert.equal(lib.executorHomeElsewhere(OASIS, CCPC), null, "CC's PC may pair into OASIS");
  assert.equal(lib.executorHomeElsewhere(SUNBIZ, CCPC), "ef8d389e", "CC's PC belongs to OASIS");
  assert.equal(lib.executorHomeElsewhere(OASIS, MAC), null, "an undeclared machine is not affected");
  // The poll gate's semantics, now read from the same map.
  assert.equal(lib.isExpectedExecutor(OASIS, CCPC), true);
  assert.equal(lib.isExpectedExecutor(OASIS, VPS), false);
  assert.equal(lib.isExpectedExecutor(OASIS, MAC), false, "the Mac still gets no OASIS cron jobs");
  assert.equal(lib.isExpectedExecutor("99999999-0000-4000-8000-000000000000", "anything"), true);

  // ── One map, not three ──────────────────────────────────────────────────
  const poll = readFileSync("app/api/cron-jobs/poll/route.ts", "utf8");
  assert.match(poll, /import \{ isExpectedExecutor \} from "@\/lib\/bridge-executors"/);
  assert.doesNotMatch(poll, /const EXPECTED_EXECUTOR_BY_TENANT_PREFIX/, "the poll route must not keep its own copy");
  for (const file of ["app/api/auth/pair/route.ts", "app/api/auth/pair-code/redeem/route.ts"]) {
    assert.match(readFileSync(file, "utf8"), /from "@\/lib\/bridge-executors"/, `${file} must use the shared map`);
  }

  await seed.batch(
    [
      `CREATE TABLE user_profiles (
         id TEXT PRIMARY KEY, auth_user_id TEXT, email TEXT, tenant_id TEXT, display_name TEXT)`,
      `CREATE TABLE bridge_pairings (
         id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
         tenant_id TEXT, user_id TEXT, label TEXT, bridge_token_hash TEXT,
         machine_fingerprint TEXT, last_seen_at TEXT, revoked_at TEXT)`,
      `CREATE TABLE bridge_pair_codes (
         id TEXT PRIMARY KEY, code TEXT UNIQUE, tenant_id TEXT, auth_user_id TEXT,
         expires_at TEXT, consumed_at TEXT, consumed_by_pairing_id TEXT)`,
      `CREATE TABLE pair_attempts (
         id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
         profile_id TEXT, outcome TEXT, ip TEXT,
         created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))`,
      `INSERT INTO user_profiles VALUES ('p-oasis', 'u-oasis', 'cc@oasis.test', '${OASIS}', 'CC')`,
      `INSERT INTO user_profiles VALUES ('p-sunbiz', 'u-sunbiz', 'ops@sunbiz.test', '${SUNBIZ}', 'Ops')`,
    ],
    "write",
  );

  // ── /api/auth/pair ──────────────────────────────────────────────────────
  const pairRoute = await import("../app/api/auth/pair/route");
  async function pair(email: string, label: string, fingerprint: string) {
    const req = new NextRequest("http://localhost/api/auth/pair", {
      method: "POST",
      headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" },
      body: JSON.stringify({ email, profile: { display_name: "renamed" }, machine: { label, fingerprint } }),
    });
    const res = await pairRoute.POST(req);
    return { status: res.status, json: (await res.json()) as { ok: boolean; error?: string } };
  }

  {
    const r = await pair("cc@oasis.test", VPS, "fp-vps");
    assert.equal(r.status, 409, "the SunBiz VPS must not pair into OASIS");
    assert.match(String(r.json.error), /^executor_belongs_to_another_tenant: "srv1723601 \(Linux\)"/);
    assert.equal(await pairingsFor(OASIS, VPS), 0, "no OASIS pairing is minted for the VPS");
    const p = await seed.execute("SELECT display_name FROM user_profiles WHERE id = 'p-oasis'");
    assert.equal(p.rows[0].display_name, "CC", "a refused pair leaves the profile untouched");
  }
  {
    const r = await pair("ops@sunbiz.test", CCPC, "fp-ccpc-sb");
    assert.equal(r.status, 409, "CC's PC must not pair into SunBiz either");
  }
  {
    const r = await pair("ops@sunbiz.test", VPS, "fp-vps");
    assert.equal(r.status, 200, "the VPS still pairs into its own tenant");
    assert.equal(await pairingsFor(SUNBIZ, VPS), 1);
  }
  {
    const r = await pair("cc@oasis.test", CCPC, "fp-ccpc");
    assert.equal(r.status, 200, "CC's PC still pairs into OASIS");
  }
  {
    const r = await pair("cc@oasis.test", MAC, "fp-mac");
    assert.equal(r.status, 200, "an undeclared machine pairs exactly as before");
  }

  // ── /api/auth/pair-code/redeem ──────────────────────────────────────────
  const future = new Date(Date.now() + 10 * 60_000).toISOString();
  await seed.batch(
    [
      `INSERT INTO bridge_pair_codes VALUES ('c1', 'OAS-ISC-OD1', '${OASIS}', 'u-oasis', '${future}', NULL, NULL)`,
      `INSERT INTO bridge_pair_codes VALUES ('c2', 'SUN-BIZ-CD1', '${SUNBIZ}', 'u-sunbiz', '${future}', NULL, NULL)`,
      `INSERT INTO bridge_pair_codes VALUES ('c3', 'OAS-ISC-OD2', '${OASIS}', 'u-oasis', '${future}', NULL, NULL)`,
    ],
    "write",
  );
  const redeemRoute = await import("../app/api/auth/pair-code/redeem/route");
  async function redeem(code: string, label: string, fingerprint: string) {
    const req = new NextRequest("http://localhost/api/auth/pair-code/redeem", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9" },
      body: JSON.stringify({ code, machine: { label, fingerprint } }),
    });
    const res = await redeemRoute.POST(req);
    return { status: res.status, json: (await res.json()) as { ok: boolean; error?: string } };
  }
  const consumed = async (id: string) =>
    (await seed.execute({ sql: "SELECT consumed_at FROM bridge_pair_codes WHERE id = ?", args: [id] })).rows[0]
      .consumed_at;

  {
    const r = await redeem("OAS-ISC-OD1", VPS, "fp-vps-2");
    assert.equal(r.status, 409, "an OASIS pair code cannot pair the SunBiz VPS");
    assert.match(String(r.json.error), /^executor_belongs_to_another_tenant/);
    assert.equal(await consumed("c1"), null, "the refused code is left unconsumed for its real machine");
    assert.equal(await pairingsFor(OASIS, VPS), 0);
  }
  {
    const r = await redeem("SUN-BIZ-CD1", VPS, "fp-vps-3");
    assert.equal(r.status, 200, "a SunBiz code still pairs the VPS into SunBiz");
    assert.ok(await consumed("c2"));
  }
  {
    const r = await redeem("OAS-ISC-OD2", "New Laptop (Windows)", "fp-laptop");
    assert.equal(r.status, 200, "an undeclared machine redeems exactly as before");
  }
}

main().then(
  () => console.log("bridge-executor-pairing: all assertions passed"),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
