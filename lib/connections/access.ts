/**
 * lib/connections/access.ts — who may manage a workspace's connections.
 *
 * PURE: the decision is made from the resolved session, never from anything a
 * request body says. The same rule as the Settings › Connections hub
 * (components/settings/settings-sections.ts canManageWorkspaceSettings): an
 * owner or admin (including the admin_access grant an admin hands out), on a
 * persona that may see system surfaces and act. Everyone else is refused — the
 * hub never shows them the workspace cards, and the API matches.
 */
import { SURFACE_CAPABILITIES, resolvePersona } from "@/lib/role-surfaces";

export type ConnectionsSession = {
  teamRole: string;
  isAdmin: boolean;
  isTrueAdmin: boolean;
  adminAccess: boolean;
};

export function mayManageConnections(session: ConnectionsSession): boolean {
  if (!session.isAdmin) return false;
  const persona = resolvePersona({
    teamRole: session.teamRole,
    isTrueAdmin: session.isTrueAdmin,
    adminAccess: session.adminAccess,
  });
  const caps = SURFACE_CAPABILITIES[persona];
  return caps.canSeeSystemSurfaces && caps.canAct;
}
