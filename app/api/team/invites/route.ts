import { NextResponse, type NextRequest } from "next/server";
import { bad } from "@/lib/api-helpers";
import { getAuthedSupabase } from "@/lib/supabase-server";
import { sendAuthEmail } from "@/lib/auth-email";
import { teamInviteEmailText, teamInviteUrl } from "@/lib/team-invite-email";
import { teamRoleLabel } from "@/lib/team-roles";
import {
  invitableRoleOptionsForActor,
  roleAllowedForTenant,
} from "@/lib/role-surfaces";
import {
  canManageTeam,
  createInvite,
  getSessionContext,
  isInvitableRole,
  isTrueAdminRole,
  listActiveInvites,
  normalizeInviteEmail,
  supersedeActiveInvites,
  tenantSlugFor,
} from "@/lib/team";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const ctx = await getSessionContext();
  if (!ctx) return bad(401, "unauthorized");
  if (!canManageTeam(ctx.teamRole, ctx.adminAccess)) return bad(403, "forbidden");
  const [invites, tenantSlug] = await Promise.all([
    listActiveInvites(ctx.tenantId),
    tenantSlugFor(ctx.tenantId),
  ]);
  return NextResponse.json({
    ok: true,
    role_options: invitableRoleOptionsForActor(
      tenantSlug,
      isTrueAdminRole(ctx.teamRole, ctx.isOwner),
    ),
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
  // TENANT GATE. The OASIS sales titles are a product concern, not platform
  // infrastructure, so they may only be granted inside an OASIS workspace. The
  // dropdown already omits them elsewhere, but that is cosmetic — this is what
  // makes a hand-rolled POST of {"role":"closer"} against a SunBiz tenant fail.
  //
  // The slug read happens ONLY on the sales-role path, so the ordinary
  // member/admin invite pays no extra query. An unresolvable slug is treated as
  // "not OASIS" and rejects, which is the fail-closed direction.
  if (!roleAllowedForTenant(role, await tenantSlugFor(ctx.tenantId))) {
    return bad(400, "invalid role");
  }
  // ESCALATION GUARD: minting a permanent ADMIN via invite is a TRUE-admin
  // action only. A toggled agent (admin_access) can invite normal teammates but
  // must NOT be able to grant admin — that would be a privilege-escalation loop.
  if (role === "admin" && !isTrueAdminRole(ctx.teamRole, ctx.isOwner)) {
    return bad(403, "forbidden");
  }
  // Every invite is a bearer credential. Pinning it to one normalized mailbox
  // prevents a forwarded/leaked link from enrolling an unrelated account.
  const email = normalizeInviteEmail(body.email);
  if (!email) return bad(400, "valid teammate email required");

  let superseded = 0;
  try {
    // Fail closed on retries: retire an earlier equivalent grant before
    // minting its replacement. The UI also blocks ordinary double-clicks.
    superseded = await supersedeActiveInvites({
      tenantId: ctx.tenantId,
      email,
    });
    const invite = await createInvite({
      tenantId: ctx.tenantId,
      role,
      createdBy: ctx.authUserId,
      email,
    });
    const inviteUrl = teamInviteUrl(invite.rawToken);
    const delivery = await sendAuthEmail({
      to: email,
      subject: "You're invited to the OASIS AI Command Center",
      text: teamInviteEmailText({
        roleLabel: teamRoleLabel(role),
        inviteUrl,
        expiresAt: invite.expiresAt,
      }),
    });
    if (!delivery.ok) {
      console.error("[team-invite] delivery failed", {
        tenantId: ctx.tenantId,
        inviteId: invite.id,
        code: delivery.code,
      });
    }
    // Audit-log the invite creation (Phase D). Best-effort — never fail
    // the operator-facing request because the audit write hiccuped.
    try {
      const authed = await getAuthedSupabase();
      await authed.rpc("log_tenant_event", {
        p_tenant_id: ctx.tenantId,
        p_action_type: "invite.create",
        p_target_table: "tenant_invites",
        p_target_id: invite.id,
        p_after: {
          team_role: role,
          email,
          expires_at: invite.expiresAt,
          email_sent: delivery.ok,
          superseded,
        },
      });
    } catch {
      // audit-log soft-fail
    }
    return NextResponse.json(
      {
        ok: true,
        invite: {
          id: invite.id,
          invite_url: inviteUrl,
          expires_at: invite.expiresAt,
          email_sent: delivery.ok,
          superseded,
        },
        message: delivery.ok
          ? `Invite emailed to ${email}.`
          : `Invite created, but email delivery failed. Copy the backup link for ${email}.`,
      },
      { status: 201 },
    );
  } catch (err) {
    console.error("[team-invite] create failed", err);
    return bad(
      500,
      superseded > 0
        ? "invite_create_failed_after_previous_revoked"
        : "invite_create_failed",
    );
  }
}
