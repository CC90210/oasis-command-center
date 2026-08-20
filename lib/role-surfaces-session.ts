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
import { getServiceSupabase } from "@/lib/supabase-server";
import {
  capabilitiesFor,
  resolvePersona,
  type Persona,
  type SurfaceCapabilities,
} from "@/lib/role-surfaces";

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
    const db = getServiceSupabase();
    const row = await db
      .from("tenants")
      .select("slug")
      .eq("id", session.tenantId)
      .maybeSingle();
    if (row.error) {
      degraded = true;
    } else {
      const slug = (row.data as { slug?: string | null } | null)?.slug;
      if (slug) tenantSlug = slug.trim().toLowerCase();
      else degraded = true;
    }
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
