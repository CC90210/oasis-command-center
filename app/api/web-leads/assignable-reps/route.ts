/**
 * GET /api/web-leads/assignable-reps — who a manager may hand a lead TO.
 *
 * EXISTS BECAUSE THE PICKER AND THE SERVER DISAGREED. The Assign tab built its
 * rep dropdown from /api/team/members, which returns every profile on the
 * tenant. The current cycle deliberately uses a separate assignment roster:
 * CC and Adon only. The manager read roster remains role-based and unchanged,
 * so assignment policy cannot accidentally widen cross-rep visibility.
 *
 * The dropdown and every assignment write now resolve through that same
 * founder-only function, so they cannot offer one destination and accept
 * another.
 *
 * This route serves the SAME function the claim route validates against, so the
 * two cannot drift. Not a filter re-implemented on the client: a client-side
 * copy of OASIS_PIPELINE_REP_ROLES is a second source of truth that goes stale
 * the first time a role is added, and it would go stale silently.
 *
 * The gate mirrors the claim route's `mayAssignOthers` exactly: only someone
 * who may actually assign can enumerate the roster, so this cannot be used to
 * read the team list from a rep account.
 */

import { NextResponse } from "next/server";
import { resolveSessionContext } from "@/lib/api-auth";
import { WEBDEV_TENANT_ID } from "@/lib/web-leads/tenant";
import { isOasisPipelineAdmin } from "@/lib/oasis-sales-pipeline-policy";
import { canReadOasisSalesTeamPipeline } from "@/lib/role-surfaces";
import { getOasisPipelineAssignmentRoster, tenantSlugFor } from "@/lib/team";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const session = await resolveSessionContext();
  if (!session.ok) {
    return NextResponse.json({ ok: false, error: session.reason }, { status: 401 });
  }
  if (session.tenantId !== WEBDEV_TENANT_ID) {
    return NextResponse.json({ ok: false, error: "wrong_tenant" }, { status: 403 });
  }

  const mayAssignOthers =
    isOasisPipelineAdmin(session.teamRole, session.isTrueAdmin, session.adminAccess)
    || canReadOasisSalesTeamPipeline({
      teamRole: session.teamRole,
      tenantSlug: await tenantSlugFor(session.tenantId),
    });
  if (!mayAssignOthers) {
    return NextResponse.json({ ok: false, error: "assign_requires_manager" }, { status: 403 });
  }

  let roster;
  try {
    roster = await getOasisPipelineAssignmentRoster(session.tenantId);
  } catch {
    return NextResponse.json(
      { ok: false, error: "sales_roster_unavailable" },
      { status: 503 },
    );
  }
  // auth_user_id is what the claim route compares against, so it is the id the
  // picker must submit. Rows without one are already excluded by the roster
  // function; the guard here is so a future change there cannot put an
  // unassignable entry on screen.
  const reps = roster.flatMap((m) => {
    const id = (m.auth_user_id || "").trim();
    if (!id) return [];
    const name = (m.display_name || m.full_name || m.email || id).trim();
    return [{ id, name }];
  });

  return NextResponse.json({ ok: true, reps });
}
