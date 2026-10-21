/**
 * Who takes booked calls, and when: the rules behind every public booking.
 *
 * CC, 2026-10-15/16: warm inbound leads book straight onto our Schedule, only
 * when the proprietor is free. Calls run 10:00 to 21:00 Toronto time and CC
 * takes every call.
 *
 * THE RULE. A host is ON DUTY for a slot when their weekly hours cover the
 * whole slot. A slot is offered when an organizer is on duty and EVERY host on
 * duty is free (with the buffer either side). Everyone on duty is invited.
 * An attendee who has not connected their calendar is not on duty at all
 * (HostBusy "absent"), so their days book with the organizer alone.
 *
 * Pure: no database, no clock, no network. The server side that feeds it busy
 * time lives in lib/booking/settings-store.ts and lib/forms/public-booking.ts.
 * ASCII only (tests/worker-source-one-byte.test.ts).
 */

import { dayNumber, fromDayNumber, instantOf, isTimeZone, wallParts } from "@/lib/calendar/zone";

export const DEFAULT_BOOKING_TIME_ZONE = "America/Toronto";
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const DAY_MINUTES = 24 * 60;

/** Minutes after local midnight; start < end <= 1440. */
export type BookingWindow = { start: number; end: number };
/** Index 0 = Sunday ... 6 = Saturday, in the settings' time zone. */
export type WeeklyHours = BookingWindow[][];
/** The organizer's Google calendar holds the event; attendees are invited to it. */
export type BookingHostRole = "organizer" | "attendee";

export type BookingHost = {
  userId: string;
  role: BookingHostRole;
  weeklyHours: WeeklyHours;
  /** The Schedule calendar a booking lands on; null = the host's default calendar. */
  targetCalendarId: string | null;
};

export type BookingSettings = {
  timeZone: string;
  /** Slots start on this grid of the local clock: 15, 30 or 60. */
  stepMinutes: number;
  /** No slot starts sooner than this after now. */
  minNoticeMinutes: number;
  /** No slot starts later than this many days after now. */
  maxDaysAhead: number;
  /** Free time required before and after a call, against each host's busy time. */
  bufferMinutes: number;
  hosts: BookingHost[];
};

/** Epoch milliseconds; end > start. */
export type BusyInterval = { start: number; end: number };

/**
 * A host whose calendar could not be read is never treated as free.
 * "absent" is narrower: an ATTENDEE who has not connected the calendar we would
 * read. That host leaves the slot entirely, neither required to
 * be free nor invited, and is back on it as soon as the calendar reads. An
 * organizer is never left off: an absent organizer closes every slot.
 */
export type HostBusy = BusyInterval[] | "unavailable" | "absent";

export type OpenSlot = {
  /** ISO instant, UTC. */
  start: string;
  /** Hosts on duty for this slot, organizer first, then settings order. */
  hostIds: string[];
};

export const BOOKING_LIMITS = {
  steps: [15, 30, 60] as readonly number[],
  maxNoticeMinutes: 7 * DAY_MINUTES,
  // Google's events.list read refuses a range over 31 days (google-calendar.ts),
  // and the range is the horizon plus one call plus the buffer.
  maxDaysAhead: 30,
  maxBufferMinutes: 120,
  // One organizer plus one attendee: the founder-meeting engine invites exactly
  // one extra person (createVerifiedFounderMeeting openerAttendee), so a third
  // host would be told they are on the call and never receive the invite.
  maxHosts: 2,
  // One window per day: the Schedule's settings dialog edits exactly one, and a
  // second window it could not show would be dropped by the next unrelated
  // save (Codex review of #628). Split hours need an editor that shows them.
  maxWindowsPerDay: 1,
} as const;

// -- Parsing ---------------------------------------------------------------

function int(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function parseWindow(value: unknown): BookingWindow | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const start = int(record.start);
  const end = int(record.end);
  if (start === null || end === null) return null;
  if (start < 0 || end > DAY_MINUTES || end <= start) return null;
  return { start, end };
}

function parseWeeklyHours(value: unknown): WeeklyHours | null {
  if (!Array.isArray(value) || value.length !== 7) return null;
  const week: WeeklyHours = [];
  for (const day of value) {
    if (!Array.isArray(day) || day.length > BOOKING_LIMITS.maxWindowsPerDay) return null;
    const windows: BookingWindow[] = [];
    for (const raw of day) {
      const window = parseWindow(raw);
      if (!window) return null;
      windows.push(window);
    }
    week.push(windows);
  }
  return week;
}

function parseHost(value: unknown): BookingHost | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const userId = typeof record.userId === "string" ? record.userId.trim() : "";
  if (!userId || userId.length > 128) return null;
  if (record.role !== "organizer" && record.role !== "attendee") return null;
  const weeklyHours = parseWeeklyHours(record.weeklyHours);
  if (!weeklyHours) return null;
  const target = record.targetCalendarId;
  if (target !== null && (typeof target !== "string" || !target.trim() || target.length > 128)) return null;
  return { userId, role: record.role, weeklyHours, targetCalendarId: target === null ? null : target.trim() };
}

/**
 * A stored or submitted settings document, or null when ANY part of it is
 * invalid. Nothing is repaired or defaulted: a half-valid document would offer
 * hours nobody chose.
 */
export function parseBookingSettings(raw: unknown): BookingSettings | null {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!isTimeZone(record.timeZone)) return null;
  const stepMinutes = int(record.stepMinutes);
  const minNoticeMinutes = int(record.minNoticeMinutes);
  const maxDaysAhead = int(record.maxDaysAhead);
  const bufferMinutes = int(record.bufferMinutes);
  if (stepMinutes === null || !BOOKING_LIMITS.steps.includes(stepMinutes)) return null;
  if (minNoticeMinutes === null || minNoticeMinutes < 0 || minNoticeMinutes > BOOKING_LIMITS.maxNoticeMinutes) return null;
  if (maxDaysAhead === null || maxDaysAhead < 1 || maxDaysAhead > BOOKING_LIMITS.maxDaysAhead) return null;
  if (bufferMinutes === null || bufferMinutes < 0 || bufferMinutes > BOOKING_LIMITS.maxBufferMinutes) return null;
  if (!Array.isArray(record.hosts) || record.hosts.length < 1 || record.hosts.length > BOOKING_LIMITS.maxHosts) return null;
  const hosts: BookingHost[] = [];
  for (const raw of record.hosts) {
    const host = parseHost(raw);
    if (!host) return null;
    if (hosts.some((h) => h.userId === host.userId)) return null;
    hosts.push(host);
  }
  // One Google calendar holds each event: exactly one organizer.
  if (hosts.filter((h) => h.role === "organizer").length !== 1) return null;
  return { timeZone: record.timeZone, stepMinutes, minNoticeMinutes, maxDaysAhead, bufferMinutes, hosts };
}

// -- Defaults --------------------------------------------------------------

/** The same windows on the listed weekdays (0 = Sunday), nothing on the rest. */
export function weeklyHoursOn(days: readonly number[], start: number, end: number): WeeklyHours {
  return Array.from({ length: 7 }, (_, day) => (days.includes(day) ? [{ start, end }] : []));
}

const TEN_AM = 10 * 60;
const NINE_PM = 21 * 60;

/**
 * OASIS before anyone saves settings: CC organizes every day 10:00-21:00.
 * The legacy attendeeUserId input is ignored so older callers cannot silently
 * restore a former collaborator to the live booking roster.
 */
export function defaultOasisBookingSettings(ids: { organizerUserId: string; attendeeUserId: string | null }): BookingSettings {
  const hosts: BookingHost[] = [
    {
      userId: ids.organizerUserId,
      role: "organizer",
      weeklyHours: weeklyHoursOn([0, 1, 2, 3, 4, 5, 6], TEN_AM, NINE_PM),
      targetCalendarId: null,
    },
  ];
  return {
    timeZone: DEFAULT_BOOKING_TIME_ZONE,
    stepMinutes: 30,
    minNoticeMinutes: 120,
    maxDaysAhead: 14,
    bufferMinutes: 0,
    hosts,
  };
}

// -- Slots -----------------------------------------------------------------

function localSlot(startMs: number, timeZone: string): { weekday: number; minute: number } {
  const p = wallParts(new Date(startMs), timeZone);
  return { weekday: fromDayNumber(dayNumber(p.y, p.m, p.d)).weekday, minute: p.h * 60 + p.mi };
}

/** Hosts whose weekly hours cover all of [start, start + duration), organizer first. */
export function onDutyHosts(settings: BookingSettings, startMs: number, durationMinutes: number): BookingHost[] {
  const { weekday, minute } = localSlot(startMs, settings.timeZone);
  const end = minute + durationMinutes;
  const covered = settings.hosts.filter((host) =>
    host.weeklyHours[weekday].some((window) => window.start <= minute && end <= window.end),
  );
  return [...covered.filter((h) => h.role === "organizer"), ...covered.filter((h) => h.role === "attendee")];
}

/**
 * The time range whose busy time can affect any offered slot. Google returns
 * an event only when it STARTS before timeMax, so the range reaches one call
 * plus the buffer past the last possible start (review of #611: a founder
 * event starting in that tail was otherwise invisible and got double-booked).
 */
export function bookingReadWindow(
  settings: BookingSettings,
  now: number,
  durationMinutes: number,
): { timeMin: number; timeMax: number } {
  const buffer = settings.bufferMinutes * MINUTE_MS;
  return {
    timeMin: now + settings.minNoticeMinutes * MINUTE_MS - buffer,
    timeMax: now + settings.maxDaysAhead * DAY_MS + durationMinutes * MINUTE_MS + buffer,
  };
}

function isFree(busy: HostBusy | undefined, start: number, end: number): boolean {
  if (!busy || busy === "unavailable" || busy === "absent") return false;
  return !busy.some((b) => b.start < end && b.end > start);
}

/**
 * Every slot a visitor may book, in time order. `busyByHost` must hold an
 * entry for every host; a missing or "unavailable" entry closes that host's
 * on-duty slots (fail closed: never invent availability). An "absent" attendee
 * is left off their on-duty slots instead (see HostBusy).
 */
export function computeOpenSlots(input: {
  settings: BookingSettings;
  now: number;
  durationMinutes: number;
  busyByHost: ReadonlyMap<string, HostBusy>;
}): OpenSlot[] {
  const { settings, now, durationMinutes } = input;
  const step = settings.stepMinutes * MINUTE_MS;
  const duration = durationMinutes * MINUTE_MS;
  const buffer = settings.bufferMinutes * MINUTE_MS;
  // Slot starts sit on whole minutes of the epoch grid, then must also sit on
  // the step of the LOCAL clock (Toronto's offset is whole hours, but a
  // half-hour zone like St. John's must still get :00/:30 local starts).
  const first = Math.ceil((now + settings.minNoticeMinutes * MINUTE_MS) / MINUTE_MS) * MINUTE_MS;
  const last = now + settings.maxDaysAhead * DAY_MS;
  const slots: OpenSlot[] = [];
  for (let start = first; start <= last; start += MINUTE_MS) {
    const { minute } = localSlot(start, settings.timeZone);
    if (minute % settings.stepMinutes !== 0) continue;
    const onDuty = onDutyHosts(settings, start, durationMinutes).filter(
      (h) => h.role === "organizer" || input.busyByHost.get(h.userId) !== "absent",
    );
    if (!onDuty.some((h) => h.role === "organizer")) {
      start += step - MINUTE_MS;
      continue;
    }
    const open = onDuty.every((h) => isFree(input.busyByHost.get(h.userId), start - buffer, start + duration + buffer));
    if (open) slots.push({ start: new Date(start).toISOString(), hostIds: onDuty.map((h) => h.userId) });
    start += step - MINUTE_MS;
  }
  return slots;
}

/** The wall-clock instant `minute` minutes into `dateKey` (YYYY-MM-DD) in `timeZone`. */
export function instantOfLocal(dateKey: string, minute: number, timeZone: string): Date {
  const [y, m, d] = dateKey.split("-").map(Number);
  return instantOf({ y, m: m - 1, d, h: Math.floor(minute / 60), mi: minute % 60, s: 0 }, timeZone);
}
