/**
 * WebLeadsSkeleton — the Suspense fallback for app/web-leads/page.tsx.
 * WebLeadsBrowser.tsx needs useSearchParams(), which requires a Suspense
 * boundary; this mirrors that component's shape (page header + segmented
 * control + filter rail + table) so the swap from skeleton to the real
 * page is visually quiet, same convention as
 * components/leads/LeadsTableClientSkeleton.tsx.
 */
export function WebLeadsSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-live="polite">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-2">
          <div className="h-7 w-32 rounded bg-bg-elev animate-pulse-slow" />
          <div className="h-3.5 w-full max-w-xl rounded bg-bg-elev/60 animate-pulse-slow" />
        </div>
        <div className="h-9 w-56 shrink-0 rounded-lg bg-bg-elev animate-pulse-slow" />
      </div>
      <div className="flex gap-6">
        <div className="w-64 shrink-0 space-y-3">
          <div className="h-9 rounded-md bg-bg-elev animate-pulse-slow" />
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="h-6 rounded bg-bg-elev/60 animate-pulse-slow" style={{ animationDelay: `${i * 40}ms` }} />
          ))}
        </div>
        <div className="min-w-0 flex-1 space-y-3">
          <div className="h-9 w-64 rounded-md bg-bg-elev animate-pulse-slow" />
          <div className="overflow-hidden rounded-lg border border-bg-border">
            <div className="h-9 border-b border-bg-border bg-bg-panel" />
            {Array.from({ length: 8 }).map((_, i) => (
              <div
                key={i}
                className="h-12 border-b border-bg-border/60 bg-bg-panel/40 last:border-0 animate-pulse-slow"
                style={{ animationDelay: `${i * 50}ms` }}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
