/**
 * Google sign-in, step 1: redirect to Google's consent screen.
 *
 * Uses CC's OWN OAuth client (GOOGLE_CLIENT_ID) — the same one Supabase Auth
 * borrowed, so users see the identical consent screen they always have. The
 * `state` value is double-submitted (URL + HttpOnly cookie) against CSRF.
 *
 * Prereq (one-time, Google Cloud Console): add
 *   https://<host>/api/auth/google/callback
 * to this client's Authorized redirect URIs.
 */
import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { tursoAuthActive } from "@/lib/turso-auth";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!tursoAuthActive() || !clientId) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const state = randomBytes(24).toString("base64url");
  const redirectUri = new URL("/api/auth/google/callback", req.url).toString();
  const next = req.nextUrl.searchParams.get("next") || "/";

  const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  auth.searchParams.set("client_id", clientId);
  auth.searchParams.set("redirect_uri", redirectUri);
  auth.searchParams.set("response_type", "code");
  auth.searchParams.set("scope", "openid email profile");
  auth.searchParams.set("state", state);
  auth.searchParams.set("prompt", "select_account");

  const res = NextResponse.redirect(auth);
  res.cookies.set({
    name: "g_oauth_state", value: `${state}|${next}`,
    httpOnly: true, secure: process.env.NODE_ENV === "production",
    sameSite: "lax", path: "/api/auth/google", maxAge: 600,
  });
  return res;
}
