/**
 * POST /api/leads/[id]/background-check/run
 *
 * Manually enqueue (or re-use) a background check for one lead. The JARVIS
 * bg-check-worker polls merchant_background_checks for status='pending' (~30-60s)
 * and drives the record-search providers. Idempotent via enqueueBackgroundCheck.
 *
 *   201 { ok: true, check_id, reused }
 *   401 { ok: false, error: 'unauthorized' }
 *   500 { ok: false, error }
 */

import { NextRequest, NextResponse } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { resolveSessionContext } from "@/lib/api-auth";
import { enqueueBackgroundCheck } from "@/lib/background-check/enqueue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const session = await resolveSessionContext();
  if (!session.ok) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const { id: leadId } = await ctx.params;

  const enq = await enqueueBackgroundCheck({
    db: getServiceSupabase(),
    tenantId: session.tenantId,
    leadId,
  });
  if (!enq.ok) {
    return NextResponse.json({ ok: false, error: enq.reason }, { status: 500 });
  }
  return NextResponse.json({ ok: true, check_id: enq.checkId, reused: enq.reused }, { status: 201 });
}
