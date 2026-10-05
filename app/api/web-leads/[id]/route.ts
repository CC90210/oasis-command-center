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
 *
 * A tenant check alone is NOT sufficient: `agent` is the commission-only
 * outside-contractor role added for website sales, and it lives INSIDE this
 * tenant -- #237 (26ecc31a) hardened the manifest records route for this
 * exact reason. fetchLead() applies the identical role scoping here (see
 * isScopedContractor in lib/web-leads/data.ts) and returns null for a lead
 * outside the viewer's scope exactly as it does for one that doesn't exist
 * at all -- this route therefore answers 404, never 403, for an id a scoped
 * contractor may not see, so the id can't be used to probe what exists.
 *
 * ?view=booking answers what the call-screen "Book the Meet" panel needs
 * instead of the whole lead: who to prefill, the prospect's time zone, any
 * existing meeting, and whether this viewer may book. It is a view on this
 * route, not a route of its own, because every route file costs the Worker
 * bundle ~70 KiB and the bundle sits just under Cloudflare's upload limit.
 * Same gate stack as above; "may book" is the intersection of
 * websiteSalesLeadSeat (the booking PATCH's own ownership gate) and
 * assertMayWorkLead (the claim rule logging a call uses), and any failure of
 * either reads as "may not book" (fail closed). The booking PATCH still
 * decides; this only tells the panel what to show.
 */

import { NextResponse } from "next/server";
import { resolveSessionContext, type SessionContext } from "@/lib/api-auth";
import { assertMayWorkLead } from "@/lib/leads/rep-lead-access";
import { getServiceSupabase } from "@/lib/supabase-server";
import { mayWorkWebsiteSalesLifecycle, websiteSalesLeadSeat } from "@/lib/website-sales-workflow";
import { bookingContextFrom, type AccessVerdict } from "@/lib/web-leads/booking-context";
import { fetchLead, WEBDEV_TENANT_ID } from "@/lib/web-leads/data";
import { resolveWebLeadViewer } from "@/lib/web-leads/viewer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
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
  if (new URL(req.url).searchParams.get("view") === "booking") return bookingView(session, id);
  try {
    const viewer = await resolveWebLeadViewer(session);
    const lead = await fetchLead(id, viewer);
    if (!lead) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
    return NextResponse.json(lead);
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "lead_failed" },
      { status: 500 },
    );
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return {}; }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

async function bookingView(session: Extract<SessionContext, { ok: true }>, id: string) {
  let visible;
  try {
    // The shared resolver, as the plain view uses: it carries a manager's
    // team scope, which an inline viewer would silently drop.
    visible = await fetchLead(id, await resolveWebLeadViewer(session));
  } catch {
    return NextResponse.json({ ok: false, error: "lead_read_failed" }, { status: 503 });
  }
  if (!visible) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });

  const row = await getServiceSupabase()
    .from("tenant_records")
    .select("id,data")
    .eq("tenant_id", WEBDEV_TENANT_ID)
    .eq("entity_type", "lead")
    .eq("id", id)
    .maybeSingle();
  if (row.error) return NextResponse.json({ ok: false, error: "lead_read_failed" }, { status: 503 });
  if (!row.data) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  const data = asRecord((row.data as { data?: unknown }).data);

  let access: AccessVerdict = { ok: false, error: "sales_role_required" };
  if (mayWorkWebsiteSalesLifecycle(session.teamRole, session.isAdmin)) {
    const seat = websiteSalesLeadSeat({
      teamRole: session.teamRole,
      isAdmin: session.isAdmin,
      userId: session.userId,
      row: { id, data },
    });
    if (!seat.ok) {
      access = { ok: false, error: seat.error };
    } else {
      try {
        const verdict = await assertMayWorkLead({
          teamRole: session.teamRole,
          userId: session.userId,
          tenantId: WEBDEV_TENANT_ID,
          leadId: id,
          isOwner: session.isTrueAdmin,
          adminAccess: session.adminAccess,
          accessMode: "owned_oasis_sales",
        });
        access = verdict.ok ? { ok: true } : { ok: false, error: verdict.error };
      } catch {
        access = { ok: false, error: "access_check_failed" };
      }
    }
  }

  return NextResponse.json({
    ok: true,
    viewerUserId: session.userId,
    ...bookingContextFrom({ data, access, viewerUserId: session.userId }),
  });
}
