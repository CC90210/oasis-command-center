/**
 * GET /api/auth/google-oauth/start — kick off the Google OAuth flow
 * for connecting a user's personal Gmail. Phase 4 of the SunBiz multi-
 * employee personalization plan (2026-05-29).
 *
 * Returns JSON { ok: true, url: "https://accounts.google.com/..." }.
 * The Settings UI redirects the browser to that URL; Google bounces
 * back to /api/auth/google-oauth/callback after consent.
 *
 * Scope: gmail.send only. The operator deliberately CANNOT read their
 * inbox or modify labels from the dashboard — that's a planning
 * decision. Future phases can expand the scope if a feature requires
 * inbox read.
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
import { getSessionUser, getServiceSupabase } from "@/lib/supabase-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// gmail.send authorizes the send; gmail.readonly authorizes the Operator
// Email Agent's inbox MONITOR (read-only — it never modifies/deletes mail).
// openid + email let the callback resolve the connected Gmail address.
// (2026-07: expanded from send-only to enable the monitor. Reading the inbox
// is now in-scope by explicit operator consent; the agent still cannot modify.)
const OAUTH_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.readonly",
].join(" ");

// Which mailbox this connect is for. 'work' → the existing gmail_oauth bundle
// (send + monitor). 'personal' → a separate gmail_oauth_personal bundle
// (monitor only, opt-in). Both store under user_integration_credentials keyed
// by service, so an operator can connect two Google accounts.
const MAILBOX_SERVICE: Record<string, string> = {
  work: "gmail_oauth",
  personal: "gmail_oauth_personal",
  // 2026-08-23: not a mailbox at all, but the same machinery -- a per-user
  // Google grant, stored in the same encrypted bundle table under its own
  // service key, revocable on its own. Reps connect this so their callbacks
  // appear on the phone in their pocket (lib/web-leads/calendar-sync.ts).
  //
  // SEPARATE SERVICE KEY, DELIBERATELY. Folding calendar scope into
  // `gmail_oauth` would mean a rep who wants callbacks on their phone has to
  // hand over their inbox too, and revoking one would revoke the other.
  calendar: "google_calendar",
};

/**
 * The scopes each target asks for. Calendar asks for calendar.events ONLY: it
 * can create and update events on the user's calendars and nothing else -- it
 * cannot read their mail, delete a calendar, or touch their contacts. A rep
 * reads that consent screen before they grant it, and it should say something
 * small and true.
 *
 * openid + email stay on every target because the callback resolves which
 * Google account was connected, and showing a rep WHICH calendar their
 * callbacks are landing on is the difference between trust and confusion when
 * they have a personal and a work account signed in.
 */
const TARGET_SCOPES: Record<string, string> = {
  calendar: ["openid", "email", "https://www.googleapis.com/auth/calendar.events"].join(" "),
};

export async function GET(req: Request) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  // Which mailbox to connect (default work). Unknown values fail closed to work.
  const mailboxParam = new URL(req.url).searchParams.get("mailbox") || "work";
  const mailbox = mailboxParam in MAILBOX_SERVICE ? mailboxParam : "work";

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
  const db = getServiceSupabase();
  const profile = await db
    .from("user_profiles")
    .select("tenant_id")
    .eq("auth_user_id", user.id)
    .maybeSingle();
  const tenantId = (profile.data as { tenant_id?: string | null } | null)?.tenant_id;
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
  authUrl.searchParams.set("scope", TARGET_SCOPES[mailbox] || OAUTH_SCOPES);
  authUrl.searchParams.set("access_type", "offline"); // need refresh_token
  authUrl.searchParams.set("prompt", "consent"); // force refresh_token issuance
  authUrl.searchParams.set("state", state);

  return NextResponse.json({ ok: true, url: authUrl.toString() });
}
