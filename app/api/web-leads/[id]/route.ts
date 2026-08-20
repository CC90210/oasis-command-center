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
 * 401, never the record. A caller resolved to a DIFFERENT tenant gets a
 * 403 -- resolving a session and never checking its tenantId would let any
 * authenticated user of any tenant read a Web Studio lead by id.
 */

import { NextResponse } from "next/server";
import { resolveSessionContext } from "@/lib/api-auth";
import { fetchLead, WEBDEV_TENANT_ID } from "@/lib/web-leads/data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await resolveSessionContext();
  if (!session.ok) {
    return NextResponse.json({ ok: false, error: session.reason }, { status: 401 });
  }
  // Resolving a caller and then not constraining them to a tenant is the same
  // class of bug as an auth check that can never fire. libSQL has no
  // row-level security, so this is the ONLY thing standing between a SunBiz
  // rep's normal login and any Web Studio lead's name, address, and phone.
  if (session.tenantId !== WEBDEV_TENANT_ID) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
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
