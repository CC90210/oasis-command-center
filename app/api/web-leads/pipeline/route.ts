/**
 * GET /api/web-leads/pipeline
 *
 * The pipeline board's read: this engine's leads, grouped by CC's existing
 * WEBSITE_SALES_STAGES (lib/website-sales.ts). READ-ONLY -- this route and
 * everything it calls never writes a stage, an assignment, or any other
 * field. See lib/web-leads/pipeline.ts's header for why: the pipeline
 * already exists, this is a view over it, never a second engine.
 *
 * Auth mirrors app/api/web-leads/[id]/audit/route.ts EXACTLY: libSQL has no
 * row-level security, so this route is the authorization boundary, not a
 * convenience. An unresolved caller gets a 401, never a read. A caller
 * resolved to a DIFFERENT tenant gets a 403. Both checks happen BEFORE any
 * read, same as every other web-leads route.
 *
 * A tenant check alone is NOT sufficient: `agent` is the commission-only
 * outside-contractor role added for website sales, and it lives INSIDE this
 * tenant -- #237 (26ecc31a) hardened the manifest records route for this
 * exact reason. fetchPipelineLeads() applies the identical role scoping (via
 * visibleToViewer in lib/web-leads/data.ts): a scoped contractor's read never
 * includes a row outside their own book in the first place, so this route
 * doesn't need to (and must not) filter after the fact.
 *
 * `?rep=<userId>` narrows the board to one rep. Only honoured for an
 * unscoped viewer (admin, or any established non-agent role) -- an
 * agent-role viewer is already locked to their own leads by the read itself,
 * so applying the filter for them would be a no-op that could read as a bug
 * ("why does this do nothing").
 */

import { NextResponse } from "next/server";
import { resolveSessionContext } from "@/lib/api-auth";
import { fetchPipelineLeads, isScopedContractor, WEBDEV_TENANT_ID, type Viewer } from "@/lib/web-leads/data";
import { groupLeadsByStage, filterByRep } from "@/lib/web-leads/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const session = await resolveSessionContext();
  if (!session.ok) {
    return NextResponse.json({ ok: false, error: session.reason }, { status: 401 });
  }
  // Resolving a caller and then not constraining them to a tenant is the same
  // class of bug as an auth check that can never fire. libSQL has no
  // row-level security, so this is the ONLY thing standing between a SunBiz
  // rep's normal login and every Web Studio lead's pipeline position.
  if (session.tenantId !== WEBDEV_TENANT_ID) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  const viewer: Viewer = { userId: session.userId, teamRole: session.teamRole, isAdmin: session.isAdmin };
  try {
    let leads = await fetchPipelineLeads(viewer);

    const url = new URL(req.url);
    const rep = url.searchParams.get("rep");
    if (rep && !isScopedContractor(viewer)) {
      leads = filterByRep(leads, rep);
    }

    const stages = groupLeadsByStage(leads);
    return NextResponse.json({ ok: true, stages, total: leads.length });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "pipeline_failed" },
      { status: 500 },
    );
  }
}
