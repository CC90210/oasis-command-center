/**
 * /leads loading skeleton — header + stage tabs + search bar + table rows.
 * Matches LeadsTableClient's layout so the swap from skeleton → data is
 * visually quiet.
 */
export default function LeadsLoading() {
  return (
    <div className="space-y-6 animate-fade-in" aria-busy="true" aria-live="polite">
      <div className="space-y-2">
        <div className="h-7 w-24 rounded-md bg-bg-elev animate-pulse-slow" />
        <div className="h-4 w-80 rounded-md bg-bg-elev/60 animate-pulse-slow" />
      </div>
      {/* Stage tabs */}
      <div className="flex flex-wrap gap-1.5">
        {Array.from({ length: 12 }).map((_, i) => (
          <div
            key={i}
            className="h-7 w-20 rounded-md bg-bg-elev animate-pulse-slow"
          />
        ))}
      </div>
      {/* Search + sort */}
      <div className="flex items-center gap-2">
        <div className="h-9 flex-1 max-w-md rounded-md bg-bg-elev/60 animate-pulse-slow" />
        <div className="h-9 w-24 rounded-md bg-bg-elev/60 animate-pulse-slow" />
      </div>
      {/* Table rows */}
      <div className="rounded-xl border border-bg-border bg-bg-elev/40 overflow-hidden">
        <div className="h-10 border-b border-bg-border bg-bg-elev/60 animate-pulse-slow" />
        {Array.from({ length: 8 }).map((_, i) => (
          <div
            key={i}
            className="flex items-center gap-3 px-4 h-14 border-b border-bg-border last:border-0"
            style={{ animationDelay: `${i * 60}ms` }}
          >
            <div className="w-9 h-9 rounded-full bg-bg-deep animate-pulse-slow" />
            <div className="flex-1 space-y-1.5">
              <div className="h-3.5 w-40 rounded-md bg-bg-elev animate-pulse-slow" />
              <div className="h-3 w-64 rounded-md bg-bg-elev/60 animate-pulse-slow" />
            </div>
            <div className="h-6 w-20 rounded-md bg-bg-elev animate-pulse-slow" />
          </div>
        ))}
      </div>
    </div>
  );
}
