/**
 * POST /api/leads/[id]/email — queue an outbound email to a lead from
 * the dashboard.
 *
 * The dashboard runs on Vercel and doesn't hold SMTP / Gmail OAuth
 * credentials directly — send_gateway.py on the operator's machine
 * does. So this endpoint QUEUES the send by inserting a
 * lead_interactions row with status='queued', and emits an
 * agent_events row of type BRAVO_OUTBOUND_QUEUED_FROM_DASHBOARD that
 * send_gateway listens for. The daemon picks up the row, performs the
 * actual SMTP send, then updates the row to status='sent' and POSTs
 * back to /api/outbound/log for the canonical audit trail.
 *
 * Until the daemon side is wired (Phase 3 of the drawer build), the
 * queued row at least preserves the operator's intent in the audit
 * log so nothing is lost — and it surfaces in the timeline panel as
 * "queued" so the operator can see it landed.
 *
 * Auth: session-cookie → tenant.
 * Body: { to_email: string, subject: string, body: string }
 */

import { NextResponse, type NextRequest } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { resolveSessionContext } from "@/lib/api-auth";
import { publishAgentEvent } from "@/lib/manifest/events";
import { dispatchLeadStageEvent } from "@/lib/lead-stage-dispatcher";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_SUBJECT = 200;
const MAX_BODY = 32_000;

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: leadId } = await ctx.params;
  if (!UUID_RE.test(leadId)) {
    return NextResponse.json({ ok: false, error: "invalid_lead_id" }, { status: 400 });
  }
  const sess = await resolveSessionContext();
  if (!sess.ok) {
    return NextResponse.json({ ok: false, error: sess.reason }, { status: 401 });
  }

  let body: { to_email?: unknown; subject?: unknown; body?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  const toEmail = typeof body.to_email === "string" ? body.to_email.trim() : "";
  const subject = typeof body.subject === "string" ? body.subject.trim() : "";
  const text = typeof body.body === "string" ? body.body : "";
  if (!EMAIL_RE.test(toEmail)) {
    return NextResponse.json({ ok: false, error: "invalid_email" }, { status: 400 });
  }
  if (!subject) {
    return NextResponse.json({ ok: false, error: "subject_required" }, { status: 400 });
  }
  if (!text.trim()) {
    return NextResponse.json({ ok: false, error: "body_required" }, { status: 400 });
  }

  const db = getServiceSupabase();
  const truncatedBody = text.slice(0, MAX_BODY);
  const truncatedSubject = subject.slice(0, MAX_SUBJECT);

  // Insert the queued interaction. send_gateway.py polls
  // lead_interactions WHERE status='queued' AND channel='email' and
  // performs the actual send + status update.
  const ins = await db
    .from("lead_interactions")
    .insert({
      tenant_id: sess.tenantId,
      lead_id: leadId,
      // type is NOT NULL — explicit. 'email_queued' distinguishes
      // dashboard-queued rows from daemon-sent rows ('email_sent')
      // so send_gateway can pick them up without re-sending the
      // existing 275 historical 'email_sent' rows.
      type: "email_queued",
      channel: "email",
      direction: "outbound",
      agent_source: "dashboard_drawer",
      subject: truncatedSubject,
      content: truncatedBody,
      content_preview: truncatedBody.slice(0, 1024),
      to_email: toEmail,
      metadata: {
        requested_by_profile_id: sess.profileId,
        requested_by_email: sess.email,
        status: "queued",
      },
    })
    .select("id, created_at")
    .single();
  if (ins.error) {
    return NextResponse.json({ ok: false, error: ins.error.message }, { status: 500 });
  }

  // Emit an agent_event so send_gateway's event-bus listener picks it
  // up immediately instead of waiting for its next poll cycle.
  // Failure to emit is non-fatal — the daemon's polling fallback will
  // still find the row. Uses the canonical publishAgentEvent helper so
  // the schema (correlation_id, publisher_agent, severity) is right.
  await publishAgentEvent({
    eventType: "BRAVO_OUTBOUND_QUEUED_FROM_DASHBOARD",
    tenantId: sess.tenantId,
    publisher: "dashboard",
    targetAgent: "send_gateway",
    payload: {
      lead_id: leadId,
      interaction_id: ins.data.id,
      channel: "email",
      to_email: toEmail,
    },
  });

  // Engine moves the lead forward through the sales motion. For SunBiz
  // that's imported → sent_application; for OASIS that's new_contact →
  // outreach. The dispatcher picks the right rules based on tenant.
  // Engine guards manual overrides so an operator-set stage isn't yanked.
  const stageEvent = await dispatchLeadStageEvent({
    type: "outbound_email_queued",
    tenantId: sess.tenantId,
    leadId,
  });

  return NextResponse.json({
    ok: true,
    interaction_id: ins.data.id,
    queued_at: ins.data.created_at,
    stage_bumped: stageEvent.fired ? stageEvent.to : null,
  });
}
