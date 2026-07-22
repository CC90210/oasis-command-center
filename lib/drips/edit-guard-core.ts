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

/** All human-visible copy of one step, joined for scanning. */
export function stepCopyJoined(s: DripStep): string {
  return [s.subject || "", s.body, ...(s.subject_variants || []), ...(s.body_variants || [])]
    .filter(Boolean)
    .join("\n");
}

/** Tokens present in `prior` but missing from `next` — the silent-merge-break case. */
export function droppedTokens(prior: DripStep, next: DripStep): string[] {
  const before = extractCopyTokens(stepCopyJoined(prior));
  const after = extractCopyTokens(stepCopyJoined(next));
  return [...before].filter((t) => !after.has(t));
}

/** True when an SMS edit removed a previously-present opt-out instruction. */
export function stopLineRemoved(prior: DripStep, next: DripStep): boolean {
  return STOP_RE.test(stepCopyJoined(prior)) && !STOP_RE.test(stepCopyJoined(next));
}
