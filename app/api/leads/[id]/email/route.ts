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
// Generous bound for the synchronous auto-dispatch below — one SMTP
// send through send_gateway takes 1-3s + the round-trip through the
// bridge proxy. 60s gives comfortable headroom for slow upstream SMTP.
export const maxDuration = 60;

/**
 * Auto-fire the email via the bridge `send_email` tool. Parallel to the
 * shop-out auto-trigger (commit 4957702): on the SunBiz VPS the
 * dashboard-email-consumer daemon is IS_WIN-gated in ecosystem.config.js,
 * so queued lead-emails sit at metadata.status='queued' forever for
 * Ezra/Jordan/Alex unless an owner/admin triggers them. This auto-trigger
 * closes that gap for owner/admin roles (members fall back to the queue —
 * /api/bridge/exec-tool's role gate rejects write tools for non-admin).
 *
 * Failure modes (best-effort): timeout / bridge offline / role denied →
 * row stays at status='queued', operator can retry or wait for the
 * daemon. Never blocks the queue confirmation.
 */
async function triggerImmediateSend(
  req: NextRequest,
  args: {
    to: string;
    subject: string;
    body: string;
    leadId: string;
    brand?: string;
  },
): Promise<
  | { status: "sent"; agent_source?: string }
  | { status: "queued"; reason: string }
> {
  try {
    const url = new URL("/api/bridge/exec-tool", req.url);
    const cookie = req.headers.get("cookie") || "";
    const sendRes = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        tool_name: "send_email",
        to: args.to,
        subject: args.subject,
        body: args.body,
        lead_id: args.leadId,
        brand: args.brand,
        intent: "transactional",
      }),
      signal: AbortSignal.timeout(50_000),
    });
    if (!sendRes.ok) {
      const txt = await sendRes.text();
      return { status: "queued", reason: `exec-tool HTTP ${sendRes.status}: ${txt.slice(0, 120)}` };
    }
    const sendData = await sendRes.json();
    if (sendData?.is_error) {
      return { status: "queued", reason: String(sendData?.output || "bridge tool is_error=true").slice(0, 240) };
    }
    // _tool_send_email passes through _run_script which returns the
    // send_gateway --json blob in `output`. Status="sent" means the gate
    // walked AND the SMTP fired.
    try {
      const parsed = JSON.parse(sendData?.output || "{}");
      if (parsed?.status === "sent") {
        return { status: "sent", agent_source: "manual_cc" };
      }
      return {
        status: "queued",
        reason: `send_gateway status=${parsed?.status || "unknown"}: ${parsed?.reason || ""}`.slice(0, 240),
      };
    } catch {
      return { status: "queued", reason: "bridge tool returned non-JSON output" };
    }
  } catch (e) {
    return {
      status: "queued",
      reason: e instanceof Error ? e.message : "auto-trigger threw unknown error",
    };
  }
}

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
      // Canonical "who queued this" — companion to migration 078.
      // metadata.acted_by_user_id retained for the consumer daemon
      // which already reads from it.
      actor_user_id: sess.userId,
      subject: truncatedSubject,
      content: truncatedBody,
      content_preview: truncatedBody.slice(0, 1024),
      to_email: toEmail,
      metadata: {
        requested_by_profile_id: sess.profileId,
        requested_by_email: sess.email,
        // Phase 4 SunBiz multi-employee personalization: the consumer
        // daemon reads acted_by_user_id and, if the user has connected
        // their personal Gmail via Settings → Personal, sends from
        // THEIR address instead of the tenant-shared submissions@.
        acted_by_user_id: sess.userId,
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

  // Resolve tenant slug → brand for the auto-trigger. send_gateway
  // defaults to OASIS brand if unset, which would ship a SunBiz lead
  // email under the wrong identity. One extra lookup; cheap.
  const tenantRes = await db
    .from("tenants")
    .select("slug")
    .eq("id", sess.tenantId)
    .maybeSingle();
  const tenantSlug = (tenantRes.data as { slug: string } | null)?.slug || "";
  const brand =
    tenantSlug === "submissions" ? "sunbiz" : tenantSlug ? "oasis" : undefined;

  // Auto-fire the send via the bridge. Best-effort: on failure the row
  // stays at metadata.status='queued' and the daemon (when running) or
  // the operator can retry.
  const sendResult = await triggerImmediateSend(req, {
    to: toEmail,
    subject: truncatedSubject,
    body: truncatedBody,
    leadId,
    brand,
  });

  // If the send actually fired, flip the queued row to 'auto_sent' so
  // the timeline reflects reality and the daemon doesn't double-send.
  // Failure to update is non-fatal — the row content is still accurate
  // (just the status flag drifts; daemon's idempotency key prevents
  // double-send).
  if (sendResult.status === "sent") {
    await db
      .from("lead_interactions")
      .update({
        metadata: {
          requested_by_profile_id: sess.profileId,
          requested_by_email: sess.email,
          acted_by_user_id: sess.userId,
          status: "auto_sent",
          auto_sent_via: sendResult.agent_source,
          auto_sent_at: new Date().toISOString(),
        },
      })
      .eq("id", ins.data.id)
      .eq("tenant_id", sess.tenantId);
  }

  return NextResponse.json({
    ok: true,
    interaction_id: ins.data.id,
    queued_at: ins.data.created_at,
    stage_bumped: stageEvent.fired ? stageEvent.to : null,
    // Real send outcome — UI uses this to render "Sent" vs "Queued
    // (retrying)" vs the explicit error reason.
    send_status: sendResult,
  });
}
