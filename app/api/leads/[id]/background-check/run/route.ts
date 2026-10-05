/**
 * POST /api/leads/[id]/background-check/run
 *
 * Manually enqueue (or re-use) a background check for one lead. The JARVIS
 * bg-check-worker polls merchant_background_checks for status='pending' (~30-60s)
 * and drives the record-search providers. Idempotent via enqueueBackgroundCheck.
 *
 *   201 { ok: true, check_id, reused }
 *   401 { ok: false, error: 'unauthorized' }
 *   403 { ok: false, error: 'forbidden_role' }
 *   500 { ok: false, error }
 */

import { NextRequest, NextResponse } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { resolveSessionContext } from "@/lib/api-auth";
import { enqueueBackgroundCheck } from "@/lib/background-check/enqueue";
import { getWritableLead } from "@/lib/lead-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const session = await resolveSessionContext();
  if (!session.ok) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  // Per-lead AI is a MEMBER CRM tool (CC 2026-07-07): any non-read_only member may
  // run a background check on a lead they're working. Admin-only is reserved for
  // automations + sequences MANAGEMENT — NOT per-lead AI.
  const { id: leadId } = await ctx.params;
  if (!UUID_RE.test(leadId)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }
  const access = await getWritableLead(
    {
      teamRole: session.teamRole,
      userId: session.userId,
      isOwner: session.isTrueAdmin,
      adminAccess: session.adminAccess,
    },
    { tenantId: session.tenantId, entity: "lead", id: leadId },
  );
  if (!access.ok) {
    return access.reason === "role_denied"
      ? NextResponse.json({ ok: false, error: "forbidden_role" }, { status: 403 })
      : NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }

  const enq = await enqueueBackgroundCheck({
    db: getServiceSupabase(),
    tenantId: session.tenantId,
    leadId,
  });
  if (!enq.ok) {
    // lead_not_found → 404 (fail closed on a missing/wrong-tenant target); else 500.
    const status = enq.reason === "lead_not_found" ? 404 : 500;
    return NextResponse.json({ ok: false, error: enq.reason }, { status });
  }
  return NextResponse.json({ ok: true, check_id: enq.checkId, reused: enq.reused }, { status: 201 });
}
