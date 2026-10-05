/**
 * Whose identity does a PUBLIC surface wear, and whose ops lane does it page?
 *
 * This is not a new registry. It is a reader over the one that already exists —
 * lib/email/brand-for-tenant.ts (tenant -> BrandKey, fail-closed) and
 * lib/email/brands.ts (BrandKey -> identity). CLAUDE.md: "one fail-closed map
 * per stack ... Never add a seventh registry." Outbound email has resolved
 * identity this way since 2026-09-09. Every public surface below was still
 * resolving it a different way, and each one of those ways was a hardcoded
 * SunBiz default.
 *
 * WHAT WENT WRONG, MEASURED 2026-09-18
 * ------------------------------------
 * Six independent leaks, one shape. Each picked a company from a module-level
 * constant instead of from the tenant in front of it:
 *
 *   - components/forms/FormPublicClient.tsx rendered <SunMark/> — by its own
 *     doc comment "Gold SunBiz sun glyph" — for any tenant with no logo_url.
 *     All four SunBiz forms set logo_url, so SunBiz never saw it. Both OASIS
 *     forms are NULL, so every OASIS prospect since the funnel launched was
 *     asked for their name and mobile under a lending client's mark.
 *   - lib/forms/themes.ts DEFAULT_PRIMARY_COLOR was #E0A53F, SunBiz Standard
 *     gold, applied to every unbranded form on the platform.
 *   - lib/forms/submit-failure-capture.ts paged SunBiz ops for a blocked
 *     submission whatever tenant it belonged to.
 *   - app/api/track/click/[id]/route.ts sent any tenant's unresolvable email
 *     click to SunBiz's intake form.
 *   - app/layout.tsx served the OASIS favicon on SunBiz's bank-statement
 *     upload page.
 *
 * A shared default standing in for a tenant decision IS the leak. It is not a
 * convenience that happens to be wrong in one place; it is the same defect
 * copied five times, and it generalises to every tenant provisioned tomorrow.
 *
 * FAIL CLOSED, ALWAYS
 * -------------------
 * Every function here returns null for a tenant the map does not know. null
 * means "render nothing / refuse / use a neutral" — it never means "use the
 * default", because "the default" is what put one company's brand on another's
 * page. A caller that turns null back into a brand reintroduces the defect this
 * module exists to remove. That is the same contract brandForTenant() states,
 * and it is stated again here because this is where it will be tempting to
 * break it: a blank logo looks like a bug to whoever is looking at the page,
 * and the wrong logo does not.
 */
import { brandForTenant } from "@/lib/email/brand-for-tenant";
import { BRAND_COMPANY } from "@/lib/email/brand-for-tenant";
import { getBrand, type BrandKey } from "@/lib/email/brands";
import type { TelegramLane } from "@/lib/notify/telegram";

export type TenantRef = {
  tenantId?: string | null;
  tenantSlug?: string | null;
};

/** The company a tenant belongs to. SunBiz and Bluerise are one company. */
export type Company = "oasis" | "sunbiz";

/**
 * Visual identity for a tenant's PUBLIC pages. Null when unmapped.
 *
 * `mark` is deliberately `string | null` even for a mapped tenant: a brand may
 * legitimately have no logo asset (Bluerise's logoUrl is null today), and the
 * correct render for that is no mark, not somebody else's.
 */
export type PublicIdentity = {
  brand: BrandKey;
  company: Company;
  /** Display name for alt text and neutral wordmarks. */
  displayName: string;
  /** Absolute logo URL, or null when this brand has no mark of its own. */
  mark: string | null;
  /** The brand's accent colour. */
  accent: string;
};

/**
 * Resolve a tenant to the identity its public pages should wear.
 *
 * Prefer passing tenantId — the UUID is the primary key and the slug is display
 * text; they have drifted before (migration 064 no-op'd because it queried slug
 * 'sun' when SunBiz's tenant slug is 'submissions').
 */
export function publicIdentityForTenant(ref: TenantRef): PublicIdentity | null {
  const brand = brandForTenant({
    tenantId: ref.tenantId ?? undefined,
    tenantSlug: ref.tenantSlug ?? undefined,
  });
  if (!brand) return null;

  const b = getBrand(brand);
  return {
    brand,
    company: BRAND_COMPANY[brand],
    displayName: b.displayName,
    mark: b.logoUrl ?? null,
    accent: b.accent,
  };
}

/**
 * The logo a tenant's public form header should show, or null for none.
 *
 * Callers MUST render a neutral header when this is null. Rendering any other
 * tenant's mark here is the 2026-09-18 defect.
 */
export function publicMarkForTenant(ref: TenantRef): string | null {
  return publicIdentityForTenant(ref)?.mark ?? null;
}

/**
 * Which ops lane owns an incident on this tenant's surface.
 *
 * null means we could not tell, and an unknown tenant must reach BOTH lanes
 * rather than defaulting to one — a blocked submission nobody is paged about
 * is worse than one two teams see. See notifyLanesForTenant().
 */
export function companyForTenant(ref: TenantRef): Company | null {
  return publicIdentityForTenant(ref)?.company ?? null;
}

/**
 * company -> the Telegram lane that owns it.
 *
 * lib/notify/telegram.ts names lanes by AUDIENCE ("operator" = CC, "sunbiz-ops"
 * = Adon/APEX) rather than by credential, and its fallback chains deliberately
 * stay within a lane. This is the one place the company->audience mapping is
 * written down, so a caller cannot quietly pick the other team's lane.
 */
const COMPANY_LANE: Readonly<Record<Company, TelegramLane>> = {
  oasis: "operator",
  sunbiz: "sunbiz-ops",
};

/**
 * The ops lane(s) to page for an incident on this tenant's surface.
 *
 * Deliberately returns an ARRAY. A blocked form submission on an unmapped
 * tenant used to page SunBiz ops unconditionally: Adon saw failures for
 * merchants he does not own and could not action, while CC — who could have
 * recovered the prospect from the dead-letter payload in minutes — was never
 * told. Fanning an unknown tenant to BOTH lanes is noisy for one team and
 * silent for nobody, which is the right way round for a lost submission. An
 * unknown tenant is common enough to matter: two dead-letter rows in production
 * carry tenant_slug NULL because the client beacon never sent one.
 */
export function notifyLanesForTenant(ref: TenantRef): TelegramLane[] {
  const company = companyForTenant(ref);
  return company ? [COMPANY_LANE[company]] : ["operator", "sunbiz-ops"];
}

/**
 * Where an untrusted or unresolvable public redirect should land for a tenant.
 *
 * Returns null when unmapped; the caller must then send the visitor to a
 * NEUTRAL first-party page, never to a live client's intake form. An OASIS
 * prospect who lands on SunBiz's funding application has been handed to another
 * company, and the row they create pollutes that company's pipeline.
 */
export function safeLandingForTenant(ref: TenantRef): string | null {
  // BRAND, not company. BRAND_COMPANY maps bluerise -> sunbiz, which is right
  // for "whose ops lane owns this incident" and wrong for "whose front door is
  // this". Branching on company here lands a Bluerise prospect on SunBiz
  // Funding's intake form — the same hand-off to another company this function
  // exists to prevent, one level up the map.
  const brand = publicIdentityForTenant(ref)?.brand;
  if (brand === "sunbiz") return "/f/submissions/initial-lead-capture";
  if (brand === "oasis") return "/f/oasis-ai-cc/ai-audit";
  // bluerise has no public funnel of its own. Null sends the visitor to the
  // neutral page, which is correct: no door is better than the wrong door.
  return null;
}

/**
 * Favicon for a tenant's public pages, or null for the neutral platform icon.
 *
 * A SunBiz merchant uploading three months of bank statements should not see
 * OASIS AI's mark in the browser tab, and vice versa.
 */
export function faviconForTenant(ref: TenantRef): string | null {
  // BRAND, not company — see safeLandingForTenant. bluerise maps to company
  // sunbiz, and a Bluerise prospect wearing SunBiz Funding's mark in the tab
  // is the leak this module exists to close, not an acceptable approximation.
  const brand = publicIdentityForTenant(ref)?.brand;
  // Both assets are verified present in public/ — a favicon that 404s is worse
  // than the platform default, because the browser shows a broken-page glyph
  // rather than falling back. sunbiz-logo.png is the square brand mark and
  // works as an icon; when SunBiz ships a dedicated .ico, point this at it.
  if (brand === "sunbiz") return "/brand/sunbiz-logo.png";
  if (brand === "oasis") return "/favicon.ico";
  // bluerise has no icon asset. Null means the platform default, not sunbiz's.
  return null;
}
