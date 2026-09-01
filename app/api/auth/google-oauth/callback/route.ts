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
 * Scope: work connections require Gmail send/read plus Calendar events;
 * personal connections require Gmail read-only only.
 */

import { NextRequest, NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";
import { getSessionUser } from "@/lib/supabase-server";
import { resolveActiveProfileForUser } from "@/lib/active-profile-resolver";
import { setUserIntegrationBundle } from "@/lib/user-integration-store";
import { hasRequiredScope } from "@/lib/integrations/google-calendar";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const SETTINGS_RETURN_PATH = "/settings#integrations";
// Must mirror start/route.ts. work → send+monitor; personal → monitor only.
const MAILBOX_SERVICE: Record<string, string> = {
  work: "gmail_oauth",
  personal: "gmail_oauth_personal",
};

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

  // Verify the granted scope covers what this mailbox needs. Google can grant
  // a subset in edge cases. Work needs send + readonly + Calendar events;
  // personal needs readonly only.
  const grantedScopeValue = tokenResp.scope || "";
  const grantedScopes = new Set(grantedScopeValue.split(/\s+/u).filter(Boolean));
  const needWorkScopes = service === "gmail_oauth";
  if (needWorkScopes && !grantedScopes.has(GMAIL_SEND_SCOPE)) {
    return settingsRedirect(req, { gmail_oauth: "error", reason: "gmail_send_scope_not_granted" });
  }
  if (!grantedScopes.has(GMAIL_READONLY_SCOPE)) {
    return settingsRedirect(req, { gmail_oauth: "error", reason: "gmail_readonly_scope_not_granted" });
  }
  // A BROADER GRANT IS NOT A FAILED GRANT.
  //
  // This asked `grantedScopes.has(CALENDAR_EVENTS_SCOPE)` -- the literal narrow
  // string. Google returns the parent `auth/calendar` when the account has
  // already granted it to this client, and the parent CONTAINS calendar.events.
  // So a rep whose Google was more privileged than we asked for was bounced
  // back to Settings with `calendar_events_scope_not_granted` and no way to
  // succeed: re-consenting grants the same broader scope again.
  //
  // hasRequiredScope is the predicate the BOOKING uses. Sharing it is the point
  // -- a connection this route accepts must be one the booking can spend, and
  // three separate copies of that question is what put a green banner over a
  // dead credential twice (#322, #331).
  if (needWorkScopes && !hasRequiredScope(grantedScopeValue)) {
    return settingsRedirect(req, {
      gmail_oauth: "error",
      reason: "calendar_events_scope_not_granted",
    });
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

  if (needWorkScopes) {
    const profile = await resolveActiveProfileForUser(user);
    const expectedWorkEmail = String(profile.profile?.email || "").trim().toLowerCase();
    if (
      profile.error ||
      profile.profile?.tenant_id !== tenantId ||
      !expectedWorkEmail ||
      gmailAddress.trim().toLowerCase() !== expectedWorkEmail
    ) {
      return settingsRedirect(req, {
        gmail_oauth: "error",
        reason: "google_account_must_match_profile_email",
        expected: expectedWorkEmail || "work_profile_email",
        gmail: gmailAddress,
        mailbox: mailboxRaw,
      });
    }
  }

  // Persist. Tokens are encrypted in user_integration_credentials.
  const expiresAt = new Date(Date.now() + (tokenResp.expires_in || 3600) * 1000).toISOString();
  const bundle: Record<string, string> = {
    refresh_token: tokenResp.refresh_token,
    access_token: tokenResp.access_token,
    expires_at: expiresAt,
    scope: tokenResp.scope || GMAIL_READONLY_SCOPE,
    gmail_address: gmailAddress,
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
