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
 *     the user_id's email matches the invite's pinned email (when
 *     pinned), so an attacker holding a stale token can't redeem it
 *     onto an unrelated account.
 *   - For non-pinned invites the security floor is the same as the
 *     existing /signup flow: anyone with the raw token can sign up.
 *     This route does not widen that surface.
 */

import { NextResponse, type NextRequest } from "next/server";
import { redeemInvite } from "@/lib/team";
import { resolveClientProfileSlug } from "@/lib/client-profiles";
import { getServiceSupabase } from "@/lib/supabase-server";
import { adminConfirmEmail } from "@/lib/turso-auth-admin";

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

  // 1. Auto-confirm the email. The invitee clicked a personalized link
  //    sent to this address — that's already proof of possession.
  //
  //    adminConfirmEmail replaces auth.admin.updateUserById: under Turso it
  //    stamps _supabase_auth_users.email_confirmed_at, under Supabase it still
  //    calls GoTrue. It fails — rather than reporting a no-op success — when
  //    the user id does not resolve to a live account, which is the guard that
  //    keeps step 2 from redeeming an invite onto a phantom user.
  const confirmed = await adminConfirmEmail(db, userId);
  if (!confirmed.ok) {
    return NextResponse.json(
      { ok: false, error: "email_confirm_failed", message: confirmed.error },
      { status: 500 },
    );
  }

  // 2. Redeem the invite. redeemInvite() validates the token + checks
  //    the user's email matches the invite's pinned email (when set).
  const result = await redeemInvite(rawToken, userId);
  if (!result.ok) {
    return NextResponse.json(
      { ok: false, error: "redeem_failed", message: result.error },
      { status: 400 },
    );
  }

  // 3. Set primary_agent + agents_enabled from the tenant manifest. The
  //    redeem RPC stamps platform defaults (primary_agent='bravo',
  //    agents_enabled=['bravo']) on new profile rows; for tenants like
  //    SunBiz whose actual agent package is [solara, helios], that leaves
  //    the new invitee chatting with the wrong persona AND with Bravo
  //    surfacing in the /agent chat picker (which reads agents_enabled).
  //
  //    BOTH columns must be overwritten — fixing primary_agent alone left
  //    agents_enabled stuck at ['bravo'], so the chat shell still rendered
  //    Bravo as the user's enabled agent. Caught 2026-06-01 when a SunBiz
  //    user was about to ship without this fix.
  //
  //    Soft-fail — if the manifest is missing or carries no enabled agents,
  //    leave the profile as-is (default 'bravo' is at least functional).
  try {
    const { data: manifestRow } = await db
      .from("tenant_manifests")
      .select("manifest")
      .eq("tenant_id", result.tenantId)
      .maybeSingle();
    const manifest = manifestRow?.manifest as { agents?: Array<{ slug: string; primary?: boolean; enabled?: boolean }> } | null;
    const enabledSlugs = (manifest?.agents || [])
      .filter((a) => a.enabled !== false)
      .map((a) => a.slug);
    const primarySlug = manifest?.agents?.find((a) => a.primary && a.enabled !== false)?.slug;
    const patch: Record<string, unknown> = {};
    if (primarySlug) patch.primary_agent = primarySlug;
    if (enabledSlugs.length > 0) patch.agents_enabled = enabledSlugs;
    if (Object.keys(patch).length > 0) {
      await db
        .from("user_profiles")
        .update(patch)
        .eq("auth_user_id", userId);
    }
  } catch {
    // Manifest lookup is best-effort; default 'bravo' is a safe fallback.
  }

  // Resolve the tenant's Command Center profile slug so the signup page
  // can route the invitee directly to /t/<slug> after the bounce through
  // /login. Skips the redundant new-tenant wizard (2026-05-29 fix).
  let tenantSlug: string | null = null;
  try {
    const { data: tenant } = await db
      .from("tenants")
      .select("slug, custom_fields")
      .eq("id", result.tenantId)
      .maybeSingle();
    if (tenant) tenantSlug = resolveClientProfileSlug(tenant);
  } catch {
    // Soft-fail — null slug just routes through "/" which the welcome
    // page's own redirect (added in this same commit) catches.
  }

  return NextResponse.json({
    ok: true,
    tenant_id: result.tenantId,
    team_role: result.teamRole,
    tenant_slug: tenantSlug,
  });
}
