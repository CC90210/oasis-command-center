import { NextResponse, type NextRequest } from "next/server";
import { bad } from "@/lib/api-helpers";
import { getAuthedSupabase } from "@/lib/supabase-server";
import { getUserIntegrationBundle } from "@/lib/user-integration-store";
import {
  canManageTeam,
  isTrueAdminRole,
  getSessionContext,
  getTenantMembers,
  removeMember,
  setMemberRole,
  type TeamRole,
} from "@/lib/team";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROLE_VALUES: TeamRole[] = [
  "admin",
  "member",
  "agent",
];

const CALENDAR_EVENTS_SCOPE = "https://www.googleapis.com/auth/calendar.events";

async function calendarReadiness(tenantId: string, userId: string | null, profileEmail: string | null) {
  if (!userId) {
    return {
      calendar_connected: false,
      calendar_reconnect_required: false,
      calendar_identity_mismatch: false,
      connected_google_address: null,
    };
  }
  try {
    const bundle = await getUserIntegrationBundle(tenantId, userId, "gmail_oauth");
    const workspaceConnected = Boolean(bundle.refresh_token);
    const scopes = new Set((bundle.scope || "").split(/\s+/u).filter(Boolean));
    const connectedAddress = String(bundle.gmail_address || "").trim().toLowerCase();
    const expectedAddress = String(profileEmail || "").trim().toLowerCase();
    const identityMatches = Boolean(connectedAddress && expectedAddress && connectedAddress === expectedAddress);
    const calendarConnected = workspaceConnected && scopes.has(CALENDAR_EVENTS_SCOPE) && identityMatches;
    return {
      calendar_connected: calendarConnected,
      calendar_reconnect_required: workspaceConnected && !calendarConnected,
      calendar_identity_mismatch: workspaceConnected && Boolean(connectedAddress && expectedAddress) && !identityMatches,
      connected_google_address: connectedAddress || null,
    };
  } catch (err) {
    // Host readiness fails closed. Never include decrypted bundle fields in
    // either the log or the response.
    console.error("[team.members] Google Workspace readiness lookup failed", {
      tenantId,
      userId,
      error: err instanceof Error ? err.message : "lookup_failed",
    });
    return {
      calendar_connected: false,
      calendar_reconnect_required: false,
      calendar_identity_mismatch: false,
      connected_google_address: null,
    };
  }
}

export async function GET() {
  const ctx = await getSessionContext();
  if (!ctx) return bad(401, "unauthorized");
  const members = await getTenantMembers(ctx.tenantId);
  const canManage = canManageTeam(ctx.teamRole, ctx.adminAccess);
  const membersWithCalendar = await Promise.all(
    members.map(async (member) => ({
      member,
      readiness: await calendarReadiness(ctx.tenantId, member.auth_user_id, member.email),
    })),
  );
  return NextResponse.json({
    ok: true,
    self_profile_id: ctx.profileId,
    self_role: ctx.teamRole,
    self_is_owner: ctx.isOwner,
    can_manage: canManage,
    members: membersWithCalendar.map(({ member: m, readiness }) => ({
      id: m.id,
      // auth_user_id is required by the lead-drawer "Assign to" dropdown
      // (Phase 3 of multi-employee personalization, 2026-05-29). Safe to
      // expose to every tenant member — it's the same UUID that surfaces
      // in chat session headers and other already-public identifiers.
      auth_user_id: m.auth_user_id,
      // Tenant teammates need the selected audit host's address so the
      // prefilled Google Calendar event actually invites that founder/closer.
      // This never crosses the tenant boundary and contains no provider secret.
      email: m.email,
      full_name: m.full_name,
      display_name: m.display_name,
      team_role: m.team_role,
      is_owner: m.is_owner,
      joined_at: m.joined_at,
      calendar_connected: readiness.calendar_connected,
      calendar_reconnect_required: readiness.calendar_reconnect_required,
      calendar_identity_mismatch: readiness.calendar_identity_mismatch,
      connected_google_address: readiness.connected_google_address,
    })),
  });
}

export async function PATCH(req: NextRequest) {
  const ctx = await getSessionContext();
  if (!ctx) return bad(401, "unauthorized");
  // ESCALATION GUARD: changing a member's role is a TRUE-admin action only —
  // canManageTeam() WITHOUT adminAccess is strict owner/admin. A toggled agent
  // (admin_access) must NOT be able to grant/alter roles. setMemberRole enforces
  // the same true-admin check internally as the authoritative backstop.
  if (!canManageTeam(ctx.teamRole)) return bad(403, "forbidden");

  let body: { profile_id?: string; role?: string };
  try {
    body = await req.json();
  } catch {
    return bad(400, "invalid JSON");
  }
  if (!body.profile_id) return bad(400, "missing profile_id");
  const newRole = body.role as TeamRole;
  if (!ROLE_VALUES.includes(newRole)) return bad(400, "invalid role");

  try {
    await setMemberRole({
      tenantId: ctx.tenantId,
      targetProfileId: body.profile_id,
      newRole,
      actor: ctx,
    });
    // Audit-log the role change (Phase D).
    try {
      const authed = await getAuthedSupabase();
      await authed.rpc("log_tenant_event", {
        p_tenant_id: ctx.tenantId,
        p_action_type: "member.role_change",
        p_target_table: "user_profiles",
        p_target_id: body.profile_id,
        p_after: { team_role: newRole },
      });
    } catch {
      // audit-log soft-fail
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "update_failed";
    const status =
      msg === "forbidden"
        ? 403
        : msg === "cannot_demote_owner" || msg === "ownership_transfer_not_supported"
          ? 409
          : msg === "member_not_found"
            ? 404
            : 500;
    return bad(status, msg);
  }
}

export async function DELETE(req: NextRequest) {
  const ctx = await getSessionContext();
  if (!ctx) return bad(401, "unauthorized");
  // Member removal is high-consequence; restricted to a PERMANENT admin — the
  // admin_access grant does NOT confer it. Owner protected in removeMember.
  if (!isTrueAdminRole(ctx.teamRole, ctx.isOwner)) return bad(403, "forbidden");
  const url = new URL(req.url);
  const profileId = url.searchParams.get("profile_id");
  if (!profileId) return bad(400, "missing profile_id");
  try {
    await removeMember({
      tenantId: ctx.tenantId,
      targetProfileId: profileId,
      actor: ctx,
    });
    // Audit-log the removal (Phase D).
    try {
      const authed = await getAuthedSupabase();
      await authed.rpc("log_tenant_event", {
        p_tenant_id: ctx.tenantId,
        p_action_type: "member.remove",
        p_target_table: "user_profiles",
        p_target_id: profileId,
      });
    } catch {
      // audit-log soft-fail
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "remove_failed";
    const status =
      msg === "forbidden" ? 403 : msg === "cannot_remove_owner" ? 409 : msg === "member_not_found" ? 404 : 500;
    return bad(status, msg);
  }
}
