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
import { getOasisSalesRepRoster } from "@/lib/team";
import { resolveAssignableTarget } from "@/lib/web-leads/assign-target";

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
  let assignedTo = typeof raw === "string" && raw.trim() ? raw : null;

  // THE TARGET IS VALIDATED, not just the caller. Until now this route checked
  // who may assign and then accepted any non-empty string as the destination,
  // so a whole city+industry sheet could be parked on:
  //
  //   - a founder, whom getOasisSalesRepRoster deliberately excludes (their
  //     assigned records are founder work, not a rep's book, and that exclusion
  //     is what keeps a manager's cross-rep read boundary honest), or
  //   - an id belonging to no profile at all. That is the bad one: the write
  //     SUCCEEDS, the sheet's leads propagate to an owner who does not exist,
  //     and they are then out of the pool and invisible to every rep. Nothing
  //     reports an error, because nothing ever asked.
  //
  // The per-lead claim route has always checked roster membership. These two
  // controls sit on the SAME tab and disagreed about whether the destination
  // matters. Same function on both sides now, so they cannot drift.
  //
  // Audited before the change: 1 assigned territory, owner valid. The hole was
  // latent, not exploited.
  if (assignedTo) {
    const roster = await getOasisSalesRepRoster(session.tenantId);
    // Take the id FROM THE ROSTER, not from the request. Matching leniently and
    // then persisting what the client sent is how a lenient comparison becomes
    // a data-integrity bug: " 8f3a-REP-ariel " passes the check and is stored
    // verbatim, producing an owner that matches the roster nowhere else -- the
    // ghost owner this check exists to prevent. (CodeRabbit, PR #383.)
    const resolved = resolveAssignableTarget(roster, assignedTo);
    if (!resolved) {
      return NextResponse.json(
        { ok: false, error: "target_not_on_sales_roster" },
        { status: 400 },
      );
    }
    assignedTo = resolved;
  }

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
