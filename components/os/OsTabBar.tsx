"use client";

/**
 * OsTabBar: the tab bar of an OS page (the Clients list's status tabs, a
 * client record's tabs). One small component, so every tab answers a click
 * the same way and the look can be restyled in one place.
 *
 * WHY. CC, 2026-10-01: "when I go into clients and try to click from all to
 * prospect ... they're not clickable" and "I'm still unable to click the
 * actual subbed things inside the clients portal". The tabs were plain server
 * links that change only the query string. Next keeps the old page on screen
 * while the server renders the new one, and a query-only change shows no
 * loading boundary (the segment's React key ignores search params), so for the
 * whole server render nothing moved: no underline, no wait, nothing. Workers
 * Logs for those clicks (10-01 22:33-22:37 UTC): every one reached the server
 * and answered 200 in 0.5 to 2.1 s; nothing on the page blocked the click.
 *
 * Each tab is still a real <Link> (middle-click and the address bar keep
 * working), and a click is answered at once:
 *   onSelect given   the page filters what it already holds: the click
 *                    selects the tab with no navigation at all (the link's
 *                    onNavigate is cancelled; a modified click still opens a
 *                    new tab).
 *   no onSelect      the tab navigates. Its underline moves on the click and
 *                    stays there until the page lands; a slim accent bar sits
 *                    under it while Next's useLinkStatus says the navigation
 *                    is pending (aria-busy for screen readers); hover or focus
 *                    warms the route (useWarmOnIntent, as the rail does).
 *
 * WHICH TAB IS CURRENT. `active`, as the page knows it, or `param`: the
 * search param that names the tab, read from the address bar. A bar drawn by a
 * LAYOUT needs `param`: a layout is not rendered again when only the query
 * changes, so a key it passed down would stay on the first tab forever. A
 * missing or unknown value is the first tab, the same rule the page applies.
 *
 * prefetch stays off: a bar of tabs is all in the viewport, and viewport
 * prefetch costs a server render per tab per page load (tests/os-nav.test.ts).
 * A tab may carry a count (the Clients list: clients per status).
 *
 * Today's tab look: -mb-px border-b-2, the current tab full-strength with a
 * foreground underline, the rail's focus ring for the keyboard. The pending bar
 * is the existing accent token in the mode tabs' indicator shape
 * (components/os/ModeTabs.tsx). No new colour, no animation.
 */

import Link, { useLinkStatus } from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { useWarmOnIntent } from "@/components/os/RailRow";

export type OsTab = {
  key: string;
  label: string;
  href: string;
  /** Shown after the label (e.g. clients with this status); absent = no count. */
  count?: number;
};

/** A click not yet answered by the page: the tab clicked, and the tab that was current then. */
export type OsTabClick = { key: string; from: string };

/** The tab a search param's value names: one of `tabs`, else the first. PURE. */
export function tabFromParam(value: string | null | undefined, tabs: readonly Pick<OsTab, "key">[]): string {
  return tabs.find((t) => t.key === value)?.key ?? tabs[0]?.key ?? "";
}

/**
 * The click still waiting for its page, or null once the page has moved on
 * from where the click was made (it landed, or Back, a link or the rail took it
 * elsewhere). Without this the bar would keep underlining a tab the page left.
 * PURE.
 */
export function pendingClick(clicked: OsTabClick | null, current: string): OsTabClick | null {
  return clicked && clicked.from === current ? clicked : null;
}

/** The tab drawn as current: the one clicked while its page is on the way, else the page's own. PURE. */
export function shownTab(current: string, clicked: OsTabClick | null): string {
  return pendingClick(clicked, current)?.key ?? current;
}

/** A tab's classes: today's look, current or not, with the rail's keyboard focus ring. PURE. */
export function osTabClass(current: boolean): string {
  return (
    "relative -mb-px border-b-2 px-3 py-2 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-accent/60 " +
    (current ? "border-fg font-medium text-fg" : "border-transparent text-fg-muted hover:text-fg")
  );
}

export function OsTabBar({
  label,
  tabs,
  active,
  param,
  onSelect,
}: {
  /** The nav's accessible name, e.g. "Client status". */
  label: string;
  tabs: readonly OsTab[];
  /** The current tab's key, as the page knows it. */
  active?: string;
  /** Or the search param naming the current tab, read from the address bar (a bar in a layout). */
  param?: string;
  /** Select a tab without navigating: the page already holds what it shows. */
  onSelect?: (key: string, href: string) => void;
}) {
  const query = useSearchParams();
  const current = param !== undefined ? tabFromParam(query.get(param), tabs) : (active ?? tabFromParam(null, tabs));
  const [clicked, setClicked] = useState<OsTabClick | null>(null);
  // The page moved on from where the click was made: that click is answered.
  if (clicked && !pendingClick(clicked, current)) setClicked(null);
  const shown = onSelect ? current : shownTab(current, clicked);
  return (
    <nav aria-label={label} className="flex flex-wrap gap-1 border-b border-hairline">
      {tabs.map((t) => (
        <OsTabLink
          key={t.key || "all"}
          tab={t}
          current={t.key === shown}
          navigates={!onSelect}
          onNavigate={(e) => {
            if (onSelect) {
              e.preventDefault();
              onSelect(t.key, t.href);
            } else {
              setClicked({ key: t.key, from: current });
            }
          }}
        />
      ))}
    </nav>
  );
}

function OsTabLink({
  tab,
  current,
  navigates,
  onNavigate,
}: {
  tab: OsTab;
  current: boolean;
  navigates: boolean;
  onNavigate: (e: { preventDefault: () => void }) => void;
}) {
  const warm = useWarmOnIntent(tab.href);
  return (
    <Link
      href={tab.href}
      prefetch={false}
      // Only a tab that navigates has a route worth warming.
      onMouseEnter={navigates ? warm : undefined}
      onFocus={navigates ? warm : undefined}
      onNavigate={onNavigate}
      aria-current={current ? "page" : undefined}
      className={osTabClass(current)}
    >
      <OsTabLabel label={tab.label} count={tab.count} />
    </Link>
  );
}

/** Inside the Link, where useLinkStatus can see this tab's navigation. */
function OsTabLabel({ label, count }: { label: string; count?: number }) {
  const { pending } = useLinkStatus();
  return (
    <span aria-busy={pending || undefined}>
      {label}
      {count !== undefined && <span className="ml-1.5 tabular-nums text-fg-dim">{count}</span>}
      {/* The slim pending bar, over the tab's underline until the page lands. */}
      {pending && <span aria-hidden className="absolute inset-x-0 -bottom-0.5 h-0.5 bg-accent" />}
    </span>
  );
}
