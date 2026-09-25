/**
 * /api/goals — the workspace revenue goal (2026-09-24).
 *
 *   GET  → active goal + recent history (any signed-in member of the workspace)
 *   POST { label, target_usd | target_cad, period_start, period_end } → make
 *        it the active goal; the previous one is superseded atomically.
 *        True admins only (owner/admin base role), like other workspace money
 *        settings.
 */

import { NextResponse, type NextRequest } from "next/server";
import { bad } from "@/lib/api-helpers";
import { getSessionContext, isTrueAdminRole } from "@/lib/team";
import { getActiveRevenueGoal, listRevenueGoals, setActiveRevenueGoal } from "@/lib/goals/revenue-goal";
import { validateGoalInput, type GoalInput } from "@/lib/goals/goal-math";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const ctx = await getSessionContext();
  if (!ctx) return bad(401, "unauthorized");
  try {
    const [active, history] = await Promise.all([
      getActiveRevenueGoal(ctx.tenantId),
      listRevenueGoals(ctx.tenantId),
    ]);
    return NextResponse.json({ ok: true, active, history });
  } catch (error) {
    console.error("[goals.get]", error);
    return bad(500, error instanceof Error ? error.message : "goal_read_failed");
  }
}

export async function POST(req: NextRequest) {
  const ctx = await getSessionContext();
  if (!ctx) return bad(401, "unauthorized");
  if (!isTrueAdminRole(ctx.teamRole, ctx.isOwner)) return bad(403, "forbidden");

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return bad(400, "invalid JSON");
  }
  const currency = body.target_cad !== undefined ? "CAD" : "USD";
  const amount = Number(currency === "CAD" ? body.target_cad : body.target_usd);
  const input: GoalInput = {
    label: String(body.label || ""),
    target_cents: Number.isFinite(amount) ? Math.round(amount * 100) : NaN,
    currency,
    period_start: String(body.period_start || ""),
    period_end: String(body.period_end || ""),
  };
  const problem = validateGoalInput(input);
  if (problem) return bad(400, problem);
  try {
    const goal = await setActiveRevenueGoal({ tenantId: ctx.tenantId, input, createdBy: ctx.profileId });
    return NextResponse.json({ ok: true, goal });
  } catch (error) {
    console.error("[goals.post]", error);
    return bad(500, error instanceof Error ? error.message : "goal_write_failed");
  }
}
