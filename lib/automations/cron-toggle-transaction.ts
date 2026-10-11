import type { Client } from "@libsql/client";
import { asBool } from "@/lib/cron-empire-row";
import { daemonToggleRefusal } from "@/lib/automations/daemon-cron-guard";
import { isMissingColumnError } from "@/lib/api-helpers";

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

    // O2: a tenant-lane row belongs to its owner_user_id. Someone else may
    // only switch it OFF (requirement B); they may never turn it on, rename,
    // reschedule, reassign or delete it. A legacy row with no recorded owner
    // (owner_user_id NULL, or the column does not exist yet on this
    // deployment) is everyone's to manage, same as before O2. This is a
    // PRE-check, in JS, against the row this same transaction already read —
    // the CAS UPDATE below re-asserts the identical rule in SQL so a
    // concurrent write cannot slip past it.
    if (input.source === "tenant") {
      const ownerUserId = typeof prior.owner_user_id === "string" && prior.owner_user_id ? prior.owner_user_id : null;
      const isMine = !ownerUserId || ownerUserId === input.actorUserId;
      if (!isMine && input.enabled !== false) {
        await tx.rollback();
        return {
          ok: false,
          status: 403,
          body: {
            ok: false,
            error: "not_your_automation",
            message: "This automation belongs to someone else. You can switch it off, but not turn it on, edit or reschedule it.",
          },
        };
      }
    }

    const previousEnabled = asBool(prior[activeColumn]);
    const newValue = input.enabled ? 1 : 0;
    const previousValue = previousEnabled ? 1 : 0;
    const update = await executeToggleUpdate(tx, table, activeColumn, input, newValue, previousValue);
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

/** The real libSQL transaction's own type, so this helper's argument stays
 *  assignable to what toggleCronWithAudit actually passes it. */
type ToggleTx = Awaited<ReturnType<Client["transaction"]>>;

/**
 * Run the CAS UPDATE itself, called from toggleCronWithAudit ABOVE only AFTER
 * the exact-row read and the daemon guard have both already run — see
 * tests/daemon-backed-crons.test.ts, which pins that order against this file.
 * Tenant-lane rows re-assert ownership IN this statement (requirement C: "the
 * CAS WHERE clause gains the owner condition"), not only in the JS pre-check
 * above it — a concurrent write from a second request cannot slip past it
 * between the two reads. Enabling also stamps last_scheduled_for = now
 * (requirement B) so O5's due-time evaluator waits for the job's next real
 * occurrence instead of reading a brand-new or just re-enabled row as
 * overdue.
 *
 * Both are columns bravo__211_automation_owner.sql adds. A deployment that
 * has not applied it yet gets "no such column" from the full statement;
 * caught here and retried as the exact pre-O2 statement, never a raw driver
 * error — the JS pre-check above already made the real ownership decision
 * using `SELECT *`, which never throws for an absent column.
 */
async function executeToggleUpdate(
  tx: ToggleTx,
  table: string,
  activeColumn: string,
  input: CronToggleInput,
  newValue: 0 | 1,
  previousValue: 0 | 1,
): Promise<{ rowsAffected: number }> {
  const legacySql = `UPDATE ${table} SET ${activeColumn} = ? WHERE id = ? AND tenant_id = ? AND ${activeColumn} = ?`;
  const legacyArgs = [newValue, input.id, input.tenantId, previousValue];
  if (input.source !== "tenant") {
    return tx.execute({ sql: legacySql, args: legacyArgs });
  }
  const stampSchedule = newValue === 1;
  const fullSql = `UPDATE ${table}
        SET ${activeColumn} = ?${stampSchedule ? ", last_scheduled_for = ?" : ""}
        WHERE id = ? AND tenant_id = ? AND ${activeColumn} = ?
          AND (owner_user_id IS NULL OR owner_user_id = ? OR ? = 0)`;
  const fullArgs = stampSchedule
    ? [newValue, new Date().toISOString(), input.id, input.tenantId, previousValue, input.actorUserId, newValue]
    : [newValue, input.id, input.tenantId, previousValue, input.actorUserId, newValue];
  try {
    return await tx.execute({ sql: fullSql, args: fullArgs });
  } catch (err) {
    const asErr = err as { message?: string; code?: string };
    if (!isMissingColumnError(asErr, "owner_user_id") && !isMissingColumnError(asErr, "last_scheduled_for")) {
      throw err;
    }
    return tx.execute({ sql: legacySql, args: legacyArgs });
  }
}
