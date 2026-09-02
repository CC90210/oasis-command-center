/**
 * PATCH /api/web-leads/territories/[id]/assign
 *
 * Give a Web Leads territory (a region/locality/vertical sheet, e.g.
 * "Toronto, ON - Salons & Personal Care") to a rep, so its leads become
 * theirs. Body: `{ assignedTo: string | null }` — a user id, or null to
 * clear the sheet's owner.
 *
 * ADMIN ONLY. Reps do not hand themselves (or each other) books of
 * business. Auth mirrors app/api/web-leads/[id]/audit/route.ts's spine
 * EXACTLY — 401 before 403, both before any read or write — with one
 * addition on top: a non-admin `agent` who IS inside the right tenant still
 * gets 403. All three checks happen before the body is even parsed, so this
 * route can't be used to probe territory existence from outside admin.
 *
 * The propagation itself (batched, partial-failure-safe, and why
 * unassigning never touches a lead's own `data.assigned_to`) lives in
 * lib/web-leads/assign.ts.
 */

import { NextResponse, type NextRequest } from "next/server";
import { resolveSessionContext } from "@/lib/api-auth";
import { WEBDEV_TENANT_ID } from "@/lib/web-leads/data";
import { assignTerritory } from "@/lib/web-leads/assign";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await resolveSessionContext();
  if (!session.ok) {
    return NextResponse.json({ ok: false, error: session.reason }, { status: 401 });
  }
  // Resolving a caller and then not constraining them to a tenant is the same
  // class of bug as an auth check that can never fire. libSQL has no
  // row-level security, so this is the ONLY thing standing between a SunBiz
  // rep's normal login and every Web Studio territory.
  if (session.tenantId !== WEBDEV_TENANT_ID) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  // lives INSIDE this tenant (#237) — passing the tenant check above is not
  // proof this caller may hand out books of business.
  const isManager = session.teamRole?.trim().toLowerCase() === "manager";
  if (!session.isAdmin && !isManager) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  const { id } = await ctx.params;

  let body: { assignedTo?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  const raw = body.assignedTo;
  if (raw !== null && raw !== undefined && typeof raw !== "string") {
    return NextResponse.json({ ok: false, error: "invalid_assigned_to" }, { status: 400 });
  }
  const assignedTo = typeof raw === "string" && raw.trim() ? raw : null;

  try {
    const result = await assignTerritory({ territoryId: id, assignedTo });
    if (!result.ok) {
      return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
    }
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "assign_failed" },
      { status: 500 },
    );
  }
}
