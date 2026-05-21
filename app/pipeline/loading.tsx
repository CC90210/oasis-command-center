/**
 * /pipeline loading skeleton — header + funnel-chart placeholder + chevron-
 * bar placeholder + table-skeleton, matching the real page's shape so the
 * layout doesn't jump when the data arrives.
 */
export default function PipelineLoading() {
  return (
    <div className="space-y-6 animate-fade-in" aria-busy="true" aria-live="polite">
      {/* PageHeader */}
      <div className="space-y-2">
        <div className="h-7 w-32 rounded-md bg-bg-elev animate-pulse-slow" />
        <div className="h-4 w-72 rounded-md bg-bg-elev/60 animate-pulse-slow" />
      </div>
      {/* Funnel chart card */}
      <div className="h-48 rounded-xl border border-bg-border bg-bg-elev/40 animate-pulse-slow" />
      {/* Chevron bar — eleven slim chips */}
      <div className="flex items-stretch gap-0">
        {Array.from({ length: 11 }).map((_, i) => (
          <div
            key={i}
            className="h-9 w-24 rounded-md bg-bg-elev animate-pulse-slow -ml-[1px]"
          />
        ))}
      </div>
      {/* View-toggle pills */}
      <div className="flex gap-2">
        <div className="h-7 w-16 rounded-md bg-bg-elev/60 animate-pulse-slow" />
        <div className="h-7 w-16 rounded-md bg-bg-elev/60 animate-pulse-slow" />
      </div>
      {/* Table */}
      <div className="rounded-xl border border-bg-border bg-bg-elev/40 overflow-hidden">
        <div className="h-10 border-b border-bg-border bg-bg-elev/60 animate-pulse-slow" />
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="h-12 border-b border-bg-border last:border-0 animate-pulse-slow"
            style={{ animationDelay: `${i * 80}ms` }}
          />
        ))}
      </div>
    </div>
  );
}
