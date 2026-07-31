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

/** Where an anonymous "/" is rewritten to. Never redirect — a redirect
 *  would move the brand apex to /home in the address bar and in search. */
export const MARKETING_HOME_PATH = "/home";

/** Public marketing pages. Order is irrelevant; both consumers use a matcher. */
export const MARKETING_PATHS = [
  MARKETING_HOME_PATH,
  "/fleet", // the agent fleet. NOT "/agents" — that's the auth-gated dashboard.
  "/work",
  "/about",
  "/contact",
  "/start", // the former /welcome entry-path page
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

/** CC's booking link — the one CTA that leaves the site. */
export const BOOKING_URL = "https://calendar.app.google/tpfvJYBGircnGu8G8";

/** The live B2B qualification funnel the inline CTA form feeds. */
export const AUDIT_FUNNEL = {
  tenantSlug: "oasis-ai-cc",
  formSlug: "ai-audit",
  /** Personalized continue-URL shape: `${path}/${minted_token}`. */
  path: "/f/oasis-ai-cc/ai-audit",
} as const;
