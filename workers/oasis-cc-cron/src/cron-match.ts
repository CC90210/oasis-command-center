/**
 * Five-field cron matcher for the oasis-cc-cron companion Worker.
 *
 * A registry row may opt into an IANA wall-clock zone; rows without one keep
 * the Worker's historical UTC behavior. Fields support "*", "*\/n", lists,
 * ranges, range steps and plain values. Day-of-week additionally accepts
 * case-insensitive SUN-SAT names. Standard cron rule: when BOTH day-of-month
 * and day-of-week are restricted, the date matches if EITHER does.
 *
 * Malformed expressions, invalid dates and unknown zones fail closed: they do
 * not dispatch a route.
 */

const DAY_NAMES: Readonly<Record<string, number>> = {
  SUN: 0,
  MON: 1,
  TUE: 2,
  WED: 3,
  THU: 4,
  FRI: 5,
  SAT: 6,
};

type CompiledCron = {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  dayOfMonthRestricted: boolean;
  dayOfWeekRestricted: boolean;
  /** All 24 wall hours are selected, so DST follows elapsed-hour semantics. */
  everyHour: boolean;
};

type WallParts = {
  year: number;
  minute: number;
  hour: number;
  dayOfMonth: number;
  month: number;
  dayOfWeek: number;
  second: number;
};

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

function atomValue(token: string, min: number, max: number, names?: Readonly<Record<string, number>>): number | null {
  const upper = token.toUpperCase();
  const named = names?.[upper];
  if (named !== undefined) return named;
  if (!/^\d+$/.test(token)) return null;
  const value = Number(token);
  return Number.isInteger(value) && value >= min && value <= max ? value : null;
}

/** Expand one field to the values it can match. Null means the field is invalid. */
function expandField(
  field: string,
  min: number,
  max: number,
  names?: Readonly<Record<string, number>>,
  sundaySeven = false,
): Set<number> | null {
  const pieces = field.split(",");
  if (pieces.some((piece) => piece === "")) return null;
  const values = new Set<number>();

  for (const piece of pieces) {
    const star = /^\*\/([0-9]+)$/.exec(piece);
    if (piece === "*" || star) {
      if (pieces.length !== 1) return null;
      const step = star ? Number(star[1]) : 1;
      if (!Number.isInteger(step) || step < 1) return null;
      for (let value = min; value <= max; value += step) values.add(sundaySeven ? value % 7 : value);
      continue;
    }

    const spec = /^([A-Za-z]{3}|\d+)(?:-([A-Za-z]{3}|\d+)(?:\/(\d+))?)?$/.exec(piece);
    if (!spec) return null;
    const from = atomValue(spec[1], min, max, names);
    const to = spec[2] === undefined ? from : atomValue(spec[2], min, max, names);
    const step = spec[3] === undefined ? 1 : Number(spec[3]);
    if (from === null || to === null || from > to || !Number.isInteger(step) || step < 1) return null;
    for (let value = from; value <= to; value += step) values.add(sundaySeven ? value % 7 : value);
  }

  return values.size > 0 ? values : null;
}

function compileCron(expr: unknown): CompiledCron | null {
  if (typeof expr !== "string") return null;
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
  const minutes = expandField(minute, 0, 59);
  const hours = expandField(hour, 0, 23);
  const daysOfMonth = expandField(dayOfMonth, 1, 31);
  const months = expandField(month, 1, 12);
  const daysOfWeek = expandField(dayOfWeek, 0, 7, DAY_NAMES, true);
  if (!minutes || !hours || !daysOfMonth || !months || !daysOfWeek) return null;
  return {
    minutes,
    hours,
    daysOfMonth,
    months,
    daysOfWeek,
    dayOfMonthRestricted: dayOfMonth !== "*",
    dayOfWeekRestricted: dayOfWeek !== "*",
    everyHour: hours.size === 24,
  };
}

const FORMATTERS = new Map<string, Intl.DateTimeFormat | null>();

function formatterFor(timeZone: string): Intl.DateTimeFormat | null {
  if (FORMATTERS.has(timeZone)) return FORMATTERS.get(timeZone) ?? null;
  let formatter: Intl.DateTimeFormat | null = null;
  try {
    formatter = new Intl.DateTimeFormat("en-US-u-ca-gregory-nu-latn", {
      timeZone,
      weekday: "short",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      hourCycle: "h23",
    });
    // Force the runtime to resolve the identifier now, inside this guard.
    formatter.resolvedOptions();
  } catch {
    formatter = null;
  }
  FORMATTERS.set(timeZone, formatter);
  return formatter;
}

/** True only for a non-empty IANA zone identifier supported by this runtime. */
export function isValidTimeZone(timeZone: unknown): timeZone is string {
  return (
    typeof timeZone === "string" &&
    timeZone.length > 0 &&
    timeZone.length <= 64 &&
    timeZone.trim() === timeZone &&
    /^[A-Za-z][A-Za-z0-9._+\-/]*$/.test(timeZone) &&
    formatterFor(timeZone) !== null
  );
}

/** True when the Worker can evaluate the complete five-field expression. */
export function isValidCronExpression(expr: unknown): expr is string {
  return compileCron(expr) !== null;
}

function wallParts(at: Date, timeZone: string): WallParts | null {
  const formatter = formatterFor(timeZone);
  if (!formatter) return null;
  const parts = new Map(formatter.formatToParts(at).map((part) => [part.type, part.value]));
  const weekday = DAY_NAMES[(parts.get("weekday") ?? "").toUpperCase()];
  const year = Number(parts.get("year"));
  const minute = Number(parts.get("minute"));
  const rawHour = Number(parts.get("hour"));
  const dayOfMonth = Number(parts.get("day"));
  const month = Number(parts.get("month"));
  const second = Number(parts.get("second"));
  if (
    weekday === undefined ||
    !Number.isInteger(year) ||
    !Number.isInteger(minute) ||
    !Number.isInteger(rawHour) ||
    !Number.isInteger(dayOfMonth) ||
    !Number.isInteger(month) ||
    !Number.isInteger(second)
  ) {
    return null;
  }
  return { year, minute, hour: rawHour % 24, dayOfMonth, month, dayOfWeek: weekday, second };
}

/** Minutes `timeZone` is ahead of UTC at this instant. */
function offsetMinutes(timeZone: string, instant: number): number | null {
  const wall = wallParts(new Date(instant), timeZone);
  if (!wall) return null;
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.dayOfMonth, wall.hour, wall.minute, wall.second);
  return Math.round((asUtc - Math.floor(instant / 1000) * 1000) / MINUTE_MS);
}

type DayOffsets = { before: number; after: number };
const DAY_OFFSET_CACHE = new Map<string, DayOffsets>();
const FIXED_DAY_CACHE = new Map<string, Set<number>>();
const CACHE_LIMIT = 256;

function remember<T>(cache: Map<string, T>, key: string, value: T): T {
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
  cache.set(key, value);
  return value;
}

function wallDateKey(wall: WallParts): string {
  return `${wall.year}-${wall.month}-${wall.dayOfMonth}`;
}

/** Offsets on either side of a wall date, using the same safe bounds as schedule-plan.ts. */
function dayOffsets(timeZone: string, wall: WallParts): DayOffsets | null {
  const key = `${timeZone}|${wallDateKey(wall)}`;
  const cached = DAY_OFFSET_CACHE.get(key);
  if (cached) return cached;
  const base = Date.UTC(wall.year, wall.month - 1, wall.dayOfMonth);
  const before = offsetMinutes(timeZone, base - 14 * HOUR_MS);
  const after = offsetMinutes(timeZone, base + 38 * HOUR_MS);
  if (before === null || after === null) return null;
  return remember(DAY_OFFSET_CACHE, key, { before, after });
}

/**
 * Every fixed-time instant on one transition date. Missing times are pushed
 * through a spring gap; repeated times keep only their first real occurrence.
 * All-hour expressions bypass this function and retain both elapsed hours.
 */
function fixedDayInstants(expr: string, cron: CompiledCron, timeZone: string, wall: WallParts, offsets: DayOffsets): Set<number> {
  const key = `${expr}|${timeZone}|${wallDateKey(wall)}`;
  const cached = FIXED_DAY_CACHE.get(key);
  if (cached) return cached;
  const base = Date.UTC(wall.year, wall.month - 1, wall.dayOfMonth);
  const instants = new Set<number>();
  for (const hour of cron.hours) {
    for (const minute of cron.minutes) {
      const desiredWall = base + (hour * 60 + minute) * MINUTE_MS;
      const real = [...new Set([offsets.before, offsets.after])]
        .map((offset) => desiredWall - offset * MINUTE_MS)
        .filter((instant) => offsetMinutes(timeZone, instant) === (desiredWall - instant) / MINUTE_MS)
        .sort((a, b) => a - b);
      instants.add(real.length > 0 ? real[0] : desiredWall - offsets.before * MINUTE_MS);
    }
  }
  return remember(FIXED_DAY_CACHE, key, instants);
}

export function cronMatches(expr: string, at: Date, timeZone = "UTC"): boolean {
  if (!(at instanceof Date) || Number.isNaN(at.getTime()) || !isValidTimeZone(timeZone)) return false;
  const cron = compileCron(expr);
  const wall = cron ? wallParts(at, timeZone) : null;
  if (!cron || !wall) return false;

  const minuteOk = cron.minutes.has(wall.minute);
  const hourOk = cron.hours.has(wall.hour);
  const monthOk = cron.months.has(wall.month);
  const dayOfMonthOk = cron.daysOfMonth.has(wall.dayOfMonth);
  const dayOfWeekOk = cron.daysOfWeek.has(wall.dayOfWeek);
  const dateOk = cron.dayOfMonthRestricted && cron.dayOfWeekRestricted
    ? dayOfMonthOk || dayOfWeekOk
    : dayOfMonthOk && dayOfWeekOk;
  if (!monthOk || !dateOk) return false;

  // Covering all wall hours means "every elapsed hour": both copies of a
  // fall-back hour run, while a spring gap has no imaginary wall occurrence.
  if (cron.everyHour) return minuteOk && hourOk;

  const offsets = dayOffsets(timeZone, wall);
  if (!offsets || offsets.before === offsets.after) return minuteOk && hourOk;
  const minuteInstant = Math.floor(at.getTime() / MINUTE_MS) * MINUTE_MS;
  return fixedDayInstants(expr, cron, timeZone, wall, offsets).has(minuteInstant);
}
