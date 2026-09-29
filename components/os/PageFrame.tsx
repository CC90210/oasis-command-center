/**
 * PageFrame — the standard wrapper for an OASIS OS page: title, optional
 * subtitle, optional actions, then the page.
 *
 *   <PageFrame title="Pipeline" subtitle="Every open deal, by stage" actions={<NewLeadButton />}>
 *     …
 *   </PageFrame>
 *
 * A server component (no hooks), usable from any page. It does NOT set width or
 * padding: MainShell's canvas already constrains every page to one content
 * width, and a second wrapper is how pages drift apart. The breadcrumb and the
 * Ask button are MainShell's ContentHeader, not this.
 *
 * Type scale (design doc §(d)): title 20/28 semibold at -0.01em, subtitle 13/20
 * muted. Actions sit right of the title from `lg` and stack below it under
 * that, the same breakpoint PageHeader uses (components/Card.tsx) — at `md` the
 * rail takes 240px and the content box is narrower than a phone's.
 */

import type { ReactNode } from "react";

export type PageFrameProps = {
  title: ReactNode;
  subtitle?: ReactNode;
  /** Buttons / links for the page. The primary one uses `.btn-primary`. */
  actions?: ReactNode;
  children: ReactNode;
  /** Extra classes for the outer wrapper (spacing between sections, etc.). */
  className?: string;
};

export function PageFrame({ title, subtitle, actions, children, className }: PageFrameProps) {
  return (
    <div className={className}>
      <header className="mb-6 flex flex-col items-start justify-between gap-3 lg:flex-row lg:items-end lg:gap-4">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold leading-7 tracking-[-0.01em] text-fg">{title}</h1>
          {subtitle && <div className="mt-1 text-[13px] leading-5 text-fg-muted">{subtitle}</div>}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </header>
      {children}
    </div>
  );
}
