/**
 * /api/campaigns/constant-contact/campaigns/[id]/schedule
 *   GET    → current schedule for the campaign's primary activity.
 *   POST   → (re)schedule the send. Body { scheduled_date: ISO-8601 | "0" }.
 *            SEND-time change → honors the isDryRun("constant_contact") gate.
 *   DELETE → cancel (unschedule) the queued send. Always allowed (the safe direction).
 * [id] is the CC campaign_id. Admin-only, fails closed.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCcAdmin, ccError, resolvePrimaryActivityId } from "@/lib/integrations/constant-contact/route-helpers";
import { isDryRun } from "@/lib/integrations/send-mode";
import { sanitizeBlastMessage } from "@/lib/integrations/blast-safety";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requireCcAdmin();
  if (!gate.ok) return gate.res;
  try {
    const activityId = await resolvePrimaryActivityId(gate.ctx.client, id);
    if (!activityId) return NextResponse.json({ ok: false, error: "no_activity" }, { status: 404 });
    const schedule = await gate.ctx.client.getSchedule(activityId).catch(() => null);
    return NextResponse.json({ ok: true, activity_id: activityId, schedule });
  } catch (e) {
    return ccError(e);
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requireCcAdmin();
  if (!gate.ok) return gate.res;

  let body: { scheduled_date?: string } = {};
  try { body = (await req.json()) as typeof body; } catch { /* empty */ }
  const scheduledDate = (body.scheduled_date || "").trim();
  if (!scheduledDate) return NextResponse.json({ ok: false, error: "scheduled_date_required" }, { status: 400 });

  const activityId = await resolvePrimaryActivityId(gate.ctx.client, id);
  if (!activityId) return NextResponse.json({ ok: false, error: "no_activity" }, { status: 404 });

  // A schedule IS a live-send trigger — the campaign may have been edited in CC's own web UI, so
  // re-run blast-safety (lender names / dashes) on the CURRENT content. Fail closed. [[one-send-gate]]
  try {
    const act = (await gate.ctx.client.getActivity(activityId, "html_content")) as { subject?: string; html_content?: string };
    const g = await sanitizeBlastMessage(gate.ctx.session.tenantId, `${act.subject || ""}\n${act.html_content || ""}`);
    if (!g.ok) return NextResponse.json({ ok: false, error: g.reason, message: g.message, lender_hits: g.lenderHits }, { status: 400 });
  } catch (e) {
    return ccError(e);
  }

  if (isDryRun("constant_contact")) {
    return NextResponse.json({ ok: true, dry_run: true, would_schedule: scheduledDate });
  }

  try {
    await gate.ctx.client.schedule(activityId, scheduledDate);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return ccError(e);
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requireCcAdmin();
  if (!gate.ok) return gate.res;
  try {
    const activityId = await resolvePrimaryActivityId(gate.ctx.client, id);
    if (!activityId) return NextResponse.json({ ok: false, error: "no_activity" }, { status: 404 });
    await gate.ctx.client.deleteSchedule(activityId);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return ccError(e);
  }
}
