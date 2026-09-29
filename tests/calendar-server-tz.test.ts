/**
 * The server (a Cloudflare Worker) runs in UTC, while the Shabbat window is
 * computed for the viewer's location. The lock must hold there too: the same
 * instants that are refused in the browser are refused on a UTC server.
 * node --conditions=react-server --import tsx tests/calendar-server-tz.test.ts
 */
import assert from "node:assert/strict";
import { DEFAULT_PREFS, type EventInput } from "../lib/calendar/types";
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

console.log("calendar-server-tz: all checks passed");
