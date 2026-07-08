"use client";

/**
 * AIDraftBanner — plan §3/§6.4. Renders above the Composer textarea whenever
 * the composer currently holds an unedited AI voice-suggestion (Composer
 * computes that equality check and only mounts this when true — see
 * Composer.tsx's `aiDraftActive`). Violet border, confidence chip, "why this
 * suggestion" tooltip, Accept & Send / Edit / Regenerate / Discard.
 */
import { Sparkles, Check, Pencil, RotateCcw, X } from "lucide-react";

const CONFIDENCE_LABEL: Record<"low" | "med" | "high", string> = {
  low: "Low confidence",
  med: "Medium confidence",
  high: "High confidence",
};

const CONFIDENCE_TONE: Record<"low" | "med" | "high", string> = {
  low: "bg-fg-dim/10 text-fg-dim border-fg-dim/30",
  med: "bg-amber-500/10 text-amber-300 border-amber-500/30",
  high: "bg-violet-500/15 text-violet-300 border-violet-500/40",
};

export function AIDraftBanner({
  confidence = "low",
  sanitized = true,
  loading,
  onAcceptSend,
  onEdit,
  onRegenerate,
  onDiscard,
}: {
  confidence?: "low" | "med" | "high";
  sanitized?: boolean;
  loading?: boolean;
  onAcceptSend?: () => void;
  onEdit?: () => void;
  onRegenerate?: () => void;
  onDiscard?: () => void;
}) {
  return (
    <div className="rounded-lg border border-violet-500/30 bg-violet-500/[0.06] px-3 py-2 space-y-1.5">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="inline-flex items-center gap-1 text-[11px] font-bold text-violet-300">
          <Sparkles className="h-3 w-3" />
          AI draft
        </span>
        <span
          title={
            sanitized
              ? "Drafted in this rep's voice from their past messages, grounded in this thread + the lead file. Review before sending."
              : "The AI draft was blocked by the safety check (lender name or unsafe content) and replaced with a safe template — review before sending."
          }
          className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[9.5px] font-bold uppercase tracking-wider cursor-help ${CONFIDENCE_TONE[confidence]}`}
        >
          {sanitized ? CONFIDENCE_LABEL[confidence] : "Safety fallback"}
        </span>
        {loading && <span className="text-[10.5px] text-fg-dim italic">Regenerating…</span>}
      </div>
      <div className="flex items-center gap-3 flex-wrap">
        {onAcceptSend && (
          <button
            type="button"
            onClick={onAcceptSend}
            disabled={loading}
            className="inline-flex items-center gap-1 text-[11px] font-bold text-violet-200 hover:text-white disabled:opacity-50"
          >
            <Check className="h-3 w-3" /> Accept &amp; Send
          </button>
        )}
        {onEdit && (
          <button
            type="button"
            onClick={onEdit}
            disabled={loading}
            className="inline-flex items-center gap-1 text-[11px] text-fg-muted hover:text-fg disabled:opacity-50"
          >
            <Pencil className="h-3 w-3" /> Edit
          </button>
        )}
        {onRegenerate && (
          <button
            type="button"
            onClick={onRegenerate}
            disabled={loading}
            className="inline-flex items-center gap-1 text-[11px] text-fg-muted hover:text-fg disabled:opacity-50"
          >
            <RotateCcw className="h-3 w-3" /> Regenerate
          </button>
        )}
        {onDiscard && (
          <button
            type="button"
            onClick={onDiscard}
            disabled={loading}
            className="inline-flex items-center gap-1 text-[11px] text-fg-dim hover:text-status-hot disabled:opacity-50"
          >
            <X className="h-3 w-3" /> Discard
          </button>
        )}
      </div>
    </div>
  );
}
