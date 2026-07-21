/**
 * lib/integrations/kixie.ts — typed Kixie API client.
 *
 * Phase 1 of the TT + Kixie full embedding plan (2026-06-01). Server-only.
 *
 * Kixie API docs (multi-page): https://support.kixie.com/hc/en-us/sections/360008032094-Webhooks-and-API-Documents
 *
 * Two endpoint families:
 *
 *   POST https://apig.kixie.com/app/event
 *     — action endpoint for outbound: make a call (alley-oop), send SMS,
 *       send to queue, add to powerlist. Discriminator = `eventname`.
 *
 *   POST   https://apig.kixie.com/app/v1/api/postwebhook    — register webhook
 *   DELETE https://apig.kixie.com/app/v1/api/deleteWebhooks — remove webhook
 *
 * Auth: `apikey` + `businessid` in the JSON body. No header signing on
 * outbound. INBOUND webhooks (from Kixie -> us) carry X-Kixie-Signature
 * HMAC-SHA256 — see app/api/webhooks/kixie/route.ts for verification.
 *
 * Outbound calls are TWO-STAGE: Kixie rings the agent's phone first, then
 * upon pickup, bridges to the target number. The acting employee's email
 * (passed as `email`) determines which agent line rings — that's the
 * per-employee routing model.
 */

import "server-only";

import { getTenantIntegrationBundle } from "@/lib/tenant-integration-store";

const EVENT_ENDPOINT = "https://apig.kixie.com/app/event";
// NOTE (2026-07-21, verified live): the path is postWebhook with a CAPITAL W —
// Kixie's own docs say "postwebhook", which returns {"success":false,
// "error":"function does not exist"}. The gateway also dispatches on a
// `call` discriminator in the body (see registerWebhook).
const WEBHOOK_REGISTER_ENDPOINT = "https://apig.kixie.com/app/v1/api/postWebhook";
const WEBHOOK_DELETE_ENDPOINT = "https://apig.kixie.com/app/v1/api/deleteWebhooks";

// ---- Credential resolution ------------------------------------------------

export type KixieCredentials = {
  apiKey: string;
  businessId: string;
  /** Default agent email to ring when the caller doesn't specify one. */
  defaultAgentEmail?: string;
  /** Default sender number for SMS when not overridden per-send. */
  defaultFromNumber?: string;
};

export async function getKixieCredentials(
  tenantId: string,
): Promise<KixieCredentials> {
  const bundle = await getTenantIntegrationBundle(tenantId, "kixie");
  if (!bundle.api_key || !bundle.business_id) {
    throw new KixieError(
      "missing_credentials",
      "Kixie API key + business ID not on file. Wire in Settings → Integrations.",
      0,
    );
  }
  return {
    apiKey: bundle.api_key,
    businessId: bundle.business_id,
    defaultAgentEmail: bundle.default_agent_email || undefined,
    defaultFromNumber: bundle.from_number || undefined,
  };
}

// ---- Error shape ----------------------------------------------------------

export class KixieError extends Error {
  readonly code: string;
  readonly status: number;
  readonly response?: unknown;
  constructor(code: string, message: string, status: number, response?: unknown) {
    super(message);
    this.name = "KixieError";
    this.code = code;
    this.status = status;
    this.response = response;
  }
}

// ---- Core fetch wrapper ---------------------------------------------------

async function kixiePost<T>(
  endpoint: string,
  body: Record<string, unknown>,
): Promise<T> {
  let resp: Response;
  try {
    resp = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      cache: "no-store",
    });
  } catch (err) {
    throw new KixieError(
      "network_error",
      err instanceof Error ? err.message : "network failure",
      0,
    );
  }

  // Kixie sometimes returns text, sometimes JSON.
  const rawText = await resp.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    parsed = rawText;
  }

  if (!resp.ok) {
    const msg =
      (typeof parsed === "object" && parsed && (parsed as { message?: string }).message) ||
      (typeof parsed === "string" && parsed) ||
      `Kixie ${resp.status}`;
    throw new KixieError(`http_${resp.status}`, String(msg), resp.status, parsed);
  }
  return parsed as T;
}

// ---- Action API (POST /app/event) -----------------------------------------

export type MakeCallArgs = {
  /** Target phone in E.164 (e.g. +14165551212). */
  target: string;
  /** Acting employee's Kixie email — this device rings first. */
  agentEmail: string;
  /** Optional display name on the call card. */
  displayName?: string;
  /** Optional lead UUID echoed back via webhook customField1 for attribution. */
  leadId?: string;
};

/**
 * Initiate an outbound call using Kixie's "Make a Call" alley-oop pattern:
 *   1. Kixie rings the agent's phone (per `agentEmail`).
 *   2. Once the agent picks up, Kixie bridges to `target`.
 *
 * This is intentional: a human is in the loop before the prospect hears
 * anything, so no awkward dead-air. The `leadId` is echoed back on every
 * call-lifecycle webhook via `customField1` so we can attribute the call
 * to the right lead in lead_interactions.
 */
export function makeCall(
  creds: KixieCredentials,
  args: MakeCallArgs,
): Promise<unknown> {
  return kixiePost(EVENT_ENDPOINT, {
    apikey: creds.apiKey,
    businessid: creds.businessId,
    eventname: "call",
    email: args.agentEmail || creds.defaultAgentEmail,
    target: args.target,
    displayname: args.displayName || "Outbound call",
    ...(args.leadId ? { customField1: args.leadId } : {}),
  });
}

export type SendSmsArgs = {
  target: string;
  message: string;
  agentEmail: string;
  from?: string;
  leadId?: string;
};

/**
 * Send an SMS via Kixie. Attribution to the acting employee uses the
 * `email` parameter so the SMS appears under their account in Kixie's UI.
 */
export function sendSms(
  creds: KixieCredentials,
  args: SendSmsArgs,
): Promise<unknown> {
  return kixiePost(EVENT_ENDPOINT, {
    apikey: creds.apiKey,
    businessid: creds.businessId,
    eventname: "sms",
    email: args.agentEmail || creds.defaultAgentEmail,
    target: args.target,
    message: args.message,
    from: args.from || creds.defaultFromNumber,
    ...(args.leadId ? { customField1: args.leadId } : {}),
  });
}

/** Send a contact to the agent's call queue (power dialer flow). */
export function sendToQueue(
  creds: KixieCredentials,
  args: { target: string; agentEmail: string; leadId?: string },
): Promise<unknown> {
  return kixiePost(EVENT_ENDPOINT, {
    apikey: creds.apiKey,
    businessid: creds.businessId,
    eventname: "sendToQueue",
    email: args.agentEmail || creds.defaultAgentEmail,
    target: args.target,
    ...(args.leadId ? { customField1: args.leadId } : {}),
  });
}

/** Add a contact to a Kixie Powerlist (power-dial campaign queue). */
export function addToPowerlist(
  creds: KixieCredentials,
  args: {
    powerlistId: string;
    target: string;
    firstName?: string;
    lastName?: string;
    email?: string;
    leadId?: string;
  },
): Promise<unknown> {
  return kixiePost(EVENT_ENDPOINT, {
    apikey: creds.apiKey,
    businessid: creds.businessId,
    eventname: "addToPowerlist",
    powerlistid: args.powerlistId,
    target: args.target,
    fname: args.firstName,
    lname: args.lastName,
    email: args.email,
    ...(args.leadId ? { customField1: args.leadId } : {}),
  });
}

// ---- Webhook management ---------------------------------------------------

/**
 * Every webhook Kixie can fire — Kixie's REAL enum, verified live 2026-07-21
 * against getWebhooks. Kixie's docs (and this file's original list) were
 * wrong: the disposition event is "disposition" (not "dispositioncall"),
 * SMS is capital "SMS", and "dialattempt" does not exist.
 */
export const KIXIE_WEBHOOK_EVENTS = [
  "endcall",        // Call terminates (duration + recording)
  "startcall",      // Call begins (ring)
  "answeredcall",   // Call connected
  "SMS",            // Every SMS (inbound + outbound)
  "disposition",    // Agent set call outcome
  "voicemail",      // Voicemail dropped
  "scheduledactivity", // Calendar event
  "cisummary",      // Conversation Intelligence finished
] as const;

export type KixieWebhookEvent = typeof KIXIE_WEBHOOK_EVENTS[number];

/** Kixie replies HTTP 200 with {success:false,error} on failures — surface it. */
function assertKixieSuccess(parsed: unknown, context: string): unknown {
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    (parsed as { success?: boolean }).success === false
  ) {
    const err = (parsed as { error?: string }).error || "unknown kixie error";
    throw new KixieError("kixie_rejected", `${context}: ${err}`, 200, parsed);
  }
  return parsed;
}

export async function registerWebhook(
  creds: KixieCredentials,
  args: {
    eventName: KixieWebhookEvent;
    location: string;
    /**
     * Static headers Kixie attaches to every delivery, JSON-encoded STRING
     * per their API: '[{"name":"X-Kixie-Token","value":"..."}]'. This is the
     * webhook auth mechanism — Kixie does not HMAC-sign.
     */
    headersJson?: string;
  },
): Promise<unknown> {
  const parsed = await kixiePost(WEBHOOK_REGISTER_ENDPOINT, {
    apikey: creds.apiKey,
    businessid: creds.businessId,
    call: "postWebhook", // gateway dispatches on this, not just the URL path
    callresult: "all",
    direction: "all",
    disposition: "all",
    eventname: args.eventName,
    headers: args.headersJson ?? false,
    location: args.location,
    name: `oasis-dashboard-${args.eventName.toLowerCase()}`,
    runtime: "realtime",
  });
  return assertKixieSuccess(parsed, `register ${args.eventName}`);
}

/**
 * Delete a webhook by id. NOTE: the docs say call:"removeWebhook", but every
 * variant probed live on 2026-07-21 returned "function does not exist" — the
 * real function name is unverified. Kept per-docs; expect it may fail until
 * Kixie support confirms the name.
 */
export async function deleteWebhooks(
  creds: KixieCredentials,
  args: { webhookId: number },
): Promise<unknown> {
  const parsed = await kixiePost(WEBHOOK_DELETE_ENDPOINT, {
    apikey: creds.apiKey,
    businessid: creds.businessId,
    call: "removeWebhook",
    webhookid: args.webhookId,
  });
  return assertKixieSuccess(parsed, `delete webhook ${args.webhookId}`);
}

/**
 * Register every webhook event at the given URL. Used by the
 * "Register webhooks" Settings button + the auto-registration route.
 * Reports per-event success/failure so the UI can show a checklist.
 */
export async function registerAllWebhooks(
  creds: KixieCredentials,
  location: string,
  opts?: { headersJson?: string },
): Promise<Array<{ event: KixieWebhookEvent; ok: boolean; error?: string }>> {
  const results: Array<{ event: KixieWebhookEvent; ok: boolean; error?: string }> = [];
  for (const event of KIXIE_WEBHOOK_EVENTS) {
    try {
      await registerWebhook(creds, {
        eventName: event,
        location,
        headersJson: opts?.headersJson,
      });
      results.push({ event, ok: true });
    } catch (err) {
      results.push({
        event,
        ok: false,
        error: err instanceof Error ? err.message : "unknown",
      });
    }
  }
  return results;
}
