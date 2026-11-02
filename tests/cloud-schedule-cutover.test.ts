import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { migrateCloudSchedules, CLOUD_NAMES, ATLAS_JOB } from "../scripts/migrate-oasis-cloud-schedules";
import { OASIS_SCRIPT_EXECUTOR as scope } from "../lib/automations/tenant-script-lease";

async function main() {
  const db = createClient({ url: `file:${join(mkdtempSync(join(tmpdir(), "cloud-cutover-")), "test.db")}` });
  await db.executeMultiple(`CREATE TABLE cron_jobs (id TEXT PRIMARY KEY,tenant_id TEXT,name TEXT,
    schedule TEXT,is_active INTEGER,owner_machine TEXT,last_result TEXT,action_type TEXT,action_config TEXT);
    CREATE TABLE tenant_cron_jobs (id TEXT PRIMARY KEY,tenant_id TEXT,owner_user_id TEXT,schedule TEXT,
    action_type TEXT,action_payload TEXT,enabled INTEGER,last_run_at TEXT,last_run_status TEXT,run_count INTEGER,agent_key TEXT);`);
  for (const [index, name] of CLOUD_NAMES.entries()) {
    await db.execute({ sql: `INSERT INTO cron_jobs VALUES (?,?,?,'* * * * *',1,NULL,'ERROR: preserve me','script_run','{}')`,
      args: [String(index), scope.tenantId, name] });
  }
  await db.execute({ sql: `INSERT INTO cron_jobs VALUES
    ('foreign','other',?,'* * * * *',1,NULL,'foreign receipt','script_run','{}'),
    ('disabled',?,'Retired','* * * * *',0,NULL,'disabled error','script_run','{}')`, args: [CLOUD_NAMES[0], scope.tenantId] });
  await db.execute({ sql: `INSERT INTO tenant_cron_jobs VALUES (?, ?, ?, '*/15 * * * *','script_run',?,1,'2026-11-01T12:00:00Z','error',7,'atlas')`,
    args: [ATLAS_JOB, scope.tenantId, scope.userId, JSON.stringify({script: "tools/financial_handoff_consumer.py",args:["once","--limit","5"]})] });
  const logs: unknown[] = [];
  const original = console.log;
  console.log = (...values) => logs.push(values);
  try {
    // Preview prints the inventory even when the fleet differs (CodeRabbit #791);
    // every mutating mode still refuses that fleet.
    await db.executeMultiple(`CREATE TABLE user_profiles (id TEXT,tenant_id TEXT,auth_user_id TEXT,team_role TEXT,is_owner INTEGER);
      CREATE TABLE bridge_pairings (id TEXT,tenant_id TEXT,user_id TEXT,label TEXT,scope TEXT,claim_enabled_at TEXT,revoked_at TEXT);`);
    await db.execute({ sql: "INSERT INTO cron_jobs VALUES ('extra-active',?,'Extra active','* * * * *',1,NULL,'','script_run','{}')",
      args: [scope.tenantId] });
    await migrateCloudSchedules("--preview", db);
    const preview = JSON.parse(String((logs.at(-1) as unknown[])[0]));
    assert.equal(preview.fleet_matches_expected, false);
    assert.equal(preview.empire.length, CLOUD_NAMES.length + 1);
    await assert.rejects(migrateCloudSchedules("--pin-empire", db));
    assert.equal((await db.execute("SELECT count(*) n FROM cron_jobs WHERE owner_machine IS NOT NULL")).rows[0].n, 0);
    await db.execute("DELETE FROM cron_jobs WHERE id='extra-active'");
    await migrateCloudSchedules("--preview", db);
    assert.equal(JSON.parse(String((logs.at(-1) as unknown[])[0])).fleet_matches_expected, true);
    // A changed owner rolls back earlier rows in the same batch.
    await db.execute("UPDATE cron_jobs SET owner_machine='another-host' WHERE id='9'");
    await assert.rejects(migrateCloudSchedules("--pin-empire", db));
    assert.equal((await db.execute("SELECT count(*) n FROM cron_jobs WHERE owner_machine='oasis-daemon-1'")).rows[0].n, 0);
    await db.execute("UPDATE cron_jobs SET owner_machine=NULL WHERE id='9'");
    await migrateCloudSchedules("--pin-empire", db);
    await migrateCloudSchedules("--pin-empire", db);
    assert.equal((await db.execute("SELECT count(*) n FROM cron_jobs WHERE owner_machine='oasis-daemon-1'")).rows[0].n, 18);
    assert.deepEqual((await db.execute("SELECT owner_machine FROM cron_jobs WHERE id IN ('foreign','disabled')")).rows.map(row => row.owner_machine), [null, null]);
    assert.equal((await db.execute("SELECT count(*) n FROM cron_jobs WHERE last_result='ERROR: preserve me'")).rows[0].n, 18);
    const race = (method: "transaction" | "execute", inject: () => Promise<unknown>) => {
      let injected = false;
      return new Proxy(db, { get(target, property) {
        if (property === method) return async (...args: unknown[]) => {
          const relevant = method === "transaction" || (typeof args[0] === "object"
            && String((args[0] as {sql?: string}).sql).startsWith("UPDATE tenant_cron_jobs SET enabled"));
          if (!injected && relevant) { injected = true; await inject(); }
          return (target[method] as (...values: unknown[]) => unknown).apply(target, args);
        };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      } });
    };
    await assert.rejects(migrateCloudSchedules("--pin-empire", race("transaction", () => db.execute({
      sql: "INSERT INTO cron_jobs VALUES ('new-active',?,'New active','* * * * *',1,NULL,'','script_run','{}')", args:[scope.tenantId] }))));
    assert.equal((await db.execute("SELECT owner_machine FROM cron_jobs WHERE id='new-active'")).rows[0].owner_machine, null);
    await db.execute("DELETE FROM cron_jobs WHERE id='new-active'");
    await assert.rejects(migrateCloudSchedules("--pin-empire", race("transaction", () => db.execute(
      "UPDATE cron_jobs SET owner_machine='changed-owner' WHERE id='0'"))));
    await db.execute("UPDATE cron_jobs SET owner_machine='oasis-daemon-1' WHERE id='0'");
    await migrateCloudSchedules("--hold-atlas", db);
    assert.equal((await db.execute("SELECT enabled FROM tenant_cron_jobs")).rows[0].enabled, 0);
    for (const edit of ["schedule='* * * * *'", "action_type='snapshot_run'", "agent_key='maven'"]) {
      await assert.rejects(migrateCloudSchedules("--activate-atlas", race("execute", () => db.execute(
        `UPDATE tenant_cron_jobs SET ${edit}`))));
      assert.equal((await db.execute("SELECT enabled FROM tenant_cron_jobs")).rows[0].enabled, 0);
      await db.execute("UPDATE tenant_cron_jobs SET schedule='*/15 * * * *', action_type='script_run',agent_key='atlas'");
    }
    await migrateCloudSchedules("--activate-atlas", db);
    const atlas = (await db.execute("SELECT * FROM tenant_cron_jobs")).rows[0];
    assert.equal(atlas.enabled, 1);
    assert.equal(atlas.schedule, "*/15 * * * *");
    assert.equal(atlas.run_count, 7);
    assert.equal(atlas.last_run_status, "error");
    assert.deepEqual(JSON.parse(String(atlas.action_payload)).args, ["once","--limit","1","--max-seconds","240","--summary-json"]);
    await migrateCloudSchedules("--apply-lease-schema", db);
    assert.equal((await db.execute("SELECT count(*) n FROM tenant_cron_execution_leases")).rows[0].n, 0);
    await db.execute("UPDATE tenant_cron_jobs SET owner_user_id='wrong-person'");
    await assert.rejects(migrateCloudSchedules("--hold-atlas", db));
    assert.equal((await db.execute("SELECT enabled FROM tenant_cron_jobs")).rows[0].enabled, 1);
  } finally { console.log = original; db.close(); }
  console.log("cloud-schedule-cutover: exact scope, atomic rollback, idempotent pin, disabled preservation and history preservation passed");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
