"use client";

/**
 * GhostTextSuggestion — plan §6.4 #2. On a focused-empty composer, Composer
 * debounces (800ms) a `mode:'ghost'` voice-suggest call and passes the
 * result here as `text`. True inline-caret ghost text would need a
 * contentEditable/canvas-measured overlay to stay pixel-aligned with a
 * plain <textarea>; instead this renders a dim, dismissible pill anchored
 * under the composer — Tab (handled by Composer's onKeyDown) accepts it,
 * any keystroke or blur dismisses it (also handled by Composer, which owns
 * the debounce/fetch/cancel lifecycle).
 */
import { Sparkles, CornerDownLeft } from "lucide-react";

export function GhostTextSuggestion({
  text,
  onAccept,
  onDismiss,
}: {
  text?: string | null;
  onAccept?: () => void;
  onDismiss?: () => void;
}) {
  if (!text) return null;
  return (
    <div className="flex items-center gap-1.5 text-[11px] text-fg-dim animate-in fade-in duration-150">
      <Sparkles className="h-3 w-3 text-violet-400/70 shrink-0" />
      <span className="italic truncate">&ldquo;{text}&rdquo;</span>
      <button
        type="button"
        onClick={onAccept}
        className="inline-flex items-center gap-0.5 shrink-0 text-violet-300 hover:text-violet-200 font-semibold"
      >
        <CornerDownLeft className="h-3 w-3 rotate-180" />
        Tab to accept
      </button>
      {onDismiss && (
        <button type="button" onClick={onDismiss} className="shrink-0 text-fg-dim hover:text-fg" aria-label="Dismiss suggestion">
          ×
        </button>
      )}
    </div>
  );
}
