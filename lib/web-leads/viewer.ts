import "server-only";

import type { SessionContext } from "@/lib/api-auth";
import { canReadOasisSalesTeamPipeline } from "@/lib/role-surfaces";
import { getOasisSalesRepRoster, tenantSlugFor } from "@/lib/team";
import type { Viewer } from "@/lib/web-leads/data";

type ResolvedSessionContext = Extract<SessionContext, { ok: true }>;

type WebLeadViewerDependencies = {
  resolveTenantSlug: (tenantId: string) => Promise<string | null>;
  listSalesRoster: (
    tenantId: string,
  ) => Promise<readonly { auth_user_id?: string | null }[]>;
};

const DEFAULT_DEPENDENCIES: WebLeadViewerDependencies = {
  resolveTenantSlug: tenantSlugFor,
  listSalesRoster: getOasisSalesRepRoster,
};

/**
 * Convert an already-authenticated session into the viewer contract shared by
 * every read-only Web Leads detail route.
 *
 * Managers receive a roster expansion only when BOTH their role and resolved
 * tenant slug pass the narrow OASIS team-pipeline gate. Admins remain admins
 * without paying for, or depending on, a roster read. Everyone else keeps the
 * ordinary self-scoped viewer shape. Tenant-boundary and roster failures are
 * allowed to surface so a manager never receives a plausible-but-empty team
 * view.
 */
export async function resolveWebLeadViewer(
  session: ResolvedSessionContext,
  dependencies: WebLeadViewerDependencies = DEFAULT_DEPENDENCIES,
): Promise<Viewer> {
  const viewer: Viewer = {
    userId: session.userId,
    teamRole: session.teamRole,
    isAdmin: session.isAdmin,
  };

  if (session.isAdmin || session.teamRole.trim().toLowerCase() !== "manager") {
    return viewer;
  }

  const tenantSlug = await dependencies.resolveTenantSlug(session.tenantId);
  if (!tenantSlug) {
    throw new Error("web_lead_viewer_tenant_slug_unavailable");
  }
  if (
    !canReadOasisSalesTeamPipeline({
      teamRole: session.teamRole,
      tenantSlug,
    })
  ) {
    return viewer;
  }

  const roster = await dependencies.listSalesRoster(session.tenantId);
  const readableAssigneeIds = [
    ...new Set(
      roster.flatMap((member) => {
        const id = member.auth_user_id?.trim().toLowerCase();
        return id ? [id] : [];
      }),
    ),
  ];

  return { ...viewer, readableAssigneeIds };
}
