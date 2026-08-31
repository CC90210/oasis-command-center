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
import { persistCanonicalLeadTouch } from "@/lib/leads/canonical-touch";
import {
  normalizedTwilioPhone,
  pendingTwilioCarrierAction,
  resolveTwilioInboundTenant,
  shouldHonorTwilioOptOut,
  TWILIO_SYNC_DB_OPERATION_BUDGET,
  twilioCarrierKeyword,
  twilioCarrierReplyForDelivery,
  twilioMessageResponse,
  verifyTwilioSignature,
} from "@/lib/sms/twilio-inbound";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Db = ReturnType<typeof getServiceSupabase>;

class SyncOperationBudget {
  private used = 0;

  consume(count = 1): void {
    if (this.used + count > TWILIO_SYNC_DB_OPERATION_BUDGET) {
      throw new Error("twilio_sync_db_operation_budget_exceeded");
    }
    this.used += count;
  }
}

type InboundJob = {
  id: string;
  from_phone: string;
  to_phone: string;
  body: string;
  lead_id: string | null;
  interaction_id: string;
  intent: string | null;
  proposed_action: string | null;
  executed_action: string | null;
  received_at: string;
};

function xmlResponse(message?: string): NextResponse {
  return new NextResponse(twilioMessageResponse(message), {
    status: 200,
    headers: { "content-type": "text/xml; charset=utf-8" },
  });
}

async function findLeadByPhone(
  db: Db,
  tenantId: string,
  phoneLast10: string,
  budget: SyncOperationBudget,
): Promise<string | null> {
  budget.consume();
  const lead = await db.from("tenant_records")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("entity_type", "lead")
    .filter("data->>phone", "ilike", `%${phoneLast10}%`)
    .order("id", { ascending: true })
    .limit(1);
  if (lead.error) throw new Error(`lead_lookup_failed:${lead.error.message}`);
  return ((lead.data || []) as Array<{ id?: string }>)[0]?.id || null;
}

async function loadExistingJob(
  db: Db,
  tenantId: string,
  providerMessageId: string,
  budget: SyncOperationBudget,
): Promise<InboundJob> {
  budget.consume();
  const existing = await db.from("sms_agent_jobs")
    .select("id,from_phone,to_phone,body,lead_id,interaction_id,intent,proposed_action,executed_action,received_at")
    .eq("tenant_id", tenantId)
    .eq("provider", "twilio")
    .eq("provider_message_id", providerMessageId)
    .maybeSingle();
  if (existing.error || !existing.data) {
    throw new Error(`sms_job_replay_lookup_failed:${existing.error?.message || "missing_job"}`);
  }
  const job = existing.data as Partial<InboundJob>;
  if (typeof job.interaction_id !== "string" || !job.interaction_id) {
    throw new Error("sms_job_replay_lookup_failed:missing_interaction_id");
  }
  if (typeof job.received_at !== "string" || !Number.isFinite(Date.parse(job.received_at))) {
    throw new Error("sms_job_replay_lookup_failed:invalid_received_at");
  }
  return job as InboundJob;
}

function assertSameDelivery(job: InboundJob, input: { from: string; to: string; body: string }): void {
  if (
    job.from_phone !== input.from ||
    job.to_phone !== input.to ||
    job.body !== input.body
  ) throw new Error("provider_message_id_payload_mismatch");
}

async function ensureInboundInteraction(
  db: Db,
  input: {
    tenantId: string;
    ownerUserId: string | null;
    providerMessageId: string;
    messageSid: string;
    accountSid: string | null;
    optOut: boolean;
    receivedAt: string;
    job: InboundJob;
    budget: SyncOperationBudget;
  },
): Promise<void> {
  input.budget.consume();
  const inserted = await db.from("lead_interactions").insert({
    id: input.job.interaction_id,
    tenant_id: input.tenantId,
    lead_id: input.job.lead_id,
    type: "sms_received",
    channel: "sms",
    direction: "inbound",
    agent_source: "twilio",
    provider: "twilio",
    provider_message_id: input.providerMessageId,
    from_phone: input.job.from_phone,
    to_phone: input.job.to_phone,
    content: input.job.body,
    content_preview: input.job.body.slice(0, 1024),
    actor_user_id: input.ownerUserId,
    created_at: input.receivedAt,
    metadata: {
      provider: "twilio",
      message_sid: input.messageSid || null,
      account_sid: input.accountSid,
      opt_out_detected: input.optOut,
      sms_agent_job_id: input.job.id,
    },
  });
  if (!inserted.error) return;
  if (!isUniqueViolationError(inserted.error)) {
    throw new Error(`interaction_write_failed:${inserted.error.message}`);
  }
  input.budget.consume();
  const existing = await db.from("lead_interactions")
    .select("id")
    .eq("tenant_id", input.tenantId)
    .eq("provider", "twilio")
    .eq("provider_message_id", input.providerMessageId)
    .maybeSingle();
  const existingId = (existing.data as { id?: string } | null)?.id;
  if (existing.error || !existingId) {
    throw new Error(`interaction_replay_verify_failed:${existing.error?.message || "missing_interaction"}`);
  }
  if (existingId !== input.job.interaction_id) {
    input.budget.consume();
    const linked = await db.from("sms_agent_jobs")
      .update({ interaction_id: existingId })
      .eq("tenant_id", input.tenantId)
      .eq("id", input.job.id);
    if (linked.error) throw new Error(`interaction_replay_link_failed:${linked.error.message}`);
    input.job.interaction_id = existingId;
  }
}

async function markCarrierAction(
  db: Db,
  tenantId: string,
  jobId: string,
  action: "suppress_and_cancel_sms" | "release_suppression" | "reply_help",
  budget: SyncOperationBudget,
): Promise<void> {
  const now = new Date().toISOString();
  const patch = action !== "suppress_and_cancel_sms"
    ? { status: "done", executed_action: action, completed_at: now, last_error: null }
    : { executed_action: action, last_error: null };
  budget.consume();
  const updated = await db.from("sms_agent_jobs").update(patch)
    .eq("tenant_id", tenantId)
    .eq("id", jobId);
  if (updated.error) throw new Error(`sms_job_complete_failed:${updated.error.message}`);
}

async function runStopComplianceEffects(
  db: Db,
  tenantId: string,
  job: InboundJob,
  budget: SyncOperationBudget,
): Promise<void> {
  budget.consume();
  await suppressPhoneNumber(db, {
    tenantId,
    phone: job.from_phone,
    reason: "OPT_OUT",
    source: "twilio_webhook",
  });
  budget.consume();
  const cancelled = await db.from("website_sales_meeting_notifications").update({
    status: "cancelled",
    claimed_at: null,
    last_error: "recipient_opted_out",
    updated_at: job.received_at,
  }).eq("tenant_id", tenantId)
    .eq("channel", "sms")
    .eq("recipient", job.from_phone)
    .in("status", ["pending", "sending"]);
  if (cancelled.error) throw new Error(`sms_outbox_cancel_failed:${cancelled.error.message}`);
}

async function runPendingCarrierAction(
  db: Db,
  tenantId: string,
  job: InboundJob,
  budget: SyncOperationBudget,
): Promise<"start" | "help" | null> {
  const action = pendingTwilioCarrierAction(job);
  if (action === "stop") throw new Error("stop_requires_compliance_first_ordering");
  if (action === "start") {
    budget.consume(2);
    await releasePhoneSuppression(db, {
      tenantId,
      phone: job.from_phone,
      source: "twilio_webhook",
      leadId: job.lead_id,
    });
    await markCarrierAction(db, tenantId, job.id, "release_suppression", budget);
  } else if (action === "help") {
    await markCarrierAction(db, tenantId, job.id, "reply_help", budget);
  }
  return action;
}

export async function POST(req: NextRequest) {
  const startedAt = Date.now();
  const budget = new SyncOperationBudget();
  const rawBody = await req.text();
  const params = new URLSearchParams(rawBody);
  const to = params.get("To") || "";
  const db = getServiceSupabase();
  const resolved = await resolveTwilioInboundTenant(db, to, process.env, () => budget.consume());
  if (!resolved) {
    console.error("[webhooks.twilio.sms-inbound] unmapped destination", {
      to_last4: normalizedTwilioPhone(to).slice(-4),
    });
    return new NextResponse("Unmapped destination", { status: 422 });
  }
  const { tenantId, ownerUserId } = resolved;
  budget.consume();
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
    leadId = await findLeadByPhone(db, tenantId, phoneLast10, budget);
  } catch (error) {
    console.error("[webhooks.twilio.sms-inbound] lead lookup failed", error);
    return new NextResponse("Lead lookup failed", { status: 503 });
  }
  const optOut = shouldHonorTwilioOptOut(body);
  const keyword = optOut ? "stop" : twilioCarrierKeyword(body);
  const jobId = randomUUID();
  const interactionId = randomUUID();
  const receivedAt = new Date().toISOString();
  const proposedAction = keyword === "stop"
    ? "cancel_meeting"
    : keyword === "start"
      ? "release_suppression"
      : keyword === "help"
        ? "reply_help"
        : null;
  const intent = keyword === "stop"
    ? "opt_out"
    : keyword === "help"
      ? "question"
      : keyword === "start"
        ? "unknown"
        : null;
  budget.consume();
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
    intent,
    intent_confidence: keyword ? "high" : null,
    intent_source: keyword ? "rules" : "none",
    proposed_action: proposedAction,
    executed_action: null,
    attempts: 0,
    received_at: receivedAt,
    completed_at: null,
  });
  let job: InboundJob;
  let deliveryWasDuplicate = false;
  if (insertedJob.error) {
    try {
      if (!isUniqueViolationError(insertedJob.error)) {
        console.error("[webhooks.twilio.sms-inbound] job enqueue failed", insertedJob.error.message);
        return new NextResponse("Queue failed", { status: 500 });
      }
      deliveryWasDuplicate = true;
      job = await loadExistingJob(db, tenantId, providerMessageId, budget);
      assertSameDelivery(job, { from, to, body });
    } catch (error) {
      console.error("[webhooks.twilio.sms-inbound] replay recovery failed", error);
      return new NextResponse("Replay recovery failed", { status: 500 });
    }
  } else {
    job = {
      id: jobId,
      from_phone: from,
      to_phone: to,
      body,
      lead_id: leadId,
      interaction_id: interactionId,
      intent,
      proposed_action: proposedAction,
      executed_action: null,
      received_at: receivedAt,
    };
  }

  try {
    await ensureInboundInteraction(db, {
      tenantId,
      ownerUserId,
      providerMessageId,
      messageSid,
      accountSid: params.get("AccountSid"),
      optOut: job.intent === "opt_out",
      receivedAt: job.received_at,
      job,
      budget,
    });
  } catch (error) {
    console.error("[webhooks.twilio.sms-inbound] interaction persistence failed", error);
    return new NextResponse("Persistence failed", { status: 500 });
  }

  let resumedAction = pendingTwilioCarrierAction(job);
  if (resumedAction === "stop") {
    try {
      await runStopComplianceEffects(db, tenantId, job, budget);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "deterministic_sms_action_failed";
      console.error("[webhooks.twilio.sms-inbound] STOP compliance action failed", detail);
      budget.consume();
      await db.from("sms_agent_jobs").update({ last_error: detail.slice(0, 500) })
        .eq("tenant_id", tenantId).eq("id", job.id);
      return new NextResponse("Action failed", { status: 503 });
    }
  }

  if (job.lead_id) {
    try {
      budget.consume();
      await persistCanonicalLeadTouch(db, { tenantId, leadId: job.lead_id, occurredAt: job.received_at });
    } catch (error) {
      console.error("[webhooks.twilio.sms-inbound] canonical touch failed", error);
      return new NextResponse("Touch persistence failed", { status: 500 });
    }
  }

  try {
    if (resumedAction === "stop") {
      await markCarrierAction(db, tenantId, job.id, "suppress_and_cancel_sms", budget);
    } else {
      resumedAction = await runPendingCarrierAction(db, tenantId, job, budget);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : "deterministic_sms_action_failed";
    console.error("[webhooks.twilio.sms-inbound] deterministic action failed", detail);
    budget.consume();
    await db.from("sms_agent_jobs").update({ last_error: detail.slice(0, 500) })
      .eq("tenant_id", tenantId).eq("id", job.id);
    return new NextResponse("Action failed", { status: 503 });
  }

  const elapsedMs = Date.now() - startedAt;
  if (elapsedMs >= 2_000) {
    console.warn("[webhooks.twilio.sms-inbound] latency budget exceeded", { elapsed_ms: elapsedMs });
  }
  const carrierReply = twilioCarrierReplyForDelivery(job, {
    duplicate: deliveryWasDuplicate,
    resumedAction,
  });
  if (carrierReply === "stop") return xmlResponse(STOP_CONFIRMATION);
  if (carrierReply === "help") return xmlResponse(HELP_RESPONSE);
  if (carrierReply === "start") return xmlResponse(START_CONFIRMATION);
  return xmlResponse();
}
