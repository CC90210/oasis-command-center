/**
 * Input validation for calendar writes. Pure, so the API and tests share it.
 * Every function returns a typed value or a stable error code, never throws.
 */

import { addDays, fromDateKey, isDateKey } from "./dates";
import { expandOccurrences } from "./recurrence";
import { overlapsShabbat, type ShabbatWindow } from "./sun";
import { isTimeZone } from "./zone";
import {
  CALENDAR_COLORS,
  DEFAULT_PREFS,
  type CalendarColor,
  type CalendarPrefs,
  type EventInput,
  type EventOp,
  type EventRecord,
  type Recurrence,
} from "./types";

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = <T>(error: string): Result<T> => ({ ok: false, error });

export const LIMITS = {
  title: 300,
  description: 8000,
  location: 500,
  guests: 50,
  reminders: 5,
  reminderMaxMinutes: 40320, // 4 weeks, Google's ceiling
  exdates: 1000,
  calendarName: 80,
  calendars: 50,
  // Runs of deletes/creates are grouped into single queries (store.applyOps),
  // so this bounds work, not database calls. Covers a series plus the 1000
  // exceptions it may carry.
  opsPerBatch: 1100,
  maxSpanDays: 366,
} as const;

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const EMAIL = /^[^\s@<>()",;]{1,64}@[^\s@<>()",;]{1,190}\.[A-Za-z]{2,24}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

export const isId = (v: unknown): v is string => typeof v === "string" && ID.test(v);
export const isColor = (v: unknown): v is CalendarColor =>
  typeof v === "string" && (CALENDAR_COLORS as readonly string[]).includes(v);

function isInstant(v: unknown): v is string {
  return typeof v === "string" && ISO_INSTANT.test(v) && Number.isFinite(Date.parse(v));
}

function str(v: unknown, max: number): string | null {
  if (v === undefined || v === null) return "";
  if (typeof v !== "string") return null;
  // Strip control characters except newline and tab.
  const clean = v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  return clean.length > max ? null : clean;
}

export function validateRecurrence(v: unknown): Result<Recurrence | null> {
  if (v === null || v === undefined) return ok(null);
  if (typeof v !== "object") return fail("recurrence_invalid");
  const r = v as Record<string, unknown>;
  if (!["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(r.freq as string)) return fail("recurrence_freq_invalid");
  const interval = Number(r.interval ?? 1);
  if (!Number.isInteger(interval) || interval < 1 || interval > 99) return fail("recurrence_interval_invalid");
  const out: Recurrence = { freq: r.freq as Recurrence["freq"], interval };
  if (r.byWeekday !== undefined) {
    if (!Array.isArray(r.byWeekday) || r.byWeekday.length > 7 || !r.byWeekday.every((d) => Number.isInteger(d) && d >= 0 && d <= 6))
      return fail("recurrence_weekday_invalid");
    if (r.byWeekday.length) out.byWeekday = [...new Set(r.byWeekday as number[])].sort();
  }
  if (r.monthlyMode !== undefined) {
    if (r.monthlyMode !== "day" && r.monthlyMode !== "nth") return fail("recurrence_monthly_invalid");
    out.monthlyMode = r.monthlyMode;
  }
  if (r.until !== undefined && r.until !== null) {
    if (!isDateKey(r.until)) return fail("recurrence_until_invalid");
    out.until = r.until;
  }
  if (r.count !== undefined && r.count !== null) {
    const count = Number(r.count);
    if (!Number.isInteger(count) || count < 1 || count > 999) return fail("recurrence_count_invalid");
    out.count = count;
  }
  if (out.until && out.count) return fail("recurrence_until_and_count");
  return ok(out);
}

/** Validates a full event input. */
export function validateEventInput(v: unknown): Result<EventInput> {
  if (!v || typeof v !== "object") return fail("event_invalid");
  const e = v as Record<string, unknown>;
  if (!isId(e.calendarId)) return fail("calendar_id_invalid");
  const title = str(e.title, LIMITS.title);
  if (title === null) return fail("title_invalid");
  const description = str(e.description, LIMITS.description);
  if (description === null) return fail("description_invalid");
  const location = str(e.location, LIMITS.location);
  if (location === null) return fail("location_invalid");
  const allDay = e.allDay === true;

  let spanMs: number;
  if (allDay) {
    if (!isDateKey(e.start) || !isDateKey(e.end)) return fail("all_day_dates_invalid");
    spanMs = fromDateKey(e.end).getTime() - fromDateKey(e.start).getTime();
  } else {
    if (!isInstant(e.start) || !isInstant(e.end)) return fail("times_invalid");
    spanMs = Date.parse(e.end) - Date.parse(e.start);
  }
  if (!(spanMs > 0)) return fail("end_before_start");
  if (spanMs > LIMITS.maxSpanDays * 86_400_000 + 3_600_000) return fail("event_too_long");

  // A real IANA zone: series expand in it, so an unknown one must not fall
  // back silently to whatever zone the server happens to run in.
  const tz = isTimeZone(e.timeZone) ? e.timeZone : null;
  if (!tz) return fail("time_zone_invalid");

  const rec = validateRecurrence(e.recurrence);
  if (!rec.ok) return rec;

  const exdates = e.exdates ?? [];
  if (!Array.isArray(exdates) || exdates.length > LIMITS.exdates || !exdates.every((x) => isDateKey(x) || isInstant(x)))
    return fail("exdates_invalid");

  const recurringEventId = e.recurringEventId ?? null;
  const originalStart = e.originalStart ?? null;
  if (recurringEventId !== null && !isId(recurringEventId)) return fail("recurring_event_id_invalid");
  if (originalStart !== null && !(isDateKey(originalStart) || isInstant(originalStart))) return fail("original_start_invalid");
  if ((recurringEventId === null) !== (originalStart === null)) return fail("override_pair_invalid");
  if (recurringEventId && rec.value) return fail("override_cannot_recur");

  const color = e.color ?? null;
  if (color !== null && !isColor(color)) return fail("color_invalid");

  const reminders = e.reminders ?? [];
  if (
    !Array.isArray(reminders) ||
    reminders.length > LIMITS.reminders ||
    !reminders.every((m) => Number.isInteger(m) && m >= 0 && m <= LIMITS.reminderMaxMinutes)
  )
    return fail("reminders_invalid");

  const guests = e.guests ?? [];
  if (!Array.isArray(guests) || guests.length > LIMITS.guests || !guests.every((g) => typeof g === "string" && EMAIL.test(g)))
    return fail("guests_invalid");

  return ok({
    calendarId: e.calendarId,
    title: title.trim(),
    description,
    location: location.trim(),
    allDay,
    start: e.start as string,
    end: e.end as string,
    timeZone: tz,
    recurrence: rec.value,
    exdates: [...new Set(exdates as string[])],
    recurringEventId: recurringEventId as string | null,
    originalStart: originalStart as string | null,
    color: color as CalendarColor | null,
    reminders: [...new Set(reminders as number[])].sort((a, b) => a - b),
    guests: [...new Set((guests as string[]).map((g) => g.toLowerCase()))],
    busy: e.busy !== false,
  });
}

export function validateOps(v: unknown): Result<EventOp[]> {
  if (!Array.isArray(v) || v.length === 0) return fail("ops_empty");
  if (v.length > LIMITS.opsPerBatch) return fail("ops_too_many");
  const out: EventOp[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== "object") return fail("op_invalid");
    const o = raw as Record<string, unknown>;
    if (o.op === "create") {
      const ev = validateEventInput(o.event);
      if (!ev.ok) return ev;
      if (o.tempId !== undefined && !isId(o.tempId)) return fail("temp_id_invalid");
      out.push({ op: "create", tempId: o.tempId as string | undefined, event: ev.value });
    } else if (o.op === "update") {
      if (!isId(o.id) || !o.patch || typeof o.patch !== "object") return fail("op_update_invalid");
      out.push({ op: "update", id: o.id, patch: o.patch as Partial<EventInput> });
    } else if (o.op === "delete") {
      if (!isId(o.id)) return fail("op_delete_invalid");
      out.push({ op: "delete", id: o.id });
    } else return fail("op_unknown");
  }
  return ok(out);
}

export function validatePrefs(v: unknown): Result<CalendarPrefs> {
  if (!v || typeof v !== "object") return fail("prefs_invalid");
  const p = { ...DEFAULT_PREFS, ...(v as Partial<CalendarPrefs>) };
  if (![0, 1, 6].includes(p.weekStartsOn)) return fail("week_start_invalid");
  if (typeof p.showWeekends !== "boolean" || typeof p.shabbatProtection !== "boolean") return fail("prefs_flag_invalid");
  if (!Number.isInteger(p.defaultDurationMin) || p.defaultDurationMin < 15 || p.defaultDurationMin > 480) return fail("duration_invalid");
  const loc = p.location;
  if (
    !loc || typeof loc.label !== "string" || loc.label.length > 80 ||
    !Number.isFinite(loc.lat) || Math.abs(loc.lat) > 90 ||
    !Number.isFinite(loc.lon) || Math.abs(loc.lon) > 180
  )
    return fail("location_invalid");
  for (const k of ["candleMinutesBeforeSunset", "havdalahMinutesAfterSunset"] as const)
    if (!Number.isInteger(p[k]) || p[k] < 0 || p[k] > 120) return fail(`${k}_invalid`);
  return ok({
    weekStartsOn: p.weekStartsOn,
    showWeekends: p.showWeekends,
    defaultDurationMin: p.defaultDurationMin,
    location: { label: loc.label.trim() || "Custom", lat: loc.lat, lon: loc.lon },
    candleMinutesBeforeSunset: p.candleMinutesBeforeSunset,
    havdalahMinutesAfterSunset: p.havdalahMinutesAfterSunset,
    shabbatProtection: p.shabbatProtection,
  });
}

/** How far ahead a recurring event is checked against Shabbat. */
const PROTECTION_HORIZON_DAYS = 400;

/**
 * The Shabbat window an event would intrude on, or null.
 * Timed events: any overlap. All-day events: any covered Saturday.
 * Series are checked occurrence by occurrence over the next ~13 months.
 */
export function shabbatConflict(input: EventInput, prefs: CalendarPrefs): ShabbatWindow | null {
  if (!prefs.shabbatProtection) return null;
  const probe: EventRecord = { ...input, id: "probe", createdAt: "", updatedAt: "", recurringEventId: null, originalStart: null };
  const from = input.allDay ? fromDateKey(input.start) : new Date(input.start);
  const occs = input.recurrence
    ? expandOccurrences([probe], from, addDays(from, PROTECTION_HORIZON_DAYS))
    : expandOccurrences([probe], new Date(from.getTime() - 1), new Date(8.64e15));
  for (const o of occs) {
    if (o.allDay) {
      for (let d = o.start; d < o.end; d = addDays(d, 1)) {
        if (d.getDay() === 6) return overlapsShabbat(d, addDays(d, 1), prefs);
      }
      continue;
    }
    const hit = overlapsShabbat(o.start, o.end, prefs);
    if (hit) return hit;
  }
  return null;
}
