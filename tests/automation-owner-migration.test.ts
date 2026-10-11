/**
 * tests/automation-owner-migration.test.ts — pins
 * database/turso/bravo__211_automation_owner.sql's backfill order against a
 * local libSQL file built from the LIVE DDL of tenant_cron_jobs,
 * bridge_pairings and user_profiles (probed 2026-10-11; the same shapes
 * ddl_tenant_cron_jobs.json / ddl_bridge_pairings.json / ddl_user_profiles.json
 * in the O2 handoff folder record).
 *
 * WHAT IS PINNED:
 *   1. owner_user_id = created_by, where created_by is an auth user id with a
 *      user_profiles row in the SAME tenant (the POST /api/cron-jobs shape).
 *   2. owner_user_id = that profile's auth_user_id, where created_by is a
 *      user_profiles.id in the same tenant (save-draft wrote profile ids —
 *      the created_by drift this migration exists to fix).
 *   3. OASIS tenant only: every row still NULL becomes the workspace's
 *      non-revoked agents-owner row.
 *   4. A non-OASIS tenant's row with no resolvable created_by stays NULL —
 *      the migration never guesses an owner for a legacy row outside OASIS.
 *   5. After applying: the count of OASIS rows with owner_user_id IS NULL is
 *      0 (the check the real rollout runs before merging).
 *   6. last_scheduled_for, tz and bridge_pairings.last_poll_ok_at all exist
 *      and are nullable; idx_tenant_cron_jobs_owner exists.
 *   7. The file is NOT re-runnable: applying it twice fails (duplicate
 *      column), which is the whole reason it says so in its own header.
 *
 * Run: node --conditions=react-server --import tsx tests/automation-owner-migration.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";

const ROOT = join(__dirname, "..");
const MIGRATION_PATH = join(ROOT, "database", "turso", "bravo__211_automation_owner.sql");
const OASIS = "ef8d389e-3f15-43f2-ae00-3660f69a1452";
const CLIENT = "8c8c8c8c-0000-4000-8000-00000000008c";
const CC_AUTH_ID = "8c000000-0000-4000-8000-000000000001";
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

async function main() {
  console.log("automation-owner-migration:");
  const dbFile = join(mkdtempSync(join(tmpdir(), "automation-owner-migration-")), "test.db");
  const db = createClient({ url: `file:${dbFile}` });

  // The live DDL (bravo__211's target schema, BEFORE this migration), as
  // probed 2026-10-11 — see ddl_tenant_cron_jobs.json / ddl_bridge_pairings.json
  // / ddl_user_profiles.json in the O2 handoff folder for the same shapes.
  await db.executeMultiple(`
    CREATE TABLE "tenant_cron_jobs" (
      "id" TEXT NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random())%4+1,1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
      "tenant_id" TEXT NOT NULL,
      "agent_key" TEXT NOT NULL DEFAULT 'bravo',
      "name" TEXT NOT NULL,
      "description" TEXT,
      "schedule" TEXT NOT NULL,
      "action_type" TEXT NOT NULL,
      "action_payload" TEXT NOT NULL DEFAULT '{}',
      "enabled" INTEGER NOT NULL DEFAULT 1,
      "last_run_at" TEXT,
      "last_run_status" TEXT,
      "last_run_output" TEXT,
      "last_run_error" TEXT,
      "run_count" INTEGER NOT NULL DEFAULT 0,
      "created_by" TEXT,
      "created_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      "updated_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      PRIMARY KEY ("id")
    );
    CREATE TABLE "bridge_pairings" (
      "id" TEXT NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random())%4+1,1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
      "tenant_id" TEXT NOT NULL,
      "user_id" TEXT,
      "label" TEXT NOT NULL,
      "bridge_token_hash" TEXT,
      "last_seen_at" TEXT,
      "revoked_at" TEXT,
      "created_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      PRIMARY KEY ("id")
    );
    CREATE TABLE "user_profiles" (
      "id" TEXT NOT NULL,
      "auth_user_id" TEXT,
      "email" TEXT NOT NULL,
      "tenant_id" TEXT,
      PRIMARY KEY ("id")
    );
    CREATE TABLE workspace_agents_owner (
      tenant_id TEXT PRIMARY KEY, auth_user_id TEXT NOT NULL, set_by TEXT NOT NULL,
      set_at TEXT NOT NULL, note TEXT, revoked_at TEXT
    );
  `);

  await db.batch(
    [
      // OASIS membership: CC.
      { sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id) VALUES ('p-cc', ?, 'cc@oasisai.work', ?)`, args: [CC_AUTH_ID, OASIS] },
      { sql: `INSERT INTO workspace_agents_owner (tenant_id, auth_user_id, set_by, set_at) VALUES (?, ?, ?, ?)`, args: [OASIS, CC_AUTH_ID, CC_AUTH_ID, STAMP] },

      // Case 1: created_by is already an auth user id with a profile in the
      // SAME tenant (POST /api/cron-jobs's shape) — a CLIENT row, so step 3
      // (OASIS-only) can never be the reason it resolves.
      { sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id) VALUES ('p-client-owner', 'client-owner-auth-id', 'owner@client.test', ?)`, args: [CLIENT] },
      {
        sql: `INSERT INTO tenant_cron_jobs (id, tenant_id, name, schedule, action_type, created_by, created_at)
              VALUES ('step1-row', ?, 'Step 1', '0 9 * * *', 'script_run', 'client-owner-auth-id', ?)`,
        args: [CLIENT, STAMP],
      },

      // Case 2: created_by is a user_profiles.id (save-draft's shape),
      // same tenant — resolves to that profile's auth_user_id.
      { sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id) VALUES ('p-client-drafter', 'client-drafter-auth-id', 'drafter@client.test', ?)`, args: [CLIENT] },
      {
        sql: `INSERT INTO tenant_cron_jobs (id, tenant_id, name, schedule, action_type, created_by, created_at)
              VALUES ('step2-row', ?, 'Step 2', '0 9 * * *', 'script_run', 'p-client-drafter', ?)`,
        args: [CLIENT, STAMP],
      },

      // Case 3: OASIS, created_by NULL (production fact: all 4 real rows are
      // this shape) — resolves to the agents owner.
      {
        sql: `INSERT INTO tenant_cron_jobs (id, tenant_id, name, schedule, action_type, created_by, created_at)
              VALUES ('step3-row', ?, 'Step 3', '0 9 * * *', 'script_run', NULL, ?)`,
        args: [OASIS, STAMP],
      },

      // Case 4: a NON-OASIS tenant, created_by NULL, no owner row for that
      // tenant — stays NULL. Never guessed.
      {
        sql: `INSERT INTO tenant_cron_jobs (id, tenant_id, name, schedule, action_type, created_by, created_at)
              VALUES ('legacy-row', ?, 'Legacy', '0 9 * * *', 'script_run', NULL, ?)`,
        args: [CLIENT, STAMP],
      },
    ],
    "write",
  );

  const migrationSql = readFileSync(MIGRATION_PATH, "utf8");

  await check("the migration file says it is not re-runnable", () => {
    assert.match(migrationSql, /NOT RE-RUNNABLE/i);
    return Promise.resolve();
  });

  await check("applying the migration backfills each case in the documented order", async () => {
    await db.executeMultiple(migrationSql);

    const owner = async (id: string) => {
      const rs = await db.execute({ sql: "SELECT owner_user_id FROM tenant_cron_jobs WHERE id = ?", args: [id] });
      return rs.rows[0]?.owner_user_id as string | null | undefined;
    };
    assert.equal(await owner("step1-row"), "client-owner-auth-id", "step 1: created_by was already an auth id");
    assert.equal(await owner("step2-row"), "client-drafter-auth-id", "step 2: created_by was a profile id, mapped to its auth id");
    assert.equal(await owner("step3-row"), CC_AUTH_ID, "step 3: OASIS NULL became the agents owner");
    assert.equal(await owner("legacy-row"), null, "a non-OASIS row with no resolvable created_by stays NULL, never guessed");
  });

  await check("no OASIS row is left NULL after applying", async () => {
    const rs = await db.execute({
      sql: "SELECT COUNT(*) AS n FROM tenant_cron_jobs WHERE tenant_id = ? AND owner_user_id IS NULL",
      args: [OASIS],
    });
    assert.equal(Number(rs.rows[0].n), 0);
  });

  await check("last_scheduled_for, tz and bridge_pairings.last_poll_ok_at exist and are nullable", async () => {
    const cols = (await db.execute("PRAGMA table_info(tenant_cron_jobs)")).rows.map((r) => String(r.name));
    assert.ok(cols.includes("last_scheduled_for"));
    assert.ok(cols.includes("tz"));
    const pairingCols = (await db.execute("PRAGMA table_info(bridge_pairings)")).rows.map((r) => String(r.name));
    assert.ok(pairingCols.includes("last_poll_ok_at"));
    // Nullable, no backfill: every existing row's new columns are NULL.
    const rs = await db.execute("SELECT last_scheduled_for, tz FROM tenant_cron_jobs WHERE id = 'step3-row'");
    assert.equal(rs.rows[0].last_scheduled_for, null);
    assert.equal(rs.rows[0].tz, null);
  });

  await check("idx_tenant_cron_jobs_owner exists", async () => {
    const rs = await db.execute(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_tenant_cron_jobs_owner'",
    );
    assert.equal(rs.rows.length, 1);
  });

  await check("the migration is NOT re-runnable: applying it a second time fails", async () => {
    await assert.rejects(() => db.executeMultiple(migrationSql), /duplicate column name|owner_user_id/i);
  });

  if (failures > 0) {
    console.log(`automation-owner-migration: ${failures} failing`);
    process.exit(1);
  }
  console.log("automation-owner-migration: all checks passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
