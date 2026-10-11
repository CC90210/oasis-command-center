/**
 * tests/cron-poll-owner.test.ts — O2: GET /api/cron-jobs/poll serves a row to
 * the computer whose paired PERSON owns it, never just whoever the label
 * gate recognises.
 *
 * WHY. Rows with no recorded owner (legacy, or a non-OASIS workspace the
 * backfill never touched) keep the existing label-only rule unchanged. A row
 * WITH an owner must only reach the computer that person approved — and a
 * computer that is the right label but the wrong person's gets a loud,
 * named refusal (409 owner_mismatch), never the empty 200 that makes
 * Bravo's runner idle in silence.
 *
 * WHAT IS PINNED, through the real route handler and a local libSQL file (no
 * session cookie — the bridge authenticates with its bearer):
 *   - a computer gets only its owner's enabled rows;
 *   - a row with no owner still reaches the label-matched computer;
 *   - a labelled executor that owns none of the tenant's enabled rows gets
 *     409 owner_mismatch, never an empty 200;
 *   - a 200 stamps bridge_pairings.last_poll_ok_at for THAT pairing;
 *   - a missing owner_user_id column answers a named 503, not a 500 with
 *     driver text.
 *
 * Run: node --conditions=react-server --import tsx tests/cron-poll-owner.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createClient } from "@libsql/client";

const dbFile = join(mkdtempSync(join(tmpdir(), "cron-poll-owner-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;

// No session is involved (the bridge authenticates with its pairing bearer),
// but lib/supabase-server reads next/headers at import time in some paths.
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

// OASIS's own tenant id prefix is in the poll route's EXPECTED_EXECUTOR map
// (CCPC); use a different, unmapped tenant here so both test computers pass
// the label gate freely and the only thing under test is ownership.
const TENANT = "7c7c7c7c-0000-4000-8000-00000000007c";
const CC_USER = "7c000000-0000-4000-8000-000000000001";
const ADON_USER = "7c000000-0000-4000-8000-000000000002";
const CC_TOKEN = "cc-computer-bridge-token-000000000001";
const ADON_TOKEN = "adon-computer-bridge-token-00000000002";
const STAMP = "2026-10-01T00:00:00Z";

let failures = 0;
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${(e as Error).message.split("\n").join("\n        ")}`);
  }
}

type PollBody = { ok?: boolean; error?: string; message?: string; jobs?: Array<{ id: string }>; polled_at?: string };

async function main() {
  console.log("cron-poll-owner:");
  const db = createClient({ url: `file:${dbFile}` });
  await db.executeMultiple(`
    CREATE TABLE bridge_pairings (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, label TEXT, user_id TEXT,
      bridge_token_hash TEXT, revoked_at TEXT, last_poll_ok_at TEXT
    );
    CREATE TABLE tenant_cron_jobs (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, agent_key TEXT NOT NULL DEFAULT 'bravo',
      name TEXT NOT NULL, description TEXT, schedule TEXT NOT NULL, action_type TEXT NOT NULL,
      action_payload TEXT NOT NULL DEFAULT '{}', enabled INTEGER NOT NULL DEFAULT 1,
      last_run_at TEXT, last_run_status TEXT, last_run_output TEXT, last_run_error TEXT,
      run_count INTEGER NOT NULL DEFAULT 0, created_by TEXT, owner_user_id TEXT,
      created_at TEXT NOT NULL, updated_at TEXT
    );
  `);
  const { sha256 } = await import("../lib/api-helpers");
  await db.batch(
    [
      {
        sql: `INSERT INTO bridge_pairings (id, tenant_id, label, user_id, bridge_token_hash) VALUES ('pair-cc', ?, 'CCPC', ?, ?)`,
        args: [TENANT, CC_USER, sha256(CC_TOKEN)],
      },
      {
        sql: `INSERT INTO bridge_pairings (id, tenant_id, label, user_id, bridge_token_hash) VALUES ('pair-adon', ?, 'UPPAECHELON', ?, ?)`,
        args: [TENANT, ADON_USER, sha256(ADON_TOKEN)],
      },
      {
        sql: `INSERT INTO tenant_cron_jobs (id, tenant_id, name, schedule, action_type, action_payload, enabled, owner_user_id, created_at)
              VALUES ('cc-job', ?, 'CC job', '0 9 * * *', 'script_run', '{}', 1, ?, ?)`,
        args: [TENANT, CC_USER, STAMP],
      },
      {
        sql: `INSERT INTO tenant_cron_jobs (id, tenant_id, name, schedule, action_type, action_payload, enabled, owner_user_id, created_at)
              VALUES ('legacy-job', ?, 'Legacy job', '0 10 * * *', 'script_run', '{}', 1, NULL, ?)`,
        args: [TENANT, STAMP],
      },
    ],
    "write",
  );

  const poll = await import("../app/api/cron-jobs/poll/route");
  const { NextRequest } = await import("next/server");
  const get = (token: string) =>
    poll.GET(new NextRequest("http://localhost/api/cron-jobs/poll", { headers: { authorization: `Bearer ${token}` } }));
  const lastPollOkAt = async (pairingId: string) => {
    const rs = await db.execute({ sql: "SELECT last_poll_ok_at FROM bridge_pairings WHERE id = ?", args: [pairingId] });
    return rs.rows[0]?.last_poll_ok_at as string | null | undefined;
  };

  await check("CC's computer gets only CC's enabled rows, plus any row with no owner", async () => {
    const res = await get(CC_TOKEN);
    const body = (await res.json()) as PollBody;
    assert.equal(res.status, 200, JSON.stringify(body));
    const ids = (body.jobs || []).map((j) => j.id).sort();
    assert.deepEqual(ids, ["cc-job", "legacy-job"]);
  });

  await check("a 200 stamps last_poll_ok_at for that pairing", async () => {
    const before = await lastPollOkAt("pair-cc");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await get(CC_TOKEN);
    const stamped = await lastPollOkAt("pair-cc");
    assert.ok(stamped, "last_poll_ok_at is now set");
    assert.ok(Number.isFinite(Date.parse(String(stamped))), "it is a real timestamp");
    if (before) assert.ok(Date.parse(String(stamped)) > Date.parse(String(before)), "it moves forward on every poll");
  });

  await check("Adon's computer, which owns none of the tenant's enabled rows besides the unowned one, still gets the unowned row — then owns nothing once that row is removed, and gets 409 owner_mismatch", async () => {
    const withLegacy = (await (await get(ADON_TOKEN)).json()) as PollBody;
    assert.deepEqual((withLegacy.jobs || []).map((j) => j.id), ["legacy-job"], "the unowned row has no person to prefer");

    await db.execute("DELETE FROM tenant_cron_jobs WHERE id = 'legacy-job'");
    try {
      const res = await get(ADON_TOKEN);
      assert.equal(res.status, 409, "a computer whose tenant has enabled rows, none of them its owner's, is a named refusal");
      const body = (await res.json()) as PollBody;
      assert.equal(body.error, "owner_mismatch");
      assert.notEqual(body.error, undefined);
    } finally {
      await db.execute({
        sql: `INSERT INTO tenant_cron_jobs (id, tenant_id, name, schedule, action_type, action_payload, enabled, owner_user_id, created_at)
              VALUES ('legacy-job', ?, 'Legacy job', '0 10 * * *', 'script_run', '{}', 1, NULL, ?)`,
        args: [TENANT, STAMP],
      });
    }
  });

  await check("a tenant with zero enabled rows at all is a plain empty 200, not owner_mismatch", async () => {
    await db.execute("UPDATE tenant_cron_jobs SET enabled = 0");
    try {
      const res = await get(ADON_TOKEN);
      assert.equal(res.status, 200, "no enabled rows anywhere is a real empty tenant, not a mismatch");
      const body = (await res.json()) as PollBody;
      assert.deepEqual(body.jobs, []);
    } finally {
      await db.execute("UPDATE tenant_cron_jobs SET enabled = 1");
    }
  });

  await check("a missing owner_user_id column answers a named 503, not a 500 with driver text", async () => {
    await db.execute("ALTER TABLE tenant_cron_jobs RENAME COLUMN owner_user_id TO owner_user_id_offline");
    const originalError = console.error;
    console.error = () => undefined;
    try {
      const res = await get(CC_TOKEN);
      assert.equal(res.status, 503, "a missing migration is a named 503");
      const body = (await res.json()) as PollBody;
      assert.equal(body.error, "automation_owner_column_missing");
      assert.match(String(body.message), /bravo__211_automation_owner\.sql/);
    } finally {
      console.error = originalError;
      await db.execute("ALTER TABLE tenant_cron_jobs RENAME COLUMN owner_user_id_offline TO owner_user_id");
    }
  });

  await check("a revoked pairing is still 401, unrelated to ownership", async () => {
    await db.execute({ sql: "UPDATE bridge_pairings SET revoked_at = ? WHERE id = 'pair-cc'", args: [STAMP] });
    try {
      const res = await get(CC_TOKEN);
      assert.equal(res.status, 401);
    } finally {
      await db.execute({ sql: "UPDATE bridge_pairings SET revoked_at = NULL WHERE id = 'pair-cc'", args: [] });
    }
  });

  if (failures > 0) {
    console.log(`cron-poll-owner: ${failures} failing`);
    process.exit(1);
  }
  console.log("cron-poll-owner: all checks passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
