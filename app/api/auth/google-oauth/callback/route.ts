/**
 * GET /api/auth/google-oauth/callback — Google bounces here after the
 * operator approves consent. Phase 4 of the SunBiz multi-employee
 * personalization plan (2026-05-29).
 *
 * Flow:
 *   1. Verify state HMAC matches what /start signed. Rejects replay /
 *      cross-user tampering attempts.
 *   2. Exchange the auth code for { access_token, refresh_token,
 *      expires_in, scope }.
 *   3. Resolve the user's actual Gmail address via the Google userinfo
 *      endpoint so the dashboard knows what "from" address to surface.
 *   4. Encrypt + store the whole bundle in user_integration_credentials
 *      under service='gmail_oauth'.
 *   5. Redirect back to /settings#integrations with success/error
 *      query param so the Settings UI can show a status banner.
 *
 * Required env (same as start):
 *   GOOGLE_CLIENT_ID
 *   GOOGLE_CLIENT_SECRET
 *   PUBLIC_APP_URL
 *
 * Scope: gmail.send only (verified against what we requested in /start).
 */

import { NextRequest, NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";
import { getSessionUser } from "@/lib/supabase-server";
import { setUserIntegrationBundle } from "@/lib/user-integration-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const SETTINGS_RETURN_PATH = "/settings#integrations";
// Must mirror start/route.ts. work → send+monitor; personal → monitor only.
const MAILBOX_SERVICE: Record<string, string> = {
  work: "gmail_oauth",
  personal: "gmail_oauth_personal",
  calendar: "google_calendar",
};
const CALENDAR_EVENTS_SCOPE = "https://www.googleapis.com/auth/calendar.events";

function settingsRedirect(req: NextRequest, params: Record<string, string>): NextResponse {
  const baseUrl =
    process.env.PUBLIC_APP_URL?.replace(/\/$/, "") ||
    new URL(req.url).origin;
  const dest = new URL(`${baseUrl}${SETTINGS_RETURN_PATH}`);
  for (const [k, v] of Object.entries(params)) dest.searchParams.set(k, v);
  return NextResponse.redirect(dest.toString());
}

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code") || "";
  const state = req.nextUrl.searchParams.get("state") || "";
  const error = req.nextUrl.searchParams.get("error") || "";

  // Google returns ?error=... on user-side denial (closed window,
  // declined consent). Redirect back without a state-failure flag.
  if (error) {
    return settingsRedirect(req, { gmail_oauth: "denied", reason: error });
  }
  if (!code || !state) {
    return settingsRedirect(req, { gmail_oauth: "denied", reason: "missing_code_or_state" });
  }

  // Verify state signature.
  const stateSecret =
    process.env.GOOGLE_OAUTH_STATE_SECRET ||
    process.env.BRAVO_FIELD_ENCRYPTION_KEY ||
    "";
  if (!stateSecret) {
    return settingsRedirect(req, { gmail_oauth: "error", reason: "state_secret_missing" });
  }
  const parts = state.split("|");
  if (parts.length !== 6) {
    return settingsRedirect(req, { gmail_oauth: "error", reason: "malformed_state" });
  }
  const [tenantId, stateUserId, nonce, issuedAtRaw, mailboxRaw, providedSig] = parts;
  const service = MAILBOX_SERVICE[mailboxRaw];
  if (!service) {
    return settingsRedirect(req, { gmail_oauth: "error", reason: "unknown_mailbox" });
  }
  const expectedSig = createHmac("sha256", stateSecret)
    .update(`${tenantId}|${stateUserId}|${nonce}|${issuedAtRaw}|${mailboxRaw}`)
    .digest("base64url");
  let sigMatch = false;
  try {
    sigMatch =
      providedSig.length === expectedSig.length &&
      timingSafeEqual(Buffer.from(providedSig), Buffer.from(expectedSig));
  } catch {
    sigMatch = false;
  }
  if (!sigMatch) {
    return settingsRedirect(req, { gmail_oauth: "error", reason: "state_signature_invalid" });
  }

  // Reject states older than 15 minutes. Stale state is the canonical
  // replay vector — even with the same signature, an attacker who
  // recovered a leaked URL should not be able to complete the flow
  // hours later. 15 min covers human-paced "click consent" with margin.
  const issuedAtMs = parseInt(issuedAtRaw, 36);
  if (!Number.isFinite(issuedAtMs) || Date.now() - issuedAtMs > 15 * 60 * 1000) {
    return settingsRedirect(req, { gmail_oauth: "error", reason: "state_expired" });
  }

  // Verify the session user matches what /start signed. Prevents an
  // attacker from completing the flow against a different account.
  const user = await getSessionUser();
  if (!user || user.id !== stateUserId) {
    return settingsRedirect(req, { gmail_oauth: "error", reason: "session_mismatch" });
  }

  // Exchange code → tokens.
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return settingsRedirect(req, { gmail_oauth: "error", reason: "client_creds_missing" });
  }
  const baseUrl =
    process.env.PUBLIC_APP_URL?.replace(/\/$/, "") || new URL(req.url).origin;
  const redirectUri = `${baseUrl}/api/auth/google-oauth/callback`;

  let tokenResp: {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    token_type?: string;
    error?: string;
    error_description?: string;
  };
  try {
    const r = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }).toString(),
    });
    tokenResp = (await r.json()) as typeof tokenResp;
  } catch {
    return settingsRedirect(req, {
      gmail_oauth: "error",
      reason: "token_exchange_network_error",
    });
  }

  if (tokenResp.error || !tokenResp.access_token || !tokenResp.refresh_token) {
    return settingsRedirect(req, {
      gmail_oauth: "error",
      reason: tokenResp.error || "token_exchange_failed",
    });
  }

  // Verify the granted scope covers what this target needs. Google can grant a
  // SUBSET of what we requested in edge cases, and storing a bundle whose scope
  // does not actually authorize the feature produces a connection that LOOKS
  // healthy in Settings and fails on first use -- the worst of both.
  //
  // work needs send (load-bearing) + readonly (monitor); personal needs
  // readonly (monitor); calendar needs calendar.events and NEITHER gmail scope.
  const grantedScopes = (tokenResp.scope || "").split(" ");
  if (service === "google_calendar") {
    if (!grantedScopes.includes(CALENDAR_EVENTS_SCOPE)) {
      return settingsRedirect(req, { gmail_oauth: "error", reason: "calendar_scope_not_granted" });
    }
  } else {
    const needSend = service === "gmail_oauth";
    if (needSend && !grantedScopes.includes(GMAIL_SEND_SCOPE)) {
      return settingsRedirect(req, { gmail_oauth: "error", reason: "gmail_send_scope_not_granted" });
    }
    if (!grantedScopes.includes(GMAIL_READONLY_SCOPE)) {
      return settingsRedirect(req, { gmail_oauth: "error", reason: "gmail_readonly_scope_not_granted" });
    }
  }

  // Look up the operator's Gmail address. We requested `openid email`
  // in the start route specifically so userinfo reliably returns the
  // email. Missing email is a HARD FAILURE — the send pipeline uses
  // gmail_address as the From identity, so storing the bundle without
  // it leaves the connection useless. Better to fail the OAuth flow
  // visibly here than to silently degrade later.
  let gmailAddress = "";
  try {
    const ur = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { authorization: `Bearer ${tokenResp.access_token}` },
    });
    if (ur.ok) {
      const userinfo = (await ur.json()) as { email?: string };
      gmailAddress = userinfo.email || "";
    }
  } catch {
    // Userinfo failure handled below as the missing-email branch.
  }
  if (!gmailAddress) {
    return settingsRedirect(req, {
      gmail_oauth: "error",
      reason: "userinfo_email_missing",
    });
  }

  // Persist. Tokens are encrypted in user_integration_credentials.
  const expiresAt = new Date(Date.now() + (tokenResp.expires_in || 3600) * 1000).toISOString();
  const bundle: Record<string, string> = {
    refresh_token: tokenResp.refresh_token,
    access_token: tokenResp.access_token,
    expires_at: expiresAt,
    scope: tokenResp.scope || GMAIL_READONLY_SCOPE,
    gmail_address: gmailAddress,
    // The same address under a neutral key for the calendar connection, which
    // is not a mailbox. Reading `gmail_address` to answer "which calendar are
    // my callbacks going to" would work today and read as a bug forever.
    ...(service === "google_calendar" ? { google_address: gmailAddress } : {}),
  };

  const setResult = await setUserIntegrationBundle(
    tenantId,
    user.id,
    service,
    bundle,
  );
  if (!setResult.ok) {
    return settingsRedirect(req, {
      gmail_oauth: "error",
      reason: "store_failed",
    });
  }

  return settingsRedirect(req, {
    gmail_oauth: "connected",
    gmail: gmailAddress,
    mailbox: mailboxRaw,
  });
}
