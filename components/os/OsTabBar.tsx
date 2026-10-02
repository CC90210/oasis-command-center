"use client";

/**
 * OsTabBar — the tab bar of an OS page (the Clients list's status tabs, a
 * client record's tabs). One small component, so every tab answers a click
 * the same way and the look can be restyled in one place.
 *
 * WHY. CC, 2026-10-02: "when I go into clients and try to click from all to
 * prospect ... they're not clickable" and "I'm still unable to click the
 * actual subbed things inside the clients portal". The tabs were plain server
 * links that change only the query string. Next keeps the old page on screen
 * while the server renders the new one, and a query-only change shows no
 * loading boundary (the segment's React key ignores search params), so for the
 * whole server render nothing moved: no underline, no wait, nothing.
 *
 * Each tab is still a real <Link> (middle-click and the address bar keep
 * working), and a click is answered at once:
 *   onSelect given   the page filters what it already holds: the click
 *                    selects the tab with no navigation at all (the link's
 *                    onNavigate is cancelled; a modified click still opens a
 *                    new tab).
 *   no onSelect      the tab navigates. Its underline moves on the click
 *                    (`clicked`, until `active` catches up), a slim accent
 *                    bar sits under it while Next's useLinkStatus says the
 *                    navigation is pending (aria-busy for screen readers), and
 *                    hover or focus warms the route (useWarmOnIntent, as the
 *                    rail does).
 * prefetch stays off: a bar of tabs is all in the viewport, and viewport
 * prefetch costs a server render per tab per page load (tests/os-nav.test.ts).
 * A tab may carry a count (the Clients list: clients per status).
 *
 * Today's tab look, unchanged: -mb-px border-b-2, the active tab full-strength
 * with a foreground underline, the rail's focus ring for the keyboard. The
 * pending bar is the existing accent token in the mode tabs' indicator shape
 * (components/os/ModeTabs.tsx). No new colour, no animation.
 */

import Link, { useLinkStatus } from "next/link";
import { useState } from "react";
import { useWarmOnIntent } from "@/components/os/RailRow";

export type OsTab = {
  key: string;
  label: string;
  href: string;
  /** Shown after the label (e.g. clients with this status); absent = no count. */
  count?: number;
};

/** The tab drawn as current: the one clicked, until the page it opens has rendered and `active` names it. PURE. */
export function shownTab(active: string, clicked: { key: string; from: string } | null): string {
  return clicked && clicked.from === active ? clicked.key : active;
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
  onSelect,
}: {
  /** The nav's accessible name, e.g. "Client status". */
  label: string;
  tabs: readonly OsTab[];
  /** The current tab's key, as the page knows it. */
  active: string;
  /** Select a tab without navigating: the page already holds what it shows. */
  onSelect?: (key: string, href: string) => void;
}) {
  const [clicked, setClicked] = useState<{ key: string; from: string } | null>(null);
  const shown = onSelect ? active : shownTab(active, clicked);
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
              setClicked({ key: t.key, from: active });
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
