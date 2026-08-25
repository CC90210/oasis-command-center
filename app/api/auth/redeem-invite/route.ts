/**
 * POST /api/auth/redeem-invite — atomic invite redemption.
 *
 * Phase A of the master multi-tenant infra plan (2026-05-17). Called by
 * the signup form and the login form after Supabase auth succeeds, when
 * the URL carried an `?invite=<token>` param. Wraps the existing
 * `redeem_tenant_invite` RPC (migration 037) and stamps onboarding
 * state so the welcome wizard (Phase C) knows this is a fresh invitee.
 *
 * Body: { raw_token: string }
 *
 * Response 200: { ok: true, tenant_id, team_role, first_login: boolean }
 * Response 4xx: { ok: false, error, message? }
 *
 * Why not pass the raw token through the existing /auth/provision route:
 * provision is overloaded — it creates a new tenant for fresh signups.
 * Mixing redeem + provision in one endpoint makes the success-path logic
 * hard to read. Keeping them separate means each route has one job.
 */

import { NextResponse, type NextRequest } from "next/server";
import { redeemInvite } from "@/lib/team";
import { finalizeInviteProfile } from "@/lib/invite-profile-finalization";
import { getServiceSupabase, getSessionUser } from "@/lib/supabase-server";

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

  // Redeem — atomic in the SECURITY DEFINER RPC. Attaches the user_profile
  // to the inviter's tenant + assigns the invite's team_role.
  const result = await redeemInvite(rawToken, user.id);
  if (!result.ok) {
    const message = result.error === "already_member_of_another_tenant"
      ? "This account already belongs to another workspace. Sign out and use the email this invite was sent to, or ask an admin for help."
      : result.error;
    return NextResponse.json(
      { ok: false, error: "redeem_failed", message },
      { status: 400 },
    );
  }

  // First-login signal: did the user have onboarding_completed_at set
  // already? If not, the welcome wizard used to fire post-redirect.
  // After the 2026-05-29 fix, invitees skip the wizard regardless and
  // land directly in their tenant workspace — the first_login flag is
  // kept for callers that want to differentiate (e.g. show a brief
  // first-time toast) but it no longer gates the redirect path.
  let firstLogin = true;
  try {
    const db = getServiceSupabase();
    const { data } = await db
      .from("user_profiles")
      .select("onboarding_completed_at")
      .eq("auth_user_id", user.id)
      .maybeSingle();
    firstLogin = !data?.onboarding_completed_at;
  } catch {
    // Soft-fail — default to first_login=true.
  }

  // Resolve the tenant's Command Center profile slug so the client can
  // route directly to /t/<slug> instead of bouncing through the welcome
  // wizard. resolveClientProfileSlug handles the SunBiz mapping (slug
  // 'submissions' OR custom_fields.command_center_profile_slug='sun')
  // along with any future client-tenant mappings.
  let tenantSlug: string | null = null;
  try {
    ({ tenantSlug } = await finalizeInviteProfile({
      tenantId: result.tenantId,
      authUserId: user.id,
      teamRole: result.teamRole,
      preserveExistingMember: result.alreadyMember === true,
    }));
  } catch (error) {
    console.error("[auth.redeem-invite] profile finalization failed", {
      tenantId: result.tenantId,
      userId: user.id,
      error: error instanceof Error ? error.message : "profile_finalize_failed",
    });
    return NextResponse.json(
      { ok: false, error: "profile_finalize_failed" },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    tenant_id: result.tenantId,
    team_role: result.teamRole,
    first_login: firstLogin,
    tenant_slug: tenantSlug,
  });
}
