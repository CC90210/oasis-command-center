/**
 * GET /api/auth/onboarding-refresh?next=/path - re-read the onboarding gate's
 * answer from the database, re-mint the session cookie with it, and continue
 * to `next` (same-origin paths only).
 *
 * WHY. Under Turso auth the gate's answer rides in the signed session cookie
 * (lib/onboarding-claim.ts) because middleware cannot read the database. When
 * the real state changes elsewhere (OASIS finishes setting up the workspace,
 * or the person finishes onboarding in another tab), the onboarding pages
 * notice and send the browser here, so the next page load is not redirected
 * back to a flow the person has already finished. Keeps the session's expiry
 * and revocation epoch: this never extends or revives a session.
 *
 * /api/* is never gated by the onboarding redirect, so this cannot loop.
 */

import { NextResponse, type NextRequest } from "next/server";
import { reissueWithOnboardingClaim } from "@/lib/onboarding-claim";
import { getTursoClient } from "@/lib/turso";
import { SESSION_COOKIE, tursoAuthActive, verifySessionAgainstDb } from "@/lib/turso-auth";
import { safeInternalPath } from "@/lib/turso-auth-admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const next = safeInternalPath(req.nextUrl.searchParams.get("next"));
  const res = NextResponse.redirect(new URL(next, req.url));
  if (!tursoAuthActive()) return res;
  const session = await verifySessionAgainstDb(getTursoClient(), req.cookies.get(SESSION_COOKIE)?.value);
  if (!session) return NextResponse.redirect(new URL(`/login?next=${encodeURIComponent(next)}`, req.url));
  await reissueWithOnboardingClaim(res, getTursoClient(), session);
  return res;
}
