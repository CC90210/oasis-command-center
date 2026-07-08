"use client";

/**
 * AISummaryCard — plan §5/§6: `app/api/conversations/summarize`-generated
 * summary. ContextPanel owns the fetch + client-side cache (keyed on
 * `thread.key + thread.last_at`, matching DealDetailsAccordion's sibling
 * pattern of the parent owning data + this component staying presentational)
 * and passes the result down so regenerate/loading/error stay one state
 * machine instead of two components racing each other.
 */
import { Sparkles, RotateCw } from "lucide-react";

export function AISummaryCard({
  summary,
  loading,
  error,
  onRegenerate,
}: {
  summary: string | null;
  loading: boolean;
  error?: string | null;
  onRegenerate: () => void;
}) {
  return (
    <div className="rounded-lg border border-violet-500/20 bg-violet-500/[0.04] px-3.5 py-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-violet-400/80">
          <Sparkles className="h-3.5 w-3.5" />
          AI summary
        </div>
        <button
          type="button"
          onClick={onRegenerate}
          disabled={loading}
          title="Regenerate summary"
          className="text-violet-400/60 hover:text-violet-300 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <RotateCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>
      {loading ? (
        <div className="mt-2 space-y-1.5 animate-pulse">
          <div className="h-2.5 w-full rounded bg-violet-500/10" />
          <div className="h-2.5 w-4/5 rounded bg-violet-500/10" />
        </div>
      ) : error ? (
        <div className="mt-1.5 text-[12px] text-fg-dim">
          {error} <button type="button" onClick={onRegenerate} className="text-violet-300 hover:underline">Retry</button>
        </div>
      ) : summary ? (
        <div className="mt-1.5 text-[12.5px] text-fg leading-relaxed">{summary}</div>
      ) : (
        <div className="mt-1.5 text-[12px] text-fg-dim italic">No summary yet.</div>
      )}
    </div>
  );
}
