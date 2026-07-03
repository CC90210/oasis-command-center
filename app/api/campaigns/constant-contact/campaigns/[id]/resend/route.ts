/**
 * POST /api/campaigns/constant-contact/campaigns/[id]/resend — resend a sent
 * campaign to its non-openers. Body { resend_subject, delay_days? | delay_minutes? }.
 * Routes through runResend (blast-safety + dry-run gate). [id] is the CC campaign_id.
 * Admin-only, fails closed.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCcAdmin, ccError, resolvePrimaryActivityId } from "@/lib/integrations/constant-contact/route-helpers";
import { runResend } from "@/lib/integrations/constant-contact/blast";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requireCcAdmin();
  if (!gate.ok) return gate.res;
  const { client, session } = gate.ctx;

  let body: { resend_subject?: string; delay_days?: number; delay_minutes?: number } = {};
  try { body = (await req.json()) as typeof body; } catch { /* empty */ }
  const resendSubject = String(body.resend_subject || "").trim();
  if (!resendSubject) return NextResponse.json({ ok: false, error: "resend_subject_required" }, { status: 400 });

  try {
    const activityId = await resolvePrimaryActivityId(client, id);
    if (!activityId) return NextResponse.json({ ok: false, error: "no_activity" }, { status: 404 });
    const result = await runResend({
      tenantId: session.tenantId,
      userId: session.userId,
      activityId,
      resendSubject,
      delayDays: body.delay_days,
      delayMinutes: body.delay_minutes,
    });
    return NextResponse.json(result, { status: result.ok ? 200 : result.status || 400 });
  } catch (e) {
    return ccError(e);
  }
}
