/**
 * /operations loading skeleton — five health tiles + agent workers grid +
 * activity tape. The page fires 8 parallel DB queries so a useful skeleton
 * is real value, not decoration.
 */
export default function OperationsLoading() {
  return (
    <div className="space-y-6 animate-fade-in" aria-busy="true" aria-live="polite">
      <div className="space-y-2">
        <div className="h-7 w-32 rounded-md bg-bg-elev animate-pulse-slow" />
        <div className="h-4 w-96 rounded-md bg-bg-elev/60 animate-pulse-slow" />
      </div>
      {/* Health tiles — 5 across on desktop, 2 across on mobile */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <div
            key={i}
            className="h-16 rounded-lg border border-bg-border bg-bg-elev/40 animate-pulse-slow"
            style={{ animationDelay: `${i * 60}ms` }}
          />
        ))}
      </div>
      {/* Agent workers — 2-column grid */}
      <div className="rounded-xl border border-bg-border bg-bg-elev/40 p-4 space-y-3">
        <div className="h-5 w-40 rounded-md bg-bg-elev animate-pulse-slow" />
        <div className="grid sm:grid-cols-2 gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="h-20 rounded-lg border border-bg-border bg-bg-elev animate-pulse-slow"
              style={{ animationDelay: `${i * 80}ms` }}
            />
          ))}
        </div>
      </div>
      {/* Activity tape */}
      <div className="rounded-xl border border-bg-border bg-bg-elev/40 p-4 space-y-2">
        <div className="h-5 w-32 rounded-md bg-bg-elev animate-pulse-slow" />
        {Array.from({ length: 8 }).map((_, i) => (
          <div
            key={i}
            className="h-12 rounded-md bg-bg-elev/60 animate-pulse-slow"
            style={{ animationDelay: `${i * 50}ms` }}
          />
        ))}
      </div>
    </div>
  );
}
