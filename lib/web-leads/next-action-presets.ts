/**
 * When to come back to a lead, shared by Call Mode and CallOutcomeLog.
 *
 * Mirrors KEEPS_LEAD_OPEN in lib/web-leads/outcome.ts, which is server-only
 * (it imports getServiceSupabase), so the client cannot value-import it.
 * tests/web-leads-callmode-next-action.test.ts runs this module's output
 * through the server's validateNextAction, so the two cannot drift.
 *
 * Offsets are computed at click time so a tab left open overnight cannot send
 * yesterday's "tomorrow".
 */
import type { CallOutcome } from "./outcome";

export const NEXT_ACTION_PRESETS: readonly { key: string; label: string; days: number }[] = [
  { key: "tomorrow", label: "Tomorrow", days: 1 },
  { key: "3d", label: "In 3 days", days: 3 },
  { key: "1w", label: "Next week", days: 7 },
  { key: "2w", label: "In 2 weeks", days: 14 },
];

export const DEFAULT_NEXT_ACTION_PRESET = "3d";

const KEEPS_LEAD_OPEN: readonly CallOutcome[] = ["no_answer", "connected", "interested"];

/** Same hour on the target day, not midnight: a callback owed "tomorrow" means
 *  during tomorrow's working day, and a midnight timestamp would read as
 *  overdue from the moment the day starts. */
export function presetToIso(days: number, now: Date = new Date()): string {
  const d = new Date(now.getTime());
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

/** A future instant for an outcome that keeps the lead open, null for one that
 *  ends it. An unknown preset key falls back to the default rather than
 *  sending no date, because no date is a guaranteed 400. */
export function nextActionForOutcome(
  outcome: CallOutcome,
  presetKey: string,
  now: Date = new Date(),
): string | null {
  if (!KEEPS_LEAD_OPEN.includes(outcome)) return null;
  const preset =
    NEXT_ACTION_PRESETS.find((p) => p.key === presetKey) ??
    NEXT_ACTION_PRESETS.find((p) => p.key === DEFAULT_NEXT_ACTION_PRESET)!;
  return presetToIso(preset.days, now);
}
