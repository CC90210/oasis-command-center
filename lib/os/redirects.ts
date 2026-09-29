/**
 * lib/os/redirects.ts — old URLs that now live somewhere else in OASIS OS.
 *
 * Read by middleware.ts's REDIRECT_MAP. Kept here, pure, so
 * tests/os-redirects.test.ts can prove every target is a real route without
 * importing middleware (which pulls the Supabase edge client).
 *
 * A redirect to a route that does not exist turns a working bookmark into a
 * 404, which is worse than leaving the old page up. Add a row only in the same
 * change that ships its target.
 *
 * Deliberately absent:
 *   /feed   — was → /operations; Feed is a real Team page again.
 *   /money  — a real page (Money › Overview), never a redirect.
 */
export const OS_REDIRECTS: Readonly<Record<string, string>> = {
  // Connections moved into Settings (plan W13). Was → /settings.
  "/integrations": "/settings/connections",
};
