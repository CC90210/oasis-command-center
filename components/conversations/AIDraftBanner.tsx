"use client";

/**
 * AIDraftBanner — STUB for Phase 2. Plan §3/§6.4: once `voice-suggest`
 * exists, this renders above the Composer textarea with a violet border,
 * a confidence chip, and Accept & Send / Edit / Regenerate / Discard
 * actions whenever an AI draft is loaded into the composer. Not mounted
 * anywhere in Phase 1 — Composer's "✨ Suggest" button is disabled, so
 * there's never a draft to show. Exported now so P2 only has to fill in
 * the body, not invent the integration point.
 */
export function AIDraftBanner({
  confidence,
  onAcceptSend,
  onEdit,
  onRegenerate,
  onDiscard,
}: {
  confidence?: "low" | "med" | "high";
  onAcceptSend?: () => void;
  onEdit?: () => void;
  onRegenerate?: () => void;
  onDiscard?: () => void;
}) {
  void confidence;
  void onAcceptSend;
  void onEdit;
  void onRegenerate;
  void onDiscard;
  return null;
}
