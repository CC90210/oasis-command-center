"use client";

/**
 * KeyPointsAccordion — PLACEHOLDER for Phase 2 (plan §5: AI bullets, each
 * click-jumps to its source message via MessageList's scrollToMessage
 * registry). No AI call in Phase 1; renders the collapsed shell only.
 */
import { ChevronDown, ListTree } from "lucide-react";

export function KeyPointsAccordion() {
  return (
    <div className="rounded-lg border border-violet-500/20 bg-violet-500/[0.04] overflow-hidden">
      <div className="w-full flex items-center justify-between px-3.5 py-2.5 text-left opacity-70">
        <span className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-violet-400/80">
          <ListTree className="h-3.5 w-3.5" />
          Key points
        </span>
        <ChevronDown className="h-3.5 w-3.5 text-violet-400/50" />
      </div>
      <div className="px-3.5 pb-3 text-[12px] text-fg-dim italic">Coming in Phase 2 — click-to-source bullets.</div>
    </div>
  );
}
