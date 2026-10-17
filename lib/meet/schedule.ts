/**
 * lib/meet/schedule.ts - a meeting made for later goes on its host's Schedule.
 *
 * Through the Schedule's own write path (lib/calendar/store.ts applyOps), so every rule the Schedule keeps holds
 * for it too: the host's own default calendar, a valid instant and IANA time zone, and the Shabbat lock. The event
 * is shaped like one made in the Schedule's own editor (components/calendar/EventEditor.tsx): the owner's default
 * length and a 10-minute reminder. It carries the meeting's link, so it can be opened from the Schedule.
 *
 * The meeting exists either way: a time the Schedule refuses (Shabbat, a bad zone) leaves a link that works and
 * a sentence saying why it is not on the Schedule.
 */
import "server-only";
import { publicAppBaseUrl } from "@/lib/api-helpers";
import { CalendarStoreError, applyOps, getPrefs, listCalendars, type Owner } from "@/lib/calendar/store";
import { validateEventInput } from "@/lib/calendar/validate";
import { displayMeetCode, type MeetRoom } from "./rooms";

/** The reminder the Schedule's editor gives a new timed event. */
const REMINDER_MINUTES = 10;

export type ScheduleOutcome = { ok: true; eventId: string } | { ok: false; reason: string };

/** Plain words for why a meeting is not on the Schedule (the link still works). */
export function scheduleReasonWords(reason: string): string {
  if (/shabbat/i.test(reason)) return "It falls on Shabbat, which your Schedule keeps free.";
  if (reason === "time_zone_invalid") return "Your time zone could not be read.";
  if (reason === "calendar_storage_missing") return "The Schedule is not set up yet.";
  return "Your Schedule could not be reached.";
}

/** The Schedule's store, as this file uses it (tests pass their own). */
export type ScheduleStore = {
  listCalendars: typeof listCalendars;
  getPrefs: typeof getPrefs;
  applyOps: typeof applyOps;
  origin: () => string;
};

const LIVE_STORE: ScheduleStore = { listCalendars, getPrefs, applyOps, origin: publicAppBaseUrl };

export async function addMeetingToSchedule(
  owner: Owner,
  room: MeetRoom,
  opts: { timeZone: string; minutes?: number },
  store: ScheduleStore = LIVE_STORE,
): Promise<ScheduleOutcome> {
  if (!room.startsAt) return { ok: false, reason: "no_time" };
  const link = `${store.origin()}/meet/${displayMeetCode(room.code)}`;
  const { listCalendars, getPrefs, applyOps } = store;
  try {
    const [calendars, prefs] = await Promise.all([listCalendars(owner), getPrefs(owner)]);
    const calendar = calendars.find((c) => c.isDefault) ?? calendars[0];
    if (!calendar) return { ok: false, reason: "no_calendar" };
    const start = new Date(room.startsAt);
    const end = new Date(start.getTime() + (opts.minutes ?? prefs.defaultDurationMin) * 60_000);
    const input = validateEventInput({
      calendarId: calendar.id,
      title: room.title,
      description: `Oasis Meet: ${link}`,
      location: link,
      allDay: false,
      start: start.toISOString(),
      end: end.toISOString(),
      timeZone: opts.timeZone,
      recurrence: null,
      exdates: [],
      recurringEventId: null,
      originalStart: null,
      color: null,
      reminders: [REMINDER_MINUTES],
      guests: [],
      busy: true,
    });
    if (!input.ok) return { ok: false, reason: input.error };
    const [created] = await applyOps(owner, [{ op: "create", event: input.value }], prefs);
    return { ok: true, eventId: created.id };
  } catch (err) {
    if (err instanceof CalendarStoreError) return { ok: false, reason: err.code };
    throw err;
  }
}
