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

const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";

export async function GET() {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

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
  const statePayload = `${tenantId}|${user.id}|${nonce}`;
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
  authUrl.searchParams.set("scope", GMAIL_SEND_SCOPE);
  authUrl.searchParams.set("access_type", "offline"); // need refresh_token
  authUrl.searchParams.set("prompt", "consent"); // force refresh_token issuance
  authUrl.searchParams.set("state", state);

  return NextResponse.json({ ok: true, url: authUrl.toString() });
}
