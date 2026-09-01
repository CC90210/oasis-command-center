/**
 * GET /api/auth/google-oauth/start — kick off the Google OAuth flow
 * for connecting a user's personal Gmail. Phase 4 of the SunBiz multi-
 * employee personalization plan (2026-05-29).
 *
 * Returns JSON { ok: true, url: "https://accounts.google.com/..." }.
 * The Settings UI redirects the browser to that URL; Google bounces
 * back to /api/auth/google-oauth/callback after consent.
 *
 * Work scope: Gmail send/read plus Calendar event management so a founder can
 * own the client invite and Google Meet. Personal scope remains Gmail read-only.
 *
 * State parameter packs the auth_user_id + tenant_id + a CSRF nonce
 * into a short-lived signed token. The callback validates it against
 * the live session so a leaked redirect can't be replayed onto a
 * different user.
 *
 * Required env (set in Vercel project settings):
 *   GOOGLE_CLIENT_ID      — OAuth client ID from Google Cloud Console
 *   GOOGLE_CLIENT_SECRET  — OAuth client secret (used by callback)
 *   PUBLIC_APP_URL        — base URL of the dashboard (already set)
 */

import { NextResponse } from "next/server";
import { randomBytes, createHmac } from "node:crypto";
import { getSessionUser } from "@/lib/supabase-server";
import { resolveTenantId } from "@/lib/api-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// gmail.send authorizes work sends; gmail.readonly authorizes the Operator
// Email Agent's inbox monitor (it never modifies/deletes mail). openid + email
// let the callback resolve the connected address.
// The work account owns both outbound email and founder meetings. Keep the
// personal account independent so it remains a read-only inbox monitor.
const WORK_OAUTH_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar.events",
].join(" ");

const PERSONAL_OAUTH_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/gmail.readonly",
].join(" ");

// Which mailbox this connect is for. 'work' → the existing gmail_oauth bundle
// (send + monitor). 'personal' → a separate gmail_oauth_personal bundle
// (monitor only, opt-in). Both store under user_integration_credentials keyed
// by service, so an operator can connect two Google accounts.
const MAILBOX_SERVICE: Record<string, string> = {
  work: "gmail_oauth",
  personal: "gmail_oauth_personal",
};

export async function GET(req: Request) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  // Which mailbox to connect (default work). Unknown values fail closed to work.
  const mailboxParam = new URL(req.url).searchParams.get("mailbox") || "work";
  const mailbox = mailboxParam in MAILBOX_SERVICE ? mailboxParam : "work";
  const oauthScopes = mailbox === "personal" ? PERSONAL_OAUTH_SCOPES : WORK_OAUTH_SCOPES;

  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    // Surface the config gap clearly instead of redirecting to a
    // Google error page. The operator who set up the project sees
    // this in the dashboard logs + the Settings UI surfaces it.
    return NextResponse.json(
      {
        ok: false,
        error: "google_oauth_not_configured",
        message:
          "GOOGLE_CLIENT_ID is not set in the dashboard env. Configure it in Vercel project settings under the OAuth section.",
      },
      { status: 500 },
    );
  }

  // Resolve tenant_id so the callback can write to the right slot.
  // The session-user lookup gives us auth_user_id; tenant_id comes
  // from user_profiles.
  const tenantId = await resolveTenantId();
  if (!tenantId) {
    return NextResponse.json(
      { ok: false, error: "no_tenant", message: "Your account isn't attached to a workspace yet." },
      { status: 400 },
    );
  }

  // State token: tenant_id|user_id|nonce signed with an HMAC secret.
  // The callback re-derives the signature from the session + nonce to
  // verify the state hasn't been tampered with. Falls back to the
  // SUPABASE_JWT_SECRET if a dedicated OAUTH_STATE_SECRET isn't set —
  // any high-entropy server secret works as long as both sides use
  // the same one.
  const stateSecret =
    process.env.GOOGLE_OAUTH_STATE_SECRET ||
    process.env.BRAVO_FIELD_ENCRYPTION_KEY ||
    "";
  if (!stateSecret) {
    return NextResponse.json(
      {
        ok: false,
        error: "state_secret_missing",
        message: "No server secret available to sign the OAuth state. Set GOOGLE_OAUTH_STATE_SECRET or BRAVO_FIELD_ENCRYPTION_KEY.",
      },
      { status: 500 },
    );
  }
  const nonce = randomBytes(16).toString("base64url");
  // Issued-at timestamp embedded in the state so the callback can
  // reject stale states (replay window <= 15 min). The HMAC covers the
  // timestamp so an attacker can't lengthen the window.
  const issuedAt = Date.now().toString(36);
  // mailbox is the 5th segment; the HMAC covers it so it can't be swapped.
  const statePayload = `${tenantId}|${user.id}|${nonce}|${issuedAt}|${mailbox}`;
  const signature = createHmac("sha256", stateSecret).update(statePayload).digest("base64url");
  const state = `${statePayload}|${signature}`;

  const baseUrl =
    process.env.PUBLIC_APP_URL?.replace(/\/$/, "") ||
    "https://agent-dashboard-cc90210.vercel.app";
  const redirectUri = `${baseUrl}/api/auth/google-oauth/callback`;

  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", oauthScopes);
  // Preserve a host's existing Gmail grants when they reconnect once to add
  // the Calendar event permission.
  authUrl.searchParams.set("include_granted_scopes", "true");
  authUrl.searchParams.set("access_type", "offline"); // need refresh_token
  authUrl.searchParams.set("prompt", "consent"); // force refresh_token issuance
  authUrl.searchParams.set("state", state);

  return NextResponse.json({ ok: true, url: authUrl.toString() });
}
