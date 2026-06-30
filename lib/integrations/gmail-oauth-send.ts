/**
 * lib/integrations/gmail-oauth-send.ts — send a single email AS the operator,
 * from THEIR connected Gmail.
 *
 * The OAuth connect flow (app/api/auth/google-oauth/*) already stores each
 * operator's encrypted { refresh_token, access_token, expires_at, scope,
 * gmail_address } in user_integration_credentials service='gmail_oauth'. Until
 * now nothing READ that bundle to send — per-lead email queued to the shared
 * submissions@ daemon. This module is the missing consumer: it refreshes the
 * operator's access token and sends via the HTTPS Gmail API (serverless-safe,
 * no SMTP socket), so the merchant receives the email FROM the operator's own
 * address.
 *
 * Contract mirrors lib/sms-direct-twilio.ts: NEVER throws — returns a typed
 * result so the route can fall back to the submissions@ queue on any failure.
 * Token-refresh pattern mirrors JARVIS services/salesforce-responder/bounce-scanner.js.
 */

import "server-only";
import { getUserIntegrationBundle, setUserIntegrationValue } from "@/lib/user-integration-store";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
const REFRESH_SKEW_MS = 60_000; // refresh if the token expires within a minute

// CAN-SPAM footer for the direct (operator-Gmail) path. The submissions@ queue
// path gets its footer from send_gateway; this path bypasses the daemon, so the
// footer must be appended here. Ported from JARVIS salesforce-responder/templates.js.
const CANSPAM_FOOTER =
  "\n\n---\nSunBiz Funding LLC\n1 East Broward Blvd, Suite 700\nFort Lauderdale, FL 33301\n\n" +
  "You received this email because you submitted a funding inquiry. To stop receiving emails, reply UNSUBSCRIBE.";

export type GmailOAuthSendResult =
  | { ok: true; provider: "gmail_oauth"; gmail_message_id: string; thread_id: string; from_address: string }
  | {
      ok: false;
      provider: "gmail_oauth";
      reason: "not_connected" | "refresh_failed" | "send_failed";
      error: string;
      http_status?: number;
    };

/** True when this operator has a usable Gmail OAuth connection (a refresh token on file). */
export async function operatorHasGmailOAuth(tenantId: string, userId: string): Promise<boolean> {
  if (!tenantId || !userId) return false;
  const bundle = await getUserIntegrationBundle(tenantId, userId, "gmail_oauth");
  return !!bundle.refresh_token && !!bundle.gmail_address;
}

/** Exchange the stored refresh token for a fresh access token; persist it back. */
async function refreshAccessToken(
  tenantId: string,
  userId: string,
  refreshToken: string,
): Promise<{ ok: true; accessToken: string } | { ok: false; error: string }> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return { ok: false, error: "google_client_env_missing" };
  let resp: { access_token?: string; expires_in?: number; error?: string };
  try {
    const r = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      }).toString(),
      signal: AbortSignal.timeout(15_000),
    });
    resp = (await r.json()) as typeof resp;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "token_network_error" };
  }
  if (resp.error || !resp.access_token) {
    // invalid_grant = revoked/expired refresh token → operator must reconnect.
    return { ok: false, error: resp.error || "no_access_token" };
  }
  const expiresAt = new Date(Date.now() + (resp.expires_in || 3600) * 1000).toISOString();
  // Best-effort persist so subsequent sends skip the refresh round-trip.
  await setUserIntegrationValue(tenantId, userId, "gmail_oauth", "access_token", resp.access_token);
  await setUserIntegrationValue(tenantId, userId, "gmail_oauth", "expires_at", expiresAt);
  return { ok: true, accessToken: resp.access_token };
}

/** RFC 2047 encode a header value only if it contains non-ASCII. */
function encodeHeader(value: string): string {
  if (/^[\x20-\x7E]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

/** Build a base64url RFC-822 message (text/plain, UTF-8, base64 body). */
function buildRawMessage(args: { from: string; to: string; subject: string; body: string }): string {
  const bodyB64 = Buffer.from(args.body, "utf8").toString("base64").replace(/(.{76})/g, "$1\r\n");
  const headers = [
    `From: ${args.from}`,
    `To: ${args.to}`,
    `Subject: ${encodeHeader(args.subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
  ];
  const mime = headers.join("\r\n") + "\r\n\r\n" + bodyB64;
  return Buffer.from(mime, "utf8").toString("base64url");
}

async function gmailSend(
  accessToken: string,
  raw: string,
): Promise<{ ok: true; id: string; threadId: string } | { ok: false; status: number; error: string }> {
  try {
    const r = await fetch(SEND_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ raw }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) {
      const txt = await r.text();
      return { ok: false, status: r.status, error: txt.slice(0, 240) };
    }
    const data = (await r.json()) as { id?: string; threadId?: string };
    return { ok: true, id: data.id || "", threadId: data.threadId || "" };
  } catch (e) {
    return { ok: false, status: 0, error: e instanceof Error ? e.message : "send_network_error" };
  }
}

/**
 * Send one email as the operator, from their connected Gmail. Appends the
 * CAN-SPAM footer. Never throws.
 */
export async function sendGmailAsOperator(args: {
  tenantId: string;
  userId: string;
  to: string;
  subject: string;
  body: string;
}): Promise<GmailOAuthSendResult> {
  const bundle = await getUserIntegrationBundle(args.tenantId, args.userId, "gmail_oauth");
  const refreshToken = bundle.refresh_token;
  const fromAddress = bundle.gmail_address;
  if (!refreshToken || !fromAddress) {
    return { ok: false, provider: "gmail_oauth", reason: "not_connected", error: "no gmail_oauth bundle" };
  }

  // Use the stored access token if still fresh; else refresh.
  let accessToken = bundle.access_token || "";
  const expiresAt = bundle.expires_at ? Date.parse(bundle.expires_at) : 0;
  if (!accessToken || !expiresAt || expiresAt - Date.now() < REFRESH_SKEW_MS) {
    const ref = await refreshAccessToken(args.tenantId, args.userId, refreshToken);
    if (!ref.ok) {
      return { ok: false, provider: "gmail_oauth", reason: "refresh_failed", error: ref.error };
    }
    accessToken = ref.accessToken;
  }

  const raw = buildRawMessage({
    from: fromAddress,
    to: args.to,
    subject: args.subject,
    body: args.body.replace(/\s+$/, "") + CANSPAM_FOOTER,
  });

  let res = await gmailSend(accessToken, raw);
  // A 401 means the token went stale between freshness check and send — force one refresh + retry.
  if (!res.ok && res.status === 401) {
    const ref = await refreshAccessToken(args.tenantId, args.userId, refreshToken);
    if (!ref.ok) {
      return { ok: false, provider: "gmail_oauth", reason: "refresh_failed", error: ref.error };
    }
    res = await gmailSend(ref.accessToken, raw);
  }
  if (!res.ok) {
    return { ok: false, provider: "gmail_oauth", reason: "send_failed", error: res.error, http_status: res.status };
  }
  return {
    ok: true,
    provider: "gmail_oauth",
    gmail_message_id: res.id,
    thread_id: res.threadId,
    from_address: fromAddress,
  };
}
