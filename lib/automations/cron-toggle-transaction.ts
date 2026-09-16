import type { Client } from "@libsql/client";
import { asBool } from "@/lib/cron-empire-row";
import { daemonToggleRefusal } from "@/lib/automations/daemon-cron-guard";

export type CronToggleSource = "tenant" | "empire";

export type CronToggleInput = {
  source: CronToggleSource;
  id: string;
  tenantId: string;
  enabled: boolean;
  actorEmail: string | null;
  actorUserId: string | null;
};

export type CronToggleResult =
  | {
      ok: true;
      row: Record<string, unknown>;
      previousEnabled: boolean;
      enabled: boolean;
    }
  | {
      ok: false;
      status: number;
      body: Record<string, unknown>;
    };

function fromDriver(value: unknown): unknown {
  if (typeof value === "string" && (value.startsWith("{") || value.startsWith("["))) {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  if (typeof value === "bigint") return Number(value);
  return value;
}

function normalizeDriverRow(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, fromDriver(value)]));
}

/**
 * Toggle one scheduler row and append its audit event in one libSQL write
 * transaction. Other connections cannot observe the new active state unless
 * the audit insert and authoritative readback also succeed.
 */
export async function toggleCronWithAudit(
  client: Client,
  input: CronToggleInput,
): Promise<CronToggleResult> {
  const table = input.source === "empire" ? "cron_jobs" : "tenant_cron_jobs";
  const activeColumn = input.source === "empire" ? "is_active" : "enabled";
  const tx = await client.transaction("write");

  try {
    const priorResult = await tx.execute({
      sql: `SELECT * FROM ${table} WHERE id = ? AND tenant_id = ? LIMIT 1`,
      args: [input.id, input.tenantId],
    });
    const priorRaw = priorResult.rows[0] as unknown as Record<string, unknown> | undefined;
    if (!priorRaw) {
      await tx.rollback();
      return {
        ok: false,
        status: 404,
        body: { ok: false, error: "not_found_or_forbidden" },
      };
    }
    const prior = normalizeDriverRow(priorRaw);
    const refusal = daemonToggleRefusal({
      ok: true,
      name: typeof prior.name === "string" ? prior.name : null,
    });
    if (refusal) {
      await tx.rollback();
      return { ok: false, status: refusal.status, body: refusal.body };
    }

    const previousEnabled = asBool(prior[activeColumn]);
    const update = await tx.execute({
      sql: `UPDATE ${table}
            SET ${activeColumn} = ?
            WHERE id = ? AND tenant_id = ? AND ${activeColumn} = ?`,
      args: [input.enabled ? 1 : 0, input.id, input.tenantId, previousEnabled ? 1 : 0],
    });
    if (update.rowsAffected !== 1) throw new Error("cron_toggle_concurrent_update");

    const persistedResult = await tx.execute({
      sql: `SELECT * FROM ${table} WHERE id = ? AND tenant_id = ? LIMIT 1`,
      args: [input.id, input.tenantId],
    });
    const persistedRaw = persistedResult.rows[0] as unknown as Record<string, unknown> | undefined;
    if (!persistedRaw) throw new Error("cron_toggle_readback_missing");
    const persisted = normalizeDriverRow(persistedRaw);
    const persistedEnabled = asBool(persisted[activeColumn]);
    if (persistedEnabled !== input.enabled) throw new Error("cron_toggle_readback_mismatch");

    const name = typeof persisted.name === "string" ? persisted.name : null;
    await tx.execute({
      sql: `INSERT INTO tenant_audit_log
              (tenant_id, actor_user_id, actor_email, action_type,
               target_table, target_id, before, after)
            VALUES (?, ?, ?, 'cron_job_toggle', ?, ?, ?, ?)`,
      args: [
        input.tenantId,
        input.actorUserId,
        input.actorEmail,
        table,
        input.id,
        JSON.stringify({ source: input.source, name, enabled: previousEnabled }),
        JSON.stringify({ source: input.source, name, enabled: persistedEnabled }),
      ],
    });

    await tx.commit();
    return {
      ok: true,
      row: persisted,
      previousEnabled,
      enabled: persistedEnabled,
    };
  } catch (error) {
    try {
      await tx.rollback();
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "cron_toggle_failed_and_rollback_could_not_be_confirmed",
      );
    }
    throw error;
  }
}
