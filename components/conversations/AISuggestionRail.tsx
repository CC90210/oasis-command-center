"use client";

/**
 * AISuggestionRail — PLACEHOLDER for Phase 2 (plan §6.4 #3: proactive
 * next-action chips derived from lead state + key points, e.g. "Send stip
 * reminder"). No logic in Phase 1.
 */
import { Sparkles } from "lucide-react";

export function AISuggestionRail() {
  return (
    <div className="flex items-center gap-1.5 px-0.5">
      <Sparkles className="h-3 w-3 text-violet-400/50 shrink-0" />
      <span className="text-[10.5px] text-fg-dim italic">Suggested actions — coming in Phase 2.</span>
    </div>
  );
}
