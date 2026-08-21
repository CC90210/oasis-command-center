import { NextResponse, type NextRequest } from "next/server";
import { bad } from "@/lib/api-helpers";
import { getAuthedSupabase } from "@/lib/supabase-server";
import {
  canManageTeam,
  createInvite,
  getSessionContext,
  isInvitableRole,
  isTrueAdminRole,
  listActiveInvites,
} from "@/lib/team";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const ctx = await getSessionContext();
  if (!ctx) return bad(401, "unauthorized");
  if (!canManageTeam(ctx.teamRole, ctx.adminAccess)) return bad(403, "forbidden");
  const invites = await listActiveInvites(ctx.tenantId);
  return NextResponse.json({
    ok: true,
    invites: invites.map((i) => ({
      id: i.id,
      email: i.email,
      team_role: i.team_role,
      expires_at: i.expires_at,
      created_at: i.created_at,
    })),
  });
}

export async function POST(req: NextRequest) {
  const ctx = await getSessionContext();
  if (!ctx) return bad(401, "unauthorized");
  if (!canManageTeam(ctx.teamRole, ctx.adminAccess)) return bad(403, "forbidden");

  let body: { role?: string; email?: string | null };
  try {
    body = await req.json();
  } catch {
    return bad(400, "invalid JSON");
  }

  // `body.role` is untrusted request input. isInvitableRole narrows it from
  // unknown to InvitableRole, so nothing below needs a cast — and "owner",
  // which is never invitable, cannot survive this line.
  const role = body.role ?? "member";
  if (!isInvitableRole(role)) {
    return bad(400, "invalid role");
  }
  // ESCALATION GUARD: minting a permanent ADMIN via invite is a TRUE-admin
  // action only. A toggled agent (admin_access) can invite normal teammates but
  // must NOT be able to grant admin — that would be a privilege-escalation loop.
  if (role === "admin" && !isTrueAdminRole(ctx.teamRole, ctx.isOwner)) {
    return bad(403, "forbidden");
  }
  const email = body.email?.trim() || null;

  try {
    const invite = await createInvite({
      tenantId: ctx.tenantId,
      role,
      createdBy: ctx.authUserId,
      email,
    });
    // Audit-log the invite creation (Phase D). Best-effort — never fail
    // the operator-facing request because the audit write hiccuped.
    try {
      const authed = await getAuthedSupabase();
      await authed.rpc("log_tenant_event", {
        p_tenant_id: ctx.tenantId,
        p_action_type: "invite.create",
        p_target_table: "tenant_invites",
        p_target_id: invite.id,
        p_after: { team_role: role, email, expires_at: invite.expiresAt },
      });
    } catch {
      // audit-log soft-fail
    }
    return NextResponse.json({
      ok: true,
      invite: {
        id: invite.id,
        raw_token: invite.rawToken,
        expires_at: invite.expiresAt,
      },
      message: "Copy this token now. It will not be shown again.",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "invite_create_failed";
    return bad(500, msg);
  }
}
