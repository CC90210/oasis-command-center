/**
 * page-gate — the rail's own answer, asked by a page.
 *
 *   const viewer = await requireOsRoute("/clients");   // 404 unless the rail draws /clients
 *
 * WHY THE PAGE ASKS THE RAIL. The rail hides a row with buildOsNav; the page
 * behind it must refuse with the SAME predicate, or a tab sits over a 404 (the
 * one CC found on the marketing hire's screen) or a hidden page quietly works
 * by URL. mayOpenOsHref (lib/os/nav.ts) is that predicate. This file only
 * gathers its inputs from the session, the way app/layout.tsx does for the
 * rail, so the two cannot disagree about persona, workspace or modules.
 *
 * WHAT IT DOES NOT RESOLVE. The founders-portal flags (Growth › Content,
 * Money › Overview) are left closed here: those pages carry their own gates
 * (resolveFounder, resolveFinanceViewer) and must keep calling them. Admin rows
 * are resolved (isPlatformOperator), but admin pages still call
 * requireOperator() themselves as their first statement.
 *
 * Fails closed: no session, no profile, no tenant, an unprovisioned workspace
 * or an unreadable manifest all answer 404. Middleware has already sent a
 * signed-out browser to /login, so no empty state is lost.
 */
import "server-only";

import { notFound } from "next/navigation";
import { getTenant } from "@/lib/queries";
import { resolveClientProfileSlug } from "@/lib/client-profiles";
import { getManifest } from "@/lib/manifest/loader";
import { isUnprovisionedManifest } from "@/lib/manifest/seeds";
import { isOasisSurfaceTenant } from "@/lib/role-surfaces";
import {
  isPlatformOperator,
  resolveViewerSurface,
  type ViewerSurface,
} from "@/lib/role-surfaces-session";
import { mayOpenOsHref, type BuildOsNavInput } from "@/lib/os/nav";
import { resolveOsModules } from "@/lib/os/modules";

export type OsPageViewer = {
  surface: Extract<ViewerSurface, { ok: true }>;
  /** The inputs the rail was built from, for further mayOpenOsHref asks. */
  navInput: BuildOsNavInput;
  /** isOasisSurfaceTenant(surface.tenantSlug): OASIS's own workspace. */
  oasis: boolean;
};

/** Is the viewer's workspace provisioned? Mirrors app/layout.tsx's manifest read. */
async function workspaceProvisioned(tenantId: string): Promise<boolean> {
  try {
    const tenant = await getTenant(tenantId);
    const slug = resolveClientProfileSlug({ slug: tenant?.slug || "", custom_fields: tenant?.custom_fields || {} });
    const manifest = await getManifest(slug, tenantId);
    return !!manifest && !isUnprovisionedManifest(manifest);
  } catch (err) {
    // The loader never throws by contract; if it ever does, the workspace is
    // treated as not set up (Today only) rather than guessed at — logged so a
    // page that 404s for everyone has a reason on record.
    console.error("[os.page-gate.manifest]", err);
    return false;
  }
}

/**
 * The viewer and the rail inputs, or null when the session does not resolve to
 * a member of a workspace. Never throws for a missing session.
 */
export async function resolveOsPageViewer(): Promise<OsPageViewer | null> {
  const surface = await resolveViewerSurface();
  if (!surface.ok) return null;
  const [provisioned, isOperator] = await Promise.all([
    workspaceProvisioned(surface.tenantId),
    // Cheap for everyone who is not on the operator alias list (no DB read).
    isPlatformOperator(),
  ]);
  const oasis = isOasisSurfaceTenant(surface.tenantSlug);
  const navInput: BuildOsNavInput = {
    persona: surface.persona,
    capabilities: surface.capabilities,
    isOperator,
    tenantSlug: surface.tenantSlug,
    isOasisTenant: oasis,
    modules: resolveOsModules({ tenantSlug: surface.tenantSlug, provisioned }),
    provisioned,
    founders: null,
  };
  return { surface, navInput, oasis };
}

/**
 * 404 unless the rail would draw a row for `href` for this viewer. Call it as
 * the page's FIRST statement, before any read: the point is that the data is
 * never fetched, not that it is never painted.
 */
export async function requireOsRoute(href: string): Promise<OsPageViewer> {
  const viewer = await resolveOsPageViewer();
  if (!viewer || !mayOpenOsHref(viewer.navInput, href)) notFound();
  return viewer;
}
