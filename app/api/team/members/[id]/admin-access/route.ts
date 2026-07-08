/**
 * PATCH /api/team/members/<id>/admin-access — grant / revoke a member's
 * full-admin toggle (`user_profiles.admin_access`). Admin-toggle design,
 * 2026-07-07.
 *
 * ESCALATION GUARD: the caller MUST be a TRUE admin (owner / admin team_role) —
 * NOT merely an admin_access-toggled agent. This is the switch that mints
 * admin-equivalents, so a temporarily-elevated agent must never be able to
 * operate it (no privilege-escalation loop). Mirrors setMemberRole's guard.
 *
 * Target rules: same tenant as the caller, and NOT the workspace owner
 * (is_owner) — the owner is always admin and can't be "granted" or stripped.
 *
 * Body: { admin_access: boolean }. Writes admin_access + admin_access_granted_by
 * (the caller's profile id) + admin_access_granted_at (now) via the service
 * client, and audit-logs `member.admin_access_change` (mirrors the
 * `member.role_change` audit in ../../route.ts).
 */

import { NextResponse, type NextRequest } from "next/server";
import { bad } from "@/lib/api-helpers";
import { getAuthedSupabase, getServiceSupabase } from "@/lib/supabase-server";
import { getSessionContext, isTrueAdminRole } from "@/lib/team";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSessionContext();
  if (!session) return bad(401, "unauthorized");
  // ESCALATION GUARD — true admins only (excludes the admin_access grant).
  if (!isTrueAdminRole(session.teamRole, session.isOwner)) return bad(403, "forbidden");

  const { id: targetProfileId } = await ctx.params;
  if (!targetProfileId) return bad(400, "missing id");

  let body: { admin_access?: unknown };
  try {
    body = await req.json();
  } catch {
    return bad(400, "invalid JSON");
  }
  if (typeof body.admin_access !== "boolean") return bad(400, "missing admin_access");
  const nextAccess = body.admin_access;

  const supa = getServiceSupabase();
  const { data: target, error: tErr } = await supa
    .from("user_profiles")
    .select("id, is_owner, tenant_id")
    .eq("id", targetProfileId)
    .maybeSingle();
  if (tErr) return bad(500, "lookup_failed");
  if (!target) return bad(404, "member_not_found");
  // Tenant isolation + owner carve-out.
  if (target.tenant_id !== session.tenantId) return bad(403, "forbidden");
  if (target.is_owner) return bad(403, "cannot_toggle_owner");

  const { error: uErr } = await supa
    .from("user_profiles")
    .update({
      admin_access: nextAccess,
      admin_access_granted_by: nextAccess ? session.profileId : null,
      admin_access_granted_at: nextAccess ? new Date().toISOString() : null,
    })
    .eq("id", targetProfileId);
  if (uErr) return bad(500, "update_failed");

  // Audit-log the change (mirrors member.role_change). Best-effort — never fail
  // the operator-facing request because the audit write hiccuped.
  try {
    const authed = await getAuthedSupabase();
    await authed.rpc("log_tenant_event", {
      p_tenant_id: session.tenantId,
      p_action_type: "member.admin_access_change",
      p_target_table: "user_profiles",
      p_target_id: targetProfileId,
      p_after: { admin_access: nextAccess },
    });
  } catch {
    // audit-log soft-fail
  }

  return NextResponse.json({ ok: true, admin_access: nextAccess });
}
