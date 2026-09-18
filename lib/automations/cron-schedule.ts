/**
 * What a row's `next_run_at` actually means once the clock has passed it.
 *
 * THE FAILURE THIS FILE EXISTS TO MAKE VISIBLE. When the machine running
 * scripts/scheduler.py stops, nothing writes to cron_jobs at all. No row goes
 * red, because a red row requires a run that failed and there are no runs. Every
 * card keeps the last_result of its last successful fire, every toggle still
 * reads "On", and `next_run_at` — a timestamp that went stale the moment the
 * scheduler died — keeps rendering through toLocaleString as a future
 * commitment: "Next Sep 1, 3:00 AM EDT", in September, weeks after Sep 1. The
 * tab reports a perfectly healthy fleet while nothing has fired since.
 *
 * A timestamp in the past is not a plan. The minimum honesty is the tense:
 * "Was due", never "Next". Past that, the row's own cron expression says how
 * late is late — a five-minute sweep is overdue in minutes, a Sunday digest is
 * not overdue until a week has gone by — so the verdict is measured against the
 * schedule rather than a flat threshold, the same way
 * scripts/core/cron_health_check.py:staleness derives its window.
 *
 * Kept out of the component so it can be exercised directly with a frozen
 * clock; a rendering-only fix to this would be untestable except by reading the
 * file back as a string.
 */

const DAY_SECONDS = 86_400;

const DOW_NAMES: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

function dayOfWeekNumber(token: string): number | null {
  if (/^\d$/.test(token)) return Number(token) % 7; // cron allows 7 for Sunday
  const named = DOW_NAMES[token];
  return named === undefined ? null : named;
}

/**
 * Expand a numeric cron field — star, step, single value, range, range with a
 * step, or a comma list of those — to the sorted values it fires on. Null for
 * anything else: a wrong interval is worse than no interval, because it mints a
 * confident "Overdue" on a schedule nobody parsed correctly.
 */
function expandNumericField(field: string, min: number, max: number): number[] | null {
  const values = new Set<number>();
  for (const rawPart of field.split(",")) {
    const part = rawPart.trim();
    if (!part) return null;
    const match = part.match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/);
    if (!match) return null;
    const step = match[2] === undefined ? 1 : Number(match[2]);
    if (!Number.isInteger(step) || step < 1) return null;
    let from: number;
    let to: number;
    if (match[1] === "*") {
      from = min;
      to = max;
    } else if (match[1].includes("-")) {
      const [a, b] = match[1].split("-").map(Number);
      from = a;
      to = b;
    } else {
      from = Number(match[1]);
      to = match[2] === undefined ? from : max;
    }
    if (from < min || to > max || from > to) return null;
    for (let v = from; v <= to; v += step) values.add(v);
  }
  return values.size > 0 ? [...values].sort((a, b) => a - b) : null;
}

/** Day-of-week field → the days it fires on. Handles MON-FRI as well as 1-5. */
function expandDayOfWeek(field: string): number[] | null {
  if (field.trim() === "*" || field.trim() === "?") return [0, 1, 2, 3, 4, 5, 6];
  const days = new Set<number>();
  for (const rawPart of field.split(",")) {
    const part = rawPart.trim().toLowerCase();
    if (!part) return null;
    const range = part.match(/^([a-z]{3}|\d)-([a-z]{3}|\d)$/);
    if (range) {
      const from = dayOfWeekNumber(range[1]);
      const to = dayOfWeekNumber(range[2]);
      if (from === null || to === null) return null;
      // Cron ranges wrap, so FRI-MON is Fri, Sat, Sun, Mon.
      for (let d = from; ; d = (d + 1) % 7) {
        days.add(d);
        if (d === to) break;
      }
      continue;
    }
    const single = dayOfWeekNumber(part);
    if (single === null) return null;
    days.add(single);
  }
  return days.size > 0 ? [...days].sort((a, b) => a - b) : null;
}

/** Largest gap, in days, between consecutive firing weekdays across the wrap. */
function largestWeeklyGapDays(days: number[]): number {
  if (days.length === 7) return 1;
  let largest = 0;
  for (let i = 0; i < days.length; i += 1) {
    const isLast = i === days.length - 1;
    const next = days[isLast ? 0 : i + 1];
    const gap = isLast ? next + 7 - days[i] : next - days[i];
    largest = Math.max(largest, gap);
  }
  return largest;
}

/**
 * The LARGEST legitimate gap between two fires of `expression`, in seconds.
 *
 * The max, not the mean, deliberately — the same rule the Python watchdog
 * settled on. "0 10 * * MON-FRI" averages under a day but its real gap is the
 * three-day weekend, and measuring against the average would declare it overdue
 * every Sunday morning until someone stopped believing the badge.
 *
 * Returns null for anything this cannot parse with confidence (named months,
 * day-of-month combined with day-of-week, L/W/# forms). Callers must treat null
 * as "no verdict available", never as zero.
 */
export function scheduleIntervalSeconds(expression: string): number | null {
  const parts = String(expression || "").trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minuteField, hourField, domField, monthField, dowField] = parts;

  if (monthField.trim() !== "*") return null;

  const minutes = expandNumericField(minuteField, 0, 59);
  const hours = expandNumericField(hourField, 0, 23);
  if (!minutes || !hours) return null;

  // Within one firing day, the span from the first slot to the last. The fields
  // form a rectangle, so the extremes are the extremes of each field.
  const firstSlot = hours[0] * 3600 + minutes[0] * 60;
  const lastSlot = hours[hours.length - 1] * 3600 + minutes[minutes.length - 1] * 60;
  const withinDaySpan = lastSlot - firstSlot;

  const domRestricted = domField.trim() !== "*";
  const dowRestricted = dowField.trim() !== "*" && dowField.trim() !== "?";

  if (domRestricted) {
    // Cron ORs day-of-month against day-of-week when both are set, which makes
    // the gap depend on the calendar. Refuse rather than guess.
    if (dowRestricted) return null;
    const domDays = expandNumericField(domField, 1, 31);
    if (!domDays || domDays.length !== 1) return null;
    // Monthly on a fixed date: the widest real gap is the longest month.
    return 31 * DAY_SECONDS - withinDaySpan;
  }

  const days = expandDayOfWeek(dowField);
  if (!days) return null;
  const gapDays = largestWeeklyGapDays(days);
  const interval = gapDays * DAY_SECONDS - withinDaySpan;
  return interval > 0 ? interval : null;
}

/** "3h", "6d", "45m" — the lateness, at the coarsest unit that still informs. */
export function humanizeLateness(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 90) return `${s}s`;
  if (s < 5_400) return `${Math.round(s / 60)}m`;
  if (s < 172_800) return `${Math.round(s / 3_600)}h`;
  return `${Math.round(s / DAY_SECONDS)}d`;
}

/** The absolute stamp a card shows for a scheduled fire. */
export function formatRunTimestamp(iso: string | null | undefined): string {
  if (!iso) return "Not scheduled";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

export type NextRunVerdict = {
  /** The line the card renders, already phrased in the tense it is actually in. */
  text: string;
  /** How far past due, in seconds. Negative while the run is still ahead; null when unknowable. */
  overdue_by_seconds: number | null;
  /** True only when the miss exceeds one whole interval of this row's own schedule. */
  overdue: boolean;
};

/**
 * Turn a stored `next_run_at` into something that cannot be misread as a promise.
 *
 * A paused row is never overdue: its stored timestamp is a bookmark, and nothing
 * is supposed to fire. An enabled row whose time has passed says "Was due" at
 * minimum; once it is a full interval late — one missed fire by the row's own
 * cadence — it says so plainly and the card wears the warm treatment, because at
 * that point the honest reading is that the scheduler is not running.
 */
export function describeNextRun(input: {
  nextRunAt: string | null | undefined;
  schedule: string;
  enabled: boolean;
  now?: number;
}): NextRunVerdict {
  const { nextRunAt, schedule, enabled } = input;
  if (!nextRunAt) return { text: "Not scheduled", overdue_by_seconds: null, overdue: false };
  const due = new Date(nextRunAt).getTime();
  if (!Number.isFinite(due)) {
    return { text: "Next run unknown", overdue_by_seconds: null, overdue: false };
  }
  const stamp = formatRunTimestamp(nextRunAt);
  const now = input.now ?? Date.now();
  const lateSeconds = (now - due) / 1000;

  if (!enabled) {
    return { text: `Stored next ${stamp} (paused)`, overdue_by_seconds: null, overdue: false };
  }
  if (lateSeconds <= 0) {
    return { text: `Next ${stamp}`, overdue_by_seconds: lateSeconds, overdue: false };
  }

  const interval = scheduleIntervalSeconds(schedule);
  if (interval !== null && lateSeconds > interval) {
    return {
      text: `Overdue by ${humanizeLateness(lateSeconds)} — was due ${stamp}, and nothing has run since`,
      overdue_by_seconds: lateSeconds,
      overdue: true,
    };
  }
  // Inside one interval, or a schedule we could not parse: late, but not yet
  // evidence the scheduler is gone. Say the tense and stop there.
  return { text: `Was due ${stamp}`, overdue_by_seconds: lateSeconds, overdue: false };
}
