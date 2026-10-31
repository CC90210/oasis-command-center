/**
 * Who may switch a scheduled cloud job on or off (2026-10-31): the agents
 * owner (CC), standing in an OASIS workspace, with system surfaces, an
 * owner/admin role, and verified platform-operator status (the rule behind the
 * /automations page's own requireOperator gate, lib/platform-operator.ts, read
 * for the session's auth user). Shared by POST /api/automations/cloud-jobs and
 * the page mounts (cloudJobsSwitchableForViewer), so a switch is offered
 * exactly when the route accepts it. Everyone else is told nothing (404), like
 * the worker controls.
 */
import "server-only";
import { resolveSessionContext } from "@/lib/api-auth";
import { getTenant } from "@/lib/queries";
import { capabilitiesFor, isOasisSurfaceTenant, resolvePersona } from "@/lib/role-surfaces";
import { resolvePlatformOperatorForAuthUser } from "@/lib/platform-operator";
import { isAgentsOwner } from "@/lib/agents-owner";

export type CloudJobControl =
  | { ok: true; tenantId: string; userId: string }
  | { ok: false; status: 401 | 404; error: "unauthorized" | "not_found" };

/** The lookups, replaceable in tests (tests/cloud-job-switches.test.ts). */
export type CloudJobControlDeps = {
  session?: typeof resolveSessionContext;
  tenant?: (tenantId: string) => Promise<{ slug?: string | null } | null>;
  isOperator?: (authUserId: string, email: string | null) => Promise<boolean>;
  isAgentsOwner?: (tenantId: string, authUserId: string) => Promise<boolean>;
};

const isVerifiedOperator = async (authUserId: string, email: string | null) =>
  (await resolvePlatformOperatorForAuthUser(authUserId, email)).operator;

export async function authorizeCloudJobControl(deps: CloudJobControlDeps = {}): Promise<CloudJobControl> {
  const session = await (deps.session ?? resolveSessionContext)();
  if (!session.ok) return { ok: false, status: 401, error: "unauthorized" };
  const tenant = await (deps.tenant ?? getTenant)(session.tenantId);
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
    !(await (deps.isOperator ?? isVerifiedOperator)(session.userId, session.email)) ||
    !(await (deps.isAgentsOwner ?? isAgentsOwner)(session.tenantId, session.userId))
  ) {
    return { ok: false, status: 404, error: "not_found" };
  }
  return { ok: true, tenantId: session.tenantId, userId: session.userId };
}

/**
 * For a page mount: offer working switches? The same verdict as the toggle
 * route. A failed check offers none (logged); the route re-checks every flip.
 */
export async function cloudJobsSwitchableForViewer(): Promise<boolean> {
  try {
    return (await authorizeCloudJobControl()).ok;
  } catch (err) {
    console.error("[automations.cloud_jobs.can_toggle]", err instanceof Error ? err.message : String(err));
    return false;
  }
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
