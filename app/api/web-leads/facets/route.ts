/**
 * GET /api/web-leads/facets
 *
 * Province -> city and industry counts for the current filter selection,
 * driving the Web Leads browser's filter rail. Counts come from the
 * denormalized leadgen_territories counters (see lib/web-leads/queries.ts),
 * not from scanning leads.
 *
 * Auth: libSQL has no row-level security, so this route is the
 * authorization boundary, not a convenience. An unresolved caller gets a
 * 401 and zero rows, never the full pool. A caller resolved to a DIFFERENT
 * tenant gets a 403 -- resolving a session and never checking its tenantId
 * would leak every Web Studio lead to any authenticated user of any tenant.
 * A failed facet read returns a 500 with the reason -- NOT an empty facet
 * list, because an empty rail reads as "there are no leads", which is a
 * different and false statement.
 *
 * A tenant check alone is NOT sufficient: `agent` is the commission-only
 * outside-contractor role added for website sales, and it lives INSIDE this
 * tenant. The fast fetchSheets() counters are tenant-wide, so serving them
 * unscoped would show a contractor the true size and shape of a book they
 * cannot open (e.g. "Toronto 8,246" beside a table of zero rows) -- the
 * same class of leak #237 (26ecc31a) closed on the manifest records route.
 * A scoped viewer gets fetchSheetsScopedToViewer() instead, which re-derives
 * counts from only the leads visible to them (see lib/web-leads/data.ts).
 */

import { NextResponse, type NextRequest } from "next/server";
import { resolveSessionContext } from "@/lib/api-auth";
import { parseFilters } from "@/lib/web-leads/filters";
import { buildFacets } from "@/lib/web-leads/queries";
import {
  fetchSheets,
  fetchSheetsScopedToViewer,
  isScopedContractor,
  WEBDEV_TENANT_ID,
} from "@/lib/web-leads/data";
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
  // class of bug as an auth check that can never fire. libSQL has no
  // row-level security, so this is the ONLY thing standing between a SunBiz
  // rep's normal login and every Web Studio facet count.
  if (session.tenantId !== WEBDEV_TENANT_ID) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  try {
    const viewer = await resolveWebLeadViewer(session);
    const fresh = req.nextUrl.searchParams.get("fresh") === "1";
    const filters = parseFilters(req.nextUrl.searchParams);
    const scope = filters.view === "mine" ? "mine" : "pool";
    // Keep the fast tenant-wide counter path for the normal (unscoped) case;
    // only a scoped contractor pays for the per-lead re-derivation.
    const sheets = isScopedContractor(viewer)
      ? await fetchSheetsScopedToViewer(viewer, { fresh, scope, now: Date.now() })
      : await fetchSheets();
    return NextResponse.json(buildFacets(sheets, filters), {
      headers: {
        // Facet counts reveal a tenant's book just as the rows do. Brief
        // browser reuse is safe; a CDN/shared proxy cache is not.
        "Cache-Control": PRIVATE_BROWSER_CACHE,
        "Vary": "Cookie",
      },
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "facets_failed" },
      { status: 500 },
    );
  }
}
