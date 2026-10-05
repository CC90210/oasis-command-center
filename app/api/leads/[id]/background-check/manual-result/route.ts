/**
 * POST /api/leads/[id]/background-check/manual-result
 *
 * Operator enters / overrides background-check results by hand — the floor when
 * the automated source is blocked (needs_assist) or for a source we don't yet
 * automate. Updates the lead's latest check row to status='completed'; creates
 * one first if none exists.
 *
 * Body: { findings_summary: string, risk_flag?: RiskFlag, findings?: unknown[] }
 *   200 { ok: true, check_id }
 *   400 { ok: false, error: 'findings_summary_required' | 'bad_risk_flag' }
 *   401 { ok: false, error: 'unauthorized' }
 */

import { NextRequest, NextResponse } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { resolveSessionContext } from "@/lib/api-auth";
import { enqueueBackgroundCheck } from "@/lib/background-check/enqueue";
import { getWritableLead } from "@/lib/lead-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RISK_FLAGS = ["none", "court_case", "mca_default", "ucc", "lien", "bankruptcy", "unknown"];

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const session = await resolveSessionContext();
  if (!session.ok) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const { id: leadId } = await ctx.params;
  const writable = await getWritableLead(
    {
      teamRole: session.teamRole,
      userId: session.userId,
      isOwner: session.isTrueAdmin,
      adminAccess: session.adminAccess,
    },
    { tenantId: session.tenantId, id: leadId },
  );
  if (!writable.ok) {
    return NextResponse.json(
      { ok: false, error: writable.reason === "role_denied" ? "forbidden_role" : "not_found" },
      { status: writable.reason === "role_denied" ? 403 : 404 },
    );
  }

  let body: { findings_summary?: unknown; risk_flag?: unknown; findings?: unknown } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    /* empty body handled below */
  }

  const summary = typeof body.findings_summary === "string" ? body.findings_summary.trim().slice(0, 4000) : "";
  if (!summary) {
    return NextResponse.json({ ok: false, error: "findings_summary_required" }, { status: 400 });
  }
  const risk_flag = typeof body.risk_flag === "string" && RISK_FLAGS.includes(body.risk_flag) ? body.risk_flag : "unknown";
  if (typeof body.risk_flag === "string" && !RISK_FLAGS.includes(body.risk_flag)) {
    return NextResponse.json({ ok: false, error: "bad_risk_flag" }, { status: 400 });
  }
  const findings = Array.isArray(body.findings) ? body.findings.slice(0, 200) : [];

  const db = getServiceSupabase();
  const tenantId = session.tenantId;

  // Latest row for this lead, or create one so manual entry always has a target.
  const latest = await db
    .from("merchant_background_checks")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("lead_id", leadId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  let checkId = (latest.data as { id?: string } | null)?.id;
  if (!checkId) {
    const enq = await enqueueBackgroundCheck({ db, tenantId, leadId });
    if (!enq.ok) return NextResponse.json({ ok: false, error: enq.reason }, { status: 500 });
    checkId = enq.checkId;
  }

  const upd = await db
    .from("merchant_background_checks")
    .update({
      status: "completed",
      risk_flag,
      findings,
      findings_summary: `[manual] ${summary}`,
      sources_run: ["manual"],
      checked_at: new Date().toISOString(),
      error: null,
    })
    .eq("tenant_id", tenantId)
    .eq("id", checkId)
    .select("id")
    .single();
  if (upd.error) {
    return NextResponse.json({ ok: false, error: upd.error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, check_id: checkId });
}
