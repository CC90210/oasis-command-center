/**
 * tests/booking-hours.test.ts - who takes booked calls, and when
 * (lib/booking/hours.ts, lib/booking/schedule-busy.ts).
 *
 * CC, 2026-10-16: calls 10:00-21:00 Toronto; Adon is off Friday and Saturday and
 * CC takes those calls alone; on the other days both founders are on the call.
 * The Schedule's own events count as busy, the weekly routine never does.
 */
import assert from "node:assert/strict";
import {
  bookingReadWindow,
  computeOpenSlots,
  defaultOasisBookingSettings,
  onDutyHosts,
  parseBookingSettings,
  weeklyHoursOn,
  type BookingSettings,
  type HostBusy,
} from "../lib/booking/hours";
import { scheduleBusyIntervals } from "../lib/booking/schedule-busy";
import type { EventRecord } from "../lib/calendar/types";

function check(name: string, fn: () => void): void {
  fn();
  console.log(`  ok - ${name}`);
}

console.log("booking hours");

const CC = "user-cc";
const ADON = "user-adon";
const settings = defaultOasisBookingSettings({ organizerUserId: CC, attendeeUserId: ADON });
// Thursday 2026-10-15 10:00 EDT.
const NOW = Date.parse("2026-10-15T14:00:00.000Z");
const free = (): Map<string, HostBusy> => new Map<string, HostBusy>([[CC, []], [ADON, []]]);
const slotsWith = (busy: Map<string, HostBusy>, s: BookingSettings = settings, now = NOW, duration = 30) =>
  computeOpenSlots({ settings: s, now, durationMinutes: duration, busyByHost: busy });
const starts = (list: { start: string }[]) => list.map((x) => x.start);
const weekdayIn = (iso: string, tz = "America/Toronto") =>
  new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(new Date(iso));

check("the default is CC every day and Adon Sunday to Thursday, 10:00 to 21:00 Toronto", () => {
  assert.equal(settings.timeZone, "America/Toronto");
  assert.deepEqual(settings.hosts.map((h) => [h.userId, h.role]), [[CC, "organizer"], [ADON, "attendee"]]);
  assert.deepEqual(settings.hosts[0].weeklyHours, weeklyHoursOn([0, 1, 2, 3, 4, 5, 6], 600, 1260));
  assert.deepEqual(settings.hosts[1].weeklyHours, weeklyHoursOn([0, 1, 2, 3, 4], 600, 1260));
  assert.equal(settings.minNoticeMinutes, 120);
  assert.equal(settings.maxDaysAhead, 14);
  assert.equal(settings.bufferMinutes, 0, "back-to-back calls stay possible, as before");
});

check("both founders are on duty Sunday to Thursday; CC alone on Friday and Saturday", () => {
  const thu = Date.parse("2026-10-15T16:00:00.000Z"); // Thu 12:00 EDT
  const fri = Date.parse("2026-10-16T14:00:00.000Z"); // Fri 10:00 EDT
  const sat = Date.parse("2026-10-17T14:00:00.000Z"); // Sat 10:00 EDT
  const sun = Date.parse("2026-10-18T14:00:00.000Z"); // Sun 10:00 EDT
  assert.deepEqual(onDutyHosts(settings, thu, 30).map((h) => h.userId), [CC, ADON]);
  assert.deepEqual(onDutyHosts(settings, fri, 30).map((h) => h.userId), [CC]);
  assert.deepEqual(onDutyHosts(settings, sat, 30).map((h) => h.userId), [CC]);
  assert.deepEqual(onDutyHosts(settings, sun, 30).map((h) => h.userId), [CC, ADON]);
});

check("a call must fit inside the hours: 20:30 is the last 30-minute start, 9:30 is too early", () => {
  const open = starts(slotsWith(free()));
  assert.ok(open.includes("2026-10-16T00:30:00.000Z"), "Thu 20:30 EDT ends at 21:00 and is offered");
  assert.ok(!open.includes("2026-10-16T01:00:00.000Z"), "Thu 21:00 EDT would end at 21:30");
  assert.ok(!open.includes("2026-10-16T13:30:00.000Z"), "Fri 09:30 EDT is before 10:00");
  assert.ok(open.includes("2026-10-16T14:00:00.000Z"), "Fri 10:00 EDT is offered");
  const fortyFive = starts(slotsWith(free(), settings, NOW, 45));
  assert.ok(!fortyFive.includes("2026-10-16T00:30:00.000Z"), "a 45-minute call cannot start at 20:30");
  assert.ok(fortyFive.includes("2026-10-16T00:00:00.000Z"), "a 45-minute call can start at 20:00");
});

check("each slot names who is on duty, organizer first", () => {
  const byStart = new Map(slotsWith(free()).map((s) => [s.start, s.hostIds]));
  assert.deepEqual(byStart.get("2026-10-15T16:00:00.000Z"), [CC, ADON]);
  assert.deepEqual(byStart.get("2026-10-16T14:00:00.000Z"), [CC]);
  assert.deepEqual(byStart.get("2026-10-17T20:00:00.000Z"), [CC]);
});

check("no slot inside the notice window or past the horizon; starts sit on the half hour", () => {
  const open = slotsWith(free());
  assert.ok(open.length > 0);
  assert.equal(open[0].start, "2026-10-15T16:00:00.000Z", "Thu 12:00 EDT: two hours after 10:00");
  for (const s of open) {
    const t = Date.parse(s.start);
    assert.ok(t >= NOW + 120 * 60_000, `${s.start} is inside the notice window`);
    assert.ok(t <= NOW + 14 * 86_400_000, `${s.start} is past the horizon`);
    assert.equal(new Date(t).getUTCMinutes() % 30, 0, `${s.start} is off the grid`);
  }
});

check("an attendee's busy time closes only the slots they are on duty for", () => {
  const busy = free();
  busy.set(ADON, [{ start: Date.parse("2026-10-15T18:00:00.000Z"), end: Date.parse("2026-10-15T19:00:00.000Z") }]);
  const open = starts(slotsWith(busy));
  assert.ok(!open.includes("2026-10-15T18:00:00.000Z"));
  assert.ok(!open.includes("2026-10-15T18:30:00.000Z"));
  assert.ok(open.includes("2026-10-15T17:30:00.000Z"), "a call ending as the busy block starts is fine");
  assert.ok(open.includes("2026-10-15T19:00:00.000Z"));
});

check("an attendee whose calendar cannot be read leaves only the organizer's solo days", () => {
  for (const busy of [new Map<string, HostBusy>([[CC, []], [ADON, "unavailable"]]), new Map<string, HostBusy>([[CC, []]])]) {
    const open = slotsWith(busy);
    assert.ok(open.length > 0, "Friday and Saturday stay bookable");
    for (const s of open) {
      assert.ok(["Fri", "Sat"].includes(weekdayIn(s.start)), `${s.start} needs Adon, whose calendar was not read`);
      assert.deepEqual(s.hostIds, [CC]);
    }
  }
});

check("an organizer whose calendar cannot be read closes everything (fail closed)", () => {
  assert.equal(slotsWith(new Map<string, HostBusy>([[CC, "unavailable"], [ADON, []]])).length, 0);
  assert.equal(slotsWith(new Map<string, HostBusy>([[ADON, []]])).length, 0);
});

check("the buffer keeps free time either side of a busy block", () => {
  const buffered = { ...settings, bufferMinutes: 10 };
  const busy = free();
  busy.set(CC, [{ start: Date.parse("2026-10-15T18:00:00.000Z"), end: Date.parse("2026-10-15T19:00:00.000Z") }]);
  const open = starts(slotsWith(busy, buffered));
  assert.ok(!open.includes("2026-10-15T17:30:00.000Z"), "ends at 18:00, inside the 10-minute buffer");
  assert.ok(!open.includes("2026-10-15T19:00:00.000Z"), "starts at 19:00, inside the 10-minute buffer");
  assert.ok(open.includes("2026-10-15T19:30:00.000Z"));
  assert.ok(open.includes("2026-10-15T17:00:00.000Z"));
});

check("the read window covers the last start plus one call plus the buffer", () => {
  const w = bookingReadWindow({ ...settings, bufferMinutes: 10 }, NOW, 45);
  assert.equal(w.timeMin, NOW + 120 * 60_000 - 10 * 60_000);
  assert.equal(w.timeMax, NOW + 14 * 86_400_000 + 45 * 60_000 + 10 * 60_000);
});

check("the November 1 clock change keeps 10:00 local on both sides", () => {
  const now = Date.parse("2026-10-29T12:00:00.000Z");
  const open = starts(slotsWith(free(), settings, now));
  assert.ok(open.includes("2026-10-31T14:00:00.000Z"), "Sat Oct 31 10:00 EDT");
  assert.ok(open.includes("2026-11-01T15:00:00.000Z"), "Sun Nov 1 10:00 EST");
  assert.ok(!open.includes("2026-11-01T14:00:00.000Z"), "Sun Nov 1 09:00 EST is before hours");
});

check("a half-hour time zone still gets starts on its own :00 and :30", () => {
  const stJohns = { ...settings, timeZone: "America/St_Johns" };
  const open = slotsWith(free(), stJohns);
  assert.ok(open.length > 0);
  for (const s of open) {
    const minute = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/St_Johns", minute: "2-digit" }).format(new Date(s.start)));
    assert.equal(minute % 30, 0, `${s.start} is not on the St. John's half hour`);
  }
});

check("settings parse strictly: anything off is refused, never repaired", () => {
  assert.deepEqual(parseBookingSettings(JSON.stringify(settings)), settings);
  const mutate = (fn: (s: Record<string, unknown>) => void) => {
    const copy = JSON.parse(JSON.stringify(settings)) as Record<string, unknown>;
    fn(copy);
    return parseBookingSettings(copy);
  };
  const hosts = (s: Record<string, unknown>) => s.hosts as Array<Record<string, unknown>>;
  assert.equal(parseBookingSettings("{not json"), null);
  assert.equal(mutate((s) => { s.timeZone = "Mars/Olympus"; }), null);
  assert.equal(mutate((s) => { s.stepMinutes = 20; }), null);
  assert.equal(mutate((s) => { s.maxDaysAhead = 31; }), null, "Google refuses a read over 31 days");
  assert.equal(mutate((s) => { s.bufferMinutes = -5; }), null);
  assert.equal(mutate((s) => { hosts(s)[1].role = "organizer"; }), null, "exactly one organizer");
  assert.equal(mutate((s) => { hosts(s)[0].role = "attendee"; }), null, "exactly one organizer");
  assert.equal(mutate((s) => { hosts(s)[1].userId = CC; }), null, "a host appears once");
  assert.equal(mutate((s) => { hosts(s).push({ ...hosts(s)[1], userId: "third" }); }), null, "the engine invites one attendee");
  assert.equal(mutate((s) => { (hosts(s)[0].weeklyHours as unknown[]).pop(); }), null, "seven days");
  assert.equal(mutate((s) => { (hosts(s)[0].weeklyHours as unknown[][])[1] = [{ start: 600, end: 600 }]; }), null);
  assert.equal(mutate((s) => { (hosts(s)[0].weeklyHours as unknown[][])[1] = [{ start: 600, end: 1500 }]; }), null);
  assert.equal(
    mutate((s) => { (hosts(s)[0].weeklyHours as unknown[][])[1] = [{ start: 600, end: 800 }, { start: 700, end: 900 }]; }),
    null,
    "overlapping windows",
  );
  assert.ok(mutate((s) => { (hosts(s)[0].weeklyHours as unknown[][])[1] = [{ start: 840, end: 1000 }, { start: 600, end: 700 }]; }));
});

// -- The Schedule as busy time ---------------------------------------------

function event(partial: Partial<EventRecord> & Pick<EventRecord, "id" | "start" | "end">): EventRecord {
  return {
    calendarId: "cal",
    title: "",
    description: "",
    location: "",
    allDay: false,
    timeZone: "America/Toronto",
    recurrence: null,
    exdates: [],
    recurringEventId: null,
    originalStart: null,
    color: null,
    reminders: [],
    guests: [],
    busy: true,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...partial,
  };
}

const MIN = NOW;
const MAX = NOW + 14 * 86_400_000;

check("the weekly routine never counts as busy, nor does an event shown as free", () => {
  const events = [
    event({
      id: "routine_v1-abc",
      start: "2026-10-12T14:00:00.000Z",
      end: "2026-10-12T21:00:00.000Z",
      recurrence: { freq: "DAILY", interval: 1 },
    }),
    event({
      id: "override-1",
      recurringEventId: "routine_v1-abc",
      originalStart: "2026-10-16T14:00:00.000Z",
      start: "2026-10-16T15:00:00.000Z",
      end: "2026-10-16T20:00:00.000Z",
    }),
    event({ id: "free-1", start: "2026-10-16T16:00:00.000Z", end: "2026-10-16T17:00:00.000Z", busy: false }),
  ];
  assert.deepEqual(scheduleBusyIntervals(events, MIN, MAX, "America/Toronto"), []);
});

check("a one-off busy event and a repeating series both block their times", () => {
  const events = [
    event({ id: "oneoff", start: "2026-10-20T15:00:00.000Z", end: "2026-10-20T16:00:00.000Z" }),
    event({
      id: "weekly",
      start: "2026-10-12T19:00:00.000Z", // Monday 15:00 EDT
      end: "2026-10-12T20:00:00.000Z",
      recurrence: { freq: "WEEKLY", interval: 1, byWeekday: [1] },
    }),
  ];
  const busy = scheduleBusyIntervals(events, MIN, MAX, "America/Toronto").map((b) => new Date(b.start).toISOString());
  assert.ok(busy.includes("2026-10-20T15:00:00.000Z"));
  assert.ok(busy.includes("2026-10-19T19:00:00.000Z"), "Monday Oct 19 15:00 EDT");
  assert.ok(busy.includes("2026-10-26T19:00:00.000Z"), "Monday Oct 26 15:00 EDT");
  assert.ok(!busy.includes("2026-10-12T19:00:00.000Z"), "before the window");
});

check("an all-day event blocks that whole day in the booking time zone", () => {
  const busy = scheduleBusyIntervals(
    [event({ id: "allday", allDay: true, start: "2026-10-20", end: "2026-10-21" })],
    MIN,
    MAX,
    "America/Toronto",
  );
  assert.deepEqual(busy, [{ start: Date.parse("2026-10-20T04:00:00.000Z"), end: Date.parse("2026-10-21T04:00:00.000Z") }]);
});

check("Schedule busy time closes the slots it covers", () => {
  const busy = free();
  busy.set(CC, scheduleBusyIntervals(
    [event({ id: "mtg", start: "2026-10-16T14:00:00.000Z", end: "2026-10-16T15:00:00.000Z" })],
    MIN,
    MAX,
    "America/Toronto",
  ));
  const open = starts(slotsWith(busy));
  assert.ok(!open.includes("2026-10-16T14:00:00.000Z"));
  assert.ok(!open.includes("2026-10-16T14:30:00.000Z"));
  assert.ok(open.includes("2026-10-16T15:00:00.000Z"));
});

console.log("booking-hours: all passed");
