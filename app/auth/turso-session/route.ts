/**
 * GET /auth/turso-session?token=<raw>&next=/path
 *
 * Redeems a one-time sign-in token into a session cookie. This is the Turso
 * replacement for /auth/callback's `?code=` exchange, which is Supabase GoTrue
 * and stops existing when the project is cancelled.
 *
 * The only minter today is /api/auth/pair-code/redeem: after a machine pairs,
 * the desktop loads this URL in its Electron window so the dashboard renders
 * already signed in. The pair-code was the authentication; this link only
 * transports the resulting session into the desktop's cookie jar.
 *
 * Security model:
 *   - Unauthed by necessity — it exists to create the session it would
 *     otherwise require.
 *   - The token IS the credential: 32 random bytes, sha256-at-rest, single-use
 *     via compare-and-swap, 15-minute TTL (consumeSessionLinkToken).
 *   - IP rate-limited, so the token space cannot be walked from one host.
 *   - `next` is forced to a same-origin absolute path. A token holder must not
 *     be able to bounce the freshly-authenticated browser to another origin.
 *   - Redirects rather than rendering, and never echoes the token, so the
 *     spent credential does not linger in the address bar.
 */

import { NextResponse, type NextRequest } from "next/server";
import { rateLimit } from "@/lib/rate-limit";
import { SESSION_COOKIE, signSession, tursoAuthActive } from "@/lib/turso-auth";
import { consumeSessionLinkToken, safeInternalPath } from "@/lib/turso-auth-admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SESSION_TTL_S = 60 * 60 * 24 * 7; // matches turso-login / turso-signup

export async function GET(req: NextRequest) {
  // Same-origin relative paths only — "//evil.com" and absolute URLs collapse
  // to "/". See safeInternalPath.
  const next = safeInternalPath(req.nextUrl.searchParams.get("next"));

  if (!tursoAuthActive()) {
    // Not a 404: a desktop build that received this URL deserves to know the
    // backend it targets is not the one running.
    return NextResponse.redirect(
      new URL("/login?err=session_link_unsupported", req.url),
    );
  }

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const gate = rateLimit({ key: `turso-session:${ip}`, capacity: 10, refillPerSec: 10 / 900 });
  if (!gate.allowed) {
    return NextResponse.redirect(new URL("/login?err=too_many_attempts", req.url));
  }

  const token = req.nextUrl.searchParams.get("token") || "";
  if (!token) {
    return NextResponse.redirect(new URL("/login?err=session_link_missing", req.url));
  }

  // Deliberately NOT wrapped in try/catch. A misconfigured Turso client throws
  // out of here with the env var it needs in the message; converting that into
  // "your link is invalid" would send an operator hunting a token problem that
  // is really a deploy problem.
  const user = await consumeSessionLinkToken(token);
  if (!user) {
    return NextResponse.redirect(new URL("/login?err=session_link_invalid", req.url));
  }

  // /auth/land resolves the tenant-aware landing path for this user and clears
  // the demo cookie — the same post-login treatment the password path gets.
  const res = NextResponse.redirect(
    new URL(`/auth/land?next=${encodeURIComponent(next)}`, req.url),
  );
  res.cookies.set({
    name: SESSION_COOKIE,
    value: signSession({
      sub: user.id,
      email: user.email,
      exp: Math.floor(Date.now() / 1000) + SESSION_TTL_S,
    }),
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_S,
  });
  return res;
}
