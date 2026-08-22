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
 * IT RESUMES AT FULL VOLUME, and that is a deliberate reversal. An earlier cut
 * restarted at 10/day; Adon set it back to 40. The protection against a bad
 * line is no longer the ceiling — it is the canary allow-list, the per-line
 * bench, the wire halt and the landline gate, all of which act in single digits
 * of wasted messages whatever the cap says. See RESTART_DAILY.
 */

import type { LineResult } from "./canary-core";
import { clearedLines, resumeAllowed } from "./canary-core";

/**
 * Where volume restarts.
 *
 * Adon, 2026-08-20: "it should be at 40 a day."
 *
 * I had this at 10 and he overrode it. Worth recording WHY that is defensible
 * now and was not this morning: on 2026-08-18 a low cap was the only thing
 * standing between a bad line and a burned cohort. It no longer is. Since then
 *
 *   - a line that refuses a canary is excluded from the pool entirely,
 *   - 3 consecutive carrier failures bench a line automatically,
 *   - 5 across a wire halt it,
 *   - known landlines are skipped before a message is spent,
 *   - and receipts are verified again, so all of the above actually fire.
 *
 * Those catch a fault in single digits of wasted messages regardless of the
 * ceiling. A volume cap was a blunt substitute for exactly this machinery, and
 * keeping it low now would cost real merchant contact to buy protection we
 * already have.
 *
 * Note this is a CEILING, not a target. Measured 2026-08-20, actual sends were
 * 2-17 a day against a cap of 40 — the cap has never been the binding
 * constraint. sms.sent_vs_target is the check that tells us when the gap is
 * real, because a number in this file cannot make texts happen.
 */
export const RESTART_DAILY = 40;
export const RESTART_HOURLY = 7;

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

