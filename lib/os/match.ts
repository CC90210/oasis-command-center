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
 * Pages that belong to a rail row they do not share a path with. Money is one
 * section (2026-09-30): its Overview row is /money, and its other tabs still
 * live at /founders/finances/* (FinanceTabs). Without this, every Finances
 * tab lit no rail row (the rail fell back to the last mode used) and its
 * breadcrumb read "Founders". A path under `prefix` is matched as `as`, and
 * its breadcrumb is the section, then the tab.
 *
 * `tabs` repeat FinanceTabs' labels (this file may import nothing); the drift
 * test tests/founders-finances-books-coverage.test.ts fails when they differ.
 */
export const PATH_ALIASES: ReadonlyArray<{
  prefix: string;
  as: string;
  section: string;
  /** The page crumb by the first path segment after `prefix`; "" is `prefix` itself. */
  tabs: Readonly<Record<string, string>>;
}> = [
  {
    prefix: "/founders/finances",
    as: "/money",
    section: "Money",
    tabs: {
      "": "Overview",
      transactions: "Transactions",
      invoices: "Invoices",
      bills: "Bills & Expenses",
      accounts: "Accounts",
      reports: "Reports",
      taxes: "Taxes",
      settings: "Settings",
    },
  },
];

function underPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/** The alias a path belongs to, if any. */
function aliasFor(pathname: string) {
  return PATH_ALIASES.find((a) => underPrefix(pathname, a.prefix)) ?? null;
}

/**
 * Longest-prefix-wins. `/` matches only `/`; any other href matches itself and
 * its sub-paths on a `/` boundary, so `/pipeline/abc` lights Pipeline and
 * `/playbooks-internal` lights nothing. This is the rule Sidebar.tsx has used
 * since the `/t/sun` Dashboard-and-Reasoning double highlight; it lives here so
 * the rail's active row, its active mode and the breadcrumb share one answer.
 * A path under an alias (PATH_ALIASES) is matched as the alias's target, so
 * /founders/finances/invoices lights the Money row.
 */
export function longestPrefixMatch<T extends { href: string }>(
  pathname: string,
  entries: readonly T[],
): T | null {
  const alias = aliasFor(pathname);
  const path = alias ? alias.as : pathname;
  let best: T | null = null;
  for (const entry of entries) {
    const href = entry.href;
    const hit = href === "/" ? path === "/" : path === href || path.startsWith(`${href}/`);
    if (hit && (!best || href.length > best.href.length)) best = entry;
  }
  return best;
}

/**
 * The page half of the "Workspace › Page" breadcrumb. A nav row's label when
 * the path belongs to one; otherwise the first path segment in sentence case
 * ("/settings/audit-log" → "Settings", "/system-health" → "System health"), so a
 * page the rail does not list still gets an honest name rather than a blank.
 * An aliased path's page crumb is its tab ("Invoices"); breadcrumbTrail puts
 * the section before it.
 */
export function breadcrumbLabel(
  pathname: string,
  entries: readonly { href: string; label: string }[],
): string {
  const trail = breadcrumbTrail(pathname, entries);
  return trail[trail.length - 1];
}

/**
 * Every crumb after the workspace: ["Money", "Invoices"] for
 * /founders/finances/invoices (and ["Money", "Overview"] for /money itself),
 * a single crumb everywhere else.
 */
export function breadcrumbTrail(
  pathname: string,
  entries: readonly { href: string; label: string }[],
): string[] {
  // Only for a viewer whose rail has the section's row: anyone else gets the
  // plain crumb (their page is a 404), so the section is never named to them.
  const has = (href: string) => entries.some((e) => e.href === href);
  const alias = aliasFor(pathname);
  if (alias && has(alias.as)) {
    const tab = pathname.slice(alias.prefix.length).split("/").filter(Boolean)[0] ?? "";
    return [alias.section, alias.tabs[tab] ?? sentenceCase(tab)];
  }
  const target = PATH_ALIASES.find((a) => underPrefix(pathname, a.as) && has(a.as));
  if (target) return [target.section, target.tabs[""]];
  const hit = longestPrefixMatch(pathname, entries);
  if (hit) return [hit.label];
  const segment = pathname.split("/").filter(Boolean)[0] || "";
  if (!segment) return ["Today"];
  return [sentenceCase(segment) || "Today"];
}

function sentenceCase(segment: string): string {
  const words = decodeURIComponentSafe(segment).replace(/[-_]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "";
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
