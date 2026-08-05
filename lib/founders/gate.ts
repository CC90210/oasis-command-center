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

export { isFounderTenant, parseFoundersAllowlist };

export function foundersAllowlist(): string[] {
  return parseFoundersAllowlist(process.env.FOUNDERS_TENANT_IDS);
}

export type FounderContext = {
  tenantId: string;
  profileId: string;
  displayName: string | null;
};

/**
 * Resolves the caller, or null if they are not a founder. Returns null rather
 * than throwing so each caller picks its own failure shape.
 */
export async function resolveFounder(): Promise<FounderContext | null> {
  const profile = await getActiveProfile().catch(() => null);
  if (!profile?.tenant_id) return null;
  if (!isFounderTenant(profile.tenant_id, foundersAllowlist())) return null;
  return {
    tenantId: profile.tenant_id,
    profileId: profile.id,
    displayName: profile.display_name || profile.full_name || null,
  };
}

/** True when the portal is reachable. Used to decide whether the nav tab renders. */
export async function isFounder(): Promise<boolean> {
  return (await resolveFounder()) !== null;
}
