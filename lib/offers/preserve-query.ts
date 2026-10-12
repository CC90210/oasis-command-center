/**
 * lib/offers/preserve-query.ts — append the attribution params a visitor
 * arrived with onto an internal navigation target, so a router-form submit
 * that sends them to a DIFFERENT page (another of the workspace's own forms,
 * V2 "router routing") does not lose them. Pure, zero dependencies — safe to
 * import from a client component.
 *
 * WHY THIS EXISTS. sessionStorage (the visit id) survives a same-tab full
 * navigation on its own; `kw`/`cat`/`utm_*` do NOT — FormPublicClient reads
 * them fresh from `window.location.search` on every page mount
 * (lib/offers/tracking-client.ts's caller), so navigating to a path with no
 * query string drops them at the NEXT page's own first submit. Appending
 * them here is what keeps attribution continuous across the hop.
 *
 * NEVER WIDENS THE TARGET INTO AN OPEN REDIRECT. `safeInternalPath` is the
 * one gate: only a same-origin relative path (starts with exactly one `/`,
 * never `//` or a scheme) is accepted. The destination itself is already
 * server-validated (lib/forms/routing-destination.ts); this is a second,
 * independent check on the client side, because a client must never trust
 * that a server response is well-formed just because it currently is.
 */

/** `/foo` yes. `//evil.com`, `/\evil.com`, `http://..`, `javascript:..`, `` (empty) no. */
export function isSafeInternalPath(path: unknown): path is string {
  if (typeof path !== "string" || path.length === 0) return false;
  if (!path.startsWith("/")) return false;
  if (path.startsWith("//")) return false;
  // Browsers treat a backslash like a slash in http(s) URLs (WHATWG URL), so
  // `/\evil.com` navigates to https://evil.com. No internal path needs one:
  // refuse any backslash or control character anywhere.
  if (/[\\\u0000-\u001f]/.test(path)) return false;
  // A colon before the first later `/`, `?` or `#` would make the first
  // path SEGMENT look like a scheme to some parsers -- reject it to be safe
  // rather than clever. (path[0] is already known to be "/", so start at 1.)
  const rest = path.slice(1);
  const breakMatch = /[/?#]/.exec(rest);
  const head = breakMatch ? rest.slice(0, breakMatch.index) : rest;
  if (head.includes(":")) return false;
  return true;
}

/**
 * Append `params` (only the truthy string ones) onto `path`'s query string,
 * without disturbing any query string `path` already carries. Returns `path`
 * unchanged if it is not a safe internal path (see isSafeInternalPath) —
 * callers should already be passing one, this is defense in depth, not the
 * primary validator.
 */
export function appendPreservedParams(
  path: string,
  params: Readonly<Record<string, string | null | undefined>>,
): string {
  if (!isSafeInternalPath(path)) return path;
  // Hash first: "#" can appear with no "?" at all, and a hash always comes
  // after any query string, never before it.
  const hashIndex = path.indexOf("#");
  const hash = hashIndex === -1 ? "" : path.slice(hashIndex);
  const withoutHash = hashIndex === -1 ? path : path.slice(0, hashIndex);
  const [base, existingQuery = ""] = withoutHash.split("?", 2);
  const sp = new URLSearchParams(existingQuery);
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string" && value.trim()) sp.set(key, value);
  }
  const qs = sp.toString();
  return `${base}${qs ? `?${qs}` : ""}${hash}`;
}
