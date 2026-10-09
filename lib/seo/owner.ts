/**
 * Who may use the SEO screen: CC and Adon only (Adon 2026-10-08). Same wall as Money:
 * inside the founders portal (tenant + capability) AND the session's auth user id is the
 * one behind an owner email. The operator list was the old gate; it admits CC's admin
 * aliases and not Adon, which is why the tab was invisible to him.
 *
 * The order and the fail-closed rule live here, with no OCC import, so they are tested
 * and move with the module. lib/seo/occ.ts supplies the three lookups.
 */

export type SeoOwnerDeps = {
  /** The founders portal gate: OASIS tenant AND a marketing-capable persona. */
  inFoundersPortal: () => Promise<boolean>;
  /** The signed-in AUTH user id, or null. */
  sessionUserId: () => Promise<string | null>;
  /** The owner email whose profile is bound to this auth user id, or null. */
  ownerEmailForUser: (userId: string) => Promise<string | null>;
};

/** The owner's email, or null. Any lookup error is a refusal, never an admit. */
export async function resolveSeoOwner(deps: SeoOwnerDeps): Promise<string | null> {
  try {
    if (!(await deps.inFoundersPortal())) return null;
    const userId = await deps.sessionUserId();
    if (!userId) return null;
    return (await deps.ownerEmailForUser(userId)) || null;
  } catch (err) {
    console.error(JSON.stringify({ seo_owner_lookup_failed: (err as Error)?.name ?? "error" }));
    return null;
  }
}
