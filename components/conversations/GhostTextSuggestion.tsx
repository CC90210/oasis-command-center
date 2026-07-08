"use client";

/**
 * GhostTextSuggestion — STUB for Phase 2. Plan §6.4 #2: on a focused-empty
 * composer, a debounced (800ms) `mode:'ghost'` call renders a single dim
 * inline completion sentence; Tab accepts, any keystroke dismisses,
 * in-flight requests cancel on input. Not wired in Phase 1 (no
 * `voice-suggest` route exists yet). Exported now so the Composer integration
 * point is stable for P2.
 */
export function GhostTextSuggestion({
  text,
  onAccept,
  onDismiss,
}: {
  text?: string;
  onAccept?: () => void;
  onDismiss?: () => void;
}) {
  void text;
  void onAccept;
  void onDismiss;
  return null;
}
