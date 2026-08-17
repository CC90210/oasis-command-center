/**
 * lib/drips/sms-pacing-core.ts — spread the Live Subs texts across the day.
 *
 * Adon, 2026-08-17: "Start sending them out slowly. Don't do it as a blast.
 * Just do it as a drip throughout the day. Let's start off with doing 40 a day."
 *
 * There was NO SMS volume governor at all — the governor caps email only. So
 * without this, enabling the sequence pushes every due row in one dispatch
 * tick: 40 texts from one number inside five minutes, which is the shape
 * carriers filter on and exactly the blast he asked not to send.
 *
 * Two ceilings, because one is not enough:
 *   DAILY   the number he asked for.
 *   HOURLY  what makes it a drip rather than a burst. 40/day with no hourly
 *           ceiling is still 40 in the first five minutes.
 *
 * HOLD, NEVER DROP. Over a ceiling the row reschedules to when the ceiling
 * actually lifts — the top of the next hour, or the start of tomorrow's send
 * window. Rescheduling to "now + an hour" instead would let a backlog drift
 * later every cycle, and rescheduling to a fixed time that is already past is
 * the permanent-loop bug this engine has produced three times.
 *
 * Pure and free of "server-only": the arithmetic that decides how many
 * merchants get a text today is directly testable.
 */

export type PacingCaps = {
  daily: number;
  hourly: number;
  /** UTC hour the sending window opens. Rows held overnight resume here rather
   *  than at midnight, so a backlog does not land at 3am local. */
  windowStartUtcHour: number;
};

export type PacingCounts = {
  sentToday: number;
  sentThisHour: number;
};

export type PacingDecision =
  | { send: true }
  | { send: false; reason: string; resumeAt: Date };

function intEnv(env: Record<string, string | undefined>, name: string, def: number): number {
  const n = parseInt((env[name] || "").trim(), 10);
  return Number.isFinite(n) && n >= 0 ? n : def;
}

/**
 * Caps, read at call time so the ramp moves without a deploy.
 *
 * 40/day is Adon's number. 6/hour is 40 spread over a business day with a
 * little headroom, so a quiet morning can still catch up in the afternoon
 * rather than stranding rows.
 */
export function smsPacingCaps(env: Record<string, string | undefined> = process.env): PacingCaps {
  return {
    daily: intEnv(env, "DRIPS_SMS_DAILY_CAP", 40),
    hourly: intEnv(env, "DRIPS_SMS_HOURLY_CAP", 6),
    windowStartUtcHour: intEnv(env, "DRIPS_SMS_WINDOW_START_UTC", 14), // ~10am ET
  };
}

/**
 * Start of the CURRENT sending day: the most recent window opening at or
 * before `now`.
 *
 * The daily count must be measured from here, not over a rolling 24 hours.
 * With a rolling window the two boundaries disagree: hit the cap at 20:00,
 * resume at 14:00 tomorrow, and yesterday's 14:00-20:00 sends are still inside
 * the last 24 hours, so the row is immediately held for another full day. That
 * turns 40 a day into roughly 40 every two days, quietly. Codex caught it.
 */
export function windowStartFor(now: Date, startHour: number): Date {
  const d = new Date(now);
  d.setUTCHours(startHour, 0, 0, 0);
  if (d.getTime() > now.getTime()) d.setUTCDate(d.getUTCDate() - 1);
  return d;
}

/** Start of the next sending window, strictly in the future. */
export function nextWindowStart(now: Date, startHour: number): Date {
  const d = new Date(now);
  d.setUTCHours(startHour, 0, 0, 0);
  // Strictly future, or a row held at exactly the window start would reschedule
  // to the instant it already is and spin.
  if (d.getTime() <= now.getTime()) d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

/** Top of the next hour, strictly in the future. */
export function nextHourStart(now: Date): Date {
  const d = new Date(now);
  d.setUTCMinutes(0, 0, 0);
  d.setUTCHours(d.getUTCHours() + 1);
  return d;
}

export function pacingDecision(
  counts: PacingCounts,
  caps: PacingCaps,
  now: Date,
): PacingDecision {
  // A cap of 0 means "stopped", which is a legitimate operator choice and must
  // not be confused with "unset". smsPacingCaps already defaults an unset value.
  if (counts.sentToday >= caps.daily) {
    return {
      send: false,
      reason: `sms_daily_cap (${counts.sentToday}/${caps.daily})`,
      resumeAt: nextWindowStart(now, caps.windowStartUtcHour),
    };
  }
  if (counts.sentThisHour >= caps.hourly) {
    return {
      send: false,
      reason: `sms_hourly_cap (${counts.sentThisHour}/${caps.hourly})`,
      resumeAt: nextHourStart(now),
    };
  }
  return { send: true };
}
