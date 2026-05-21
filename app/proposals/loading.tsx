/**
 * /proposals loading skeleton — header + table-shaped placeholder. Smaller
 * than /leads because there's no stage-tab strip and proposals volume is
 * always low relative to leads.
 */
export default function ProposalsLoading() {
  return (
    <div className="space-y-6 animate-fade-in" aria-busy="true" aria-live="polite">
      <div className="space-y-2">
        <div className="h-7 w-32 rounded-md bg-bg-elev animate-pulse-slow" />
        <div className="h-4 w-80 rounded-md bg-bg-elev/60 animate-pulse-slow" />
      </div>
      <div className="rounded-xl border border-bg-border bg-bg-elev/40 overflow-hidden">
        <div className="h-10 border-b border-bg-border bg-bg-elev/60 animate-pulse-slow" />
        {Array.from({ length: 5 }).map((_, i) => (
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
