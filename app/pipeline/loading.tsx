/**
 * /pipeline loading skeleton — header + stage-card grid + collapsible
 * stage section placeholders. Mirrors the LeadPipelineView DOM (the
 * component the real /pipeline renders) so the swap from skeleton to
 * data doesn't reflow.
 */
export default function PipelineLoading() {
  return (
    <div className="space-y-4 animate-fade-in" aria-busy="true" aria-live="polite">
      {/* Header block — title + LIVE chip + counts row + New lead btn */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-2">
          <div className="h-7 w-44 rounded-md bg-bg-elev animate-pulse-slow" />
          <div className="h-3.5 w-80 rounded-md bg-bg-elev/60 animate-pulse-slow" />
        </div>
        <div className="h-7 w-24 rounded-md bg-bg-elev animate-pulse-slow" />
      </div>

      {/* Search + meta row */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="h-9 flex-1 min-w-[260px] max-w-md rounded-md bg-bg-elev/60 animate-pulse-slow" />
        <div className="h-3 w-24 rounded-md bg-bg-elev/60 animate-pulse-slow" />
        <div className="h-3 w-20 rounded-md bg-bg-elev/60 animate-pulse-slow" />
      </div>

      {/* Stage-card grid (11 OASIS stages or 12 SunBiz stages — render 12
          so the grid doesn't pop on tenant detection) */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
        {Array.from({ length: 12 }).map((_, i) => (
          <div
            key={i}
            className="h-14 rounded-md border border-bg-border bg-bg-deep/45 animate-pulse-slow"
            style={{ animationDelay: `${i * 40}ms` }}
          />
        ))}
      </div>

      {/* Collapsible stage section placeholders */}
      {Array.from({ length: 6 }).map((_, i) => (
        <div
          key={i}
          className="rounded-lg border border-bg-border bg-bg-deep/30 overflow-hidden"
          style={{ borderLeftWidth: 4 }}
        >
          <div className="h-10 bg-bg-elev/40 animate-pulse-slow" />
        </div>
      ))}
    </div>
  );
}
