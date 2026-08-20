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
 * 401 and zero rows, never the full pool. A failed facet read returns a 500
 * with the reason -- NOT an empty facet list, because an empty rail reads
 * as "there are no leads", which is a different and false statement.
 */

import { NextResponse, type NextRequest } from "next/server";
import { resolveSessionContext } from "@/lib/api-auth";
import { parseFilters } from "@/lib/web-leads/filters";
import { buildFacets } from "@/lib/web-leads/queries";
import { fetchSheets } from "@/lib/web-leads/data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const session = await resolveSessionContext();
  if (!session.ok) {
    return NextResponse.json({ ok: false, error: session.reason }, { status: 401 });
  }

  try {
    const sheets = await fetchSheets();
    const filters = parseFilters(req.nextUrl.searchParams);
    return NextResponse.json(buildFacets(sheets, filters));
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "facets_failed" },
      { status: 500 },
    );
  }
}
