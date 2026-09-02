/**
 * Metrics tab skeleton (P1 instant-load, 2026-09-01). Metrics is the
 * heaviest remaining read in the app (the unbounded lead-blob pull, P2's
 * target), so its wait deserves a shaped placeholder rather than the
 * generic root fallback: header, stat tiles, then two chart panels —
 * matching the page's real furniture without mocking any data.
 */

export default function Loading() {
  return (
    <div className="space-y-6 animate-fade-in" aria-busy="true" aria-live="polite">
      <div className="space-y-2">
        <div className="h-7 w-40 rounded-md bg-bg-elev animate-pulse-slow" />
        <div className="h-4 w-64 rounded-md bg-bg-elev/60 animate-pulse-slow" />
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className="h-24 rounded-xl border border-bg-border bg-bg-elev/60 animate-pulse-slow"
          />
        ))}
      </div>
      <div className="h-80 rounded-xl border border-bg-border bg-bg-elev/40 animate-pulse-slow" />
      <div className="grid lg:grid-cols-2 gap-4">
        <div className="h-64 rounded-xl border border-bg-border bg-bg-elev/40 animate-pulse-slow" />
        <div className="h-64 rounded-xl border border-bg-border bg-bg-elev/40 animate-pulse-slow" />
      </div>
    </div>
  );
}
