/**
 * Sunrise / sunset from the NOAA solar-position approximation, and the
 * Shabbat window derived from it.
 *
 * Accuracy: within about a minute at mid latitudes, which is the precision
 * published community tables work at. It is still a computation, so the UI
 * always labels the times as computed for a named location, and the offsets
 * are user settings. Above the polar circles the sun may not set; those days
 * return null and the caller falls back to a conservative fixed window.
 */

import { addDays, startOfDay } from "./dates";
import type { CalendarPrefs } from "./types";

const RAD = Math.PI / 180;

export type SunTimes = { sunrise: Date | null; sunset: Date | null };

/**
 * Sun times for the LOCAL calendar date of `day` at lat/lon.
 * Uses the standard 90.833° zenith (refraction + solar disc).
 */
export function sunTimes(day: Date, lat: number, lon: number): SunTimes {
  const d = startOfDay(day);
  // Julian day at 12:00 UTC of the local calendar date.
  const jd = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), 12) / 86_400_000 + 2440587.5;
  const t = (jd - 2451545.0) / 36525;

  const l0 = (280.46646 + t * (36000.76983 + t * 0.0003032)) % 360;
  const m = 357.52911 + t * (35999.05029 - 0.0001537 * t);
  const e = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
  const c =
    Math.sin(m * RAD) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    Math.sin(2 * m * RAD) * (0.019993 - 0.000101 * t) +
    Math.sin(3 * m * RAD) * 0.000289;
  const trueLong = l0 + c;
  const omega = 125.04 - 1934.136 * t;
  const lambda = trueLong - 0.00569 - 0.00478 * Math.sin(omega * RAD);
  const eps0 = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(omega * RAD);
  const decl = Math.asin(Math.sin(eps * RAD) * Math.sin(lambda * RAD)) / RAD;

  const y = Math.tan((eps / 2) * RAD) ** 2;
  const eqTime =
    4 /
    RAD *
    (y * Math.sin(2 * l0 * RAD) -
      2 * e * Math.sin(m * RAD) +
      4 * e * y * Math.sin(m * RAD) * Math.cos(2 * l0 * RAD) -
      0.5 * y * y * Math.sin(4 * l0 * RAD) -
      1.25 * e * e * Math.sin(2 * m * RAD));

  const cosH =
    Math.cos(90.833 * RAD) / (Math.cos(lat * RAD) * Math.cos(decl * RAD)) -
    Math.tan(lat * RAD) * Math.tan(decl * RAD);
  if (cosH > 1 || cosH < -1) return { sunrise: null, sunset: null };
  const ha = Math.acos(cosH) / RAD;

  const noonUtcMin = 720 - 4 * lon - eqTime;
  const utcMidnight = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  const at = (min: number) => new Date(utcMidnight + Math.round(min * 60) * 1000);
  return { sunrise: at(noonUtcMin - 4 * ha), sunset: at(noonUtcMin + 4 * ha) };
}

export type ShabbatWindow = {
  /** Candle lighting (Friday). */
  start: Date;
  /** End of Shabbat (Saturday night). */
  end: Date;
  /** False when a polar day forced the conservative fallback. */
  computed: boolean;
};

/** The Shabbat that begins on the Friday of the week containing `anyDay`. */
export function shabbatForWeekOf(anyDay: Date, prefs: Pick<CalendarPrefs, "location" | "candleMinutesBeforeSunset" | "havdalahMinutesAfterSunset">): ShabbatWindow {
  const d = startOfDay(anyDay);
  const friday = addDays(d, (5 - d.getDay() + 7) % 7 - (d.getDay() === 6 ? 7 : 0));
  const saturday = addDays(friday, 1);
  const fri = sunTimes(friday, prefs.location.lat, prefs.location.lon).sunset;
  const sat = sunTimes(saturday, prefs.location.lat, prefs.location.lon).sunset;
  if (!fri || !sat) {
    // Fail closed: protect Friday noon to Sunday 1am rather than guess.
    const start = new Date(friday);
    start.setHours(12, 0, 0, 0);
    const end = addDays(saturday, 1);
    end.setHours(1, 0, 0, 0);
    return { start, end, computed: false };
  }
  return {
    start: new Date(fri.getTime() - prefs.candleMinutesBeforeSunset * 60_000),
    end: new Date(sat.getTime() + prefs.havdalahMinutesAfterSunset * 60_000),
    computed: true,
  };
}

/** Every Shabbat window that touches [rangeStart, rangeEnd). */
export function shabbatWindows(rangeStart: Date, rangeEnd: Date, prefs: CalendarPrefs): ShabbatWindow[] {
  const out: ShabbatWindow[] = [];
  // Start one week early so a window that began before the range is caught.
  for (let d = addDays(startOfDay(rangeStart), -7); d < rangeEnd; d = addDays(d, 7)) {
    const w = shabbatForWeekOf(d, prefs);
    if (w.start < rangeEnd && w.end > rangeStart && !out.some((x) => x.start.getTime() === w.start.getTime())) out.push(w);
  }
  return out;
}

/** True when [start, end) overlaps any Shabbat window. All-day events count by day. */
export function overlapsShabbat(start: Date, end: Date, prefs: CalendarPrefs): ShabbatWindow | null {
  if (!prefs.shabbatProtection) return null;
  return shabbatWindows(start, end, prefs).find((w) => start < w.end && end > w.start) ?? null;
}
