/**
 * integrations-health-read.test.ts — a failed heartbeat read is unknown, never
 * "every service unconfigured" (CodeRabbit, PR #477).
 *
 * integrationsHealth (lib/queries.ts) expands the services a read did not list
 * into "unconfigured" placeholders. It used to ignore the read's error, so a
 * failed query rendered every integration as unconfigured on /health instead
 * of reaching the page's "could not be read" state. Driven against a real
 * local libSQL file.
 *
 * Run: node --conditions=react-server --import tsx tests/integrations-health-read.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";

const dbFile = join(mkdtempSync(join(tmpdir(), "integrations-health-read-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;

async function main() {
  const { integrationsHealth } = await import("../lib/queries");

  // No table yet: the read fails, and the failure reaches the caller.
  await assert.rejects(() => integrationsHealth("tenant-a"), /integrations_health read failed/);

  const db = createClient({ url: `file:${dbFile}` });
  await db.execute(
    `CREATE TABLE integrations_health (
       id TEXT PRIMARY KEY, profile_id TEXT, tenant_id TEXT, service TEXT, status TEXT,
       last_ping_at TEXT, last_error TEXT, metadata TEXT, updated_at TEXT)`,
  );
  await db.execute(
    `INSERT INTO integrations_health (id, tenant_id, service, status, last_ping_at, metadata)
     VALUES ('h-a', 'tenant-a', 'telegram', 'healthy', '2026-09-29T00:00:00Z', '{}'),
            ('h-b', 'tenant-b', 'gws', 'healthy', '2026-09-29T00:00:00Z', '{}')`,
  );

  // A successful read: listed services come back as stored, the rest are placeholders.
  const rows = await integrationsHealth("tenant-a");
  const telegram = rows.find((r) => r.service === "telegram");
  assert.equal(telegram?.status, "healthy");
  assert.equal(telegram?.id, "h-a");
  const gws = rows.find((r) => r.service === "gws");
  assert.equal(gws?.status, "unconfigured", "tenant-b's gws heartbeat is not tenant-a's");
  assert.ok(rows.every((r) => r.tenant_id === "tenant-a"));

  console.log("integrations-health-read: all passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
