/**
 * POST /api/auth/redeem-invite — atomic invite redemption.
 *
 * Called by the signup form and the login form after sign-in succeeds, when
 * the URL carried an `?invite=<token>` param.
 *
 * Body: { raw_token: string }
 *
 * Response 200: { ok: true, tenant_id, team_role, first_login, tenant_slug }
 * Response 4xx/5xx: { ok: false, error: <code>, message: <a sentence for a person> }
 *
 * ONE WRITE (2026-09-30). lib/team.ts redeemInvite decides the joining member's
 * profile first (lib/invite-profile-finalization.ts) and redeem_tenant_invite
 * claims the invite and writes that profile in one batch. It used to claim the
 * invite, commit, and only then finish the profile in a second step here; when
 * that step failed (every invite into a client workspace, since 5c374a19), the
 * invite was used up, the person was half-joined, the screen showed the raw
 * code "profile_finalize_failed", and a retry failed the same way. Now a
 * failure leaves the invite unclaimed and a retry can succeed.
 *
 * Under Turso auth the session cookie is re-minted here with the onboarding
 * gate's new answer (lib/onboarding-claim.ts): the person's state just changed.
 */

import { NextResponse, type NextRequest } from "next/server";
import { redeemInvite } from "@/lib/team";
import { getServiceSupabase, getSessionUser } from "@/lib/supabase-server";
import { reissueWithOnboardingClaim } from "@/lib/onboarding-claim";
import { getTursoClient } from "@/lib/turso";
import { SESSION_COOKIE, tursoAuthActive, verifySessionAgainstDb } from "@/lib/turso-auth";
import { inviteRedeemFailure } from "@/lib/invite-redeem-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let body: { raw_token?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const rawToken = (body.raw_token || "").trim();
  if (!rawToken) {
    return NextResponse.json(
      { ok: false, error: "missing_fields", message: "raw_token required" },
      { status: 400 },
    );
  }

  const result = await redeemInvite(rawToken, user.id);
  if (!result.ok) {
    const failure = inviteRedeemFailure(result.error);
    return NextResponse.json(
      { ok: false, error: failure.code, message: failure.message },
      { status: failure.status },
    );
  }

  // First-login signal for callers that want a first-time toast. Not a gate.
  let firstLogin = true;
  const profileRead = await getServiceSupabase()
    .from("user_profiles")
    .select("onboarding_completed_at")
    .eq("auth_user_id", user.id)
    .maybeSingle();
  if (profileRead.error) {
    console.error("[auth.redeem-invite] first-login read failed; reporting first_login=true", {
      userId: user.id,
      error: profileRead.error.message,
    });
  } else {
    firstLogin = !profileRead.data?.onboarding_completed_at;
  }

  const res = NextResponse.json({
    ok: true,
    tenant_id: result.tenantId,
    team_role: result.teamRole,
    first_login: firstLogin,
    tenant_slug: result.tenantSlug,
  });
  if (tursoAuthActive()) {
    const session = await verifySessionAgainstDb(getTursoClient(), req.cookies.get(SESSION_COOKIE)?.value);
    if (session) await reissueWithOnboardingClaim(res, getTursoClient(), session);
  }
  return res;
}
