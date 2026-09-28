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
import { chooseActiveProfile, type ActiveUserProfile } from "@/lib/active-profile-resolver";
import { isOperatorEmail } from "@/lib/operator-credentials";
import { getTenant } from "@/lib/queries";
import { getServiceSupabase, getSessionUser } from "@/lib/supabase-server";
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
 * The OASIS home tenant (slug `oasis-ai-cc`). A platform operator is a founder
 * HERE — not merely someone whose email is on a list.
 *
 * Declared rather than imported from lib/web-leads/tenant.ts (WEBDEV_TENANT_ID
 * holds the same uuid today): that constant has been repointed once already, to
 * move the web-design leads, and a lead-routing change must never silently move
 * who holds operator powers across every tenant.
 */
export const OASIS_OPERATOR_TENANT_ID = "ef8d389e-3f15-43f2-ae00-3660f69a1452";

export type PlatformOperatorCheck =
  | { operator: true; userId: string }
  | {
      operator: false;
      reason: "no_session" | "not_operator_email" | "not_oasis_founder" | "lookup_failed";
    };

type OperatorProfileRow = ActiveUserProfile & { deactivated_at?: string | null };

/**
 * Is the signed-in AUTH USER a platform operator (P0-7 interim, 2026-09-28)?
 *
 * Both must hold:
 *   1. the session email is an operator alias (isOperatorEmail), and
 *   2. that auth user id is an active owner/admin member of the OASIS tenant.
 *
 * Why (2) exists: isOperatorEmail alone trusts an email string, and signup
 * issues a session to any address with no proof of ownership. Any alias in
 * OPERATOR_EMAIL / ADMIN_EMAILS with no live auth user could be registered by
 * a stranger, who then held operator access to every tenant. A stranger who
 * registers an alias gets their OWN new tenant, never an owner/admin row in
 * OASIS's, so the membership check closes that without a migration. The
 * durable fix is a platform_operators table keyed by auth id (doc 02 P0-7).
 *
 * Membership is read by auth_user_id ONLY. The email fallback in
 * resolveActiveProfileForUser is exactly the path an alias squatter would ride,
 * so it is not used here, and neither is the viewer's ACTIVE profile — CC stays
 * an operator while standing in another workspace.
 *
 * "Owner/admin" is resolvePersona's founder rule with the admin_access toggle
 * forced off: that toggle hands someone the full screen of ONE workspace and
 * explicitly confers no escalation powers, and operator is the biggest one.
 * Duplicate OASIS rows resolve through chooseActiveProfile, the same canonical
 * pick every session makes, so a stale admin duplicate cannot elevate a
 * current non-admin row; a deactivated canonical row is refused.
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
  // Cheap check first: a session that is not on the alias list never costs a
  // database read, which is every client member on every gated request.
  if (!isOperatorEmail(user.email)) return { operator: false, reason: "not_operator_email" };

  let rows: OperatorProfileRow[];
  try {
    const { data, error } = await getServiceSupabase()
      .from("user_profiles")
      .select("id, email, tenant_id, team_role, is_owner, admin_access, onboarding_completed_at, updated_at, deactivated_at")
      .eq("auth_user_id", user.id)
      .eq("tenant_id", OASIS_OPERATOR_TENANT_ID)
      .limit(20);
    if (error) throw new Error(error.message);
    rows = (data || []) as OperatorProfileRow[];
  } catch (err) {
    console.error("[role-surfaces.platform_operator.membership]", err);
    return { operator: false, reason: "lookup_failed" };
  }
  if (rows.length === 0) return { operator: false, reason: "not_oasis_founder" };

  const profile = chooseActiveProfile(rows, user.email) as OperatorProfileRow;
  const founder =
    !profile.deactivated_at &&
    resolvePersona({
      teamRole: profile.team_role,
      // Number(): true and 1 both count, and a stringly "0" cannot read as truthy.
      isTrueAdmin: Number(profile.is_owner) === 1,
      adminAccess: false,
    }) === "founder";
  return founder
    ? { operator: true, userId: user.id }
    : { operator: false, reason: "not_oasis_founder" };
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
