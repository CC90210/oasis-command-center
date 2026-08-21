import { Card, PageHeader, EmptyState } from "@/components/Card";
import { UsersRound } from "lucide-react";
import {
  canManageTeam,
  getSessionContext,
  getTenantMembers,
  INVITE_TTL_DAYS,
  isTrueAdminRole,
  listActiveInvites,
  tenantSlugFor,
} from "@/lib/team";
import { invitableRoleOptionsFor } from "@/lib/role-surfaces";
import { computeSeatWarning } from "@/lib/seat-warning";
import {
  TeamInviteActions,
  RemoveMemberClientButton,
  AdminAccessToggle,
} from "./TeamInviteActions";
import { redirect } from "next/navigation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROLE_LABEL: Record<string, string> = {
  owner: "Owner",
  admin: "Admin",
  agent: "Agent",
  loan_officer: "Loan officer",
  processor: "Processor",
  read_only: "Read only",
  member: "Member",
};

export default async function TeamPage() {
  const ctx = await getSessionContext();
  if (!ctx) redirect("/login?next=%2Fteam");

  const canManage = canManageTeam(ctx.teamRole, ctx.adminAccess);
  // Only a TRUE admin (owner/admin base role — NOT an admin_access-toggled agent)
  // may grant/revoke the admin-access switch. Mirrors the endpoint's escalation
  // guard so the control never renders for someone the API would 403.
  const canGrantAdmin = isTrueAdminRole(ctx.teamRole, ctx.isOwner);
  const [members, invites, seatWarning, tenantSlug] = await Promise.all([
    getTenantMembers(ctx.tenantId),
    canManage ? listActiveInvites(ctx.tenantId) : Promise.resolve([]),
    canManage ? computeSeatWarning(ctx.tenantId) : Promise.resolve(null),
    canManage ? tenantSlugFor(ctx.tenantId) : Promise.resolve(null),
  ]);
  // The OASIS sales titles appear only in an OASIS workspace. Resolved here, on
  // the server, so the client component never carries the tenant rules — and so
  // the menu cannot offer a role the invite API would reject.
  const roleOptions = [...invitableRoleOptionsFor(tenantSlug)];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Team"
        subtitle={canManage ? "Invite, manage, and remove team members." : "Members on this tenant."}
      />

      {canManage && seatWarning && seatWarning.status !== "ok" && (
        <div
          className={`rounded-lg border px-4 py-3 text-sm ${
            seatWarning.status === "over"
              ? "border-status-warm/40 bg-status-warm/10 text-status-warm"
              : "border-accent/40 bg-accent/5 text-accent"
          }`}
        >
          {seatWarning.message}
        </div>
      )}

      {canManage && (
        <Card
          title="Invite a teammate"
          subtitle={
            seatWarning && seatWarning.status === "ok"
              ? `${seatWarning.message} Generate a one-time invite link.`
              : "Generate a one-time invite link."
          }
        >
          <TeamInviteActions roleOptions={roleOptions} activeInvites={invites.map((i) => ({
            id: i.id,
            email: i.email,
            team_role: i.team_role,
            expires_at: i.expires_at,
          }))} />
        </Card>
      )}

      <Card
        title="Members"
        subtitle={`${members.length} on the team`}
      >
        {members.length === 0 ? (
          <EmptyState message="The team is empty." />
        ) : (
          <ul className="divide-y divide-bg-border">
            {members.map((m) => (
              <li
                key={m.id}
                className="grid grid-cols-[1fr_7rem_11rem] gap-4 py-3 items-center"
              >
                <div>
                  <div className="font-semibold text-fg flex items-center gap-2 flex-wrap">
                    {m.display_name || m.full_name || m.email}
                    {m.is_owner && (
                      <span className="text-[10px] uppercase tracking-wider text-accent font-mono">
                        owner
                      </span>
                    )}
                    {!m.is_owner && m.admin_access && (
                      <span
                        className="text-[10px] uppercase tracking-wider text-status-warm font-mono"
                        title="Full admin access granted by an admin"
                      >
                        admin (granted)
                      </span>
                    )}
                    {m.id === ctx.profileId && (
                      <span className="text-[10px] uppercase tracking-wider text-fg-dim font-mono">
                        you
                      </span>
                    )}
                  </div>
                  {canManage && m.email && (
                    <div className="text-xs text-fg-muted font-mono mt-0.5">{m.email}</div>
                  )}
                </div>
                <div className="text-sm text-fg-muted">
                  {ROLE_LABEL[m.team_role] ?? m.team_role}
                </div>
                <div className="flex items-center justify-end gap-2 text-xs text-fg-dim">
                  {canGrantAdmin && !m.is_owner && (
                    <AdminAccessToggle profileId={m.id} initialGranted={m.admin_access} />
                  )}
                  {/* Removal is a true-admin action (not conferred by admin_access), matching the server gate. */}
                  {canGrantAdmin && !m.is_owner && m.id !== ctx.profileId && (
                    <RemoveMemberClientButton profileId={m.id} />
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {!canManage && (
        <Card title="Want to invite teammates?" subtitle="Ask an admin or the tenant owner.">
          <p className="text-sm text-fg-muted">
            Only owners and admins can generate invite links. Talk to your owner if you
            need to expand the team.
          </p>
        </Card>
      )}

      <div className="text-xs text-fg-dim flex items-center gap-2">
        <UsersRound className="w-4 h-4" />
        <span>
          Invites are single-use, hashed at rest, and expire after {INVITE_TTL_DAYS}{" "}
          days.
        </span>
      </div>
    </div>
  );
}

