import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createClient } from "@libsql/client";

async function main() {
  const migration = readFileSync("database/turso/bravo__108_cron_owner_agent_key.sql", "utf8");
  const reconciliation = readFileSync(
    "database/turso/bravo__110_cron_owner_reconciliation.sql",
    "utf8",
  );
  assert.equal(
    createHash("sha256").update(reconciliation.replace(/\r\n?/g, "\n"), "utf8").digest("hex"),
    "8b8f63edc413cceeecefc702800a92b8558b6ae9aba9b6266af271b216702579",
    "the OCC reconciliation companion must retain the live-ledger migration checksum",
  );
  // apply_turso_migration.py reads in text mode, so Python normalizes Windows
  // CRLF checkouts before hashing. Mirror that algorithm instead of raw bytes.
  const ledgerText = migration.replace(/\r\n?/g, "\n");
  assert.equal(
    createHash("sha256").update(ledgerText, "utf8").digest("hex"),
    "1abe84a6eb7dc3ae149b76d0492f3fb8a7d09190b33378c6755fbc9570e4185f",
    "the OCC companion must retain the live-ledger bravo__108 checksum",
  );
  const db = createClient({ url: ":memory:" });

  await db.executeMultiple(`
    CREATE TABLE cron_jobs (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      action_type TEXT,
      is_active INTEGER NOT NULL DEFAULT 1
    );
    INSERT INTO cron_jobs VALUES
      ('maven', 'ef8d389e-3f15-43f2-ae00-3660f69a1452', 'Maven — Carousel Post', 'old', 'script_run', 1),
      ('atlas', 'tenant-2', 'Atlas — marketing spend', 'old', 'script_run', 1),
      ('aura', 'tenant-2', 'Morning Pow Wow', 'old', 'morning_powwow', 1),
      ('bravo', 'tenant-2', 'Ordinary job', 'old', 'script_run', 1);
  `);
  await db.executeMultiple(migration);
  await db.executeMultiple(reconciliation);

  const rows = await db.execute(
    "SELECT id, owner_agent_key, description FROM cron_jobs ORDER BY id",
  );
  const byId = Object.fromEntries(rows.rows.map((row) => [String(row.id), row]));
  assert.equal(byId.maven.owner_agent_key, "maven");
  assert.match(String(byId.maven.description), /GEN-10/);
  assert.equal(byId.atlas.owner_agent_key, "atlas");
  assert.equal(byId.aura.owner_agent_key, "aura");
  assert.equal(byId.bravo.owner_agent_key, "bravo");

  const index = await db.execute(
    "SELECT name FROM sqlite_schema WHERE type = 'index' AND name = 'idx_cron_jobs_tenant_owner_active'",
  );
  assert.equal(index.rows.length, 1);

  await db.close();
  console.log("cron-owner-migration: durable ownership and index verified");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
