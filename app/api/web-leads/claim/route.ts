/**
 * POST /api/web-leads/claim    — take leads into the caller's own book
 * POST /api/web-leads/claim?release=1 — put them back in the pool
 *
 * SELF-SERVICE ON PURPOSE. A sales-capable member of this tenant may claim a
 * lead for THEMSELVES. Read-only and non-sales accounts may still browse but
 * cannot mutate ownership. There is no `userId` in the request body and no way
 * to claim on someone else's behalf through this route -- the owner is always
 * the resolved session. Admin bulk-assignment to a named rep is a separate,
 * admin-gated route; keeping the two apart means a compromised or
 * misunderstood client cannot quietly move leads between reps' books.
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
import { getOasisSalesRepRoster, tenantSlugFor } from "@/lib/team";

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
  //   - only an admin or a manager may name someone else. A rep must not be
  //     able to push work onto a colleague, or quietly take a lead off one.
  //   - the target must be on the server-resolved sales roster, so this cannot
  //     park a lead on a founder, a builder, or an id someone typed.
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
    if (target !== session.userId.trim().toLowerCase()) {
      const roster = await getOasisSalesRepRoster(session.tenantId);
      const onRoster = roster.some(
        (m) => (m.auth_user_id || "").trim().toLowerCase() === target,
      );
      if (!onRoster) {
        return NextResponse.json({ ok: false, error: "target_not_on_sales_roster" }, { status: 400 });
      }
    }
    claimFor = target;
  }

  try {
    if (req.nextUrl.searchParams.get("release") === "1") {
      const result = await releaseLeads(session.userId, session.isAdmin, leadIds);
      return NextResponse.json({ ok: true, ...result });
    }
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
