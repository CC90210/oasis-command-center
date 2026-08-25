/**
 * Who am I? — the replacement for supabase.auth.getUser() in client components.
 *
 * AuthRedirectGuard, ChangePasswordForm and the invite-redeem screen all call
 * getUser() from the browser. Under Turso the session is an HMAC cookie the
 * browser cannot read (httpOnly, by design), so they ask the server instead.
 *
 * Always 200 with `{ user: null }` when unauthenticated rather than 401 — these
 * callers use it to DECIDE whether to redirect, and a 401 would make "logged
 * out" indistinguishable from "the endpoint is broken".
 *
 * Returns id and email only. Anything more would put profile data behind a
 * route whose whole job is answering an unauthenticated question.
 */
import { NextRequest, NextResponse } from "next/server";
import {
  SESSION_COOKIE,
  tursoAuthActive,
  verifySessionAgainstDb,
} from "@/lib/turso-auth";
import { getTursoClient } from "@/lib/turso";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  if (!tursoAuthActive()) {
    // Not an error: Supabase auth is still the active backend, so the caller
    // should fall back to its Supabase path rather than treat this as failure.
    return NextResponse.json({ user: null, mode: "supabase" });
  }
  const session = await verifySessionAgainstDb(
    getTursoClient(),
    req.cookies.get(SESSION_COOKIE)?.value,
  );
  return NextResponse.json({
    mode: "turso",
    user: session ? { id: session.sub, email: session.email } : null,
  });
}
