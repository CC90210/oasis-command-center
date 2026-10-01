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
 * Moves that depend on WHO is asking, so they are not middleware redirects:
 * middleware knows only that a session exists. The old page makes the move
 * itself, after its own gate, and only for a viewer the new page serves, with
 * Next's redirect() (a 307). Never a 308: a browser caches a permanent
 * redirect for every later visit to that URL on that device, so one viewer's
 * move would become everyone's (W1a review R1).
 *
 * The AI Team's builder and a custom teammate's chat lived under the manifest
 * shell (/t/<slug>/marketplace/new, /t/<slug>/agent/<agent>), so an owner who
 * clicked New teammate left the OS rail for the legacy sidebar (W1a, U1-04).
 * They are OS pages now, /agents/new and /agents/<agent>, which read only the
 * session's own workspace and serve only viewers the AI team serves
 * (components/os/aiteam/access.ts aiTeamServes). So the old page moves:
 *   - a viewer on their OWN workspace's slug whom the AI team serves, never an
 *     operator previewing another workspace (the OS page would act on the
 *     operator's own workspace instead) and never a viewer the AI team does
 *     not serve yet (a client owner until the rail opens it: the OS page 404s
 *     them, and the old page is their builder);
 *   - for the chat, only a custom teammate this workspace built: /agents/<agent>
 *     serves nothing else, so a platform agent's chat stays where it is.
 * The query is kept (`?edit=` from a teammate's configure panel, `?template=`
 * from an old template link).
 */
export const OS_VIEWER_MOVES: ReadonlyArray<{
  /** The old route, as its app/ folder spells it (tests/os-redirects.test.ts resolves both). */
  route: string;
  to: string;
}> = [
  { route: "/t/[slug]/marketplace/new", to: "/agents/new" },
  { route: "/t/[slug]/agent/[agent]", to: "/agents/[slug]" },
];

/** `path` with a page's own query string kept (its searchParams), for a move the page makes. */
export function withQuery(
  path: string,
  searchParams: Readonly<Record<string, string | string[] | undefined>> | null | undefined,
): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams ?? {})) {
    for (const one of Array.isArray(value) ? value : value === undefined ? [] : [value]) query.append(key, one);
  }
  const qs = query.toString();
  return qs ? `${path}?${qs}` : path;
}
