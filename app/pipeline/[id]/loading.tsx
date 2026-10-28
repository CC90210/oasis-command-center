/**
 * /pipeline/[id] loading skeleton (2026-10-28) - header, the status strip
 * (stage, last touch, touches, next), the lifecycle card and the details
 * section, in the lead page's own order and sizes, so the swap to data does
 * not reflow.
 *
 * It is also where an intent warm stops: hovering a row on the board prefetches
 * the lead page down to this boundary and no further (lib/perf/warm-route.ts),
 * so the click paints this at once and the lead's data is read fresh.
 */
export default function LeadLoading() {
  return (
    <div className="space-y-4" aria-busy="true" aria-live="polite">
      {/* Header: lead name, funnel stage line, Back to pipeline */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-2">
          <div className="h-7 w-56 rounded-md bg-bg-elev animate-pulse-slow" />
          <div className="h-3.5 w-72 rounded-md bg-bg-elev/60 animate-pulse-slow" />
        </div>
        <div className="h-8 w-32 rounded-md bg-bg-elev animate-pulse-slow" />
      </div>

      {/* Status strip: stage pill, then Last touch, Touches, Next */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-xl border border-bg-border bg-bg-elev/25 px-4 py-3">
        <div className="h-6 w-24 rounded-full bg-bg-elev animate-pulse-slow" />
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="space-y-1.5">
            <div className="h-2.5 w-14 rounded-md bg-bg-elev/60 animate-pulse-slow" />
            <div className="h-4 w-20 rounded-md bg-bg-elev animate-pulse-slow" />
          </div>
        ))}
      </div>

      {/* Lifecycle actions */}
      <div className="space-y-3 rounded-lg border border-bg-border bg-bg-deep/30 p-4">
        <div className="h-4 w-40 rounded-md bg-bg-elev animate-pulse-slow" />
        <div className="h-3 w-full max-w-lg rounded-md bg-bg-elev/60 animate-pulse-slow" />
        <div className="flex flex-wrap gap-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-8 w-28 rounded-md bg-bg-elev animate-pulse-slow" />
          ))}
        </div>
      </div>

      {/* Lead details */}
      <div className="rounded-lg border border-bg-border bg-bg-deep/30 p-4">
        <div className="h-4 w-28 rounded-md bg-bg-elev animate-pulse-slow" />
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-4 rounded-md bg-bg-elev/60 animate-pulse-slow" />
          ))}
        </div>
      </div>
    </div>
  );
}
