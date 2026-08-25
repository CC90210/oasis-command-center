/**
 * Google sign-in, step 2: code → tokens → session cookie.
 *
 * The id_token arrives FIRST-HAND from Google's token endpoint over TLS (not
 * from the browser), so payload validation (iss / aud / exp / email_verified)
 * is sufficient without a JWKS round trip — we never trust a client-supplied
 * token here.
 *
 * Account policy: EXISTING migrated users only. The 47 Google identities were
 * preserved into _supabase_auth_identities; we match by Google's stable subject
 * id first, then verified email. Unknown Google accounts get a clean refusal —
 * signup is a deliberate separate flow, not a side effect of OAuth.
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@libsql/client";
import { SESSION_COOKIE, signSession, tursoAuthActive } from "@/lib/turso-auth";
import { inviteTokenFromPath, safeInternalPath } from "@/lib/turso-auth-admin";

export const runtime = "nodejs";

function loginRedirect(req: NextRequest, error: string, next = "/"): NextResponse {
  const url = new URL("/login", req.url);
  url.searchParams.set("err", error);
  const safeNext = safeInternalPath(next);
  if (safeNext !== "/") url.searchParams.set("next", safeNext);
  const inviteToken = inviteTokenFromPath(safeNext);
  if (inviteToken) url.searchParams.set("invite", inviteToken);
  const res = NextResponse.redirect(url);
  res.cookies.set({ name: "g_oauth_state", value: "", path: "/api/auth/google", maxAge: 0 });
  return res;
}

export async function GET(req: NextRequest) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!tursoAuthActive() || !clientId || !clientSecret) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  const cookieVal = req.cookies.get("g_oauth_state")?.value ?? "";
  const [cookieState, next = "/"] = cookieVal.split("|");
  const safeNext = safeInternalPath(next);
  const providerError = req.nextUrl.searchParams.get("error");
  if (providerError) {
    return loginRedirect(req, "oauth_denied", safeNext);
  }
  if (!code || !state || !cookieState || state !== cookieState) {
    return loginRedirect(req, "oauth_state_mismatch", safeNext);
  }

  const redirectUri = new URL("/api/auth/google/callback", req.url).toString();
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code, client_id: clientId, client_secret: clientSecret,
      redirect_uri: redirectUri, grant_type: "authorization_code",
    }),
  });
  if (!tokenRes.ok) return loginRedirect(req, "oauth_exchange_failed", safeNext);
  const tokens = (await tokenRes.json()) as { id_token?: string };
  if (!tokens.id_token) return loginRedirect(req, "oauth_exchange_failed", safeNext);

  let payload: { iss?: string; aud?: string; exp?: number; sub?: string;
                 email?: string; email_verified?: boolean };
  try {
    payload = JSON.parse(
      Buffer.from(tokens.id_token.split(".")[1], "base64url").toString("utf8"));
  } catch {
    return loginRedirect(req, "oauth_bad_token", safeNext);
  }
  const issOk = payload.iss === "https://accounts.google.com" || payload.iss === "accounts.google.com";
  if (!issOk || payload.aud !== clientId
      || typeof payload.exp !== "number" || payload.exp * 1000 < Date.now()
      || !payload.sub || !payload.email || payload.email_verified !== true) {
    return loginRedirect(req, "oauth_bad_token", safeNext);
  }

  const url = process.env.TURSO_DATABASE_URL || process.env.TURSO_DB_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url || !authToken) return loginRedirect(req, "auth_backend_unavailable", safeNext);
  const db = createClient({ url, authToken });

  // Stable Google subject id first (survives email changes), verified email second.
  let userId: string | null = null;
  let sessionVersion: number | null = null;
  let email = payload.email.toLowerCase();
  const bySub = await db.execute({
    sql: `SELECT u.id, u.email, u.session_version FROM "_supabase_auth_identities" i
          JOIN "_supabase_auth_users" u ON u.id = i.user_id
          WHERE i.provider = 'google' AND i.provider_id = ?
            AND u.deleted_at IS NULL LIMIT 1`,
    args: [payload.sub],
  });
  if (bySub.rows.length) {
    userId = String(bySub.rows[0].id);
    email = String(bySub.rows[0].email ?? email).toLowerCase();
    sessionVersion = Number(bySub.rows[0].session_version ?? 0);
  } else {
    const byEmail = await db.execute({
      sql: `SELECT id, session_version FROM "_supabase_auth_users"
            WHERE lower(email) = ? AND deleted_at IS NULL LIMIT 1`,
      args: [email],
    });
    if (byEmail.rows.length) {
      userId = String(byEmail.rows[0].id);
      sessionVersion = Number(byEmail.rows[0].session_version ?? 0);
    }
  }
  if (!userId || !Number.isSafeInteger(sessionVersion) || Number(sessionVersion) < 0) {
    return loginRedirect(req, "no_account", safeNext);
  }

  const res = NextResponse.redirect(new URL(safeNext, req.url));
  res.cookies.set({ name: "g_oauth_state", value: "", path: "/api/auth/google", maxAge: 0 });
  res.cookies.set({
    name: SESSION_COOKIE,
    value: signSession({
      sub: userId,
      email,
      exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7,
      ver: Number(sessionVersion),
    }),
    httpOnly: true, secure: process.env.NODE_ENV === "production",
    sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 7,
  });
  return res;
}
