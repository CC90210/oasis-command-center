/**
 * Pure pieces of the sequence edit guard (no server-only imports) — mirrors
 * the blast-safety / blast-safety-core split so client code and unit tests
 * can use the predicates without dragging in the DB-backed guard.
 */

import type { DripStep } from "./types";

const TOKEN_RE = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;
export const STOP_RE = /\b(reply\s+stop|text\s+stop|stop\s+to\s+(opt\s*out|unsubscribe|end))\b/i;

export function extractCopyTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of (text || "").matchAll(TOKEN_RE)) out.add(m[1]);
  return out;
}

/** All copy of one step that can REACH a merchant, joined for scanning —
 *  including `body_html`, which is what actually gets delivered when present
 *  (codex P1 2026-07-22: HTML previously bypassed the write guard). */
export function stepCopyJoined(s: DripStep): string {
  return [
    s.subject || "",
    s.body,
    s.body_html || "",
    ...(s.subject_variants || []),
    ...(s.body_variants || []),
  ]
    .filter(Boolean)
    .join("\n");
}

/** Union of merge tokens across a whole sequence's steps. */
export function sequenceTokens(steps: DripStep[]): Set<string> {
  const out = new Set<string>();
  for (const s of steps || []) {
    for (const t of extractCopyTokens(stepCopyJoined(s))) out.add(t);
  }
  return out;
}

/**
 * Tokens referenced ANYWHERE in the prior sequence but NOWHERE in the next —
 * sequence-level on purpose (codex P1 2026-07-22): index-to-index comparison
 * false-rejected legitimate reorders/inserts/deletes. Moving a token between
 * steps is fine; only losing it from the whole sequence flags.
 */
export function sequenceDroppedTokens(prior: DripStep[], next: DripStep[]): string[] {
  const after = sequenceTokens(next);
  return [...sequenceTokens(prior)].filter((t) => !after.has(t));
}

/**
 * True when the prior sequence carried an SMS opt-out instruction, the next
 * still has SMS steps, and NONE of them carries one — sequence-level for the
 * same reorder-safety reason. A sequence that drops SMS entirely passes.
 */
export function smsStopRemoved(prior: DripStep[], next: DripStep[]): boolean {
  const priorHadStop = (prior || []).some(
    (s) => s.channel === "sms" && STOP_RE.test(stepCopyJoined(s)),
  );
  if (!priorHadStop) return false;
  const nextSms = (next || []).filter((s) => s.channel === "sms");
  if (nextSms.length === 0) return false;
  return !nextSms.some((s) => STOP_RE.test(stepCopyJoined(s)));
}
