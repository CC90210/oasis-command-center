/**
 * lib/email/brand-for-tenant.ts — which company a tenant's outbound mail is FROM.
 *
 * WHY (2026-09-09). This decision was an inline ternary in one route:
 *
 *     const brand = tenantSlug === "submissions" ? "sunbiz"
 *                 : tenantSlug ? "oasis" : undefined;
 *
 * Two failures in one line. A failed tenant lookup — warned about, not blocked —
 * produced `undefined`, which every downstream helper then read as SunBiz. And
 * EVERY tenant that was not SunBiz was branded OASIS: the live table holds 49
 * tenants, 47 of them self-signup accounts including real third parties (Yoga
 * Tantric LLC, Promptimagica, Sarif' Ai), so any of them sending mail would have
 * claimed to be OASIS AI Solutions, Montreal.
 *
 * FAIL CLOSED. An unmapped tenant returns null and the caller refuses to send.
 * That costs nothing today — of 49 tenants exactly two have ever sent email
 * (submissions: 4,595, oasis-ai-cc: 59) — and it stops a new signup from
 * inheriting a legal identity that is not theirs.
 *
 * MIRRORS scripts/lib/tenant_brand.py in Business-Empire-Agent. The two stacks
 * previously disagreed in opposite directions — Python defaulted unknown to
 * "oasis", TypeScript defaulted unknown to "sunbiz" — so a brand that went
 * missing landed on a different company depending on which side of the stack
 * noticed. Both now refuse instead. Keep the maps identical; the parity is
 * asserted by tests/brand-tenant-parity.test.ts.
 */

import { resolveBrandKeyOrNull, type BrandKey } from "./brands";

/**
 * tenant_id (UUID) -> brand. Verified against the live `tenants` table
 * 2026-09-09.
 *
 * The UUID is the primary key and the slug is display text; they have already
 * drifted once (migration 064 no-op'd because it queried slug 'sun' when
 * SunBiz's tenant slug is 'submissions'). Prefer the UUID where you have it.
 */
export const TENANT_ID_BRAND: Readonly<Record<string, BrandKey>> = {
  "aa04fa1f-ad6a-44b0-ac4b-2ff5d1067110": "sunbiz", // slug "submissions", name "SunBiz"
  "ef8d389e-3f15-43f2-ae00-3660f69a1452": "oasis", // slug "oasis-ai-cc"
  "42423fde-be8b-454f-932a-750e8c9b743d": "oasis", // slug "oasis-webdev"
};

/**
 * tenant/profile slug -> brand.
 *
 * SunBiz's TENANT slug is "submissions"; its dashboard PROFILE slug is "sun".
 * Both are real and they are not interchangeable, so both are listed.
 *
 * EXACT MATCH ONLY. A self-signup tenant exists with the slug
 * "submissions-5f63d7e6", which is a different company that merely shares a
 * prefix with the client's. Never `startsWith` here.
 */
export const TENANT_SLUG_BRAND: Readonly<Record<string, BrandKey>> = {
  submissions: "sunbiz",
  sunbiz: "sunbiz",
  sun: "sunbiz",
  "oasis-ai-cc": "oasis",
  "oasis-webdev": "oasis",
  oasis: "oasis",
};

/**
 * The brand this tenant sends as, or null when we do not know.
 *
 * null means "refuse to send commercial mail", never "use the default". A
 * caller that turns null into a brand reintroduces the defect this module
 * exists to remove.
 */
export function brandForTenant(args: {
  tenantId?: string | null;
  tenantSlug?: string | null;
}): BrandKey | null {
  const id = String(args.tenantId ?? "").trim().toLowerCase();
  const slug = String(args.tenantSlug ?? "").trim().toLowerCase();

  // AN ID THAT IS SUPPLIED BUT UNMAPPED RETURNS NULL. It does not fall through
  // to the slug.
  //
  // The first version of this fell through, which contradicted its own comment
  // that the id "wins" and reopened the hole one layer down: a caller passing
  // { tenantId: <some stranger's workspace>, tenantSlug: "submissions" } would
  // have resolved to SunBiz. The id is the primary key — if we hold one and do
  // not recognise it, that is precisely the case where guessing is worst.
  // (Codex, adversarial review, 2026-09-09.)
  // OWN PROPERTIES ONLY. A plain object inherits from Object.prototype, so
  // TENANT_SLUG_BRAND["constructor"] and ["toString"] return functions —
  // truthy values that are not brands. A tenant slug is attacker-adjacent
  // input (it comes from a row anyone with workspace access can name), and
  // "resolved to a truthy non-brand" is precisely the class of accident this
  // module exists to make impossible. (CodeRabbit, PR #423.)
  const ownId = Object.prototype.hasOwnProperty.call(TENANT_ID_BRAND, id)
    ? TENANT_ID_BRAND[id]
    : undefined;
  const ownSlug = Object.prototype.hasOwnProperty.call(TENANT_SLUG_BRAND, slug)
    ? TENANT_SLUG_BRAND[slug]
    : undefined;

  if (id) {
    if (!ownId) return null;
    // If a slug was ALSO supplied and disagrees, refuse rather than pick one.
    if (slug && ownSlug && ownSlug !== ownId) return null;
    return ownId;
  }

  if (slug) return ownSlug ?? null;
  return null;
}

/**
 * Does a caller-supplied brand agree with the tenant's real one?
 *
 * Returns null when there is nothing to contradict (unknown tenant, or no brand
 * supplied), and an explanation when they genuinely disagree. Mirrors
 * `brand_matches_tenant` in the Python gateway, which refuses the send on a
 * non-null result — the ledger holds two rows where this fired unnoticed
 * (tenant oasis-ai-cc sending as sunbiz 2026-07-10; submissions as oasis
 * 2026-08-01).
 */
export function brandTenantConflict(args: {
  brand?: unknown;
  tenantId?: string | null;
  tenantSlug?: string | null;
}): string | null {
  const expected = brandForTenant(args);
  if (!expected) return null;
  const supplied = resolveBrandKeyOrNull(args.brand);
  if (!supplied) return null;
  if (supplied === expected) return null;
  return (
    `brand "${supplied}" does not match tenant ` +
    `${args.tenantId || args.tenantSlug} (which sends as "${expected}")`
  );
}
