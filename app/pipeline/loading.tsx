/**
 * /pipeline loading skeleton — header + funnel-chart placeholder +
 * LeadsTableClient skeleton (shared with /leads via
 * components/leads/LeadsTableClientSkeleton.tsx) + recent inbound /
 * outbound placeholders. Matches the real page's DOM so the swap from
 * skeleton → data doesn't reflow.
 */

import { LeadsTableClientSkeleton } from "@/components/leads/LeadsTableClientSkeleton";

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
      {/* The actual leads table (shared skeleton). 11-stage strip for OASIS. */}
      <LeadsTableClientSkeleton stageCount={11} rowCount={6} />
      {/* Recent inbound / outbound — 2-column grid below the table */}
      <div className="grid lg:grid-cols-2 gap-6">
        <div className="h-56 rounded-xl border border-bg-border bg-bg-elev/40 animate-pulse-slow" />
        <div className="h-56 rounded-xl border border-bg-border bg-bg-elev/40 animate-pulse-slow" />
      </div>
    </div>
  );
}
