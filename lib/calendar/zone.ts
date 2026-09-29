/**
 * Wall-clock arithmetic in a named IANA time zone, without a date library.
 *
 * A repeating 9am meeting stored in America/Toronto must expand to the same
 * instants in a Montréal browser, a Paris browser and a UTC Worker, or the
 * page and the server's Shabbat check see different schedules and saved
 * exceptions stop matching on another device. So series are expanded on
 * wall dates in the event's own zone and converted to instants here.
 */

export type WallParts = { y: number; m: number; d: number; h: number; mi: number; s: number };

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat | null {
  if (formatters.has(tz)) return formatters.get(tz)!;
  try {
    const f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(tz, f);
    return f;
  } catch {
    return null;
  }
}

export function isTimeZone(tz: unknown): tz is string {
  return typeof tz === "string" && tz.length <= 64 && formatter(tz) !== null;
}

/** Wall-clock parts of an instant in `tz`. Unknown zones fall back to the runtime zone. */
export function wallParts(instant: Date, tz: string): WallParts {
  const f = formatter(tz);
  if (!f) {
    return { y: instant.getFullYear(), m: instant.getMonth(), d: instant.getDate(), h: instant.getHours(), mi: instant.getMinutes(), s: instant.getSeconds() };
  }
  const parts = f.formatToParts(instant);
  const pick = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { y: pick("year"), m: pick("month") - 1, d: pick("day"), h: pick("hour") % 24, mi: pick("minute"), s: pick("second") };
}

/** Minutes `tz` is ahead of UTC at `instant`. */
function offsetMinutes(instant: number, tz: string): number {
  const p = wallParts(new Date(instant), tz);
  const asUtc = Date.UTC(p.y, p.m, p.d, p.h, p.mi, p.s);
  return Math.round((asUtc - Math.floor(instant / 1000) * 1000) / 60_000);
}

/**
 * The instant at which `tz` shows this wall-clock time. In a spring-forward
 * gap the time is pushed forward by the gap, as calendars do; in a fall-back
 * overlap the earlier instant wins.
 */
export function instantOf(p: WallParts, tz: string): Date {
  if (!formatter(tz)) return new Date(p.y, p.m, p.d, p.h, p.mi, p.s);
  const guess = Date.UTC(p.y, p.m, p.d, p.h, p.mi, p.s);
  const o1 = offsetMinutes(guess, tz);
  const o2 = offsetMinutes(guess - o1 * 60_000, tz);
  const candidates = [...new Set([guess - o1 * 60_000, guess - o2 * 60_000])];
  const shows = (t: number) => {
    const w = wallParts(new Date(t), tz);
    return w.y === p.y && w.m === p.m && w.d === p.d && w.h === p.h && w.mi === p.mi;
  };
  const exact = candidates.filter(shows);
  // Fall-back overlap: both match, the earlier wins. Spring-forward gap:
  // neither matches; the later candidate is the time pushed past the gap.
  return new Date(exact.length ? Math.min(...exact) : Math.max(...candidates));
}

/** Day number (days since 1970-01-01) of a wall date, for zone-free day arithmetic. */
export const dayNumber = (y: number, m: number, d: number) => Math.round(Date.UTC(y, m, d) / 86_400_000);

export function fromDayNumber(n: number): { y: number; m: number; d: number; weekday: number } {
  const x = new Date(n * 86_400_000);
  return { y: x.getUTCFullYear(), m: x.getUTCMonth(), d: x.getUTCDate(), weekday: x.getUTCDay() };
}

/** `YYYY-MM-DD` of an instant's wall date in `tz`. */
export function wallDateKey(instant: Date, tz: string): string {
  const p = wallParts(instant, tz);
  return `${p.y}-${String(p.m + 1).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

/** Weekday (0 = Sunday) of an instant in `tz`. */
export function wallWeekday(instant: Date, tz: string): number {
  const p = wallParts(instant, tz);
  return fromDayNumber(dayNumber(p.y, p.m, p.d)).weekday;
}
