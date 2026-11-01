/** Narrow cloud cutover. Default is metadata-only; each mutation is explicit. */
import { readFileSync } from "node:fs";
import { getTursoClient } from "../lib/turso";
import { OASIS_SCRIPT_EXECUTOR as scope } from "../lib/automations/tenant-script-lease";

export const ATLAS_JOB = "2a5b3642-172d-4bbc-955a-6ad840be77be";
export const CLOUD_MACHINE = "oasis-daemon-1"; // exact live COORD_MACHINE, not a role label
export const CLOUD_NAMES = ["Bravo — Hourly Cron Health Check", "Bravo — Nightly Harness Eval",
  "Content Tools Runner", "Daily Automation Register", "Daily Bravo Brief", "Daily Log Rotation Audit",
  "Daily State DB Backup", "Event Bus Offline Drain", "Library Post Linker", "Library Reviews Sync",
  "Marketing Publish Drain", "Monthly Inventory Sync", "Post Analytics Sync", "Service Checks (Connections)",
  "Weekly Eval Suites", "Weekly Event Bus Retention", "Weekly Receipts Reconciliation", "Weekly tmp/ Hygiene"];

export async function migrateCloudSchedules(mode = "--preview", client = getTursoClient()) {
  if (!["--preview", "--pin-empire", "--apply-lease-schema", "--hold-atlas", "--activate-atlas"].includes(mode)) {
    throw new Error("Unknown cutover mode");
  }
  const fleetQuery = { sql: `SELECT id,name,schedule,is_active,owner_machine,action_type,action_config FROM cron_jobs
    WHERE tenant_id=? AND is_active=1 ORDER BY name`, args: [scope.tenantId] };
  const jobs = await client.execute(fleetQuery);
  if (jobs.rows.length !== CLOUD_NAMES.length || new Set(jobs.rows.map(job => job.name)).size !== CLOUD_NAMES.length
      || jobs.rows.some((job) => !CLOUD_NAMES.includes(String(job.name)))) {
    throw new Error("Active Empire fleet changed; review the inventory before cutover");
  }
  const atlas = (await client.execute({ sql: `SELECT id,tenant_id,owner_user_id,schedule,action_type,agent_key,
    action_payload,enabled,last_run_at,last_run_status,run_count FROM tenant_cron_jobs WHERE tenant_id=? AND id=?`,
  args: [scope.tenantId, ATLAS_JOB] })).rows[0];
  if (mode === "--preview") {
    const identity = await client.execute({ sql: `SELECT id,auth_user_id,team_role,is_owner FROM user_profiles
      WHERE tenant_id=? AND auth_user_id=?`, args: [scope.tenantId, scope.userId] });
    const pairing = await client.execute({ sql: `SELECT id,tenant_id,user_id,label,scope,claim_enabled_at,revoked_at
      FROM bridge_pairings WHERE tenant_id=? AND id=?`, args: [scope.tenantId, scope.pairingId] });
    console.log(JSON.stringify({ mode, empire: jobs.rows, atlas, identity: identity.rows, pairing: pairing.rows }, null, 2));
    return;
  }
  if (!atlas || atlas.owner_user_id !== scope.userId || atlas.action_type !== "script_run"
      || atlas.agent_key !== "atlas" || atlas.schedule !== "*/15 * * * *") {
    throw new Error("Atlas identity or schedule changed; cutover refused");
  }
  const payload = JSON.parse(String(atlas.action_payload));
  if (payload.script !== "tools/financial_handoff_consumer.py" || (payload.root && payload.root !== "atlas")) {
    throw new Error("Atlas runtime changed; cutover refused");
  }
  const safeArgs = ["once", "--limit", "1", "--max-seconds", "240", "--summary-json"];
  if (![JSON.stringify(["once", "--limit", "5"]), JSON.stringify(safeArgs)].includes(JSON.stringify(payload.args))) {
    throw new Error("Atlas arguments changed; cutover refused");
  }
  if (mode === "--apply-lease-schema") {
    await client.executeMultiple(readFileSync("database/turso/bravo__252_tenant_cron_execution_leases.sql", "utf8"));
    console.log(JSON.stringify({ mode, table_present: (await client.execute(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='tenant_cron_execution_leases'")).rows.length === 1 }));
    return;
  }
  if (mode === "--pin-empire") {
    const tx = await client.transaction("write");
    try {
      const current = await tx.execute(fleetQuery);
      if (JSON.stringify(current.rows) !== JSON.stringify(jobs.rows)) {
        throw new Error("Fleet changed after preview; all updates refused");
      }
      let changed = 0;
      for (const job of current.rows) {
        if (job.owner_machine === CLOUD_MACHINE) continue;
        if (job.owner_machine !== null) throw new Error("Unexpected current machine owner");
        const result = await tx.execute({ sql: `UPDATE cron_jobs SET owner_machine=?
          WHERE tenant_id=? AND id=? AND name=? AND schedule=? AND is_active=1 AND owner_machine IS NULL RETURNING id`,
        args: [CLOUD_MACHINE, scope.tenantId, job.id, job.name, job.schedule] });
        if (result.rows.length !== 1) throw new Error("Fleet changed during pin; all updates rolled back");
        changed += 1;
      }
      await tx.commit();
      console.log(JSON.stringify({ mode, changed, schedules_or_history_changed: false }));
    } catch (error) { await tx.rollback(); throw error; } finally { tx.close(); }
    return;
  }
  if (mode === "--hold-atlas" || mode === "--activate-atlas") {
    const activate = mode === "--activate-atlas";
    if (Number(atlas.enabled) !== (activate ? 0 : 1)) throw new Error("Unexpected Atlas switch; cutover refused");
    const nextPayload = activate ? JSON.stringify({ ...payload,
      args: safeArgs }) : String(atlas.action_payload);
    const result = await client.execute({ sql: `UPDATE tenant_cron_jobs SET enabled=?, action_payload=?
      WHERE tenant_id=? AND id=? AND owner_user_id=? AND enabled=? AND action_payload=?
        AND schedule=? AND action_type=? AND agent_key=? RETURNING id`,
    args: [activate ? 1 : 0, nextPayload, scope.tenantId, ATLAS_JOB, scope.userId,
      activate ? 0 : 1, String(atlas.action_payload), atlas.schedule, atlas.action_type, atlas.agent_key] });
    if (result.rows.length !== 1) throw new Error("Atlas changed during cutover; no update applied");
    console.log(JSON.stringify({ mode, changed: 1, schedule_preserved: true, history_preserved: true }));
    return;
  }
  console.log(JSON.stringify({ mode, empire: jobs.rows.map((row) => ({ id: row.id, name: row.name,
    owner_machine: row.owner_machine, schedule: row.schedule })), atlas: { id: atlas.id,
    owner_matches: true, enabled: atlas.enabled, schedule: atlas.schedule, args: payload.args,
    last_run_at: atlas.last_run_at, last_run_status: atlas.last_run_status, run_count: atlas.run_count } }, null, 2));
}
if (require.main === module) migrateCloudSchedules(process.argv[2]).catch((error) => {
  console.error(error instanceof Error ? error.message : "cutover_failed"); process.exitCode = 1;
});
