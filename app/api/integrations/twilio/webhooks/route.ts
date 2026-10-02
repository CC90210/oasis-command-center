/**
 * /api/integrations/twilio/webhooks - the two URLs a workspace's own Twilio
 * account calls OASIS on, and the explicit "set them on my number" action.
 *
 *   GET   the incoming-texts URL and the delivery-updates URL (OASIS's public
 *         origin, never a request header), the saved sender, and whether OASIS
 *         can verify incoming texts (only with the Auth Token). No Twilio call.
 *   POST  points the saved sender at those URLs through Twilio's API
 *         (lib/twilio/connection.ts pointTwilioWebhooksAtOasis): a number's
 *         incoming-message URL, or a messaging service's incoming URL and
 *         status callback. Only on this click, never automatically, and audited.
 *
 * Owner/admin only (the Connections gate). The account is the session
 * workspace's own: its stored keys, or OASIS's deployment keys for OASIS's own
 * workspace only (getTenantIntegrationBundle). No response carries a key.
 */
import { NextResponse } from "next/server";
import { resolveConnectionsActor, routeFailure } from "@/lib/connections/route-helpers";
import { getTenantIntegrationBundle } from "@/lib/tenant-integration-store";
import { publicAppBaseUrl } from "@/lib/api-helpers";
import { logTenantAudit } from "@/lib/audit/activity-feed";
import {
  pointTwilioWebhooksAtOasis,
  twilioInboundVerifiable,
  twilioSenderOf,
  type TwilioWebhookResult,
} from "@/lib/twilio/connection";
import { twilioWebhookUrls } from "@/lib/twilio/shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const json = (status: number, body: Record<string, unknown>) =>
  NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });

const FAILURE_STATUS: Record<Extract<TwilioWebhookResult, { ok: false }>["error"], number> = {
  incomplete: 409,
  auth_token_required: 409,
  needs_number: 409,
  number_lacks_sms: 409,
  messaging_service_not_found: 404,
  credentials_rejected: 422,
  account_inactive: 409,
  unreachable: 502,
  connected: 500,
};

export async function GET() {
  try {
    const resolved = await resolveConnectionsActor();
    if (!resolved.ok) return resolved.response;
    const bundle = await getTenantIntegrationBundle(resolved.actor.tenantId, "twilio");
    const urls = twilioWebhookUrls(publicAppBaseUrl());
    const sender = twilioSenderOf(bundle);
    return json(200, {
      ok: true,
      inbound_url: urls.inbound,
      status_url: urls.status,
      sender: sender ? (sender.kind === "number" ? { kind: "number", label: sender.number } : { kind: "messaging_service", label: sender.sid }) : null,
      inbound_verifiable: twilioInboundVerifiable(bundle),
    });
  } catch (error) {
    return routeFailure("api/integrations/twilio/webhooks GET", error);
  }
}

export async function POST() {
  try {
    const resolved = await resolveConnectionsActor();
    if (!resolved.ok) return resolved.response;
    const { actor } = resolved;
    const bundle = await getTenantIntegrationBundle(actor.tenantId, "twilio");
    const urls = twilioWebhookUrls(publicAppBaseUrl());
    const result = await pointTwilioWebhooksAtOasis(bundle, urls);
    if (!result.ok) return json(FAILURE_STATUS[result.error] ?? 409, { ok: false, error: result.error, message: result.message });
    const audit = await logTenantAudit({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      actorEmail: actor.email,
      actionType: "twilio.webhooks_set",
      targetTable: "tenant_integration_credentials",
      targetId: null,
      after: { target: result.target, sender: result.label, inbound_url: urls.inbound, status_url: urls.status },
    });
    if (!audit.ok) console.error("[twilio.webhooks] audit write failed", { tenantId: actor.tenantId, error: audit.error });
    return json(200, { ok: true, target: result.target, label: result.label, message: result.message });
  } catch (error) {
    return routeFailure("api/integrations/twilio/webhooks POST", error);
  }
}
