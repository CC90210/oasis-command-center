/**
 * GET /api/applications/[id]/underwriting/latest
 *
 * Returns the most recent application_underwriting row for one application,
 * or { run: null } when no run has been enqueued yet. 200 in both cases —
 * the absence of a run IS a meaningful UI state (shows the "Run Underwriting"
 * CTA in the BankTab rather than a results panel).
 *
 * Response:
 *   { run: UnderwritingRun | null }
 *
 * UnderwritingRun is the full row shape from migration 069:
 *   id, run_at, status, triggered_by, triggered_by_user_id,
 *   parser_output, debt_analysis, sales_angle,
 *   avg_monthly_revenue, avg_daily_balance, nsf_count,
 *   deposit_consistency_pct, debt_service_monthly,
 *   debt_to_revenue_ratio, lender_count, risk_flags,
 *   readiness_score, error_message
 *
 * Phase 7.3 SunBiz CRM (second-meeting 2026-05-25).
 */

import { NextRequest, NextResponse } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { resolveTenantId } from "@/lib/api-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const tenantId = await resolveTenantId();
  if (!tenantId) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const { id: applicationId } = await ctx.params;

  const db = getServiceSupabase();

  const result = await db
    .from("application_underwriting")
    .select(
      [
        "id",
        "run_at",
        "status",
        "triggered_by",
        "triggered_by_user_id",
        "parser_output",
        "debt_analysis",
        "sales_angle",
        "avg_monthly_revenue",
        "avg_daily_balance",
        "nsf_count",
        "deposit_consistency_pct",
        "debt_service_monthly",
        "debt_to_revenue_ratio",
        "lender_count",
        "risk_flags",
        "readiness_score",
        "error_message",
      ].join(", "),
    )
    .eq("tenant_id", tenantId)
    .eq("application_id", applicationId)
    .order("run_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (result.error) {
    return NextResponse.json(
      { ok: false, error: result.error.message },
      { status: 500 },
    );
  }

  return NextResponse.json({ run: result.data ?? null });
}
