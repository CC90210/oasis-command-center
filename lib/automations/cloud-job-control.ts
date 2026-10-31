/**
 * Who may switch a scheduled cloud job on or off (2026-10-31): the agents
 * owner (CC), standing in an OASIS workspace, with system surfaces and an
 * owner/admin role. Shared by POST /api/automations/cloud-jobs and the
 * Automations card, so a switch is offered exactly when the route accepts it.
 * Everyone else is told nothing (404), like the worker controls.
 */
import "server-only";
import { resolveSessionContext } from "@/lib/api-auth";
import { getTenant } from "@/lib/queries";
import { capabilitiesFor, isOasisSurfaceTenant, resolvePersona } from "@/lib/role-surfaces";
import { isAgentsOwner } from "@/lib/agents-owner";

export type CloudJobControl =
  | { ok: true; tenantId: string; userId: string }
  | { ok: false; status: 401 | 404; error: "unauthorized" | "not_found" };

export async function authorizeCloudJobControl(): Promise<CloudJobControl> {
  const session = await resolveSessionContext();
  if (!session.ok) return { ok: false, status: 401, error: "unauthorized" };
  const tenant = await getTenant(session.tenantId);
  const tenantSlug = tenant?.slug?.trim().toLowerCase() || null;
  const persona = resolvePersona({
    teamRole: session.teamRole,
    isTrueAdmin: session.isTrueAdmin,
    adminAccess: session.adminAccess,
  });
  if (
    !isOasisSurfaceTenant(tenantSlug) ||
    !capabilitiesFor(persona, tenantSlug).canSeeSystemSurfaces ||
    !(session.isTrueAdmin || session.adminAccess) ||
    !(await isAgentsOwner(session.tenantId, session.userId))
  ) {
    return { ok: false, status: 404, error: "not_found" };
  }
  return { ok: true, tenantId: session.tenantId, userId: session.userId };
}

/**
 * CSRF defence for this cookie-authenticated write: the Origin (or, failing
 * that, the Referer) must name this host. Missing or unparseable headers fail
 * closed. Same rule as lib/calendar/http.ts sameOrigin.
 */
export function sameOrigin(req: Request): boolean {
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (!host) return false;
  const source = req.headers.get("origin") ?? req.headers.get("referer");
  if (!source) return false;
  try {
    return new URL(source).host === host;
  } catch {
    return false;
  }
}
