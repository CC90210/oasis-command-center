/**
 * POST /api/auth/finalize-invite-signup
 *
 * Unauthed companion to /api/auth/redeem-invite. Fires from the signup
 * page when Supabase's email-confirmation gate returns no session
 * post-signUp — the operator can't call redeem-invite (which requires
 * a session) so they used to dead-end at "Check your email to finish
 * accepting the invite." That broke the onboarding loop because the
 * invitee already proved possession of their email by clicking the
 * personalized invite link in their inbox — making them confirm the
 * SAME email a second time is pointless and confusing.
 *
 * This route:
 *   1. Auto-confirms the user's email via service-role admin
 *      (idempotent — harmless if already confirmed)
 *   2. Redeems the invite via the existing service-role redeemInvite
 *      helper (which validates token + email-matches-pinned + atomic
 *      RPC)
 *
 * Caller then redirects to /login?invite=...&email=... so the invitee
 * signs in with the password they just created.
 *
 * Security model:
 *   - Unauthed by design — the user has no session yet.
 *   - redeemInvite() validates the raw_token is still valid AND that
 *     the user_id's email matches the invite's pinned email. Legacy
 *     email-less invites fail closed and cannot reach this path.
 */

import { NextResponse, type NextRequest } from "next/server";
import { previewInvite, redeemInvite } from "@/lib/team";
import { getServiceSupabase } from "@/lib/supabase-server";
import { adminConfirmEmail, adminGetUser } from "@/lib/turso-auth-admin";
import { finalizeInviteProfile } from "@/lib/invite-profile-finalization";
import { confirmInviteBoundEmail } from "@/lib/invite-account-recovery";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: NextRequest) {
  let body: { raw_token?: string; user_id?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const rawToken = (body.raw_token || "").trim();
  const userId = (body.user_id || "").trim();
  if (!rawToken || !userId) {
    return NextResponse.json(
      { ok: false, error: "missing_fields", message: "raw_token and user_id required" },
      { status: 400 },
    );
  }
  if (!UUID_RE.test(userId)) {
    return NextResponse.json(
      { ok: false, error: "invalid_user_id" },
      { status: 400 },
    );
  }

  const db = getServiceSupabase();

  // 1. Bind the active, email-pinned invite to this exact auth identity before
  //    making the privileged email-confirmation mutation. This route is
  //    intentionally unauthenticated, so neither a bare user UUID nor an invite
  //    for a different mailbox is sufficient authority to confirm an account.
  const confirmation = await confirmInviteBoundEmail(
    { rawToken, userId },
    {
      previewInvite: async (token) => {
        const preview = await previewInvite(token);
        return preview ? { emailPinned: preview.email_pinned } : null;
      },
      getUserEmail: async (authUserId) => {
        const authUser = await adminGetUser(db, authUserId);
        return authUser.ok ? authUser.value.email : null;
      },
      confirmUserEmail: async (authUserId) => {
        const confirmed = await adminConfirmEmail(db, authUserId);
        return confirmed.ok ? { ok: true } : { ok: false, error: confirmed.error };
      },
    },
  );
  if (!confirmation.ok && confirmation.stage === "preflight") {
    return NextResponse.json(
      { ok: false, error: "redeem_failed", message: "invalid invite or account binding" },
      { status: 400 },
    );
  }
  if (!confirmation.ok) {
    return NextResponse.json(
      { ok: false, error: "email_confirm_failed", message: confirmation.error },
      { status: 500 },
    );
  }

  // 2. Redeem the invite. redeemInvite() re-validates the token + checks
  //    the user's email matches the invite's pinned email (when set).
  const result = await redeemInvite(rawToken, userId);
  if (!result.ok) {
    return NextResponse.json(
      { ok: false, error: "redeem_failed", message: result.error },
      { status: 400 },
    );
  }

  // 3. Apply the same role/manifest profile policy as authenticated invite
  //    redemption, then return the tenant route. This step fails closed so a
  //    redeemed user never lands with a stale agent roster.
  let tenantSlug: string | null = null;
  try {
    ({ tenantSlug } = await finalizeInviteProfile({
      tenantId: result.tenantId,
      authUserId: userId,
      teamRole: result.teamRole,
      preserveExistingMember: result.alreadyMember === true,
    }));
  } catch (error) {
    console.error("[auth.finalize-invite-signup] profile finalization failed", {
      tenantId: result.tenantId,
      userId,
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
    tenant_slug: tenantSlug,
  });
}
