import "server-only";

/**
 * The active revenue goal for a workspace — read from revenue_goals (migration
 * 182), never from hand-typed profile columns. See lib/goals/goal-math.ts for
 * the arithmetic.
 */

import { getServiceSupabase } from "@/lib/supabase-server";
import type { RevenueGoal } from "@/lib/goals/goal-math";

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
