/**
 * role-surfaces-session — the session-shaped front door to lib/role-surfaces.
 *
 * Every policy decision lives in lib/role-surfaces.ts, which is pure. This file
 * does the two impure things that policy must never do: read the session, and
 * look up the workspace slug. It then hands both to `capabilitiesFor` and
 * returns the answer. If you find yourself writing a rule here, it belongs
 * next door.
 *
 * SPLIT ON PURPOSE. lib/role-surfaces.ts imports nothing from next/* or the
 * database, so tests/role-surfaces.test.ts can exercise the whole matrix in a
 * bare node process with no credentials — including the fail-closed cases,
 * which are exactly the ones a test with a live session would never reach.
 */

import { notFound } from "next/navigation";
import { resolveSessionContext } from "@/lib/api-auth";
import {
  resolvePlatformOperatorForAuthUser,
  type PlatformOperatorCheck,
} from "@/lib/platform-operator";
import { getTenant } from "@/lib/queries";
import { getSessionUser } from "@/lib/supabase-server";
import {
  capabilitiesFor,
  resolvePersona,
  type Persona,
  type SurfaceCapabilities,
} from "@/lib/role-surfaces";

// The verified operator rule lives in lib/platform-operator.ts so route
// handlers and lib code can use it without loading next/navigation. Re-exported
// here so a page reaches every operator helper from one import.
export {
  OASIS_OPERATOR_TENANT_ID,
  isPlatformOperatorForAuthUser,
  resolvePlatformOperatorForAuthUser,
  type PlatformOperatorCheck,
} from "@/lib/platform-operator";

export type ViewerSurface = {
  ok: true;
  persona: Persona;
  capabilities: SurfaceCapabilities;
  /** auth_user_id — the value leads carry in data.assigned_to. */
  userId: string;
  tenantId: string;
  /** The RAW tenants.slug, lowercased. Null when the lookup failed or found nothing. */
  tenantSlug: string | null;
  teamRole: string;
  /**
   * True when the workspace slug could NOT be established — a DB hiccup, or a
   * profile pointing at a tenant row that no longer exists.
   *
   * This matters because `capabilitiesFor` treats an unknown workspace as "not
   * ours" and switches the money off. That is the right call for safety and the
   * wrong thing to render silently: a founder whose slug lookup blipped would
   * see a dashboard with no revenue on it and no reason given, which reads as
   * "the business made nothing today". Surfaces must say so out loud instead —
   * an absent answer is not a zero.
   */
  degraded: boolean;
} | {
  ok: false;
  reason: "no_session" | "no_profile" | "no_tenant";
};

/**
 * Resolve the viewer's persona and capabilities for the workspace they are
 * standing in.
 *
 * Two reads: the session/profile (via resolveSessionContext) and the tenant
 * slug. The slug read is deliberately NOT wrapped in `safe()` — swallowing its
 * failure would make "this is not an OASIS workspace" and "I could not find out"
 * the same value, and those are different facts with different screens.
 */
export async function resolveViewerSurface(): Promise<ViewerSurface> {
  const session = await resolveSessionContext();
  if (!session.ok) return { ok: false, reason: session.reason };

  let tenantSlug: string | null = null;
  let degraded = false;
  try {
    // P1 instant-load (2026-09-01): reads through the React-cache()d
    // getTenant() instead of firing its own raw `tenants` SELECT. The layout
    // resolves the same tenant on every authenticated render, so this was a
    // duplicate ~140ms Turso round trip on EVERY page that calls
    // resolveViewerSurface (Today, Settings, Pipeline, Health, Analytics,
    // Agents, Operations, Automations, audit-log). Failure semantics are
    // unchanged: a failed or empty read still degrades rather than resolving
    // slug-gated capabilities, and getTenant's null collapses "read failed"
    // and "no row" — both of which already degraded identically here.
    const tenant = await getTenant(session.tenantId);
    const slug = tenant?.slug;
    if (slug) tenantSlug = slug.trim().toLowerCase();
    else degraded = true;
  } catch (err) {
    // Loud, not silent: a persistently broken tenants read is why a founder's
    // money vanished from their own dashboard, and a swallowed exception would
    // make that a mystery instead of a log line.
    console.error("[role-surfaces.tenant_slug]", err);
    degraded = true;
  }

  const persona = resolvePersona({
    teamRole: session.teamRole,
    isTrueAdmin: session.isTrueAdmin,
    adminAccess: session.adminAccess,
  });

  return {
    ok: true,
    persona,
    capabilities: capabilitiesFor(persona, tenantSlug),
    userId: session.userId,
    tenantId: session.tenantId,
    tenantSlug,
    teamRole: session.teamRole,
    degraded,
  };
}

/**
 * Page guard for the system surfaces (/operations, /automations, /health,
 * /analytics, /settings, /agents). Call it as the FIRST statement of the page,
 * before any query — the point is that the data is never fetched, not that it
 * is never painted.
 *
 * 404, never 403, matching the founders-portal precedent: a 403 confirms the
 * route exists, and an outside contractor learning that OASIS runs an internal
 * analytics page is a small leak that costs nothing to avoid.
 *
 * An unresolved session falls through rather than 404ing, so the existing
 * sign-in redirects and empty states on each page keep working unchanged.
 */
export async function requireSystemSurface(): Promise<void> {
  const surface = await resolveViewerSurface();
  if (surface.ok && !surface.capabilities.canSeeSystemSurfaces) notFound();
}

/**
 * Is the signed-in AUTH USER a platform operator (P0-7 interim, 2026-09-28)?
 *
 * Reads the session, then applies lib/platform-operator.ts
 * resolvePlatformOperatorForAuthUser — the alias AND an active owner/admin
 * OASIS membership read by auth_user_id. The full rule and the reasons for each
 * half are documented there; this function adds only the session read.
 *
 * Fails CLOSED: any session or profile lookup error is logged and answers
 * "not an operator".
 */
export async function resolvePlatformOperator(): Promise<PlatformOperatorCheck> {
  let user: Awaited<ReturnType<typeof getSessionUser>>;
  try {
    user = await getSessionUser();
  } catch (err) {
    console.error("[role-surfaces.platform_operator.session]", err);
    return { operator: false, reason: "lookup_failed" };
  }
  if (!user?.id) return { operator: false, reason: "no_session" };
  return resolvePlatformOperatorForAuthUser(user.id, user.email);
}

/** Boolean form of resolvePlatformOperator, for callers that only branch. */
export async function isPlatformOperator(): Promise<boolean> {
  return (await resolvePlatformOperator()).operator;
}

/**
 * Page guard for operator-only admin surfaces (/runs, /inbox, /reasoning,
 * /system-health). Call it as the FIRST statement of the page, before any
 * query, exactly like requireSystemSurface.
 *
 * Unlike requireSystemSurface, an unresolved session also 404s: these pages
 * belong to no persona of any client workspace, so there is no empty state to
 * preserve, and middleware has already sent a signed-out browser to /login.
 */
export async function requireOperator(): Promise<void> {
  if (!(await isPlatformOperator())) notFound();
}
