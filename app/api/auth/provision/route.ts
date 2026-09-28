/**
 * POST /api/auth/provision
 *
 * Binds the signed-in session to the user_profile it is entitled to. The
 * browser may not choose auth_user_id; the route binds provisioning to the
 * signed-in session so a malicious client cannot link profiles for another user.
 *
 * It no longer creates tenants (P0-8, 2026-09-28). OASIS OS is invite-only: a
 * teammate joins the inviting tenant through /api/auth/redeem-invite, and a new
 * client workspace is operator-provisioned. A session with no profile gets
 * 403 invite_required. See lib/auth-provisioning.ts for the full rule.
 *
 * Body: { invite_token? }
 *   Only needed to claim a pre-created profile row with no auth account yet; it
 *   must be an active invite pinned to the session's email for that row's
 *   tenant. `full_name` / `brand` are no longer read.
 * Returns: { ok, tenant_id, profile_id, already_provisioned, relinked? }
 * Refusals: { ok: false, code, error } with 403 / 409.
 */

import { NextResponse, type NextRequest } from "next/server";
import { ProvisioningRefusedError, provisionAuthenticatedUser } from "@/lib/auth-provisioning";
import { getServiceSupabase, getSessionUser } from "@/lib/supabase-server";
import { getTursoClient, tursoConfigured } from "@/lib/turso";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let body: { invite_token?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON" }, { status: 400 });
  }

  const email = user.email;
  if (!email) {
    return NextResponse.json(
      { ok: false, error: "session_email_required" },
      { status: 400 },
    );
  }

  const inviteToken = typeof body.invite_token === "string" ? body.invite_token.trim() : "";
  // tenant_invites lives in Turso. Without it the invite cannot be verified, and
  // an unverifiable invite must not be treated as either valid or absent.
  if (inviteToken && !tursoConfigured()) {
    console.error("[auth/provision] invite presented but Turso is not configured", {
      userId: user.id,
    });
    return NextResponse.json(
      { ok: false, error: "invite_verification_unavailable" },
      { status: 503 },
    );
  }

  try {
    const out = await provisionAuthenticatedUser({
      db: getServiceSupabase(),
      authUserId: user.id,
      email,
      invite: inviteToken ? { rawToken: inviteToken, db: getTursoClient() } : null,
    });
    return NextResponse.json(out);
  } catch (err) {
    if (err instanceof ProvisioningRefusedError) {
      console.warn("[auth/provision] refused", { userId: user.id, code: err.code });
      return NextResponse.json(
        { ok: false, code: err.code, error: err.message },
        { status: err.status },
      );
    }
    console.error("[auth/provision] failed", {
      userId: user.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "provisioning failed" },
      { status: 500 },
    );
  }
}
