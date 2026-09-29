/**
 * lib/os/match.ts — pathname → nav row, for the client rail and the content
 * header.
 *
 * ZERO IMPORTS ON PURPOSE. The rail and header are client components; this
 * file is the only lib/os module they load at runtime, so nothing here may pull
 * the policy layer (lib/role-surfaces → website-sales → …) into the browser
 * bundle. Policy runs on the server in lib/os/nav.ts and reaches the client as
 * plain data.
 */

/**
 * Longest-prefix-wins. `/` matches only `/`; any other href matches itself and
 * its sub-paths on a `/` boundary, so `/pipeline/abc` lights Pipeline and
 * `/playbooks-internal` lights nothing. This is the rule Sidebar.tsx has used
 * since the `/t/sun` Dashboard-and-Reasoning double highlight; it lives here so
 * the rail's active row, its active mode and the breadcrumb share one answer.
 */
export function longestPrefixMatch<T extends { href: string }>(
  pathname: string,
  entries: readonly T[],
): T | null {
  let best: T | null = null;
  for (const entry of entries) {
    const href = entry.href;
    const hit = href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
    if (hit && (!best || href.length > best.href.length)) best = entry;
  }
  return best;
}

/**
 * The page half of the "Workspace › Page" breadcrumb. A nav row's label when
 * the path belongs to one; otherwise the first path segment in sentence case
 * ("/settings/audit-log" → "Settings", "/system-health" → "System health"), so a
 * page the rail does not list still gets an honest name rather than a blank.
 */
export function breadcrumbLabel(
  pathname: string,
  entries: readonly { href: string; label: string }[],
): string {
  const hit = longestPrefixMatch(pathname, entries);
  if (hit) return hit.label;
  const segment = pathname.split("/").filter(Boolean)[0] || "";
  if (!segment) return "Today";
  const words = decodeURIComponentSafe(segment).replace(/[-_]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Today";
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
