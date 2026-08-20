/**
 * GET /api/web-leads/[id]
 *
 * Everything held on one lead, for the detail panel. fetchLead already pins
 * WEBDEV_TENANT_ID (see lib/web-leads/data.ts), so an id from outside that
 * tenant resolves to null here -- indistinguishable from an id that does
 * not exist at all, on purpose: the reply must never confirm another
 * tenant's row.
 *
 * Auth: libSQL has no row-level security, so this route is the
 * authorization boundary, not a convenience. An unresolved caller gets a
 * 401, never the record.
 */

import { NextResponse } from "next/server";
import { resolveSessionContext } from "@/lib/api-auth";
import { fetchLead } from "@/lib/web-leads/data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await resolveSessionContext();
  if (!session.ok) {
    return NextResponse.json({ ok: false, error: session.reason }, { status: 401 });
  }

  const { id } = await ctx.params;
  try {
    const lead = await fetchLead(id);
    if (!lead) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
    return NextResponse.json(lead);
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "lead_failed" },
      { status: 500 },
    );
  }
}
