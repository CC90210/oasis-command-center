/**
 * GET /api/web-leads
 *
 * One page (PAGE_SIZE) of leads for the current filter selection, plus the
 * total match count for pagination. Sheet selection narrows which
 * territories are in play; the actual lead rows are filtered and paged in
 * memory (see lib/web-leads/data.ts for why: territory_id lives inside a
 * JSON blob, not a column).
 *
 * Auth: libSQL has no row-level security, so this route is the
 * authorization boundary, not a convenience. An unresolved caller gets a
 * 401 and zero rows, never the full pool. A caller resolved to a DIFFERENT
 * tenant gets a 403 -- resolving a session and never checking its tenantId
 * would leak every Web Studio lead to any authenticated user of any tenant.
 *
 * A tenant check alone is NOT sufficient: `agent` is the commission-only
 * outside-contractor role added for website sales, and it lives INSIDE this
 * tenant -- so passing the tenant check is not proof a caller may see every
 * lead in it. #237 (26ecc31a) hardened the manifest records route for this
 * exact reason; fetchLeads() applies the identical role scoping here (see
 * isScopedContractor in lib/web-leads/data.ts) regardless of tenant match.
 */

import { NextResponse, type NextRequest } from "next/server";
import { resolveSessionContext } from "@/lib/api-auth";
import { parseFilters } from "@/lib/web-leads/filters";
import { selectSheetIds } from "@/lib/web-leads/queries";
import { fetchSheets, fetchLeads, PAGE_SIZE, WEBDEV_TENANT_ID, type Viewer } from "@/lib/web-leads/data";
import { fetchScoreIndex } from "@/lib/web-leads/scores";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const session = await resolveSessionContext();
  if (!session.ok) {
    return NextResponse.json({ ok: false, error: session.reason }, { status: 401 });
  }
  // Resolving a caller and then not constraining them to a tenant is the same
  // class of bug as an auth check that can never fire (see the discriminated-
  // union bug this replaced). libSQL has no row-level security, so this is
  // the ONLY thing standing between a SunBiz rep's normal login and all
  // 31,000+ Web Studio leads. Any authenticated user of ANY tenant must be
  // refused here, before any data read.
  if (session.tenantId !== WEBDEV_TENANT_ID) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  try {
    const viewer: Viewer = { userId: session.userId, teamRole: session.teamRole, isAdmin: session.isAdmin };
    const filters = parseFilters(req.nextUrl.searchParams);
    // Concurrent, not serial: the score index is a tenant-wide read that does
    // not depend on which sheets the filters select, so it has no reason to
    // wait on fetchSheets().
    //
    // A FAILED SCORE READ FAILS THE WHOLE REQUEST, deliberately. The tempting
    // alternative -- catch it and serve the list with every lead marked "not
    // scored" -- produces a page that looks completely normal and is quietly
    // lying: 23,195 measured sites would read as unmeasured, the score-band
    // filter would return nothing, and a rep would work a queue that silently
    // excluded exactly the prospects they asked for. Nothing on screen would
    // say so. An error the operator can see is the honest failure here.
    const [sheets, scoreIndex] = await Promise.all([fetchSheets(), fetchScoreIndex()]);
    const ids = selectSheetIds(sheets, filters);
    const { leads, total } = await fetchLeads(filters, ids, viewer, scoreIndex);
    return NextResponse.json({ leads, total, page: filters.page, pageSize: PAGE_SIZE });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "leads_failed" },
      { status: 500 },
    );
  }
}
