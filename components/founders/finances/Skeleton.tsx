/**
 * Placeholder furniture for the Finances loading.tsx files. Each tab's
 * loading.tsx arranges these in the shape of its real page, so a tab click
 * paints the page's outline at once (Next prefetches each tab's loading
 * state) while the server render streams in. Shapes only, never numbers.
 * Same tokens as app/metrics/loading.tsx.
 */
import type { ReactNode } from "react";

const bar = "rounded-md bg-bg-elev animate-pulse-slow";
const panel = "rounded-xl border border-bg-border bg-bg-elev/40 animate-pulse-slow";

export function SkeletonPage({ children }: { children: ReactNode }) {
  return (
    <div className="space-y-6 animate-fade-in" aria-busy="true" aria-live="polite">
      {children}
    </div>
  );
}

/** Page title, subtitle and the primary action button on the right. */
export function SkeletonHeader({ action = true }: { action?: boolean }) {
  return (
    <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
      <div className="space-y-2">
        <div className={`h-7 w-40 ${bar}`} />
        <div className={`h-4 w-72 max-w-full ${bar} bg-bg-elev/60`} />
      </div>
      {action && <div className={`h-9 w-36 ${bar}`} />}
    </div>
  );
}

/** A row of figure tiles, like the Overview's. */
export function SkeletonFigures({ count = 4 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="h-24 rounded-xl border border-bg-border bg-bg-elev/60 animate-pulse-slow" />
      ))}
    </div>
  );
}

/** A plain panel of a fixed height (charts, forms). */
export function SkeletonPanel({ className = "h-64" }: { className?: string }) {
  return <div className={`${panel} ${className}`} />;
}

/** A card holding a table: header strip, then `rows` lines. */
export function SkeletonTable({ rows = 6 }: { rows?: number }) {
  return (
    <div className="rounded-xl border border-bg-border bg-bg-panel">
      <div className="border-b border-bg-border px-5 py-3.5">
        <div className={`h-4 w-44 ${bar}`} />
      </div>
      <div className="divide-y divide-bg-border/60">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="flex items-center justify-between gap-4 px-5 py-3">
            <div className={`h-3.5 w-1/2 ${bar} bg-bg-elev/70`} />
            <div className={`h-3.5 w-20 ${bar} bg-bg-elev/70`} />
          </div>
        ))}
      </div>
    </div>
  );
}
