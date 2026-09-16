import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { toggleCronWithAudit } from "../lib/automations/cron-toggle-transaction";

let dbSequence = 0;
const testDir = mkdtempSync(join(tmpdir(), "atomic-cron-toggle-"));

async function createDb(withAudit = true) {
  dbSequence += 1;
  const db = createClient({ url: `file:${join(testDir, `${dbSequence}.db`)}` });
  await db.executeMultiple(`
    CREATE TABLE cron_jobs (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      name TEXT NOT NULL,
      is_active INTEGER NOT NULL,
      action_config TEXT
    );
    CREATE TABLE tenant_cron_jobs (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      action_payload TEXT
    );
    ${withAudit ? `CREATE TABLE tenant_audit_log (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      tenant_id TEXT NOT NULL,
      actor_user_id TEXT,
      actor_email TEXT,
      action_type TEXT NOT NULL,
      target_table TEXT,
      target_id TEXT,
      before TEXT,
      after TEXT
    );` : ""}
  `);
  return db;
}

async function main() {
const db = await createDb();
await db.execute({
  sql: "INSERT INTO cron_jobs (id, tenant_id, name, is_active, action_config) VALUES (?, ?, ?, 1, ?)",
  args: ["maven", "tenant-1", "Maven — Carousel Post", JSON.stringify({ script: "runner.py" })],
});

const wrongTenant = await toggleCronWithAudit(db, {
  source: "empire",
  id: "maven",
  tenantId: "tenant-2",
  enabled: false,
  actorEmail: "intruder@example.com",
  actorUserId: "other-user",
});
assert.equal(wrongTenant.ok, false);
if (wrongTenant.ok) throw new Error("wrong tenant must not reach a scheduler row");
assert.equal(wrongTenant.status, 404);
assert.equal(
  Number((await db.execute("SELECT is_active FROM cron_jobs WHERE id = 'maven'")).rows[0]?.is_active),
  1,
);
assert.equal((await db.execute("SELECT id FROM tenant_audit_log")).rows.length, 0);

const off = await toggleCronWithAudit(db, {
  source: "empire",
  id: "maven",
  tenantId: "tenant-1",
  enabled: false,
  actorEmail: "conaugh@oasisai.work",
  actorUserId: "cc-user",
});
assert.equal(off.ok, true);
if (!off.ok) throw new Error("expected successful atomic toggle");
assert.equal(off.enabled, false);
assert.deepEqual(off.row.action_config, { script: "runner.py" });

const stored = await db.execute("SELECT is_active FROM cron_jobs WHERE id = 'maven'");
assert.equal(Number(stored.rows[0]?.is_active), 0);
const audit = await db.execute("SELECT actor_email, before, after FROM tenant_audit_log");
assert.equal(audit.rows.length, 1);
assert.equal(audit.rows[0]?.actor_email, "conaugh@oasisai.work");
assert.equal(JSON.parse(String(audit.rows[0]?.before)).enabled, true);
assert.equal(JSON.parse(String(audit.rows[0]?.after)).enabled, false);

await db.execute({
  sql: "INSERT INTO tenant_cron_jobs (id, tenant_id, name, enabled, action_payload) VALUES (?, ?, ?, 0, ?)",
  args: ["atlas", "tenant-1", "Atlas — Pulse Refresh", JSON.stringify({ script: "pulse.py" })],
});
const tenantOn = await toggleCronWithAudit(db, {
  source: "tenant",
  id: "atlas",
  tenantId: "tenant-1",
  enabled: true,
  actorEmail: "conaugh@oasisai.work",
  actorUserId: "cc-user",
});
assert.equal(tenantOn.ok, true);
if (!tenantOn.ok) throw new Error("expected successful tenant toggle");
assert.equal(tenantOn.enabled, true);
assert.deepEqual(tenantOn.row.action_payload, { script: "pulse.py" });
assert.equal(
  Number((await db.execute("SELECT enabled FROM tenant_cron_jobs WHERE id = 'atlas'")).rows[0]?.enabled),
  1,
);
const tenantAudit = await db.execute(
  "SELECT target_table, before, after FROM tenant_audit_log WHERE target_id = 'atlas'",
);
assert.equal(tenantAudit.rows[0]?.target_table, "tenant_cron_jobs");
assert.equal(JSON.parse(String(tenantAudit.rows[0]?.before)).enabled, false);
assert.equal(JSON.parse(String(tenantAudit.rows[0]?.after)).enabled, true);
await db.close();

// If the audit insert cannot land, the scheduler flag must not land either.
const noAuditDb = await createDb(false);
await noAuditDb.execute(
  "INSERT INTO cron_jobs (id, tenant_id, name, is_active) VALUES ('rollback', 'tenant-1', 'Safe job', 1)",
);
await assert.rejects(
  toggleCronWithAudit(noAuditDb, {
    source: "empire",
    id: "rollback",
    tenantId: "tenant-1",
    enabled: false,
    actorEmail: "conaugh@oasisai.work",
    actorUserId: "cc-user",
  }),
);
const rolledBack = await noAuditDb.execute("SELECT is_active FROM cron_jobs WHERE id = 'rollback'");
assert.equal(Number(rolledBack.rows[0]?.is_active), 1, "audit failure must roll back the toggle");

await noAuditDb.close();
console.log("atomic-cron-toggle: state and audit commit or roll back together");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
