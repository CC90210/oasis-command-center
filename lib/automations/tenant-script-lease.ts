import "server-only";
import { randomUUID } from "node:crypto";
import type { Client } from "@libsql/client";
import { nextRuns } from "@/lib/automations/schedule-plan";

// The operator approved this exact VPS pairing. A matching display label alone
// never grants execution rights; old desktop pairings cannot claim or report.
export const OASIS_SCRIPT_EXECUTOR = {
  tenantId: "ef8d389e-3f15-43f2-ae00-3660f69a1452",
  pairingId: "c2644fe5-6464-421f-8eec-ff38fadc5248",
  // Auth identity used by bridge_pairings and tenant_cron_jobs (not profile ID).
  userId: "c88bdce9-b11c-4731-bdc8-4357f96f820c",
  timezone: "America/Toronto",
} as const;
export type ScriptExecutor = { tenantId: string; pairingId: string; userId: string | null };
export const SCRIPT_LEASE_MS = 180_000;
export function isOasisScriptExecutor(executor: ScriptExecutor): boolean {
  return executor.tenantId === OASIS_SCRIPT_EXECUTOR.tenantId
    && executor.pairingId === OASIS_SCRIPT_EXECUTOR.pairingId
    && executor.userId === OASIS_SCRIPT_EXECUTOR.userId;
}

const JOB_SCOPE = `tenant_id = ? AND id = ? AND owner_user_id = ?
  AND enabled = 1 AND action_type IN ('script_run', 'snapshot_run')`;
const SAME_SPEC = `action_type = tenant_cron_execution_leases.job_action_type
  AND agent_key = tenant_cron_execution_leases.job_agent_key
  AND schedule = tenant_cron_execution_leases.job_schedule
  AND action_payload = tenant_cron_execution_leases.job_payload`;
function scope(executor: ScriptExecutor, jobId: string): string[] {
  if (!isOasisScriptExecutor(executor)) throw new Error("executor_not_authorized_for_tenant");
  return [executor.tenantId, jobId, executor.userId!];
}

/** Server clock and Toronto calendar own due times; clients cannot invent runs. */
export async function claimTenantScript(client: Client, executor: ScriptExecutor,
  jobId: string, now = new Date()) {
  const args = scope(executor, jobId);
  const lookup = await client.execute({
    sql: `SELECT id, schedule, action_type, action_payload, agent_key, last_run_at
      FROM tenant_cron_jobs WHERE ${JOB_SCOPE}`, args,
  });
  const row = lookup.rows[0];
  if (!row) return { ok: false, error: "job_not_enabled_or_owned" };
  const actionPayload = JSON.parse(String(row.action_payload));
  if (!actionPayload || typeof actionPayload !== "object" || Array.isArray(actionPayload)) {
    return { ok: false, error: "job_payload_invalid" };
  }
  // Two missed polling minutes can catch up once. Never replay hours after a
  // restart, and never drift when the Linux server is configured in UTC.
  const due = nextRuns(String(row.schedule), OASIS_SCRIPT_EXECUTOR.timezone,
    now.getTime() - 180_000, 4).filter((date) => date <= now).at(-1);
  if (!due) return { ok: true, claimed: false };
  const nowIso = now.toISOString();
  const occurrence = due.toISOString();
  const token = randomUUID();
  const until = new Date(now.getTime() + SCRIPT_LEASE_MS).toISOString();
  // One atomic statement is the cross-process lock, including the live job
  // switch/owner/spec and persisted completion time. No module promise locks.
  const grant = await client.execute({
    sql: `INSERT INTO tenant_cron_execution_leases
      (tenant_id, job_id, pairing_id, owner_user_id, lease_token, occurrence_at, lease_until,
        job_action_type, job_agent_key, job_schedule, job_payload, completed_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL WHERE EXISTS
        (SELECT 1 FROM tenant_cron_jobs WHERE ${JOB_SCOPE}
          AND schedule = ? AND action_payload = ? AND action_type = ? AND agent_key = ?
          AND (last_run_at IS NULL OR julianday(last_run_at) < julianday(?)))
      ON CONFLICT(tenant_id, job_id) DO UPDATE SET
        pairing_id=excluded.pairing_id, owner_user_id=excluded.owner_user_id,
        lease_token=excluded.lease_token, occurrence_at=excluded.occurrence_at,
        lease_until=excluded.lease_until, completed_at=NULL,
        job_action_type=excluded.job_action_type, job_agent_key=excluded.job_agent_key,
        job_schedule=excluded.job_schedule, job_payload=excluded.job_payload
      WHERE tenant_cron_execution_leases.lease_until <= ?
        AND (tenant_cron_execution_leases.completed_at IS NULL
          OR tenant_cron_execution_leases.occurrence_at < excluded.occurrence_at)
      RETURNING lease_token`,
    args: [executor.tenantId, jobId, executor.pairingId, executor.userId!, token,
      occurrence, until, String(row.action_type), String(row.agent_key), String(row.schedule),
      String(row.action_payload), ...args, String(row.schedule), String(row.action_payload),
      String(row.action_type), String(row.agent_key), occurrence, nowIso],
  });
  if (!grant.rows.length) return { ok: true, claimed: false };
  return { ok: true, claimed: true, lease_token: token, lease_until: until,
    occurrence_at: occurrence, job: { id: row.id, agent_key: row.agent_key,
      action_type: row.action_type, action_payload: actionPayload } };
}

export async function heartbeatTenantScript(client: Client, executor: ScriptExecutor,
  jobId: string, token: string, now = new Date()): Promise<boolean> {
  const args = scope(executor, jobId);
  const result = await client.execute({
    sql: `UPDATE tenant_cron_execution_leases SET lease_until = ?
      WHERE tenant_id = ? AND job_id = ? AND pairing_id = ? AND owner_user_id = ?
        AND lease_token = ? AND completed_at IS NULL AND lease_until > ?
        AND EXISTS (SELECT 1 FROM tenant_cron_jobs WHERE ${JOB_SCOPE} AND ${SAME_SPEC})
      RETURNING job_id`,
    args: [new Date(now.getTime() + SCRIPT_LEASE_MS).toISOString(), executor.tenantId,
      jobId, executor.pairingId, executor.userId!, token, now.toISOString(), ...args],
  });
  return result.rows.length === 1;
}

/** Completion and history advance together, once, only for the live grant. */
export async function completeTenantScript(client: Client, executor: ScriptExecutor,
  input: { jobId: string; token: string; status: "success" | "error";
    output: string | null; error: string | null }, now = new Date()) {
  const args = scope(executor, input.jobId);
  const tx = await client.transaction("write");
  try {
    const lease = (await tx.execute({
      sql: `SELECT completed_at, lease_until FROM tenant_cron_execution_leases
        WHERE tenant_id=? AND job_id=? AND pairing_id=? AND owner_user_id=? AND lease_token=?
        AND EXISTS (SELECT 1 FROM tenant_cron_jobs WHERE ${JOB_SCOPE} AND ${SAME_SPEC})`,
      args: [executor.tenantId, input.jobId, executor.pairingId, executor.userId!, input.token, ...args],
    })).rows[0];
    if (!lease || (!lease.completed_at && String(lease.lease_until) <= now.toISOString())) {
      await tx.rollback();
      return { ok: false, error: "lease_lost" };
    }
    if (lease.completed_at) {
      await tx.commit();
      return { ok: true, duplicate: true };
    }
    const updated = await tx.execute({
      sql: `UPDATE tenant_cron_jobs SET last_run_at=?, last_run_status=?, last_run_output=?,
        last_run_error=?, run_count=COALESCE(run_count,0)+1, updated_at=?
        WHERE ${JOB_SCOPE} RETURNING run_count`,
      args: [now.toISOString(), input.status, input.output?.slice(0, 8000) ?? null,
        input.error?.slice(0, 2000) ?? null, now.toISOString(), ...args],
    });
    if (!updated.rows.length) throw new Error("job_changed_during_completion");
    await tx.execute({
      sql: `UPDATE tenant_cron_execution_leases SET completed_at=?, lease_until=?
        WHERE tenant_id=? AND job_id=? AND lease_token=?`,
      args: [now.toISOString(), now.toISOString(), executor.tenantId, input.jobId, input.token],
    });
    await tx.commit();
    return { ok: true, run_count: Number(updated.rows[0].run_count) };
  } catch (error) {
    await tx.rollback();
    throw error;
  } finally { tx.close(); }
}
