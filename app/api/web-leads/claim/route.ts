/**
 * POST /api/web-leads/claim    — take leads into the caller's own book
 * POST /api/web-leads/claim?release=1 — put them back in the pool
 *
 * WHO MAY RECEIVE A CLAIM (2026-09-24): CC, Adon, and every ACTIVE sales rep --
 * exactly getOasisPipelineAssignmentRoster(), the same list the Assign picker
 * reads. Until that day it was CC + Adon only. When the sales team was retired
 * CC kept Schneur (builder) and David (opener) as working reps, so an active rep
 * may now self-claim from the pool and a founder may assign a pool lead to one.
 * A deactivated teammate (user_profiles.deactivated_at set) is off that roster
 * and is refused, as a self-claim and as an assignTo target alike. Every target
 * off the roster fails closed before the claim operation runs.
 *
 * Deactivation normally ends the session before this route is reached:
 * deactivateMember (lib/team-activation.ts) bans the login and bumps
 * session_version, lib/turso-auth.ts verifySessionAgainstDb refuses both, and
 * the caller gets the 401 below. The roster check is defense in depth for a
 * session that still resolves: a login left open because the person is still
 * active in another workspace, a ban step that failed after the profile was
 * marked, or deactivated_at set directly in the database.
 *
 * Sending assignTo at all needs an admin or a manager -- even when it names the
 * caller. A rep self-claims by leaving assignTo out.
 *
 * Auth, in the same order every other route in this feature uses: unresolved
 * caller -> 401 before any read. Caller in a different tenant -> 403. libSQL
 * has no row-level security, so this route IS the authorization boundary.
 */

import { NextResponse, type NextRequest } from "next/server";
import { resolveSessionContext } from "@/lib/api-auth";
import { WEBDEV_TENANT_ID } from "@/lib/web-leads/tenant";
import { claimLeads, releaseLeads } from "@/lib/web-leads/claim-ops";
import { mayWorkWebsiteSalesLifecycle } from "@/lib/website-sales-workflow";
import { isOasisPipelineAdmin } from "@/lib/oasis-sales-pipeline-policy";
import { canReadOasisSalesTeamPipeline } from "@/lib/role-surfaces";
import { getOasisPipelineAssignmentRoster, tenantSlugFor } from "@/lib/team";
import { resolveAssignableTarget } from "@/lib/web-leads/assign-target";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Hard ceiling on one request. Well above a rep's cap so it never binds in
 *  normal use; it exists so a malformed or hostile client cannot ask us to read
 *  and write an unbounded id list in one shot. */
const MAX_IDS_PER_REQUEST = 500;

export async function POST(req: NextRequest) {
  const session = await resolveSessionContext();
  if (!session.ok) {
    return NextResponse.json({ ok: false, error: session.reason }, { status: 401 });
  }
  if (session.tenantId !== WEBDEV_TENANT_ID) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  if (!mayWorkWebsiteSalesLifecycle(session.teamRole, session.isAdmin)) {
    return NextResponse.json({ ok: false, error: "sales_role_required" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const raw = (body as { leadIds?: unknown })?.leadIds;
  if (!Array.isArray(raw)) {
    return NextResponse.json({ ok: false, error: "leadIds_required" }, { status: 400 });
  }
  // Deduplicated: the same id twice in one batch would otherwise consume two
  // slots against the rep's cap for one lead.
  const leadIds = Array.from(
    new Set(raw.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map((v) => v.trim())),
  );
  if (leadIds.length === 0) {
    return NextResponse.json({ ok: false, error: "leadIds_required" }, { status: 400 });
  }
  if (leadIds.length > MAX_IDS_PER_REQUEST) {
    return NextResponse.json(
      { ok: false, error: `too_many_ids: ${leadIds.length} > ${MAX_IDS_PER_REQUEST}` },
      { status: 400 },
    );
  }

  // Releasing historical work must remain possible even when the new-cycle
  // assignment roster is unavailable. It is a cleanup of existing ownership,
  // not a new assignment.
  if (req.nextUrl.searchParams.get("release") === "1") {
    try {
      const result = await releaseLeads(session.userId, session.isAdmin, leadIds);
      return NextResponse.json({ ok: true, ...result });
    } catch (err) {
      return NextResponse.json(
        { ok: false, error: err instanceof Error ? err.message : "release_failed" },
        { status: 500 },
      );
    }
  }

  // ASSIGNING TO SOMEONE ELSE (2026-09-02).
  //
  // The Assign surface handed out whole territories -- a rep got every lead in
  // "Toronto, ON - Restaurants & Bars" or none. That shape made sense when the
  // board held ~27,000 rows and a sheet was a week of work; at ~1,800 it is the
  // wrong unit entirely, and there was no way to give one rep one lead.
  //
  // No new write path: claimLeads() already claims FOR a userId, so naming a
  // different one inherits every guard it enforces -- the per-rep cap (counted
  // against the TARGET, not the caller), the compare-and-set that stops two
  // people taking one lead, the missing-id report, and touch tracking. A second
  // bespoke "assign" implementation is how those rules drift apart.
  //
  // Two gates, because assignment moves commission:
  //   - only an admin or a manager may send assignTo, whoever it names (the
  //     caller's own id included). A rep must not be able to push work onto a
  //     colleague, or quietly take a lead off one; a rep claims by omitting it.
  //   - the target must be on the server-resolved assignment roster (CC, Adon
  //     and active reps), so this cannot park a lead on an arbitrary id someone
  //     typed, or on a rep who has been deactivated.
  const assignToRaw = (body as { assignTo?: unknown })?.assignTo;
  let claimFor = session.userId;
  if (typeof assignToRaw === "string" && assignToRaw.trim()) {
    const target = assignToRaw.trim().toLowerCase();
    const mayAssignOthers =
      isOasisPipelineAdmin(session.teamRole, session.isTrueAdmin, session.adminAccess)
      || canReadOasisSalesTeamPipeline({
        teamRole: session.teamRole,
        tenantSlug: await tenantSlugFor(session.tenantId),
      });
    if (!mayAssignOthers) {
      return NextResponse.json({ ok: false, error: "assign_requires_manager" }, { status: 403 });
    }
    claimFor = target;
  }

  // Every claim, a self-claim included, must land on the assignment roster:
  // CC, Adon and ACTIVE reps. This is separate from the manager read roster
  // (getOasisSalesRepRoster): adding founders to that one would widen cross-rep
  // visibility. Skipping this check would let an admin who is neither a founder
  // nor a rep take new work, and would leave a deactivated rep whose session
  // still resolves (see the header) with nothing between them and the pool. A
  // normal deactivation is refused earlier, at the session check.
  let roster;
  try {
    roster = await getOasisPipelineAssignmentRoster(session.tenantId);
  } catch (error) {
    console.error("[web-leads.claim] pipeline assignment roster unavailable", {
      tenantId: session.tenantId,
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ ok: false, error: "sales_roster_unavailable" }, { status: 503 });
  }
  const resolved = resolveAssignableTarget(roster, claimFor);
  if (!resolved) {
    return NextResponse.json(
      {
        ok: false,
        error: "target_not_on_sales_roster",
        message: "Only CC, Adon or an active sales rep can receive these leads. A deactivated teammate cannot take new work.",
      },
      { status: 400 },
    );
  }
  claimFor = resolved;

  try {
    // One clock for the whole request: the expiry rules must not see time move
    // between deciding a lead is claimable and writing the claim.
    const result = await claimLeads(claimFor, leadIds, Date.now());
    return NextResponse.json({ ok: true, assignedTo: claimFor, ...result });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "claim_failed" },
      { status: 500 },
    );
  }
}
