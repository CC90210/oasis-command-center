/**
 * founders-gate — session-aware wrapper around the founders check.
 *
 * The decision itself is PURE and lives in lib/founders-marketing-core.ts
 * (`isFounderTenant` / `parseFoundersAllowlist`) so it can be tested with no
 * session, no DB and no env, and so importing it never drags in the server
 * chain. Read the comment there for the SunBiz-leak bug this design prevents.
 *
 * Usage:
 *   pages      → const f = await resolveFounder(); if (!f) notFound();
 *   API routes → if (!(await isFounder())) return NextResponse.json({...}, { status: 404 });
 *
 * 404 and never 403: a 403 confirms the route exists. SunBiz should not learn
 * there is a founders portal at all.
 *
 * Set FOUNDERS_TENANT_IDS in Vercel env to a comma-separated list of tenant
 * UUIDs. While it is unset the portal 404s for everyone, which is the safe
 * default state — including for us.
 */

import { getActiveProfile } from "@/lib/queries";
import { isFounderTenant, parseFoundersAllowlist } from "@/lib/founders-marketing-core";
import { resolveSessionContext } from "@/lib/api-auth";
import { SURFACE_CAPABILITIES, resolvePersona } from "@/lib/role-surfaces";

export { isFounderTenant, parseFoundersAllowlist };

export function foundersAllowlist(): string[] {
  return parseFoundersAllowlist(process.env.FOUNDERS_TENANT_IDS);
}

export type FounderContext = {
  tenantId: string;
  profileId: string;
  displayName: string | null;
  /**
   * The founder's email, for provenance.
   *
   * Two people use this portal — CC and Adon — and a display name is not an
   * identity you can argue with later ("adon" vs "Adon Bousseau" vs null).
   * Every row either of them creates is stamped with this.
   */
  email: string | null;
};

/**
 * Resolves the caller, or null if they are not a founder. Returns null rather
 * than throwing so each caller picks its own failure shape.
 */
export async function resolveFounder(): Promise<FounderContext | null> {
  const profile = await getActiveProfile().catch(() => null);
  if (!profile?.tenant_id) return null;
  if (!isFounderTenant(profile.tenant_id, foundersAllowlist())) return null;
  // THE TENANT CHECK ABOVE IS NECESSARY AND, SINCE 2026-08-19, NOT SUFFICIENT.
  //
  // The comment at the top of this file says the gate keys on tenant identity
  // "never on role, because is_owner/team_role are per-tenant and SunBiz has its
  // own owners". That reasoning is still right about SunBiz and was wrong about
  // us: OASIS is now onboarding OUTSIDE commission-only sales contractors
  // (team_role='agent') INTO OASIS'S OWN WORKSPACE. A tenant-only gate lets
  // every one of them into the founders portal, because they are, by tenant,
  // standing exactly where CC and Adon stand.
  //
  // So the gate is now tenant AND persona — the same composition the rest of
  // the dashboard uses (lib/role-surfaces.ts). Persona resolution is an
  // allowlist that fails closed, so a null / unknown team_role is refused here
  // rather than admitted.
  //
  // Placed in resolveFounder() rather than on the marketing page so it covers
  // every founders route and API caller at once (library, performance, asset,
  // train, ingest) — a per-page check would have been one file away from a hole
  // the next time a founders route is added.
  //
  // 2026-08-21: the persona check was `persona !== "founder"`, which was right
  // when the only people who did marketing WERE the founders. It stopped being
  // right the moment OASIS hired a marketing specialist: their whole job is
  // this portal, and the gate 404'd them out of it. CC reported exactly that
  // for schneur@oasisai.work.
  //
  // The gate now asks the CAPABILITY rather than naming a persona, which is the
  // composition the rest of the dashboard already uses. `canSeeMarketing` is
  // true for founder, marketing and builder, and FALSE for sales and manager —
  // so the protection this gate was written for is untouched: an outside
  // commission-only contractor still cannot reach the founders portal, and now
  // that fact lives in one capability row instead of a hardcoded string here.
  //
  // The BASE capability row is the right thing to read here, not
  // capabilitiesFor(): that function re-applies the OASIS tenant narrowing, and
  // isFounderTenant() three lines above has already established this tenant is
  // on the founders allowlist. Asking again would mean a second slug lookup on
  // every founders route to re-answer a question already answered.
  const session = await resolveSessionContext();
  if (!session.ok) return null;
  const persona = resolvePersona({
    teamRole: session.teamRole,
    isTrueAdmin: session.isTrueAdmin,
    adminAccess: session.adminAccess,
  });
  if (!SURFACE_CAPABILITIES[persona].canSeeMarketing) return null;
  return {
    tenantId: profile.tenant_id,
    profileId: profile.id,
    displayName: profile.display_name || profile.full_name || null,
    email: profile.email || null,
  };
}

/** True when the portal is reachable. Used to decide whether the nav tab renders. */
export async function isFounder(): Promise<boolean> {
  return (await resolveFounder()) !== null;
}
