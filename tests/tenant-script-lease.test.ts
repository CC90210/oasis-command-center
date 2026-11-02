import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { claimTenantScript, heartbeatTenantScript, completeTenantScript,
  OASIS_SCRIPT_EXECUTOR as executor } from "../lib/automations/tenant-script-lease";

async function main() {
  const url = `file:${join(mkdtempSync(join(tmpdir(), "tenant-script-lease-")), "test.db")}`;
  const db = createClient({ url });
  const other = createClient({ url });
  await db.executeMultiple(`CREATE TABLE tenant_cron_jobs (
    id TEXT PRIMARY KEY, tenant_id TEXT, owner_user_id TEXT, enabled INTEGER,
    action_type TEXT, action_payload TEXT, agent_key TEXT, schedule TEXT,
    last_run_at TEXT, last_run_status TEXT, last_run_output TEXT, last_run_error TEXT,
    run_count INTEGER DEFAULT 0, updated_at TEXT);`);
  await db.executeMultiple(readFileSync("database/turso/bravo__252_tenant_cron_execution_leases.sql", "utf8"));
  const add = async (id: string, schedule = "* * * * *", owner = executor.userId as string) => {
    await db.execute({ sql: `INSERT INTO tenant_cron_jobs
      (id,tenant_id,owner_user_id,enabled,action_type,action_payload,agent_key,schedule)
      VALUES (?,?,?,1,'script_run','{}','atlas',?)`, args: [id, executor.tenantId, owner, schedule] });
  };
  const now = new Date("2026-11-01T20:00:10Z");
  await add("job");
  // Independent clients compete against the actual SQL CAS, no fake lock.
  const grants = await Promise.all([claimTenantScript(db, executor, "job", now),
    claimTenantScript(other, executor, "job", now)]);
  assert.deepEqual(grants.map((grant) => Boolean(grant.claimed)).sort(), [false, true]);
  const grant = grants.find((entry) => entry.claimed)!;
  assert.ok(grant.lease_token);
  assert.equal(await heartbeatTenantScript(db, executor, "job", "wrong-token", now), false);
  await assert.rejects(claimTenantScript(db, { ...executor, pairingId: "same-label-different-pair" }, "job", now));
  await add("foreign-owner", "* * * * *", "another-person");
  assert.equal((await claimTenantScript(db, executor, "foreign-owner", now)).ok, false);
  const input = { jobId: "job", token: grant.lease_token!, status: "success" as const, output: "processed=0", error: null };
  assert.equal((await completeTenantScript(db, executor, input, now)).ok, true);
  assert.equal((await completeTenantScript(db, executor, input, now)).duplicate, true);
  assert.equal((await db.execute("SELECT run_count FROM tenant_cron_jobs WHERE id='job'")).rows[0].run_count, 1);
  assert.equal((await claimTenantScript(db, executor, "job", now)).claimed, false);

  // Expired processes cannot heartbeat or overwrite a replacement's receipt.
  await add("expired");
  const old = await claimTenantScript(db, executor, "expired", now);
  const later = new Date(now.getTime() + 181_000);
  assert.equal(await heartbeatTenantScript(db, executor, "expired", old.lease_token!, later), false);
  const replacement = await claimTenantScript(other, executor, "expired", later);
  assert.equal(replacement.claimed, true);
  assert.equal((await completeTenantScript(db, executor, { ...input, jobId: "expired", token: old.lease_token! }, later)).ok, false);
  await db.execute("UPDATE tenant_cron_jobs SET enabled=0 WHERE id='expired'");
  assert.equal(await heartbeatTenantScript(db, executor, "expired", replacement.lease_token!, later), false);
  assert.equal((await completeTenantScript(db, executor, { ...input, jobId: "expired", token: replacement.lease_token! }, later)).ok, false);

  // A failed history write must leave the live lease retryable, never completed.
  await add("rollback");
  const retry = await claimTenantScript(db, executor, "rollback", now);
  await db.executeMultiple(`CREATE TRIGGER refuse_receipt BEFORE UPDATE ON tenant_cron_jobs
    WHEN NEW.id='rollback' BEGIN SELECT RAISE(ABORT,'injected write failure'); END;`);
  await assert.rejects(completeTenantScript(db, executor, { ...input, jobId: "rollback", token: retry.lease_token! }, now));
  assert.equal((await db.execute("SELECT completed_at FROM tenant_cron_execution_leases WHERE job_id='rollback'")).rows[0].completed_at, null);
  await db.execute("DROP TRIGGER refuse_receipt");
  assert.equal((await completeTenantScript(db, executor, { ...input, jobId: "rollback", token: retry.lease_token! }, now)).ok, true);

  // Toronto fixed-time schedules remain correct across the fall DST change.
  await add("summer", "0 9 * * *");
  await add("winter", "0 9 * * *");
  assert.equal((await claimTenantScript(db, executor, "summer", new Date("2026-10-31T13:00:10Z"))).claimed, true);
  assert.equal((await claimTenantScript(db, executor, "winter", new Date("2026-11-01T13:00:10Z"))).claimed, false);
  assert.equal((await claimTenantScript(db, executor, "winter", new Date("2026-11-01T14:00:10Z"))).claimed, true);
  // Edit after lookup but before INSERT must not authorize the cached action.
  await add("edit-race");
  let raced = false;
  const racingClient = new Proxy(db, { get(target, property) {
    if (property === "execute") return async (statement: Parameters<typeof db.execute>[0]) => {
      if (!raced && typeof statement === "object" && statement.sql.startsWith("INSERT INTO tenant_cron_execution_leases")) {
        raced = true;
        await db.execute("UPDATE tenant_cron_jobs SET action_type='snapshot_run',agent_key='maven' WHERE id='edit-race'");
      }
      return target.execute(statement);
    };
    const member = Reflect.get(target, property);
    return typeof member === "function" ? member.bind(target) : member;
  } });
  assert.equal((await claimTenantScript(racingClient, executor, "edit-race", now)).claimed, false);
  await add("changed-after-claim");
  const beforeEdit = await claimTenantScript(db, executor, "changed-after-claim", now);
  await db.execute("UPDATE tenant_cron_jobs SET action_payload='{\"args\":[]}' WHERE id='changed-after-claim'");
  assert.equal(await heartbeatTenantScript(db, executor, "changed-after-claim", beforeEdit.lease_token!, now), false);
  assert.equal((await completeTenantScript(db, executor, { ...input, jobId: "changed-after-claim", token: beforeEdit.lease_token! }, now)).ok, false);
  // Malformed payload text is the job's fault: a refusal, never a store outage (CodeRabbit #791).
  await add("malformed");
  await db.execute("UPDATE tenant_cron_jobs SET action_payload='{not json' WHERE id='malformed'");
  assert.deepEqual(await claimTenantScript(db, executor, "malformed", now), { ok: false, error: "job_payload_invalid" });
  db.close(); other.close();
  console.log("tenant-script-lease: concurrent claim, ownership, fencing, idempotent receipt, rollback and Toronto DST checks passed");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
