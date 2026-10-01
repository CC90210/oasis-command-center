/**
 * lib/os/full-bleed.ts - the pages that render WITHOUT the OS shell.
 *
 * app/layout.tsx wraps every other page in the rail (SidebarShell) and the
 * canvas (MainShell: breadcrumb, Ask, footer), and resolves the viewer's
 * profile and workspace manifest to draw them. A page listed here gets neither:
 * it draws its own full-screen layout, and the layout does no session work.
 *
 * TWO KINDS OF PAGE BELONG HERE:
 *   1. Every page an anonymous visitor can open. middleware.ts
 *      PUBLIC_PATH_PREFIXES decides what is public; a public page that is not
 *      listed here renders the rail around a signer, an unsubscriber or a
 *      prospect who has no account (U1-17: "Your workspace", Sign out and
 *      Settings around a contract someone was asked to sign).
 *      tests/shell-boundary.test.ts walks every page under app/ and fails when
 *      a public one is missing here.
 *   2. A signed-in page that draws its own header and must not sit inside the
 *      canvas (/onboarding, /desktop-link). The same test pins this set, so a
 *      third one is a deliberate edit.
 *
 * Boundary-aware match (lib/path-prefix.ts, the rule middleware's isPublic
 * uses): a raw startsWith() would let a future "/workflows" or "/aboutus"
 * inherit the marketing chrome because of a shared prefix.
 *
 * Never add "/" itself: the matcher would swallow every route and strip the
 * operator chrome site-wide. "/home" is the rewrite target for an anonymous "/"
 * (middleware re-stamps x-pathname so it lands here).
 *
 * A page here is a SHELL BOUNDARY: the root layout does not re-render on a
 * client-side navigation, so a <Link> from one of these pages into a shell page
 * renders that page without its rail. Leave them with a plain <a>
 * (SHELL_BOUNDARY_NOTE in lib/marketing/routes.ts; tests/shell-boundary.test.ts).
 */

import { ALL_MARKETING_PATHS } from "@/lib/marketing/routes";
import { matchesPathPrefix } from "@/lib/path-prefix";

export const FULL_BLEED_PREFIXES: readonly string[] = [
  // Public marketing site + the three legal pages, from the shared registry.
  ...ALL_MARKETING_PATHS,
  "/welcome", // legacy URL; next.config.js 308s it to "/" before middleware or the layout ever see it. Inert backstop, same reasoning as the middleware entry.
  "/download",
  "/login",
  "/signup",
  "/forgot-password",
  "/auth/callback",
  "/auth/reset-password",
  "/onboarding", // signed in, but the wizard owns the screen
  "/f/", // public form pages (anonymous + personalized)
  "/invite/", // pre-signup invite landing
  "/sign/", // public e-signature page: the signer may never have an account
  "/unsubscribe", // email opt-out landing: the recipient may be another company's customer
  "/link-expired", // where an unverifiable tracking click lands; belongs to no company
  "/desktop-link", // signed in, but it draws its own Desktop Connect header (U1-16)
];

/** Does this path render without the OS shell? */
export function isFullBleedPath(pathname: string): boolean {
  return FULL_BLEED_PREFIXES.some((prefix) => matchesPathPrefix(pathname, prefix));
}
