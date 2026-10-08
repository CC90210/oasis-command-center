/**
 * components/os/department/viewer.ts — the session, shaped the way the rail
 * shapes it, for pages that must agree with the rail.
 *
 * app/layout.tsx builds buildOsNav's input from resolveViewerSurface, the
 * workspace manifest and resolveOsModules. The department pages and the AI Team
 * page gate on mayOpenOsHref, so they build the SAME input the same way here.
 * If the two ever disagree, a tab sits over a 404 (or a hidden page opens).
 *
 * Two inputs are passed closed on purpose: `isOperator` and `founders`. No
 * department row uses the `operator`, `founders_content` or `finance_owner`
 * audiences (tests/os-departments.test.ts pins that), so closing them costs a
 * department nothing and saves every page load the operator lookup.
 */

import "server-only";
import { getTenant } from "@/lib/queries";
import { resolveClientProfileSlug } from "@/lib/client-profiles";
import { getManifest } from "@/lib/manifest/loader";
import { isUnprovisionedManifest } from "@/lib/manifest/seeds";
import type { TenantManifest } from "@/lib/manifest/schema";
import { capabilitiesFor, isOasisSurfaceTenant, resolvePersona, type Persona, type SurfaceCapabilities } from "@/lib/role-surfaces";
import { resolveViewerSurface, type ViewerSurface } from "@/lib/role-surfaces-session";
import { chooseActiveProfile, type ActiveUserProfile } from "@/lib/active-profile-resolver";
import { getServiceSupabase, getSessionUser } from "@/lib/supabase-server";
import { dbBool } from "@/lib/db-bool";
import type { BuildOsNavInput } from "@/lib/os/nav";
import { resolveOsModules } from "@/lib/os/modules";

export type OsViewer = {
  ok: true;
  surface: Extract<ViewerSurface, { ok: true }>;
  navInput: BuildOsNavInput;
  /** The viewer's workspace is one of OASIS's own (slug-verified). */
  oasis: boolean;
  provisioned: boolean;
  manifest: TenantManifest;
  /** Session email, for owner-only links. Never used to grant access on its own. */
  email: string | null;
  /** Session auth user id: the verified operator check keys on it, not the email. */
  authUserId: string | null;
};

export type OsViewerResult =
  | OsViewer
  | {
      ok: false;
      /**
       * signed_out: no session/profile/tenant (middleware normally sent them
       *             to /login already).
       * degraded:   the workspace slug could not be read. The rail would
       *             treat it as "not OASIS", which for an OASIS founder hides
       *             Finance and shows the wrong channels — so pages say "we
       *             could not tell" instead of guessing.
       */
      reason: "signed_out" | "degraded";
    };

export async function resolveOsViewer(): Promise<OsViewerResult> {
  const surface = await resolveViewerSurface();
  if (!surface.ok) return { ok: false, reason: "signed_out" };
  if (surface.degraded || !surface.tenantSlug) return { ok: false, reason: "degraded" };

  let manifest: TenantManifest;
  let email: string | null = null;
  let authUserId: string | null = null;
  try {
    const [tenant, user] = await Promise.all([getTenant(surface.tenantId), getSessionUser()]);
    email = user?.email ?? null;
    authUserId = user?.id ?? null;
    // Same manifest the layout renders the shell from: the tenant's profile
    // slug, with the session tenant id for the OASIS alias fallback.
    manifest = await getManifest(resolveClientProfileSlug(tenant), surface.tenantId);
  } catch (err) {
    console.error("[os.viewer.manifest]", err);
    return { ok: false, reason: "degraded" };
  }

  const provisioned = !isUnprovisionedManifest(manifest);
  const oasis = isOasisSurfaceTenant(surface.tenantSlug);
  return {
    ok: true,
    surface,
    oasis,
    provisioned,
    manifest,
    email,
    authUserId,
    navInput: navInputFor(surface.persona, surface.capabilities, surface.tenantSlug, provisioned),
  };
}

function navInputFor(
  persona: Persona,
  capabilities: SurfaceCapabilities,
  tenantSlug: string,
  provisioned: boolean,
): BuildOsNavInput {
  return {
    persona,
    capabilities,
    isOperator: false,
    tenantSlug,
    isOasisTenant: isOasisSurfaceTenant(tenantSlug),
    modules: resolveOsModules({ tenantSlug, provisioned }),
    provisioned,
    founders: null,
  };
}

/**
 * The same rail input for a member a server caller already knows by id: an
 * agent tool inside a chat turn has the session's tenant and auth user
 * (ToolContext), not a request to read cookies from. The persona comes from
 * the member's profile in THIS workspace, the way lib/api-auth.ts
 * resolveSessionContext derives it for a session. No profile here, or a
 * workspace that cannot be read, is { ok: false } — never a guess.
 */
export async function resolveMemberNavInput(
  tenantId: string,
  authUserId: string,
): Promise<{ ok: true; persona: Persona; navInput: BuildOsNavInput } | { ok: false }> {
  if (!tenantId || !authUserId) return { ok: false };
  try {
    const [profiles, tenant] = await Promise.all([
      getServiceSupabase().from("user_profiles").select("*").eq("auth_user_id", authUserId).eq("tenant_id", tenantId).limit(20),
      getTenant(tenantId),
    ]);
    if (profiles.error) throw new Error(profiles.error.message);
    const rows = (profiles.data || []) as ActiveUserProfile[];
    const tenantSlug = tenant?.slug?.trim().toLowerCase() || null;
    if (rows.length === 0 || !tenantSlug) return { ok: false };
    const profile = chooseActiveProfile(rows, null);
    // Fail closed, as resolveSessionContext does: no role is read-only.
    const teamRole = profile.team_role || "read_only";
    // Both flags through dbBool (lib/db-bool.ts), exactly as resolveSessionContext
    // reads them: `!!` read a stored "0" as an owner, `=== true` refused a grant.
    const persona = resolvePersona({
      teamRole,
      isTrueAdmin: dbBool(profile.is_owner) || teamRole === "admin" || teamRole === "owner",
      adminAccess: dbBool(profile.admin_access),
    });
    const manifest = await getManifest(resolveClientProfileSlug(tenant), tenantId);
    const provisioned = !isUnprovisionedManifest(manifest);
    return { ok: true, persona, navInput: navInputFor(persona, capabilitiesFor(persona, tenantSlug), tenantSlug, provisioned) };
  } catch (err) {
    console.error("[os.viewer.member]", err);
    return { ok: false };
  }
}
