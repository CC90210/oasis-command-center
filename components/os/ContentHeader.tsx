"use client";

/**
 * ContentHeader — the 44px bar across the top of the OS canvas:
 *
 *   Workspace › Page                                   [Ask]
 *
 * Rendered once by components/MainShell.tsx for every page on a workspace's own
 * shell, so pages do not draw it themselves. The page name follows the URL on
 * every soft navigation (usePathname), resolved against the viewer's own rail
 * rows; a page the rail does not list still gets a name from its path.
 *
 * Ask opens the Chief of Staff channel (plan D2). It is only rendered when the
 * viewer's rail has that department — a button into a page that 404s for them
 * is a dead door. The in-canvas Ask drawer (plan W2 AskDrawer) replaces the
 * link once channels exist.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronRight, MessageSquareText } from "lucide-react";
import { breadcrumbTrail } from "@/lib/os/match";
import { useWarmOnIntent } from "@/components/os/RailRow";

export type ContentHeaderProps = {
  /** Workspace name — the first breadcrumb crumb, linking to Today. */
  workspace: string;
  /** The viewer's rail rows ({href, label}), for the page crumb. */
  entries: readonly { href: string; label: string }[];
  /** Chief of Staff href when the viewer has it; null hides Ask. */
  askHref: string | null;
};

export function ContentHeader({ workspace, entries, askHref }: ContentHeaderProps) {
  const pathname = usePathname() || "/";
  // Usually one crumb; a page that belongs to a section it does not share a
  // path with gets the section first ("Money › Invoices", lib/os/match.ts).
  const trail = breadcrumbTrail(pathname, entries);
  const warmHome = useWarmOnIntent("/");
  return (
    <header className="flex h-11 shrink-0 items-center justify-between gap-3 border-b border-hairline px-4 md:px-5">
      <nav aria-label="Breadcrumb" className="min-w-0">
        <ol className="flex min-w-0 items-center gap-1.5 text-[13px]">
          <li className="min-w-0">
            <Link
              href="/"
              prefetch={false}
              onMouseEnter={warmHome}
              onFocus={warmHome}
              className="block truncate rounded text-fg-muted outline-none transition-colors duration-150 hover:text-fg focus-visible:ring-2 focus-visible:ring-accent/60"
            >
              {workspace}
            </Link>
          </li>
          {trail.map((crumb, i) => {
            const last = i === trail.length - 1;
            return (
              <Crumb key={`${i}:${crumb}`} label={crumb} current={last} />
            );
          })}
        </ol>
      </nav>
      {askHref && <AskLink href={askHref} />}
    </header>
  );
}

/** A chevron, then one crumb: the page itself (current) or the section it sits in. */
function Crumb({ label, current }: { label: string; current: boolean }) {
  return (
    <>
      <li aria-hidden className="shrink-0 text-fg-dim">
        <ChevronRight size={14} strokeWidth={1.75} />
      </li>
      <li className="min-w-0">
        <span aria-current={current ? "page" : undefined} className={`block truncate ${current ? "font-medium text-fg" : "text-fg-muted"}`}>
          {label}
        </span>
      </li>
    </>
  );
}

function AskLink({ href }: { href: string }) {
  const warm = useWarmOnIntent(href);
  return (
    <Link
      href={href}
      prefetch={false}
      onMouseEnter={warm}
      onFocus={warm}
      title="Ask your Chief of Staff"
      className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg border border-hairline bg-bg-raised px-2.5 text-[13px] font-medium text-fg outline-none transition-colors duration-150 hover:border-bg-border-strong hover:bg-bg-elev focus-visible:ring-2 focus-visible:ring-accent/60"
    >
      <MessageSquareText size={14} strokeWidth={1.75} aria-hidden className="text-fg-muted" />
      Ask
    </Link>
  );
}
