"use client";

/**
 * KeyPointsAccordion — plan §5: AI bullets from `summarize`, each click-jumps
 * to its source message via MessageList's `scrollToMessage` registry
 * (InboxShell owns `messageRegistry`, threaded down through ContextPanel).
 * Collapsed/open state persists in ContextPanel's existing accordion
 * localStorage bucket (passed down as `open`/`onToggle`, same shape as
 * DealDetailsAccordion).
 */
import { ChevronDown, ListTree } from "lucide-react";
import type { KeyPoint } from "@/lib/ai-conversation-summarize";

export function KeyPointsAccordion({
  keyPoints,
  loading,
  open,
  onToggle,
  onJump,
}: {
  keyPoints: KeyPoint[];
  loading: boolean;
  open: boolean;
  onToggle: () => void;
  onJump: (messageId: string) => void;
}) {
  return (
    <div className="rounded-lg border border-violet-500/20 bg-violet-500/[0.04] overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center justify-between px-3.5 py-2.5 text-left"
      >
        <span className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-violet-400/80">
          <ListTree className="h-3.5 w-3.5" />
          Key points
          {keyPoints.length > 0 && <span className="text-violet-400/50 normal-case font-normal">({keyPoints.length})</span>}
        </span>
        <ChevronDown className={`h-3.5 w-3.5 text-violet-400/50 transition-transform duration-200 ${open ? "rotate-180" : ""}`} />
      </button>
      <div className={`grid transition-[grid-template-rows] duration-200 ease-out ${open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`}>
        <div className="overflow-hidden">
          <div className="px-3.5 pb-3 text-[12px]">
            {loading ? (
              <div className="space-y-1.5 animate-pulse">
                <div className="h-2.5 w-full rounded bg-violet-500/10" />
                <div className="h-2.5 w-3/5 rounded bg-violet-500/10" />
              </div>
            ) : keyPoints.length === 0 ? (
              <div className="text-fg-dim italic">No key points extracted yet.</div>
            ) : (
              <ul className="space-y-1.5">
                {keyPoints.map((kp, i) => (
                  <li key={`${kp.message_id}-${i}`}>
                    <button
                      type="button"
                      onClick={() => onJump(kp.message_id)}
                      className="text-left text-fg-muted hover:text-fg group flex items-start gap-1.5"
                      title="Jump to source message"
                    >
                      <span className="text-violet-400/60 group-hover:text-violet-300 mt-0.5">•</span>
                      <span className="group-hover:underline">{kp.text}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
