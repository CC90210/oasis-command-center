/**
 * Marketing route registry — the single list that middleware.ts and
 * app/layout.tsx both read.
 *
 * These two files have to agree or the site breaks in one of two silent ways:
 *   - missing from middleware  -> the page 401s / bounces to /login
 *   - missing from the layout  -> the page renders INSIDE the operator
 *     sidebar shell, and the root layout does a full Supabase profile +
 *     tenant-manifest resolution for an anonymous visitor
 * Neither failure throws. Keeping one exported array is what stops them
 * drifting apart the next time a page is added.
 *
 * NOTE ON "/": the marketing home is NOT listed here. `matchesPathPrefix`
 * treats a trailing-slash prefix as a plain `startsWith`, so the literal
 * "/" would match every path in the app and make the entire dashboard
 * public. Instead middleware REWRITES an anonymous "/" to "/home" (which
 * IS listed) and stamps x-pathname accordingly. The URL bar still reads
 * "/"; the layout and the auth gate both see "/home".
 */

import { resolveBookingUrl } from "@/lib/booking-link";
import { OASIS_SUPPORT_EMAIL } from "@/lib/legal/constants";

/** Where an anonymous "/" is rewritten to. Never redirect — a redirect
 *  would move the brand apex to /home in the address bar and in search. */
/**
 * SHELL_BOUNDARY_NOTE — why some internal links are <a> and not <Link>.
 *
 * app/layout.tsx decides the whole page shell (operator sidebar + tenant
 * manifest, or bare full-bleed marketing) from `isFullBleed`, computed from
 * headers() in a SERVER component. Next does not re-render a root layout on a
 * client-side (soft) navigation, so that decision FREEZES at whatever page was
 * hard-loaded. A <Link> that crosses the boundary therefore renders the new page
 * inside the previous page's shell.
 *
 * CC, 2026-08-14: "when I search for OasisAI.Work/contact and then click the
 * OASIS AI logo, it takes me to a page that's super zoomed in and looks warped.
 * I have to refresh the page again, and then it zooms out and I can see the
 * navigation bar on the left." That is the dashboard rendering with no sidebar,
 * because the frozen shell still thinks it is showing marketing.
 *
 * Every other marketing link is safe because its target is ALSO full-bleed
 * (/fleet, /work, /about, /contact, /privacy, /terms, /dmca, /login). The one
 * ambiguous path is "/" — marketing for a visitor, the dashboard for a signed-in
 * operator — so links to it must hard-navigate. components/MainShell.tsx already
 * uses plain <a> for the app -> /privacy and /terms links for exactly this
 * reason; the marketing -> app direction was simply missed.
 *
 * Pinned by tests/shell-boundary.test.ts.
 */

export const SHELL_AMBIGUOUS_PATHS: readonly string[] = ["/"];

export const MARKETING_HOME_PATH = "/home";

/** Public marketing pages. Order is irrelevant; both consumers use a matcher. */
export const MARKETING_PATHS = [
  MARKETING_HOME_PATH,
  "/fleet", // the agent fleet. NOT "/agents" — that's the auth-gated dashboard.
  "/work",
  "/about",
  "/contact",
  // "/start" (the former /welcome entry-path page) was removed 2026-09-29 (F0
  // containment): it fed the developer install funnel (/configure, /download),
  // which cloned a repo that is now private. The page calls notFound().
] as const;

/**
 * Public legal pages. Already public + full-bleed before this change; listed
 * separately because they render from lib/legal/constants.ts and are covered
 * by tests/legal-compliance-drift.test.ts — they are re-skinned, never rewritten.
 */
export const MARKETING_LEGAL_PATHS = ["/privacy", "/terms", "/dmca"] as const;

/** Everything the marketing shell owns. */
export const ALL_MARKETING_PATHS: readonly string[] = [
  ...MARKETING_PATHS,
  ...MARKETING_LEGAL_PATHS,
];

/** Canonical origin, used for metadata/sitemap/OG absolute URLs. */
export const SITE_ORIGIN = "https://oasisai.work";

/**
 * CC's booking link — the one CTA that leaves the site. MAY BE EMPTY.
 *
 * It used to fall back to a hardcoded calendar.app.google URL. That schedule
 * was deleted at some point and the site kept serving it, so "Book a call" on
 * /contact and /work sent every visitor to "Appointment not found" — verified
 * live on 2026-09-09. A default cannot promise that a resource owned outside
 * this repo still exists, so there is no default any more: callers render the
 * CTA only when there is a link, and offer email when there is not.
 *
 * Resolution lives in lib/booking-link.ts so the site, the quick email and the
 * qualified-lead email cannot drift onto different values again.
 */
export const BOOKING_URL = resolveBookingUrl();

/**
 * The address a prospect or a client should write to: support@oasisai.work.
 *
 * Re-exported from lib/legal/constants.ts (OASIS_SUPPORT_EMAIL), never retyped,
 * so the marketing site, the error pages, the setup page, the opt-out page and
 * the legal pages cannot publish two different addresses. Until 2026-10-01 this
 * was the founder's own inbox; since support@ exists as its own Workspace user,
 * the founder's address is an identity (his login, his calendar), not a contact.
 */
export const CONTACT_EMAIL = OASIS_SUPPORT_EMAIL;

/** The live B2B qualification funnel the inline CTA form feeds. */
export const AUDIT_FUNNEL = {
  tenantSlug: "oasis-ai-cc",
  formSlug: "ai-audit",
  /** Personalized continue-URL shape: `${path}/${minted_token}`. */
  path: "/f/oasis-ai-cc/ai-audit",
} as const;
