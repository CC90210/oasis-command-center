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

/**
 * Moves that carry a workspace slug or an agent slug in the old URL, so they
 * cannot be keys of OS_REDIRECTS. Each is a permanent move (middleware answers
 * 308) and keeps the query string (`?template=` from a template tile,
 * `?edit=` from a teammate's configure panel).
 *
 * The AI Team's builder and a custom teammate's chat lived under the manifest
 * shell (/t/<slug>/marketplace/new, /t/<slug>/agent/<agent>), so an owner who
 * clicked New teammate left the OS rail for the legacy sidebar (W1a, U1-04).
 * They are OS pages now, /agents/new and /agents/<agent>, and those read only
 * the session's own workspace, so the old URL's slug is dropped on the way:
 * neither page ever acts on another workspace.
 */
export const OS_PATTERN_REDIRECTS: ReadonlyArray<{
  /** The old route, as its app/ folder spells it (tests/os-redirects.test.ts resolves it). */
  route: string;
  from: RegExp;
  to: (match: RegExpExecArray) => string;
}> = [
  {
    route: "/t/[slug]/marketplace/new",
    from: /^\/t\/[a-z0-9][a-z0-9_-]{1,62}\/marketplace\/new\/?$/i,
    to: () => "/agents/new",
  },
  {
    route: "/t/[slug]/agent/[agent]",
    from: /^\/t\/[a-z0-9][a-z0-9_-]{1,62}\/agent\/([a-z0-9][a-z0-9_-]{0,63})\/?$/i,
    to: (m) => `/agents/${m[1].toLowerCase()}`,
  },
];

/** Where a pattern move sends `pathname` (path only, no query), or null. */
export function osPatternRedirect(pathname: string): string | null {
  for (const r of OS_PATTERN_REDIRECTS) {
    const m = r.from.exec(pathname);
    if (m) return r.to(m);
  }
  return null;
}
