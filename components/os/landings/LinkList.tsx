/**
 * LinkList — a card of destinations, one dense row each: icon, label, one line
 * of what is there, chevron. Used by the Admin hub and Money's section list.
 *
 * Rows, not a grid of feature tiles: the tiled icon-card grid is one of the
 * generated-UI tells #464 removed, and a list scans faster when the job is
 * "find the one I want". Hairline separators, neutral hover, no shadow.
 * Prefetch is off: every row is in the viewport, and viewport prefetch renders
 * each destination on load for pages nobody opened (tests/perf-prefetch.test.ts).
 */

import Link from "next/link";
import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";

export type LinkListItem = {
  href: string;
  label: string;
  description: string;
  icon?: ReactNode;
};

export function LinkList({ items, label }: { items: readonly LinkListItem[]; label?: string }) {
  return (
    <nav aria-label={label} className="overflow-hidden rounded-xl border border-hairline bg-bg-panel">
      <ul className="divide-y divide-hairline">
        {items.map((item) => (
          <li key={item.href}>
            <Link
              href={item.href}
              prefetch={false}
              className="group flex items-center gap-3 px-4 py-3 transition-colors duration-150 hover:bg-active-hover focus-visible:bg-active-hover"
            >
              {item.icon && (
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-hairline text-fg-muted">
                  {item.icon}
                </span>
              )}
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-fg">{item.label}</span>
                <span className="block truncate text-[13px] leading-5 text-fg-muted">{item.description}</span>
              </span>
              <ChevronRight size={16} strokeWidth={1.75} className="shrink-0 text-fg-dim group-hover:text-fg-muted" aria-hidden />
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
