/**
 * Twilio's synchronous inbound front door. It verifies, persists, performs
 * deterministic carrier commands, and queues everything else; it never calls
 * an LLM or an outbound provider.
 *
 * Deliberate D4 policy: a STOP always suppresses immediately and also queues a
 * cancel_meeting proposal. The only inline reply is the STOP confirmation.
 */
import { NextRequest, NextResponse } from "next/server";
import { createHash, randomUUID } from "node:crypto";
import { isUniqueViolationError } from "@/lib/api-helpers";
import { releasePhoneSuppression, suppressPhoneNumber } from "@/lib/sms-opt-out";
import {
  HELP_RESPONSE,
  START_CONFIRMATION,
  STOP_CONFIRMATION,
} from "@/lib/sms/auto-responses";
import { getServiceSupabase } from "@/lib/supabase-server";
import { getTenantIntegrationBundle } from "@/lib/tenant-integration-store";
import { nudgeConversations } from "@/lib/realtime/conversations-nudge";
import { persistCanonicalLeadTouch } from "@/lib/leads/canonical-touch";
import { writeAgentAlert } from "@/lib/notify/agent-alert";
import {
  normalizedTwilioPhone,
  resolveTwilioInboundTenant,
  shouldHonorTwilioOptOut,
  twilioCarrierKeyword,
  twilioMessageResponse,
  verifyTwilioSignature,
} from "@/lib/sms/twilio-inbound";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Db = ReturnType<typeof getServiceSupabase>;

function xmlResponse(message?: string): NextResponse {
  return new NextResponse(twilioMessageResponse(message), {
    status: 200,
    headers: { "content-type": "text/xml; charset=utf-8" },
  });
}

async function findLeadByPhone(db: Db, tenantId: string, phoneLast10: string): Promise<string | null> {
  const lead = await db.from("tenant_records")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("entity_type", "lead")
    .filter("data->>phone", "ilike", `%${phoneLast10}%`)
    .limit(1);
  if (lead.error) throw new Error(`lead_lookup_failed:${lead.error.message}`);
  return ((lead.data || []) as Array<{ id?: string }>)[0]?.id || null;
}

async function completeDeterministicJob(db: Db, tenantId: string, jobId: string, action: string): Promise<void> {
  const now = new Date().toISOString();
  const updated = await db.from("sms_agent_jobs").update({
    status: "done",
    executed_action: action,
    completed_at: now,
    last_error: null,
  }).eq("tenant_id", tenantId).eq("id", jobId);
  if (updated.error) throw new Error(`sms_job_complete_failed:${updated.error.message}`);
}

export async function POST(req: NextRequest) {
  const startedAt = Date.now();
  const rawBody = await req.text();
  const params = new URLSearchParams(rawBody);
  const to = params.get("To") || "";
  const db = getServiceSupabase();
  const resolved = await resolveTwilioInboundTenant(db, to);
  if (!resolved) {
    console.error("[webhooks.twilio.sms-inbound] unmapped destination", {
      to_last4: normalizedTwilioPhone(to).slice(-4),
    });
    return new NextResponse("Unmapped destination", { status: 422 });
  }
  const { tenantId, ownerUserId } = resolved;
  const bundle = await getTenantIntegrationBundle(tenantId, "twilio");
  const authToken = bundle.auth_token || process.env.TWILIO_AUTH_TOKEN || "";
  if (!verifyTwilioSignature(req.url, params, req.headers.get("x-twilio-signature"), authToken)) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  const from = params.get("From") || "";
  const body = params.get("Body") || "";
  const phoneLast10 = normalizedTwilioPhone(from).slice(-10);
  if (phoneLast10.length !== 10) return new NextResponse("Invalid sender", { status: 400 });
  const messageSid = params.get("MessageSid") || params.get("SmsMessageSid") || "";
  const providerMessageId = messageSid || `twilio-fp:${createHash("sha256").update(rawBody).digest("hex")}`;
  let leadId: string | null;
  try {
    leadId = await findLeadByPhone(db, tenantId, phoneLast10);
  } catch (error) {
    console.error("[webhooks.twilio.sms-inbound] lead lookup failed", error);
    return new NextResponse("Lead lookup failed", { status: 503 });
  }

  const optOut = shouldHonorTwilioOptOut(body);
  const keyword = optOut ? "stop" : twilioCarrierKeyword(body);
  const jobId = randomUUID();
  const interactionId = randomUUID();
  const receivedAt = new Date().toISOString();
  const insertedJob = await db.from("sms_agent_jobs").insert({
    id: jobId,
    tenant_id: tenantId,
    provider: "twilio",
    provider_message_id: providerMessageId,
    from_phone: from,
    to_phone: to,
    phone_last10: phoneLast10,
    body,
    lead_id: leadId,
    appointment_id: null,
    interaction_id: interactionId,
    status: "pending",
    intent: keyword === "stop" ? "opt_out" : keyword === "help" ? "question" : keyword === "start" ? "unknown" : null,
    intent_confidence: keyword ? "high" : null,
    intent_source: keyword ? "rules" : "none",
    proposed_action: keyword === "stop" ? "cancel_meeting" : null,
    attempts: 0,
    received_at: receivedAt,
  });
  if (insertedJob.error) {
    if (isUniqueViolationError(insertedJob.error)) return xmlResponse();
    console.error("[webhooks.twilio.sms-inbound] job enqueue failed", insertedJob.error.message);
    return new NextResponse("Queue failed", { status: 500 });
  }

  const interaction = await db.from("lead_interactions").insert({
    id: interactionId,
    tenant_id: tenantId,
    lead_id: leadId,
    type: "sms_received",
    channel: "sms",
    direction: "inbound",
    agent_source: "twilio",
    provider: "twilio",
    provider_message_id: providerMessageId,
    from_phone: from,
    to_phone: to,
    content: body,
    content_preview: body.slice(0, 1024),
    actor_user_id: ownerUserId,
    created_at: receivedAt,
    metadata: {
      provider: "twilio",
      message_sid: messageSid || null,
      account_sid: params.get("AccountSid") || null,
      opt_out_detected: optOut,
      sms_agent_job_id: jobId,
    },
  });
  if (interaction.error) {
    console.error("[webhooks.twilio.sms-inbound] persistence failed", interaction.error.message);
    return new NextResponse("Persistence failed", { status: 500 });
  }

  if (leadId) {
    try {
      await persistCanonicalLeadTouch(db, { tenantId, leadId, occurredAt: receivedAt });
    } catch (error) {
      console.error("[webhooks.twilio.sms-inbound] canonical touch failed", error);
      return new NextResponse("Touch persistence failed", { status: 500 });
    }
  }

  try {
    if (keyword === "stop") {
      await suppressPhoneNumber(db, {
        tenantId,
        phone: from,
        reason: "OPT_OUT",
        source: "twilio_webhook",
      });
      const cancelled = await db.from("website_sales_meeting_notifications").update({
        status: "cancelled",
        claimed_at: null,
        last_error: "recipient_opted_out",
        updated_at: receivedAt,
      }).eq("tenant_id", tenantId)
        .eq("channel", "sms")
        .eq("recipient", from)
        .in("status", ["pending", "sending"]);
      if (cancelled.error) throw new Error(`sms_outbox_cancel_failed:${cancelled.error.message}`);
      await writeAgentAlert({
        tenantId,
        alertType: "sms_agent_cancel_requested",
        severity: "warn",
        title: "Client opted out and requested meeting review",
        body: "SMS was suppressed immediately. A cancel-meeting job is queued for the assigned rep.",
        lane: "operator",
        subjectType: "sms_agent_job",
        subjectId: jobId,
        payload: { job_id: jobId, lead_id: leadId },
        telegram: false,
      });
    } else if (keyword === "start") {
      await releasePhoneSuppression(db, {
        tenantId,
        phone: from,
        source: "twilio_webhook",
        leadId,
      });
      await completeDeterministicJob(db, tenantId, jobId, "release_suppression");
    } else if (keyword === "help") {
      await completeDeterministicJob(db, tenantId, jobId, "reply_help");
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : "deterministic_sms_action_failed";
    console.error("[webhooks.twilio.sms-inbound] deterministic action failed", detail);
    await db.from("sms_agent_jobs").update({ last_error: detail.slice(0, 500) })
      .eq("tenant_id", tenantId).eq("id", jobId);
    return new NextResponse("Action failed", { status: 503 });
  }

  await nudgeConversations(tenantId);
  const elapsedMs = Date.now() - startedAt;
  if (elapsedMs >= 2_000) {
    console.warn("[webhooks.twilio.sms-inbound] latency budget exceeded", { elapsed_ms: elapsedMs });
  }
  if (keyword === "stop") return xmlResponse(STOP_CONFIRMATION);
  if (keyword === "help") return xmlResponse(HELP_RESPONSE);
  if (keyword === "start") return xmlResponse(START_CONFIRMATION);
  return xmlResponse();
}
