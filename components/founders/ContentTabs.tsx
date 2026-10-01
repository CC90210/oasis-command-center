"use client";

/**
 * Content's tab bar: Overview - Library - Train - Performance. The one strip
 * that reaches the Library from inside the OS shell (2026-10-01): the rail
 * draws Content as a single row and the breadcrumb knew no sub-pages, so the
 * Library was reachable only through the legacy founders banner, which CC had
 * already asked to remove. Modelled on components/founders/finances/FinanceTabs.tsx
 * and rendered by app/founders/marketing/layout.tsx above every Content page.
 * lib/os/match.ts carries these same labels for the breadcrumb ("Content >
 * Library"); tests/content-hub.test.ts pins the two lists together.
 *
 * OS tokens, not the founders cyan: the active tab is full-strength text with
 * a 2px underline in the foreground colour, like the rail's mode tabs
 * (components/os/ModeTabs.tsx). The accent is for actions.
 *
 * Overview is the hub root, so its href is a prefix of every other tab's. It
 * lights only on its exact path: an asset page (/founders/marketing/asset/<id>)
 * is not the Overview, and longest-prefix alone would underline Overview there.
 * The other tabs light on themselves and their sub-paths, longest prefix wins.
 *
 * Train stays a tab for now. It moves to Playbook > Skills ("Teach from a URL")
 * with the Playbook track (docs/os-revamp/01-product-surface-ia-ux.md, the
 * /founders/marketing row).
 *
 * Plain <Link>s, as on Finances: with a loading.tsx beside the layout, Next
 * prefetches each tab's shell and a click paints the skeleton under the tabs
 * immediately instead of waiting on the server render.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";

export const CONTENT_ROOT = "/founders/marketing";

export const CONTENT_TABS = [
  { href: "/founders/marketing", label: "Overview" },
  { href: "/founders/marketing/library", label: "Library" },
  { href: "/founders/marketing/train", label: "Train" },
  { href: "/founders/marketing/performance", label: "Performance" },
] as const;

/** The href of the tab lit on `pathname`, or null when none is. PURE, for the test. */
export function activeContentTab(pathname: string): string | null {
  const lit = (href: string) =>
    href === CONTENT_ROOT ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
  return [...CONTENT_TABS].filter((t) => lit(t.href)).sort((a, b) => b.href.length - a.href.length)[0]?.href ?? null;
}

export function ContentTabs() {
  const pathname = usePathname() || "";
  const active = activeContentTab(pathname);
  return (
    <nav className="-mx-1 flex gap-1 overflow-x-auto border-b border-hairline px-1" aria-label="Content">
      {CONTENT_TABS.map((t) => {
        const isActive = t.href === active;
        return (
          <Link
            key={t.href}
            href={t.href}
            aria-current={isActive ? "page" : undefined}
            className={`whitespace-nowrap border-b-2 px-3 py-2 text-xs font-semibold transition-colors ${
              isActive ? "border-fg text-fg" : "border-transparent text-fg-muted hover:text-fg"
            }`}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
