/**
 * /leads loading skeleton — header + LeadsTableClient skeleton (shared
 * with /pipeline via components/leads/LeadsTableClientSkeleton.tsx).
 *
 * Defaults to 12 stage tabs (SunBiz's max) so the strip doesn't pop
 * when the OASIS 11-stage list arrives; the extra placeholder row
 * just vanishes on swap which reads as "one tab finished loading"
 * rather than "the strip changed shape."
 */

import { LeadsTableClientSkeleton } from "@/components/leads/LeadsTableClientSkeleton";

export default function LeadsLoading() {
  return (
    <div className="space-y-6 animate-fade-in" aria-busy="true" aria-live="polite">
      <div className="space-y-2">
        <div className="h-7 w-24 rounded-md bg-bg-elev animate-pulse-slow" />
        <div className="h-4 w-80 rounded-md bg-bg-elev/60 animate-pulse-slow" />
      </div>
      <LeadsTableClientSkeleton />
    </div>
  );
}
