/**
 * Local-time date helpers. Everything here works in the viewer's local zone
 * and keeps wall-clock time across DST changes (setDate, never +86_400_000).
 */

export const MINUTE_MS = 60_000;
export const DAY_MINUTES = 24 * 60;

export function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

export function addDays(d: Date, days: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + days);
  return x;
}

export function addMonths(d: Date, months: number): Date {
  const x = new Date(d);
  const day = x.getDate();
  x.setDate(1);
  x.setMonth(x.getMonth() + months);
  x.setDate(Math.min(day, daysInMonth(x.getFullYear(), x.getMonth())));
  return x;
}

export function addMinutes(d: Date, minutes: number): Date {
  return new Date(d.getTime() + minutes * MINUTE_MS);
}

export function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

export function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export function startOfWeek(d: Date, weekStartsOn: number): Date {
  const x = startOfDay(d);
  const diff = (x.getDay() - weekStartsOn + 7) % 7;
  return addDays(x, -diff);
}

export function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

/** Whole local days between two dates (b - a), DST-safe. */
export function diffDays(a: Date, b: Date): number {
  const ua = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  const ub = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((ub - ua) / 86_400_000);
}

/** `YYYY-MM-DD` of the LOCAL date. */
export function toDateKey(d: Date): string {
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0"),
  ].join("-");
}

const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isDateKey(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const m = DATE_KEY.exec(value);
  if (!m) return false;
  const d = fromDateKey(value);
  return d.getMonth() + 1 === Number(m[2]) && d.getDate() === Number(m[3]);
}

/** Local midnight of a `YYYY-MM-DD`. */
export function fromDateKey(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function minutesIntoDay(d: Date): number {
  return d.getHours() * 60 + d.getMinutes();
}

export function atMinute(day: Date, minute: number): Date {
  const x = startOfDay(day);
  x.setMinutes(minute);
  return x;
}

export function snap(minutes: number, step: number): number {
  return Math.round(minutes / step) * step;
}

// ── Formatting ────────────────────────────────────────────────────────────

export function formatTime(d: Date): string {
  const h = d.getHours();
  const m = d.getMinutes();
  const hour = h % 12 || 12;
  const suffix = h >= 12 ? "pm" : "am";
  return m ? `${hour}:${String(m).padStart(2, "0")}${suffix}` : `${hour}${suffix}`;
}

export function formatHourLabel(hour: number): string {
  if (hour === 0 || hour === 24) return "12 AM";
  if (hour === 12) return "12 PM";
  return hour < 12 ? `${hour} AM` : `${hour - 12} PM`;
}

export function formatTimeRange(start: Date, end: Date): string {
  const s = formatTime(start);
  const e = formatTime(end);
  // "9 – 10:30am" when both halves share a meridiem, as Google does.
  const sameMeridiem = (start.getHours() >= 12) === (end.getHours() >= 12);
  return sameMeridiem && sameDay(start, end) ? `${s.replace(/[ap]m$/, "")} – ${e}` : `${s} – ${e}`;
}

const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEKDAY_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export const weekdayShort = (d: number) => WEEKDAY_SHORT[d];
export const weekdayLong = (d: number) => WEEKDAY_LONG[d];
export const monthShort = (m: number) => MONTH_SHORT[m];
export const monthLong = (m: number) => MONTH_LONG[m];

export function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
}

export function formatLongDate(d: Date): string {
  return `${weekdayLong(d.getDay())}, ${monthLong(d.getMonth())} ${d.getDate()}, ${d.getFullYear()}`;
}

export function formatShortDate(d: Date): string {
  return `${weekdayShort(d.getDay())}, ${monthShort(d.getMonth())} ${d.getDate()}`;
}

/** Title for the toolbar: "September 2026", "Sep 27 – Oct 3, 2026". */
export function formatRangeTitle(start: Date, endInclusive: Date, mode: "day" | "range" | "month" | "year"): string {
  if (mode === "year") return String(start.getFullYear());
  if (mode === "month") return `${monthLong(start.getMonth())} ${start.getFullYear()}`;
  if (mode === "day") return `${monthLong(start.getMonth())} ${start.getDate()}, ${start.getFullYear()}`;
  const sameYear = start.getFullYear() === endInclusive.getFullYear();
  const sameMonth = sameYear && start.getMonth() === endInclusive.getMonth();
  if (sameMonth) return `${monthLong(start.getMonth())} ${start.getFullYear()}`;
  if (sameYear)
    return `${monthShort(start.getMonth())} – ${monthShort(endInclusive.getMonth())} ${start.getFullYear()}`;
  return `${monthShort(start.getMonth())} ${start.getFullYear()} – ${monthShort(endInclusive.getMonth())} ${endInclusive.getFullYear()}`;
}

/** 6x7 matrix of dates covering a month view. */
export function monthMatrix(anchor: Date, weekStartsOn: number): Date[][] {
  const first = startOfWeek(startOfMonth(anchor), weekStartsOn);
  return Array.from({ length: 6 }, (_, w) =>
    Array.from({ length: 7 }, (_, d) => addDays(first, w * 7 + d)),
  );
}

export function durationLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} hr ${m} min` : `${h} hr`;
}
