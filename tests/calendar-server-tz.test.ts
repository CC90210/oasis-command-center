/**
 * The server (a Cloudflare Worker) runs in UTC, while the Shabbat window is
 * computed for the viewer's location. The lock must hold there too: the same
 * instants that are refused in the browser are refused on a UTC server.
 * node --conditions=react-server --import tsx tests/calendar-server-tz.test.ts
 */
import assert from "node:assert/strict";
import { seriesStarts } from "../lib/calendar/recurrence";
import { instantOf, wallAsLocal } from "../lib/calendar/zone";
import { DEFAULT_PREFS, type EventInput, type EventRecord } from "../lib/calendar/types";
import { shabbatConflict } from "../lib/calendar/validate";

process.env.TZ = "UTC";
assert.equal(new Date("2026-07-01T12:00:00Z").getTimezoneOffset(), 0);

const base: EventInput = {
  calendarId: "cal", title: "t", description: "", location: "", allDay: false,
  start: "", end: "", timeZone: "America/Toronto", recurrence: null, exdates: [],
  recurringEventId: null, originalStart: null, color: null, reminders: [], guests: [], busy: true,
};
// Instants written as Montréal wall-clock (EDT, UTC-4) on Fri 2 / Sat 3 Oct 2026.
const at = (s: string, e: string): EventInput => ({ ...base, start: new Date(`${s}-04:00`).toISOString(), end: new Date(`${e}-04:00`).toISOString() });

assert.ok(shabbatConflict(at("2026-10-02T20:00", "2026-10-02T21:00"), DEFAULT_PREFS), "Fri 8pm Montréal is refused on a UTC server");
assert.ok(shabbatConflict(at("2026-10-03T19:30", "2026-10-03T19:45"), DEFAULT_PREFS), "Sat 7:30pm, before the 72-minute end, is refused");
assert.equal(shabbatConflict(at("2026-10-02T12:00", "2026-10-02T13:00"), DEFAULT_PREFS), null, "Fri noon is allowed");
assert.equal(shabbatConflict(at("2026-10-03T20:30", "2026-10-03T21:30"), DEFAULT_PREFS), null, "Sat 8:30pm, after Shabbat, is allowed");
assert.ok(shabbatConflict({ ...base, allDay: true, start: "2026-10-03", end: "2026-10-04" }, DEFAULT_PREFS), "all-day Saturday is refused");
assert.ok(
  shabbatConflict({ ...at("2026-10-01T19:00", "2026-10-01T20:00"), recurrence: { freq: "WEEKLY", interval: 1, byWeekday: [4, 5] } }, DEFAULT_PREFS),
  "a series reaching Friday evening is refused",
);

// [P1, Codex 2026-09-29] A Toronto 9am weekly series expands to Toronto 9am
// on a UTC server too, across the Nov 1 DST change: 13:00Z in October (EDT),
// 14:00Z in November (EST). It used to expand in the server's own zone.
{
  const series: EventRecord = {
    ...base, id: "s", createdAt: "", updatedAt: "",
    start: "2026-10-26T13:00:00.000Z", end: "2026-10-26T14:00:00.000Z",
    recurrence: { freq: "WEEKLY", interval: 1, count: 3 },
  };
  assert.deepEqual([...seriesStarts(series)].map((d) => d.toISOString()), [
    "2026-10-26T13:00:00.000Z",
    "2026-11-02T14:00:00.000Z",
    "2026-11-09T14:00:00.000Z",
  ]);
  // `until` is a date in the event's zone: Mon 9 Nov 9am Toronto is still the 9th there.
  const until = { ...series, recurrence: { freq: "WEEKLY" as const, interval: 1, until: "2026-11-09" } };
  assert.equal([...seriesStarts(until)].length, 3);
}

// [P2, Codex round 4] Wall-clock to instant around DST changes.
{
  const w = (y: number, m: number, d: number, h: number, mi: number) => ({ y, m, d, h, mi, s: 0 });
  // Paris 01:30 on the spring-forward day exists (CET) and must stay 01:30.
  assert.equal(instantOf(w(2026, 2, 29, 1, 30), "Europe/Paris").toISOString(), "2026-03-29T00:30:00.000Z");
  // Toronto 02:30 on Mar 8 does not exist: pushed past the gap to 03:30 EDT.
  assert.equal(instantOf(w(2026, 2, 8, 2, 30), "America/Toronto").toISOString(), "2026-03-08T07:30:00.000Z");
  // Toronto 01:30 on Nov 1 happens twice: the earlier (EDT) wins.
  assert.equal(instantOf(w(2026, 10, 1, 1, 30), "America/Toronto").toISOString(), "2026-11-01T05:30:00.000Z");
  // Ordinary times on either side.
  assert.equal(instantOf(w(2026, 6, 1, 9, 0), "America/Toronto").toISOString(), "2026-07-01T13:00:00.000Z");
  assert.equal(instantOf(w(2026, 0, 15, 9, 0), "Asia/Kolkata").toISOString(), "2026-01-15T03:30:00.000Z");
}

// Repeat choices are built in the event's zone: a Toronto Monday 23:00 is a
// Monday for the editor even where it is already Tuesday (here: UTC).
{
  const mon11pm = new Date("2026-10-05T23:00:00-04:00");
  assert.equal(mon11pm.getUTCDay(), 2, "Tuesday in UTC");
  assert.equal(wallAsLocal(mon11pm, "America/Toronto").getDay(), 1, "Monday in the event's zone");
}

console.log("calendar-server-tz: all checks passed");
