import "server-only";

/**
 * The active revenue goal for a workspace — read from revenue_goals (migration
 * 182), never from hand-typed profile columns. See lib/goals/goal-math.ts for
 * the arithmetic and input validation.
 */

import { randomUUID } from "node:crypto";
import { getServiceSupabase } from "@/lib/supabase-server";
import { getTursoClient } from "@/lib/turso";
import { validateGoalInput, type GoalInput, type RevenueGoal } from "@/lib/goals/goal-math";

export async function getActiveRevenueGoal(tenantId: string): Promise<RevenueGoal | null> {
  const { data, error } = await getServiceSupabase()
    .from("revenue_goals")
    .select("id, label, target_cents, currency, period_start, period_end")
    .eq("tenant_id", tenantId)
    .eq("metric", "revenue_collected")
    .eq("status", "active")
    .maybeSingle();
  // Loud: a Today card that silently shows no goal reads as "no target".
  if (error) throw new Error(`revenue_goal_read_failed: ${error.message}`);
  if (!data) return null;
  const row = data as RevenueGoal & { target_cents: number | string };
  return { ...row, target_cents: Number(row.target_cents) };
}

export type RevenueGoalHistoryRow = RevenueGoal & { status: string; created_at: string; closed_at: string | null };

export async function listRevenueGoals(tenantId: string, limit = 12): Promise<RevenueGoalHistoryRow[]> {
  const { data, error } = await getServiceSupabase()
    .from("revenue_goals")
    .select("id, label, target_cents, currency, period_start, period_end, status, created_at, closed_at")
    .eq("tenant_id", tenantId)
    .eq("metric", "revenue_collected")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`revenue_goal_list_failed: ${error.message}`);
  return ((data || []) as RevenueGoalHistoryRow[]).map((row) => ({ ...row, target_cents: Number(row.target_cents) }));
}

/**
 * Make `input` the active goal. The previous active goal is marked superseded
 * in the SAME batch, so there is never a moment with two active goals (the
 * partial unique index would refuse it) or with none.
 */
export async function setActiveRevenueGoal(args: {
  tenantId: string;
  input: GoalInput;
  createdBy: string;
}): Promise<RevenueGoal> {
  const problem = validateGoalInput(args.input);
  if (problem) throw new Error(`invalid_goal: ${problem}`);
  const id = `goal-${randomUUID()}`;
  const nowIso = new Date().toISOString();
  await getTursoClient().batch(
    [
      {
        sql: `UPDATE revenue_goals SET status = 'superseded', closed_at = ?
               WHERE tenant_id = ? AND metric = 'revenue_collected' AND status = 'active'`,
        args: [nowIso, args.tenantId],
      },
      {
        sql: `INSERT INTO revenue_goals
                (id, tenant_id, metric, label, target_cents, currency, period_start, period_end, status, created_by, created_at)
              VALUES (?, ?, 'revenue_collected', ?, ?, ?, ?, ?, 'active', ?, ?)`,
        args: [
          id,
          args.tenantId,
          args.input.label.trim(),
          args.input.target_cents,
          args.input.currency,
          args.input.period_start,
          args.input.period_end,
          args.createdBy,
          nowIso,
        ],
      },
    ],
    "write",
  );
  return { id, ...args.input, label: args.input.label.trim() };
}
