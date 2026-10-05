/**
 * GET /api/leads/[id]/background-check/latest
 *
 * Most recent merchant_background_checks row for one lead, or { check: null }
 * when none has been enqueued (200 in both cases — "no check yet" is a real UI
 * state that shows the "Run check" CTA). raw_results is intentionally NOT
 * selected (service-role only; may carry PII).
 */

import { NextRequest, NextResponse } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { resolveSessionContext } from "@/lib/api-auth";
import { getReadableLeadTargetForSession } from "@/lib/lead-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const session = await resolveSessionContext();
  if (!session.ok) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const { id: leadId } = await ctx.params;
  const target = await getReadableLeadTargetForSession(session, {
    tenantId: session.tenantId,
    id: leadId,
  });
  if (!target) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  const db = getServiceSupabase();

  const result = await db
    .from("merchant_background_checks")
    .select(
      [
        "id",
        "status",
        "risk_flag",
        "findings",
        "findings_summary",
        "sources_run",
        "error",
        "checked_at",
        "created_at",
        "business_name",
        "owner_name",
        "state",
      ].join(", "),
    )
    .eq("tenant_id", session.tenantId)
    .eq("lead_id", target.queryLeadId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (result.error) {
    return NextResponse.json({ ok: false, error: result.error.message }, { status: 500 });
  }
  return NextResponse.json({ check: result.data ?? null });
}
