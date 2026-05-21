/**
 * LeadsTableClientSkeleton — placeholder that matches LeadsTableClient's
 * DOM shape (stage-tab strip + search input + table rows) so the swap
 * from `loading.tsx` to the real component is visually quiet.
 *
 * Used by every Next.js route that renders LeadsTableClient — currently
 * /pipeline and /leads. Centralised here so the skeleton can't drift
 * from the real component as the table evolves.
 *
 * Stage-tab count is configurable so /pipeline (11 OASIS stages) and
 * /leads (11 OASIS or 12 SunBiz — picks the larger to avoid empty space)
 * both look right.
 */

type Props = {
  /** Number of stage-tab placeholders to render. Defaults to 12
   *  (SunBiz max); pass 11 for OASIS-only callers. */
  stageCount?: number;
  /** Number of leading skeleton rows in the table body. Defaults to 8. */
  rowCount?: number;
};

export function LeadsTableClientSkeleton({ stageCount = 12, rowCount = 8 }: Props) {
  return (
    <div className="space-y-3" aria-busy="true" aria-live="polite">
      {/* Stage tabs */}
      <div className="flex flex-wrap gap-1.5">
        {Array.from({ length: stageCount }).map((_, i) => (
          <div
            key={i}
            className="h-7 w-20 rounded-md bg-bg-elev animate-pulse-slow"
            style={{ animationDelay: `${i * 40}ms` }}
          />
        ))}
      </div>
      {/* Search + sort */}
      <div className="flex items-center gap-2">
        <div className="h-9 flex-1 max-w-md rounded-md bg-bg-elev/60 animate-pulse-slow" />
        <div className="h-9 w-24 rounded-md bg-bg-elev/60 animate-pulse-slow" />
      </div>
      {/* Table */}
      <div className="rounded-xl border border-bg-border bg-bg-elev/40 overflow-hidden">
        <div className="h-10 border-b border-bg-border bg-bg-elev/60 animate-pulse-slow" />
        {Array.from({ length: rowCount }).map((_, i) => (
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
