/**
 * lib/sms-direct-twilio.ts — direct Twilio Messages API dispatch.
 *
 * The PRIMARY SMS path runs through `dispatchSmsThroughClientAgent`
 * (lib/client-agent.ts) which hands off to a hosted client-agent
 * HTTP endpoint. That model fits multi-tenant SaaS deployments where
 * each client has their own Twilio sub-account behind a managed
 * gateway.
 *
 * For SunBiz and other tenants that pasted their own Twilio creds
 * into Settings → Integration Keys, we skip the indirection and call
 * the Twilio REST API directly using the per-tenant stored values.
 * This is the consumer-side payoff for the
 * tenant_integration_credentials work — credentials live in the DB,
 * the dashboard reads them, sends land on the lead's phone.
 *
 * Reads creds via getTenantIntegrationBundle (DB-first, env fallback)
 * so a fresh tenant with no env vars + a pasted (sid, token, from)
 * just works. No env config required.
 *
 * ── Per-tenant direct-dispatch template ───────────────────────────
 * This module is the prototype for any future per-service direct
 * dispatcher (email-direct-smtp, email-direct-gmail, push-direct-
 * apns, etc.). New dispatchers should follow the same shape so the
 * route-side logic stays uniform:
 *
 *   1. Named result types:
 *        Result =
 *          | { ok: true;  provider: "<name>"; ...providerFields }
 *          | { ok: false; provider: "<name>"; error: string; http_status }
 *
 *   2. `tenantHas<Service>(tenantId): Promise<boolean>` —
 *      returns true when getTenantIntegrationBundle resolves the
 *      minimum required field set. Route-side gate: "try direct
 *      first?".
 *
 *   3. `send<Service>({tenantId, ...payload}): Promise<Result>` —
 *      fetches the bundle, calls the provider's HTTP API, returns
 *      a typed Result. NEVER throws on network errors; returns
 *      `{ok: false, error, http_status}` so the route can decide
 *      to fall through to a hosted gateway path.
 *
 *   4. Cred resolution lives ONLY in getTenantIntegrationBundle.
 *      No `process.env.*` reads in dispatcher modules — that path
 *      goes through the store so ENV_FALLBACKS stays the single
 *      authority on which envs are honored.
 * ──────────────────────────────────────────────────────────────────
 */

import "server-only";
import { getTenantIntegrationBundle } from "./tenant-integration-store";
import { checkPhoneOptOut } from "./lead-interactions-queries";

export type DirectTwilioResult =
  | {
      ok: true;
      provider: "twilio_direct";
      message_sid: string;
      status: string;
    }
  | {
      ok: false;
      provider: "twilio_direct";
      error: string;
      http_status: number;
    };

export type TwilioCredentialBundle = {
  account_sid?: string;
  auth_token?: string;
  from_number?: string;
  messaging_service_sid?: string;
};

export function twilioCredentialsReady(bundle: TwilioCredentialBundle): boolean {
  return Boolean(
    bundle.account_sid &&
    bundle.auth_token &&
    (bundle.messaging_service_sid || bundle.from_number),
  );
}

export function buildTwilioMessageForm(
  bundle: TwilioCredentialBundle,
  input: { to: string; body: string },
): URLSearchParams {
  const form = new URLSearchParams();
  form.set("To", input.to);
  if (bundle.messaging_service_sid) {
    form.set("MessagingServiceSid", bundle.messaging_service_sid);
  } else if (bundle.from_number) {
    form.set("From", bundle.from_number);
  }
  form.set("Body", input.body);
  return form;
}

/**
 * Returns true when the tenant has the minimum set of Twilio creds
 * (account_sid + auth_token + from_number) to dispatch via the
 * direct path. The route uses this to decide whether to try
 * direct dispatch before falling through to the hosted-agent path.
 */
export async function tenantHasDirectTwilio(tenantId: string): Promise<boolean> {
  const b = await getTenantIntegrationBundle(tenantId, "twilio");
  return twilioCredentialsReady(b);
}

export async function sendSmsDirectTwilio(input: {
  tenantId: string;
  to: string;
  body: string;
}): Promise<DirectTwilioResult> {
  // Opt-out gate — this direct path bypasses send_gateway's suppression, so
  // re-check and FAIL CLOSED before dispatch (channel is gated off today but
  // must ship safe when enabled). CASL/TCPA. [[fail-closed-default]]
  const optOut = await checkPhoneOptOut(input.tenantId, input.to);
  if (optOut.optedOut) {
    return { ok: false, provider: "twilio_direct", error: "recipient_opted_out", http_status: 409 };
  }
  if (optOut.checkFailed) {
    return { ok: false, provider: "twilio_direct", error: "opt_out_check_failed", http_status: 503 };
  }

  const creds = await getTenantIntegrationBundle(input.tenantId, "twilio");
  const sid = creds.account_sid;
  const token = creds.auth_token;
  if (!twilioCredentialsReady(creds) || !sid || !token) {
    return {
      ok: false,
      provider: "twilio_direct",
      error: "missing_twilio_credentials",
      http_status: 503,
    };
  }
  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`;
  const form = buildTwilioMessageForm(creds, input);

  try {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(`${sid}:${token}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: form.toString(),
    });
    const j = (await r.json().catch(() => ({}))) as {
      sid?: string;
      status?: string;
      message?: string;
      code?: number;
    };
    if (r.status >= 200 && r.status < 300 && j.sid) {
      return {
        ok: true,
        provider: "twilio_direct",
        message_sid: j.sid,
        status: j.status || "queued",
      };
    }
    return {
      ok: false,
      provider: "twilio_direct",
      error: j.message || `twilio_http_${r.status}`,
      http_status: r.status,
    };
  } catch (err) {
    return {
      ok: false,
      provider: "twilio_direct",
      error: `network_error: ${(err as Error).message}`,
      http_status: 502,
    };
  }
}
