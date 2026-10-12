/**
 * AiBrainSummaryBar - the one sentence at the top of Settings > AI brain
 * (AI1): "Your departments answer with X. If it's offline: Y." Built from
 * lib/ai/ai-brain-summary.ts, which reads ONLY the viewer's own effective
 * engine and device, plus the workspace's fallback account -- never a
 * teammate's row. A failed read says so plainly, never a guess.
 */
import Link from "next/link";
import { Dot } from "lucide-react";
import type { AiBrainSummary } from "@/lib/ai/ai-brain-summary";

export function AiBrainSummaryBar({ summary, changeHref }: { summary: AiBrainSummary; changeHref: string }) {
  if (!summary.ok) {
    return (
      <div className="rounded-lg border border-hairline bg-bg-panel p-3 text-sm text-fg-muted" role="alert">
        Couldn&apos;t load what answers your departments right now. Refresh to try again.
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-hairline bg-bg-panel p-3">
      <p className="text-sm text-fg">
        Your departments answer with <span className="font-bold">{summary.primaryLine}</span>
        {summary.primaryIsDevice && summary.deviceOnline !== null && (
          <span
            className={`ml-1.5 inline-flex items-center text-[11px] font-semibold ${summary.deviceOnline ? "text-status-engaged" : "text-status-warm"}`}
            data-testid="ai-brain-device-status"
          >
            <Dot className="h-4 w-4" strokeWidth={3} aria-hidden />
            {summary.deviceOnline ? "Online" : "Offline"}
          </span>
        )}
        {summary.deviceLastSeenAt && (
          <span className="ml-1 text-xs text-fg-dim">(last check-in {new Date(summary.deviceLastSeenAt).toLocaleString()})</span>
        )}
        {summary.fallbackLine && (
          <>
            {" "}
            <span className="text-fg-muted">If it&apos;s offline: {summary.fallbackLine}.</span>
          </>
        )}
      </p>
      <Link href={changeHref} prefetch={false} className="shrink-0 text-xs font-semibold text-accent hover:text-accent-bright underline underline-offset-2">
        Change
      </Link>
    </div>
  );
}
