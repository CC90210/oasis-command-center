/** Minute dispatcher for enabled guided department tasks. */
import "server-only";

import type { Client } from "@libsql/client";
import { nextRuns, planToCron, validatePlan, type SchedulePlan } from "@/lib/automations/schedule-plan";
import {
  recordMissedGuidedAutomation,
  runGuidedAutomation,
  type GuidedAutomationRow,
} from "@/lib/os/runs/guided-run";

const ROW_LIMIT = 25;
const SLOT_LIMIT = 16;
const CONCURRENCY = 2;
const MIN_MISS_MS = 15 * 60_000;
const DEFAULT_BUDGET_MS = 740_000;

export type GuidedDispatchSummary = {
  scanned: number;
  overLimit: boolean;
  started: string[];
  alreadyClaimed: string[];
  missed: string[];
  failed: string[];
  deferred: string[];
  invalid: string[];
};

type DispatcherDeps = {
  run: typeof runGuidedAutomation;
  recordMissed: typeof recordMissedGuidedAutomation;
};

function rowsOf(result: { rows: unknown[] }): GuidedAutomationRow[] {
  return result.rows.map((raw) => {
    const row = raw as Record<string, unknown>;
    return {
      id: String(row.id ?? ""),
      tenant_id: String(row.tenant_id ?? ""),
      owner_user_id: String(row.owner_user_id ?? ""),
      agent_key: String(row.agent_key ?? ""),
      name: String(row.name ?? "Automation"),
      action_type: String(row.action_type ?? ""),
      action_payload: row.action_payload,
      enabled: row.enabled,
      last_scheduled_for: typeof row.last_scheduled_for === "string" ? row.last_scheduled_for : null,
      created_at: typeof row.created_at === "string" ? row.created_at : null,
      updated_at: typeof row.updated_at === "string" ? row.updated_at : null,
    };
  });
}

function planOf(raw: unknown): SchedulePlan | null {
  try {
    const payload = typeof raw === "string" ? JSON.parse(raw) as Record<string, unknown> : raw as Record<string, unknown>;
    const schedule = payload?.schedule as Record<string, unknown> | undefined;
    const checked = validatePlan(schedule?.plan);
    return checked.ok ? checked.plan : null;
  } catch {
    return null;
  }
}

function dateOf(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isFinite(date.getTime()) ? date : null;
}

async function stampSlot(db: Client, row: GuidedAutomationRow, slot: Date, now: Date): Promise<void> {
  await db.execute({
    sql: `UPDATE tenant_cron_jobs
          SET last_scheduled_for = ?, updated_at = ?
          WHERE id = ? AND tenant_id = ?
            AND (last_scheduled_for IS NULL OR last_scheduled_for < ?)`,
    args: [slot.toISOString(), now.toISOString(), row.id, row.tenant_id, slot.toISOString()],
  });
}

function dueSlots(row: GuidedAutomationRow, plan: SchedulePlan, now: Date): Date[] {
  if (plan.mode === "manual") return [];
  // Activation stamps last_scheduled_for. created_at is the fail-closed legacy
  // fallback; updated_at can be changed by a preview result and is not an
  // enabling time.
  const base = dateOf(row.last_scheduled_for) ?? dateOf(row.created_at) ?? dateOf(row.updated_at) ?? now;
  return nextRuns(planToCron(plan), plan.timezone, base, SLOT_LIMIT).filter((slot) => slot.getTime() <= now.getTime());
}

function missCutoff(plan: SchedulePlan, slot: Date): number {
  const following = nextRuns(planToCron(plan), plan.timezone, slot, 1)[0];
  const gap = following ? following.getTime() - slot.getTime() : MIN_MISS_MS;
  return Math.max(MIN_MISS_MS, 2 * gap);
}

/** Dispatch rows independently, but only two model turns at a time. */
export async function dispatchGuidedAutomations(input: {
  db: Client;
  now?: Date;
  rowLimit?: number;
  budgetMs?: number;
  concurrency?: number;
  deps?: Partial<DispatcherDeps>;
}): Promise<GuidedDispatchSummary> {
  const now = input.now ?? new Date();
  const startedAt = Date.now();
  const budgetMs = input.budgetMs ?? DEFAULT_BUDGET_MS;
  const deps: DispatcherDeps = {
    run: input.deps?.run ?? runGuidedAutomation,
    recordMissed: input.deps?.recordMissed ?? recordMissedGuidedAutomation,
  };
  const limit = Math.max(1, Math.min(input.rowLimit ?? ROW_LIMIT, ROW_LIMIT));
  const result = await input.db.execute({
    sql: `SELECT id, tenant_id, owner_user_id, agent_key, name, action_type, action_payload,
                 enabled, last_scheduled_for, created_at, updated_at
          FROM tenant_cron_jobs
          WHERE enabled = 1 AND action_type = 'department_task'
            AND CASE
                  WHEN json_valid(action_payload) = 1 THEN COALESCE(json_extract(action_payload, '$.schedule.plan.mode'), '')
                  ELSE ''
                END <> 'manual'
          ORDER BY COALESCE(last_scheduled_for, created_at, updated_at) ASC, id ASC
          LIMIT ?`,
    args: [limit + 1],
  });
  const read = rowsOf(result as unknown as { rows: unknown[] });
  const rows = read.slice(0, limit);
  const summary: GuidedDispatchSummary = {
    scanned: rows.length,
    overLimit: read.length > limit,
    started: [],
    alreadyClaimed: [],
    missed: [],
    failed: [],
    deferred: [],
    invalid: [],
  };
  let cursor = 0;
  const work = async (): Promise<void> => {
    while (cursor < rows.length) {
      const row = rows[cursor++];
      const plan = planOf(row.action_payload);
      if (!plan) {
        summary.invalid.push(row.id);
        console.error("[guided.dispatch.invalid]", { tenantId: row.tenant_id, automationId: row.id, code: "schedule_invalid" });
        continue;
      }
      const slots = dueSlots(row, plan, now);
      for (let i = 0; i < slots.length; i += 1) {
        const slot = slots[i];
        if (Date.now() - startedAt >= budgetMs) {
          summary.deferred.push(`${row.id}:${slot.toISOString()}`);
          continue;
        }
        try {
          if (now.getTime() - slot.getTime() > missCutoff(plan, slot)) {
            const missed = await deps.recordMissed({ db: input.db, row, scheduledFor: slot, now });
            if (missed.created) summary.missed.push(missed.runId);
          } else {
            const run = await deps.run({ db: input.db, row, mode: "live", scheduledFor: slot, now });
            if (run.status === "already_claimed") summary.alreadyClaimed.push(run.runId || `${row.id}:${slot.toISOString()}`);
            else {
              summary.started.push(run.runId);
              if (run.status === "failed") summary.failed.push(run.runId);
            }
          }
          await stampSlot(input.db, row, slot, now);
        } catch (error) {
          summary.failed.push(`${row.id}:${slot.toISOString()}`);
          console.error("[guided.dispatch.failed]", {
            tenantId: row.tenant_id,
            automationId: row.id,
            scheduledFor: slot.toISOString(),
            code: error instanceof Error ? error.name : "unknown",
          });
          break;
        }
      }
      if (slots.length === SLOT_LIMIT && slots[SLOT_LIMIT - 1].getTime() <= now.getTime()) {
        summary.deferred.push(`${row.id}:more_slots`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(input.concurrency ?? CONCURRENCY, CONCURRENCY)) }, work));
  return summary;
}
