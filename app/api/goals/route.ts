/**
 * /api/goals — the workspace revenue goal (2026-09-24).
 *
 *   GET  → active goal + recent history. Only viewers whose capabilities include
 *        company financials (resolveViewerSurface → canSeeCompanyFinancials:
 *        a founder standing in an OASIS workspace). Everyone else gets 404.
 *   POST { label, target_usd | target_cad, period_start, period_end } → make
 *        it the active goal; the previous one is superseded atomically.
 *        True admins only (owner/admin base role), like other workspace money
 *        settings.
 *
 * The GET gate (P0-9, 2026-09-28): it used to answer any signed-in member, so a
 * commission-only rep could read the company revenue target that Today and
 * Settings deliberately never fetch for them. Money is gated by capability AND
 * workspace, the same rule as every other company-money reader
 * (lib/role-surfaces.ts capabilitiesFor).
 */

import { NextResponse, type NextRequest } from "next/server";
import { bad } from "@/lib/api-helpers";
import { getSessionContext, isTrueAdminRole } from "@/lib/team";
import { resolveViewerSurface } from "@/lib/role-surfaces-session";
import { getActiveRevenueGoal, listRevenueGoals, setActiveRevenueGoal } from "@/lib/goals/revenue-goal";
import { validateGoalInput, type GoalInput } from "@/lib/goals/goal-math";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  let surface: Awaited<ReturnType<typeof resolveViewerSurface>>;
  try {
    surface = await resolveViewerSurface();
  } catch (error) {
    // resolveSessionContext throws on a profile-store outage rather than
    // pretending the caller is signed out; answer with JSON that names it.
    console.error("[goals.get.surface]", error);
    return bad(503, "profile_resolution_unavailable");
  }
  if (!surface.ok) return bad(401, "unauthorized");
  if (!surface.capabilities.canSeeCompanyFinancials) {
    // A founder whose workspace-slug read failed is not a rep: say the real
    // fault out loud rather than a 404 the panel would show as "not found".
    // Nothing is read either way.
    if (surface.degraded && surface.persona === "founder") {
      return bad(503, "workspace_unresolved");
    }
    return bad(404, "not_found");
  }
  try {
    const [active, history] = await Promise.all([
      getActiveRevenueGoal(surface.tenantId),
      listRevenueGoals(surface.tenantId),
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
