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
import { buildFacets, selectSheetIds } from "@/lib/web-leads/queries";
import {
  fetchLeadProjection,
  fetchSheets,
  fetchSheetsScopedToViewer,
  fetchLeads,
  PAGE_SIZE,
  WEBDEV_TENANT_ID,
} from "@/lib/web-leads/data";
import { fetchScoreIndex } from "@/lib/web-leads/scores";
import { resolveWebLeadViewer } from "@/lib/web-leads/viewer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PRIVATE_BROWSER_CACHE = "private, max-age=15, stale-while-revalidate=30";

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
    const viewer = await resolveWebLeadViewer(session);
    const filters = parseFilters(req.nextUrl.searchParams);
    const fresh = req.nextUrl.searchParams.get("fresh") === "1";
    const scopeParam = req.nextUrl.searchParams.get("scope");
    const scope = scopeParam === "mine" ? "mine" : scopeParam === "team" ? "team" : "pool";
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
    //
    // TIMING IS MEASURED, NOT INFERRED. This route was reported at "15 seconds"
    // and the cause turned out not to be where it looked: the score index (three
    // whole-table reads) is ~1.3s, while the single lead read was 4.4-18.0s
    // because it pulled 37.8 MB of JSON blob to render one page. Guessing which
    // half is slow is how that went unfixed; a Server-Timing header means the
    // next person reads the answer off the response instead. Visible in the
    // browser's network panel under Timing, and in `curl -i`.
    const t0 = Date.now();
    const projectedRowsPromise = fetchLeadProjection(viewer, scope, fresh);
    const sheetsPromise = scope === "pool" ? fetchSheets() : Promise.resolve([]);
    const [sheets, scoreIndex, projectedRows] = await Promise.all([
      sheetsPromise,
      fetchScoreIndex(),
      projectedRowsPromise,
    ]);
    const tIndex = Date.now() - t0;
    const ids = selectSheetIds(sheets, filters);
    // scope=mine returns the caller's OWN book (including lapsed claims);
    // the default pool excludes every lead somebody currently holds, which is
    // what stops two reps dialling the same business. One clock for the whole
    // request so the expiry rules cannot see time move mid-read.
    const t1 = Date.now();
    const { leads, total } = await fetchLeads(filters, ids, viewer, scoreIndex, {
      scope,
      now: Date.now(),
      fresh,
      projectedRows,
    });
    const tLeads = Date.now() - t1;
    // Counts are DERIVED from the rows this response is built from, for every
    // viewer — not read off leadgen_territories' denormalized columns.
    //
    // Those columns are written when leads are promoted and never recomputed
    // when they leave. After the board was consolidated from ~27,000 rows to
    // ~1,800 they were wrong by 72x: the rail advertised 133,599 leads against
    // 1,846 that exist, and "Toronto, ON - Restaurants & Bars" offered 6,225
    // where 37 remain. A rep picked a sheet and got a near-empty table.
    //
    // The derivation already existed but was gated on isScopedContractor,
    // because at 31,000 rows walking them was a real cost worth paying only to
    // close a leak. At 1,846 it is one pass over an array already in memory:
    // `projectedRows` is fetched for every request regardless, and `baseSheets`
    // reuses the territory read for its labels. So the fast path bought nothing
    // and cost correctness for exactly the people who trust the number most --
    // admins and managers, the only viewers who were still on it.
    const facets = scope === "pool"
      ? buildFacets(
          await fetchSheetsScopedToViewer(viewer, {
            scope,
            fresh,
            projectedRows,
            baseSheets: sheets,
          }),
          filters,
        )
      : null;
    return NextResponse.json(
      {
        leads,
        total,
        page: filters.page,
        pageSize: PAGE_SIZE,
        facets,
      },
      {
        headers: {
          // Authenticated tenant data may be reused only by this browser and
          // only for the same session cookie. `private` keeps CDNs/shared
          // proxies out; Vary prevents one signed-in identity reusing another's
          // response in a shared browser cache.
          "Cache-Control": PRIVATE_BROWSER_CACHE,
          "Vary": "Cookie",
          // Both legs plus the total, so a slow page can be attributed without
          // reproducing it locally. Cache state is what separates a cold
          // instance from a warm one, and it is the difference that matters:
          // the memo (lib/web-leads/cache.ts) is per-instance, so on Vercel a
          // fresh instance pays full price no matter how warm its neighbours
          // are.
          "Server-Timing": [
            `index;desc="sheets+scores+projection";dur=${tIndex}`,
            `leads;desc="filter+page";dur=${tLeads}`,
            `total;dur=${Date.now() - t0}`,
          ].join(", "),
        },
      },
    );
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "leads_failed" },
      { status: 500 },
    );
  }
}
