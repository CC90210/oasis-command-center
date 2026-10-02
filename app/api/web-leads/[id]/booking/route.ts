/**
 * GET /api/web-leads/[id]/booking: what the call-screen "Book the Meet" panel
 * needs before it renders. Read-only.
 *
 * Same gate stack as every other web-leads route (tests/web-leads-guards.test.ts):
 * resolve the caller, refuse another tenant with 403, scope the lead read to
 * the viewer so an out-of-scope id 404s exactly like a missing one. "May this
 * person book" is assertMayWorkLead, the same check logging a call uses, and
 * any failure of that check reads as "may not book" (fail closed). The booking
 * route still decides; this only tells the panel what to show.
 */
import { NextResponse, type NextRequest } from "next/server";
import { resolveSessionContext } from "@/lib/api-auth";
import { assertMayWorkLead } from "@/lib/leads/rep-lead-access";
import { getServiceSupabase } from "@/lib/supabase-server";
import { mayWorkWebsiteSalesLifecycle } from "@/lib/website-sales-workflow";
import { fetchLead, WEBDEV_TENANT_ID } from "@/lib/web-leads/data";
import { resolveWebLeadViewer } from "@/lib/web-leads/viewer";
import { bookingContextFrom, type AccessVerdict } from "@/lib/web-leads/booking-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return {}; }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = await resolveSessionContext();
  if (!session.ok) {
    return NextResponse.json({ ok: false, error: session.reason }, { status: 401 });
  }
  if (session.tenantId !== WEBDEV_TENANT_ID) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  let visible;
  try {
    // The shared resolver, as the other per-lead reads use: it carries a
    // manager's team scope, which an inline viewer would silently drop.
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

  return NextResponse.json({
    ok: true,
    viewerUserId: session.userId,
    ...bookingContextFrom({ data, access, viewerUserId: session.userId }),
  });
}
