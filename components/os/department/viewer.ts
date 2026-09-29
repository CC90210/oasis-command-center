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
import { isOasisSurfaceTenant } from "@/lib/role-surfaces";
import { resolveViewerSurface, type ViewerSurface } from "@/lib/role-surfaces-session";
import { getSessionUser } from "@/lib/supabase-server";
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
    navInput: {
      persona: surface.persona,
      capabilities: surface.capabilities,
      isOperator: false,
      tenantSlug: surface.tenantSlug,
      isOasisTenant: oasis,
      modules: resolveOsModules({ tenantSlug: surface.tenantSlug, provisioned }),
      provisioned,
      founders: null,
    },
  };
}
