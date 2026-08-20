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
 * 401 and zero rows, never the full pool.
 */

import { NextResponse, type NextRequest } from "next/server";
import { resolveSessionContext } from "@/lib/api-auth";
import { parseFilters } from "@/lib/web-leads/filters";
import { selectSheetIds } from "@/lib/web-leads/queries";
import { fetchSheets, fetchLeads, PAGE_SIZE } from "@/lib/web-leads/data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const session = await resolveSessionContext();
  if (!session.ok) {
    return NextResponse.json({ ok: false, error: session.reason }, { status: 401 });
  }

  try {
    const filters = parseFilters(req.nextUrl.searchParams);
    const sheets = await fetchSheets();
    const ids = selectSheetIds(sheets, filters);
    const { leads, total } = await fetchLeads(filters, ids);
    return NextResponse.json({ leads, total, page: filters.page, pageSize: PAGE_SIZE });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "leads_failed" },
      { status: 500 },
    );
  }
}
