/**
 * PORTAL REGISTRY — the single declaration of what software lives in this
 * deployment and which files belong to which piece of it.
 *
 * WHY
 * The command center hosts several portals at once. Adon, 2026-08-03:
 *
 *   "Those are two very separate pieces of software that we're going to be
 *    building basically synonymously. I want to be able to tell you, 'Okay push
 *    this to the Sun Biz funding software' / 'push to the Oasis AI portal'...
 *    It's about separation. We need to ensure that there's no data leakage...
 *    going forward when we add real estate there's a different portal."
 *
 * Without a declaration, "push this to SunBiz" is a vibe. With one it is a
 * checkable fact: a change belongs to a portal if every path it touches is
 * owned by that portal or by SHARED. `tests/portal-boundaries.test.ts` enforces
 * it as a static property of the whole tree, so a cross-portal import fails the
 * build instead of being noticed in review, or not at all.
 *
 * WHAT THIS IS NOT
 * This does not create separate deployments. Every portal ships from one Vercel
 * project (`agent-dashboard`) on one push to `main`. This registry governs CODE
 * ownership and import boundaries, which is what actually prevents leakage.
 * True deploy isolation would mean separate Vercel projects or microfrontends —
 * a much larger change, deliberately not made here. See docs/PORTALS.md.
 *
 * ADDING A PORTAL (e.g. real estate)
 *   1. Add an entry below with its own `routePrefix` and `owns` paths.
 *   2. Create app/<prefix>/ and lib/<id>/ following the founders example.
 *   3. Run `npm run test:sunbiz` — the boundary test picks it up automatically.
 */

import type { NavIconKey } from "@/lib/nav-config";

export type PortalId = "founders" | "oasis" | "sunbiz" | "shared";

export type PortalSection = {
  href: string;
  label: string;
  /** false renders the chip greyed and unclickable — honest about what is not built. */
  enabled: boolean;
};

export type Portal = {
  id: PortalId;
  label: string;
  tagline: string;
  /** URL prefix this portal owns, or null for shared infrastructure. */
  routePrefix: string | null;
  /**
   * Tenant slugs this portal serves. The founders portal serves none: it is not
   * a tenant of the platform, it is the platform owner's own tooling.
   */
  tenantSlugs: string[];
  /**
   * Repo-relative path prefixes this portal OWNS. Forward slashes.
   * A file under one portal's `owns` may not be imported by another portal.
   */
  owns: string[];
  sections: PortalSection[];
};

/**
 * OASIS's own tooling. Not a tenant, not a product, never sold. Gated by
 * FOUNDERS_TENANT_IDS — see lib/founders/gate.ts.
 */
/**
 * FEATURE 1 SWITCH — is the founders Growth module operational yet?
 *
 * PR #175 shipped /founders/growth as an inactive preview shell and, in the
 * same commit, put it in the nav labelled "Marketing" while renaming the live
 * hub at /founders/marketing to "Content". CC, 2026-08-13: "For some reason,
 * there's a duplication... There are now two tabs for this: Content and
 * Marketing."
 *
 * He is right, and it is worse than a spare tab: BOTH pages render an <h1> of
 * "Marketing" (app/founders/marketing/page.tsx and app/founders/growth/page.tsx),
 * and each nav label contradicted its own route — the URL saying marketing was
 * labelled Content, the URL saying growth was labelled Marketing. Every future
 * "fix the marketing page" would inherit that ambiguity.
 *
 * So the naming is a FUNCTION of this flag, not a hardcoded pair:
 *
 *   false (today) → ONE entry: /founders/marketing, labelled "Marketing".
 *                   Route, nav label, <h1> and <title> finally agree.
 *   true          → #175's split returns: "Content" + "Marketing".
 *
 * Flipping this one boolean is the entirety of shipping Feature 1's navigation.
 *
 * The growth section is OMITTED rather than set `enabled: false`, which is the
 * tempting one-line version: a disabled section still renders — as a greyed,
 * unclickable chip (see PortalSection.enabled and app/founders/layout.tsx). That
 * is still a second visible tab reading "Marketing", so it would not actually
 * have answered CC's complaint. The route itself stays reachable by direct URL
 * and still fails closed for non-founders, so APEX keeps their preview surface.
 *
 * WHY HERE and not lib/founders/growth-shell.ts, where the constant was born:
 * this file is SHARED infrastructure, and shared code may not import a portal
 * (isImportAllowed, enforced by tests/portal-boundaries.test.ts). The nav is the
 * consumer and the nav lives here, so the switch lives here. growth-shell.ts
 * re-exports it — founders → shared is legal — so every existing import, and
 * APEX's own test, keep working unchanged.
 */
export const MARKETING_SHELL_ACTIVE = false as const;

/**
 * The founders portal's TOP-LEVEL destinations — the one declaration both navs
 * read. app/layout.tsx renders these as sidebar rows; app/founders/layout.tsx
 * renders them, plus the sub-sections below, as header chips.
 *
 * Maven's handover, 2026-08-13: "whoever resolves the naming should take both
 * nav files in one commit, so the sidebar and the header tabs can never
 * disagree." One commit is the weak form of that — they could drift apart again
 * on the next edit. This is the structural form: there is now only one list, so
 * disagreement is not expressible.
 */
export const FOUNDERS_NAV: ReadonlyArray<{
  href: string;
  label: string;
  icon: NavIconKey;
}> = MARKETING_SHELL_ACTIVE
  ? [
      { href: "/founders/marketing", label: "Content", icon: "Megaphone" },
      { href: "/founders/growth", label: "Marketing", icon: "BarChart3" },
    ]
  : [{ href: "/founders/marketing", label: "Marketing", icon: "Megaphone" }];

export const FOUNDERS_PORTAL: Portal = {
  id: "founders",
  label: "OASIS · Founders Portal",
  tagline: "Our own marketing, ops and intelligence. Not a tenant surface.",
  routePrefix: "/founders",
  tenantSlugs: [],
  owns: ["app/founders/", "lib/founders/", "lib/founders-marketing-core.ts", "components/founders/"],
  sections: [
    ...FOUNDERS_NAV.map((n) => ({ href: n.href, label: n.label, enabled: true })),
    { href: "/founders/marketing/library", label: "Library", enabled: true },
    { href: "/founders/marketing/train", label: "Train", enabled: true },
    { href: "/founders/marketing/performance", label: "Performance", enabled: false },
  ],
};

/**
 * OASIS AI's own product surface: the public marketing website, the agency lead
 * lifecycle, and CC's empire observability. Distinct from the FOUNDERS portal —
 * this is the OASIS-tenant-facing software, that is the private founders tool.
 *
 * NOTE the two "marketing" namespaces, which is a genuine trap:
 *   lib/marketing/       = the PUBLIC marketing website (oasis-owned)
 *   lib/founders-*       = the founders' internal marketing studio
 */
export const OASIS_PORTAL: Portal = {
  id: "oasis",
  label: "OASIS AI",
  tagline: "Agency surface and public site.",
  routePrefix: null, // shared top-level routes + /t/oasis/ + app/(marketing)/
  tenantSlugs: ["oasis", "oasis-ai-cc"],
  owns: [
    "app/(marketing)/",
    "components/marketing/",
    "components/landing/",
    "lib/marketing/",
    "lib/oasis-",
  ],
  sections: [],
};

/**
 * SunBiz Funding — the lending CRM. A TENANT of the platform, sold and
 * operated. Its own nav, its own agents, its own data.
 *
 * `owns` lists directories and prefixes that are UNAMBIGUOUSLY SunBiz. It is
 * deliberately incomplete rather than aggressive: a prefix that also captures a
 * shared file (e.g. a bare `lib/lead-` would swallow the shared
 * `lib/lead-scope.ts`) would fail the build for every other session on a claim
 * that is not true. Ownership is tightened as each area is verified.
 */
export const SUNBIZ_PORTAL: Portal = {
  id: "sunbiz",
  label: "Sun Biz Funding",
  tagline: "Lending CRM.",
  routePrefix: null, // served from shared top-level routes + /t/sun/
  tenantSlugs: ["sun", "sunbiz", "submissions"],
  owns: [
    // whole directories, unambiguous
    "lib/lenders/",
    "lib/underwriting/",
    "lib/drips/",
    "lib/renewals/",
    "lib/applications/",
    "lib/esign/",
    "lib/clair/",
    "lib/background-check/",
    "lib/cold-outreach/",
    "lib/import/",
    "lib/renewals-core.ts",
    "lib/sunbiz-",
    "components/sunbiz/",
    "components/lenders/",
    "components/underwriting/",
    "components/shop-out/",
    "components/shopping-out/",
    "components/offers/",
    "components/renewals/",
    "components/drips/",
    "components/applications/",
    "components/esign/",
    "components/import/",
  ],
  sections: [],
};

export const PORTALS: Portal[] = [FOUNDERS_PORTAL, OASIS_PORTAL, SUNBIZ_PORTAL];

/**
 * Infrastructure any portal may import: auth, tenancy, the manifest system,
 * supabase clients, the shell, shared UI primitives. Everything not owned by a
 * portal and not listed here is unclassified, which the boundary test reports
 * rather than silently allowing.
 */
export const SHARED_PREFIXES = [
  "lib/supabase",
  "lib/api-auth",
  "lib/api-helpers",
  "lib/queries",
  "lib/manifest/",
  "lib/nav-config",
  "lib/portals/",
  "lib/role-gates",
  "lib/tenant-access",
  "lib/path-prefix",
  "lib/secret-redaction",
  "lib/llm-input-boundary",
  "lib/bridge-infer",
  "components/Card",
  "components/Sidebar",
  "components/SidebarShell",
  "components/MainShell",
  "components/brand/",
];

/**
 * Cross-portal imports that ALREADY EXIST. Recorded, not hidden.
 *
 * The boundary test fails on any NEW violation and skips these, so the rule can
 * land without a risky refactor of shared production code that every tenant and
 * every sibling session depends on.
 *
 * It also asserts each entry is STILL a real violation, so a fixed one must be
 * deleted from this list rather than rotting here and quietly re-permitting the
 * import later. Same discipline as a secrets baseline.
 *
 * Each entry needs a reason and an explicit owner decision. Do not add to this
 * list to make a build pass.
 */
export const KNOWN_BOUNDARY_DEBT: ReadonlyArray<{
  from: string;
  to: string;
  reason: string;
}> = [
  // Empty. The one entry that lived here — lib/manifest/data.ts importing
  // @/lib/drips/stage-cancel — was fixed properly on 2026-08-03 by introducing
  // the composition root below, not grandfathered. See lib/portals/stage-hooks.ts.
];

/**
 * COMPOSITION ROOTS — the only files permitted to import across portals.
 *
 * Something has to know about every portal in order to wire them together. The
 * boundary rule does not pretend otherwise; it confines that knowledge to a
 * short, named list instead of letting it seep into shared infrastructure.
 *
 * A composition root's ONLY job is wiring. If one starts containing portal
 * logic, extract the logic back into the portal that owns it.
 *
 * Keep this list very short. Every entry is a permanent, deliberate exception,
 * and the boundary test asserts they all live under lib/portals/ so they are
 * findable in one place.
 */
export const COMPOSITION_ROOTS = ["lib/portals/stage-hooks.ts"] as const;

export function isCompositionRoot(path: string): boolean {
  const p = path.replace(/\\/g, "/");
  return (COMPOSITION_ROOTS as readonly string[]).includes(p);
}

function isKnownDebt(from: string, to: string): boolean {
  const f = from.replace(/\\/g, "/");
  const t = to.replace(/\\/g, "/");
  return KNOWN_BOUNDARY_DEBT.some((d) => d.from === f && d.to === t);
}

/** Which portal owns a repo-relative path, or null if shared/unclassified. */
export function portalForPath(path: string): PortalId | null {
  const p = path.replace(/\\/g, "/");
  for (const portal of PORTALS) {
    if (portal.owns.some((o) => p.startsWith(o))) return portal.id;
  }
  return null;
}

/** True when a path is explicitly shared infrastructure. */
export function isSharedPath(path: string): boolean {
  const p = path.replace(/\\/g, "/");
  return SHARED_PREFIXES.some((s) => p.startsWith(s));
}

/**
 * The boundary rule, as a pure function so the test and any future lint rule
 * agree by construction.
 *
 * Legal:  founders -> founders, founders -> shared, sunbiz -> sunbiz, ...
 * Illegal: founders -> sunbiz, sunbiz -> founders  (either direction)
 *
 * Shared code importing a portal is ALSO illegal: shared infrastructure that
 * reaches into one portal is no longer shared, and is how a "platform" file
 * quietly becomes SunBiz-only.
 */
export function isImportAllowed(
  fromPath: string,
  toPath: string,
): { allowed: true } | { allowed: false; reason: string } {
  const from = portalForPath(fromPath);
  const to = portalForPath(toPath);

  // Composition roots exist precisely to wire portals together. This is the one
  // sanctioned way to cross the boundary, and the list is deliberately tiny.
  if (isCompositionRoot(fromPath)) return { allowed: true };

  // Grandfathered, listed with a reason in KNOWN_BOUNDARY_DEBT. Reported by the
  // test as debt rather than silently permitted.
  if (isKnownDebt(fromPath, toPath)) return { allowed: true };

  if (to === null) return { allowed: true }; // importing shared/unclassified is fine
  if (from === to) return { allowed: true }; // within a portal

  if (from === null) {
    // Shared code reaching into a portal.
    if (isSharedPath(fromPath)) {
      return {
        allowed: false,
        reason: `shared module imports portal-owned code (${to}); shared code that reaches into one portal is no longer shared`,
      };
    }
    // Unclassified app/component code importing a portal: allowed, because the
    // root layout legitimately imports the founders gate to decide the nav.
    return { allowed: true };
  }

  return {
    allowed: false,
    reason: `${from} portal imports ${to} portal-owned code — portals must not depend on each other`,
  };
}
