/**
 * Pure grouping of the board's per-stage counts into Today's tiles. No I/O —
 * tests/oasis-board-summary.test.ts executes it.
 */

export type BoardSummary = {
  /** Every lead on the board except lost ones — open work plus won/delivery. */
  onBoard: number;
  qualified: number;
  meetings: number;
  won: number;
  lost: number;
  cycleStartedAt: string;
};

/** Stages that mean the sale is closed-won (delivery stages included). */
export const WON_STAGES: readonly string[] = ["won", "onboarding", "in_build", "client_review", "launched"];
/** Stages where a founder conversation is booked or has happened. */
export const MEETING_STAGES: readonly string[] = ["founder_meeting_booked", "demo_completed", "proposal_sent"];

export function summarizeBoardCounts(
  stageCounts: Readonly<Record<string, number>>,
  cycleStartedAt: string,
): BoardSummary {
  const count = (keys: readonly string[]) =>
    keys.reduce((sum, key) => sum + (Number(stageCounts[key]) || 0), 0);
  const total = Object.values(stageCounts).reduce((sum, n) => sum + (Number(n) || 0), 0);
  const lost = Number(stageCounts.lost) || 0;
  return {
    onBoard: total - lost,
    qualified: Number(stageCounts.qualified) || 0,
    meetings: count(MEETING_STAGES),
    won: count(WON_STAGES),
    lost,
    cycleStartedAt,
  };
}
