import "server-only";

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { hasTickedConsent } from "@/lib/consent/ledger";
import { normalizeConsentSubject } from "@/lib/consent/ledger-disclosure";
import { publishAgentEvent } from "@/lib/manifest/events";

export const TRANSACTIONAL_OUTBOX_SOURCE = "ai_audit_transactional";
export const TRANSACTIONAL_OUTBOX_PROVIDER = "oasis_transactional_outbox";

type Channel = "email" | "sms";

export type QueueChannelResult = {
  queued: boolean;
  interactionId?: string;
  reason?: string;
};

export type QueueAiAuditConfirmationResult = {
  email: QueueChannelResult;
  sms: QueueChannelResult;
};

function deliveryKey(tenantId: string, leadId: string, channel: Channel): string {
  return createHash("sha256")
    .update(`ai-audit-confirmation:v1:${tenantId}:${leadId}:${channel}`, "utf8")
    .digest("hex");
}

async function queueOne(input: {
  db: SupabaseClient;
  tenantId: string;
  leadId: string;
  formId: string;
  channel: Channel;
  destination: string;
  subject?: string;
  body: string;
  consentBasis: "requested_service" | "explicit_sms_consent";
}): Promise<QueueChannelResult> {
  const providerMessageId = deliveryKey(input.tenantId, input.leadId, input.channel);
  const now = new Date().toISOString();
  const row = {
    tenant_id: input.tenantId,
    lead_id: input.leadId,
    type: input.channel === "email" ? "email_queued" : "sms_queued",
    channel: input.channel,
    direction: "outbound",
    agent_source: TRANSACTIONAL_OUTBOX_SOURCE,
    provider: TRANSACTIONAL_OUTBOX_PROVIDER,
    provider_message_id: providerMessageId,
    subject: input.subject?.slice(0, 200) || null,
    content: input.body,
    content_preview: input.body.slice(0, 1024),
    to_email: input.channel === "email" ? input.destination : null,
    to_phone: input.channel === "sms" ? input.destination : null,
    metadata: {
      status: "queued",
      attempts: 0,
      next_attempt_at: now,
      max_attempts: 5,
      outbox_kind: "ai_audit_confirmation",
      form_id: input.formId,
      intent: "transactional",
      consent_basis: input.consentBasis,
      queued_at: now,
    },
  };

  const inserted = await input.db
    .from("lead_interactions")
    .upsert(row, {
      onConflict: "provider,provider_message_id",
      ignoreDuplicates: true,
    })
    .select("id");
  if (inserted.error) {
    console.error("[transactional-outbox] queue failed", {
      tenant_id: input.tenantId,
      lead_id: input.leadId,
      channel: input.channel,
      error: inserted.error.message,
    });
    return { queued: false, reason: `queue_failed: ${inserted.error.message}` };
  }

  const saved = await input.db
    .from("lead_interactions")
    .select("id, metadata")
    .eq("tenant_id", input.tenantId)
    .eq("lead_id", input.leadId)
    .eq("provider", TRANSACTIONAL_OUTBOX_PROVIDER)
    .eq("provider_message_id", providerMessageId)
    .maybeSingle();
  if (saved.error || !saved.data) {
    const reason = saved.error?.message || "queued_row_not_found";
    console.error("[transactional-outbox] queue readback failed", {
      tenant_id: input.tenantId,
      lead_id: input.leadId,
      channel: input.channel,
      error: reason,
    });
    return { queued: false, reason };
  }

  const savedRow = saved.data as { id: string; metadata?: { status?: string } | string | null };
  let metadata: { status?: string } | null | undefined;
  if (typeof savedRow.metadata === "string") {
    try {
      const parsed: unknown = JSON.parse(savedRow.metadata);
      metadata = parsed && typeof parsed === "object"
        ? parsed as { status?: string }
        : null;
    } catch {
      console.error("[transactional-outbox] queued row has invalid metadata", {
        tenant_id: input.tenantId,
        lead_id: input.leadId,
        interaction_id: savedRow.id,
      });
      return { queued: false, interactionId: savedRow.id, reason: "invalid_queue_metadata" };
    }
  } else {
    metadata = savedRow.metadata;
  }
  const status = metadata?.status;
  const created = Array.isArray(inserted.data) && inserted.data.length > 0;
  if (!created) {
    return {
      queued: false,
      interactionId: savedRow.id,
      reason: status === "sent" ? "already_sent" : status === "queued" ? "already_queued" : status,
    };
  }
  return { queued: true, interactionId: savedRow.id };
}

/**
 * Queue the AI-audit receipt through the single Python send_gateway chokepoint.
 * Email is the requested-service receipt. SMS is queued only when the durable
 * consent ledger authorises the exact number that will receive it.
 */
export async function queueAiAuditConfirmation(input: {
  db: SupabaseClient;
  tenantId: string;
  leadId: string;
  formId: string;
  email: unknown;
  phone: unknown;
  emailSubject: string;
  emailBody: string;
  smsBody: string;
}): Promise<QueueAiAuditConfirmationResult> {
  const email = normalizeConsentSubject("email", input.email);
  const phone = normalizeConsentSubject("sms", input.phone);

  const emailResult = email
    ? await queueOne({
        ...input,
        channel: "email",
        destination: email,
        subject: input.emailSubject,
        body: input.emailBody,
        consentBasis: "requested_service",
      })
    : { queued: false, reason: "no_usable_email" };

  let smsResult: QueueChannelResult = { queued: false, reason: "no_usable_phone" };
  if (phone) {
    const smsAllowed = await hasTickedConsent(input.db, {
      tenantId: input.tenantId,
      channel: "sms",
      destination: phone,
    });
    smsResult = smsAllowed
      ? await queueOne({
          ...input,
          channel: "sms",
          destination: phone,
          body: input.smsBody,
          consentBasis: "explicit_sms_consent",
        })
      : { queued: false, reason: "sms_consent_required" };
  }

  const queued = [emailResult, smsResult].filter((result) => result.queued && result.interactionId);
  for (const result of queued) {
    await publishAgentEvent({
      eventType: "BRAVO_TRANSACTIONAL_OUTBOUND_QUEUED",
      tenantId: input.tenantId,
      publisher: "dept:sales",
      targetAgent: "send_gateway",
      payload: {
        lead_id: input.leadId,
        interaction_id: result.interactionId,
        reason: "ai_audit_confirmation",
      },
    });
  }

  return { email: emailResult, sms: smsResult };
}
