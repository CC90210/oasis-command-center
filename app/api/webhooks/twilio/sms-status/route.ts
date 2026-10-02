/**
 * POST /api/webhooks/twilio/sms-status - Twilio's delivery report for a text
 * OASIS sent (the StatusCallback sendSmsDirectTwilio sets, or a messaging
 * service's status callback).
 *
 * Public by path (middleware "/api/webhooks/"), authenticated INSIDE, exactly
 * like the inbound route next to it:
 *   1. The workspace is the one that owns the SENDING number or messaging
 *      service (`From` / `MessagingServiceSid`), resolved the same way as an
 *      incoming text's destination. Unknown: 403.
 *   2. X-Twilio-Signature is verified with THAT workspace's Auth Token (its own
 *      stored token; OASIS's deployment token for OASIS's own workspace only).
 *      No token (an API-key-only workspace), or a bad signature: 403.
 *   3. The AccountSid Twilio names must be that workspace's own account.
 * Then the carrier's verdict is written onto the matching outbound message of
 * that workspace only (lead_interactions, by Twilio's message SID). A final
 * verdict (delivered / undelivered / failed / read) is never overwritten by a
 * late "sent". Nothing is sent and no model is called.
 */
import { NextRequest, NextResponse } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { getTursoClient, tursoConfigured } from "@/lib/turso";
import { getTenantIntegrationBundle } from "@/lib/tenant-integration-store";
import {
  normalizedTwilioPhone,
  resolveTwilioInboundTenant,
  twilioInboundForbiddenResponse,
  verifyTwilioSignature,
} from "@/lib/sms/twilio-inbound";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Twilio's message statuses (Messaging API). Anything else is acknowledged and ignored. */
const KNOWN_STATUSES = new Set([
  "accepted",
  "scheduled",
  "queued",
  "sending",
  "sent",
  "delivered",
  "undelivered",
  "failed",
  "read",
  "canceled",
  "receiving",
  "received",
]);
const FINAL_STATUSES = ["delivered", "undelivered", "failed", "read", "canceled"] as const;

const ack = () => new NextResponse(null, { status: 204 });

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const params = new URLSearchParams(rawBody);
  const from = params.get("From") || "";
  const messagingServiceSid = params.get("MessagingServiceSid") || "";

  const resolved = await resolveTwilioInboundTenant(getServiceSupabase(), from, process.env, undefined, messagingServiceSid);
  if (!resolved) {
    console.error("[webhooks.twilio.sms-status] unmapped sender", { from_last4: normalizedTwilioPhone(from).slice(-4) });
    return twilioInboundForbiddenResponse();
  }
  const { tenantId } = resolved;
  const bundle = await getTenantIntegrationBundle(tenantId, "twilio");
  // The workspace's own Auth Token only: an API key secret cannot verify a
  // Twilio signature, and another workspace's token must never be tried.
  if (!verifyTwilioSignature(req.url, params, req.headers.get("x-twilio-signature"), bundle.auth_token || "")) {
    return twilioInboundForbiddenResponse();
  }
  const accountSid = (params.get("AccountSid") || "").trim();
  if (!accountSid || !bundle.account_sid || accountSid !== bundle.account_sid.trim()) {
    return twilioInboundForbiddenResponse();
  }

  const messageSid = (params.get("MessageSid") || params.get("SmsSid") || "").trim();
  const status = (params.get("MessageStatus") || params.get("SmsStatus") || "").trim().toLowerCase();
  if (!/^(SM|MM)[0-9a-fA-F]{32}$/.test(messageSid) || !KNOWN_STATUSES.has(status)) return ack();
  const errorCode = (params.get("ErrorCode") || "").trim();
  if (!tursoConfigured()) {
    console.error("[webhooks.twilio.sms-status] database not configured; delivery report dropped", { tenantId });
    return new NextResponse("Unavailable", { status: 503 });
  }

  const finals = FINAL_STATUSES.map(() => "?").join(", ");
  try {
    await getTursoClient().execute({
      sql: `UPDATE lead_interactions
               SET metadata = json_set(
                     CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END,
                     '$.delivery_status', ?,
                     '$.delivery_error_code', ?,
                     '$.delivery_status_at', ?)
             WHERE tenant_id = ?
               AND provider IN ('twilio', 'twilio_direct')
               AND provider_message_id = ?
               AND (? IN (${finals})
                    OR json_extract(CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END, '$.delivery_status') IS NULL
                    OR json_extract(CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END, '$.delivery_status') NOT IN (${finals}))`,
      args: [status, errorCode || null, new Date().toISOString(), tenantId, messageSid, status, ...FINAL_STATUSES, ...FINAL_STATUSES],
    });
  } catch (error) {
    // A report that did not land answers 500, so Twilio's debugger shows it.
    console.error("[webhooks.twilio.sms-status] delivery report write failed", {
      tenantId,
      error: error instanceof Error ? error.message : String(error),
    });
    return new NextResponse("Write failed", { status: 500 });
  }
  return ack();
}
