"use client";

/**
 * AISummaryCard — PLACEHOLDER for Phase 2 (plan §5/§6: `app/api/conversations
 * /summarize` + Haiku-generated summary). Renders the violet-tinted shell now
 * so the ContextPanel layout is final and doesn't shift when P2 lands; no AI
 * call happens in Phase 1.
 */
import { Sparkles } from "lucide-react";

export function AISummaryCard() {
  return (
    <div className="rounded-lg border border-violet-500/20 bg-violet-500/[0.04] px-3.5 py-3">
      <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-violet-400/80">
        <Sparkles className="h-3.5 w-3.5" />
        AI summary
      </div>
      <div className="mt-1.5 text-[12px] text-fg-dim italic">Coming in Phase 2 — thread summarization.</div>
    </div>
  );
}
