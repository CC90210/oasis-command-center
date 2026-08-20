/**
 * lib/sms/resume-core.ts — the rule for turning texting back on.
 *
 * Texting was halted on 2026-08-20 at three levels: queued rows cancelled, SMS
 * sequences disabled, tenant SMS caps set to zero. This decides when that comes
 * back, and it is written as a REFUSAL rather than a procedure, because the
 * failure being designed out is a human deciding "it looks fine now".
 *
 * On 2026-08-18 it did look fine. Eight of eight delivered. Twenty-two hours
 * later every send from those numbers was refused. The bar is therefore
 * evidence separated in time (canary-core.ts), and this file will not resume
 * without it.
 *
 * IT ALSO RESUMES SMALL. The caps before the halt were 40/day and 7/hour. Going
 * straight back to those would put a day's volume through lines that have two
 * data points each. Ten a day is enough to accumulate real receipts and cheap
 * enough that being wrong again costs ten messages, not four hundred.
 */

import type { LineResult } from "./canary-core";
import { clearedLines, resumeAllowed } from "./canary-core";

/** Where volume restarts, regardless of where it was before the halt. */
export const RESTART_DAILY = 10;
export const RESTART_HOURLY = 2;

export type ResumePlan = {
  allowed: boolean;
  reason: string;
  /** Lines proven to deliver. Empty when not allowed. */
  lines: string[];
  dailyCap: number;
  hourlyCap: number;
};

/**
 * May texting resume, and at what volume?
 *
 * FAIL CLOSED in every direction: no cleared lines, an unreadable canary
 * history, or an empty result set all refuse. There is no argument that
 * produces a resume without at least one line having delivered twice.
 */
export function resumePlan(
  results: LineResult[] | null,
  opts: { dailyCap?: number; hourlyCap?: number } = {},
): ResumePlan {
  const daily = opts.dailyCap ?? RESTART_DAILY;
  const hourly = opts.hourlyCap ?? RESTART_HOURLY;

  if (results === null) {
    return {
      allowed: false,
      reason: "canary history could not be read - refusing to resume on an unknown pool",
      lines: [],
      dailyCap: 0,
      hourlyCap: 0,
    };
  }

  const verdict = resumeAllowed(results);
  if (!verdict.ok) {
    return { allowed: false, reason: verdict.reason, lines: [], dailyCap: 0, hourlyCap: 0 };
  }

  const lines = clearedLines(results);
  return {
    allowed: true,
    reason: `${verdict.reason}. Restarting at ${daily}/day, ${hourly}/hour.`,
    lines,
    dailyCap: daily,
    hourlyCap: hourly,
  };
}

/**
 * The next step up, once a restart has held.
 *
 * Deliberately NOT automatic. Every ramp in this system that moved on a timer
 * eventually moved on a day when the thing it was measuring was broken. A step
 * requires a clean week of real carrier receipts, which is a judgement about
 * evidence rather than about elapsed time, and it stays a human decision.
 */
export function nextRamp(currentDaily: number): number {
  if (currentDaily < RESTART_DAILY) return RESTART_DAILY;
  if (currentDaily < 25) return 25;
  if (currentDaily < 40) return 40;
  return currentDaily;
}
