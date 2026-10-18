/**
 * lib/meet/schedule.ts - a meeting made for later goes on its host's Schedule.
 *
 * Through the Schedule's own write path (lib/calendar/store.ts applyOps), so every rule the Schedule keeps holds
 * for it too: the host's own default calendar, a valid instant and IANA time zone, and the Shabbat lock. The event
 * is shaped like one made in the Schedule's own editor (components/calendar/EventEditor.tsx): the owner's default
 * length and a 10-minute reminder. It carries the meeting's link, so it can be opened from the Schedule.
 *
 * The meeting exists either way: a time the Schedule refuses (Shabbat, a bad zone) leaves a link that works and
 * the Schedule's own reason code, which the Meet panel words with the Schedule's own messageFor
 * (components/calendar/useCalendarData.ts), so a refusal reads the same in both places.
 */
import "server-only";
import { publicAppBaseUrl } from "@/lib/api-helpers";
import { CalendarStoreError, applyOps, getPrefs, listCalendars, type Owner } from "@/lib/calendar/store";
import { validateEventInput } from "@/lib/calendar/validate";
import { displayMeetCode, type MeetRoom } from "./rooms";

/** The reminder the Schedule's editor gives a new timed event. */
const REMINDER_MINUTES = 10;

export type ScheduleOutcome = { ok: true; eventId: string } | { ok: false; reason: string };

/** The Schedule's store, as this file uses it (tests pass their own). */
export type ScheduleStore = {
  listCalendars: typeof listCalendars;
  getPrefs: typeof getPrefs;
  applyOps: typeof applyOps;
  origin: () => string;
};

const LIVE_STORE: ScheduleStore = { listCalendars, getPrefs, applyOps, origin: publicAppBaseUrl };

/**
 * Take a deleted meeting off its creator's Schedule, through the Schedule's own write path. Best effort: the
 * meeting is deleted either way, and an event that is already gone, or a Schedule that cannot be reached, is
 * logged, never thrown (the entry then simply holds a link that no longer works).
 */
export async function removeMeetingFromSchedule(owner: Owner, eventId: string, store: ScheduleStore = LIVE_STORE): Promise<void> {
  try {
    const prefs = await store.getPrefs(owner);
    await store.applyOps(owner, [{ op: "delete", id: eventId }], prefs);
  } catch (err) {
    console.error("[meet.schedule] could not take a deleted meeting off the Schedule", err instanceof Error ? err.message : err);
  }
}

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
