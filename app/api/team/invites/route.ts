import { NextResponse, type NextRequest } from "next/server";
import { bad } from "@/lib/api-helpers";
import { getAuthedSupabase } from "@/lib/supabase-server";
import { sendAuthEmail } from "@/lib/auth-email";
import {
  INVITABLE_ROLES,
  canManageTeam,
  createInvite,
  getSessionContext,
  isTrueAdminRole,
  listActiveInvites,
  supersedeActiveInvites,
  type TeamRole,
} from "@/lib/team";

/** Same shape the reset-password mail uses. Plain text, no tracking, no unsubscribe. */
function inviteEmailBody(args: {
  role: string;
  link: string;
  expiresAt: string;
}): string {
  const expires = new Date(args.expiresAt).toLocaleString("en-US", {
    timeZone: "America/New_York",
    dateStyle: "medium",
    timeStyle: "short",
  });
  return [
    "You have been added to the SunBiz CRM.",
    "",
    `Role: ${args.role}`,
    "",
    "Set your password and sign in here:",
    args.link,
    "",
    `This is a one-time link. It expires ${expires} ET.`,
    "If you were not expecting this, you can ignore this email.",
  ].join("\n");
}

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

  const role = (body.role ?? "member") as TeamRole;
  if (!INVITABLE_ROLES.includes(role as Exclude<TeamRole, "owner">)) {
    return bad(400, "invalid role");
  }
  // ESCALATION GUARD: minting a permanent ADMIN via invite is a TRUE-admin
  // action only. A toggled agent (admin_access) can invite normal teammates but
  // must NOT be able to grant admin — that would be a privilege-escalation loop.
  if (role === "admin" && !isTrueAdminRole(ctx.teamRole, ctx.isOwner)) {
    return bad(403, "forbidden");
  }
  const email = body.email?.trim() || null;
  // A malformed pin is worse than no pin: the invite is minted, the mail bounces,
  // and the address can never satisfy inviteEmailMatchesUser, so the link is dead
  // on arrival with nothing anywhere saying why. Reject it at the door instead.
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return bad(400, "enter a valid email address");
  }

  try {
    // Idempotency: one live invite per (tenant, email, role). A double-click or a
    // retried request supersedes its predecessor rather than leaving two valid
    // seat grants outstanding. See supersedeActiveInvites.
    const superseded = email
      ? await supersedeActiveInvites({
          tenantId: ctx.tenantId,
          role: role as Exclude<TeamRole, "owner">,
          email,
        })
      : 0;

    const invite = await createInvite({
      tenantId: ctx.tenantId,
      role: role as Exclude<TeamRole, "owner">,
      createdBy: ctx.authUserId,
      email,
    });

    const appOrigin = (process.env.PUBLIC_APP_URL || req.nextUrl.origin).replace(/\/+$/, "");
    const inviteLink = `${appOrigin}/invite/${invite.rawToken}`;

    // Dispatch is best-effort BY DESIGN, and the invite is already durable at this
    // point. A mailer outage must not cost the operator the seat grant, and must
    // not silently look like success either: emailSent is returned so the UI can
    // fall back to the manual link. sendAuthEmail already logs the reason.
    // The reason stays in the server log on purpose. SMTP failures quote host and
    // credential detail, and this response goes to a browser.
    let emailSent = false;
    if (email) {
      const sent = await sendAuthEmail({
        to: email,
        subject: "Your SunBiz CRM account",
        text: inviteEmailBody({ role, link: inviteLink, expiresAt: invite.expiresAt }),
      });
      emailSent = sent.ok;
      if (!sent.ok) {
        console.error(
          `[team-invite] email dispatch failed invite=${invite.id} tenant=${ctx.tenantId}: ${sent.error ?? "send_failed"}`
        );
      }
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
          email_sent: emailSent,
          superseded,
        },
      });
    } catch {
      // audit-log soft-fail
    }

    return NextResponse.json({
      ok: true,
      invite: {
        id: invite.id,
        raw_token: invite.rawToken,
        // The canonical link, so the one the operator copies is byte-identical to
        // the one in the email. Rebuilding it client-side from window.location
        // would hand out a preview-domain link whenever an admin is on a preview.
        invite_url: inviteLink,
        expires_at: invite.expiresAt,
        email_sent: emailSent,
        superseded,
      },
      message: !email
        ? "Invite link created. Copy it now, it will not be shown again."
        : emailSent
          ? `Invite emailed to ${email}. Copy the link too, it will not be shown again.`
          : `Invite created, but the email could not be sent. Send this link to ${email} yourself, it will not be shown again.`,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "invite_create_failed";
    return bad(500, msg);
  }
}
