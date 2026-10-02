/**
 * "2 o'clock" means the prospect's 2 o'clock. A rep in Montreal booking a
 * plumber in Vancouver must send 2 p.m. Pacific, not 2 p.m. Eastern.
 *
 * Run: node --conditions=react-server --import tsx tests/meeting-time-zones.test.ts
 */
import assert from "node:assert/strict";
import {
  EASTERN_TIME_ZONE,
  MEETING_TIME_OPTIONS,
  dateChoiceInZone,
  formatMeetingInZone,
  meetingIsoInZone,
  prospectTimeZone,
} from "../lib/meeting-time";

// Province to zone, codes and names, case and spacing tolerant.
assert.equal(prospectTimeZone("BC").timeZone, "America/Vancouver");
assert.equal(prospectTimeZone("British Columbia").timeZone, "America/Vancouver");
assert.equal(prospectTimeZone(" on ").timeZone, "America/Toronto");
assert.equal(prospectTimeZone("Québec").timeZone, "America/Toronto");
assert.equal(prospectTimeZone("SK").timeZone, "America/Regina");
assert.equal(prospectTimeZone("NL").timeZone, "America/St_Johns");
assert.equal(prospectTimeZone("NS").timeZone, "America/Halifax");
// Unknown or multi-zone: Eastern, flagged unknown so the panel says so.
assert.deepEqual(prospectTimeZone(null), { timeZone: EASTERN_TIME_ZONE, label: "Eastern time", known: false });
assert.equal(prospectTimeZone("NU").known, false, "Nunavut spans several zones; never guess");

// 2:00 p.m. local on Tue 2026-10-06 (DST in force everywhere that observes it).
assert.equal(meetingIsoInZone("2026-10-06", "14:00", "America/Toronto"), "2026-10-06T18:00:00.000Z");
assert.equal(meetingIsoInZone("2026-10-06", "14:00", "America/Vancouver"), "2026-10-06T21:00:00.000Z");
assert.equal(meetingIsoInZone("2026-10-06", "14:00", "America/Halifax"), "2026-10-06T17:00:00.000Z");
assert.equal(meetingIsoInZone("2026-10-06", "14:00", "America/St_Johns"), "2026-10-06T16:30:00.000Z");
// Saskatchewan never changes its clocks.
assert.equal(meetingIsoInZone("2026-10-06", "14:00", "America/Regina"), "2026-10-06T20:00:00.000Z");
assert.equal(meetingIsoInZone("2026-12-01", "14:00", "America/Regina"), "2026-12-01T20:00:00.000Z");
// A wall-clock time that does not exist (spring forward 2027-03-14) is refused, never shifted.
assert.equal(meetingIsoInZone("2027-03-14", "02:30", "America/Toronto"), null);
// Garbage in, null out.
assert.equal(meetingIsoInZone("2026-10-06", "", "America/Toronto"), null);
assert.equal(meetingIsoInZone("06/10/2026", "14:00", "America/Toronto"), null);

// Slots: 07:00 to 20:45 in 15-minute steps, labelled for a Canadian reader.
assert.equal(MEETING_TIME_OPTIONS[0].value, "07:00");
assert.equal(MEETING_TIME_OPTIONS.at(-1)!.value, "20:45");
assert.equal(MEETING_TIME_OPTIONS.length, 56);
assert.equal(MEETING_TIME_OPTIONS.find((o) => o.value === "14:00")!.label, "2:00 p.m.");

// "Tomorrow" is tomorrow in the prospect's zone.
const lateEvening = Date.parse("2026-10-06T05:30:00.000Z"); // 1:30 a.m. Toronto Oct 6, 10:30 p.m. Vancouver Oct 5
assert.equal(dateChoiceInZone(0, "America/Toronto", lateEvening), "2026-10-06");
assert.equal(dateChoiceInZone(0, "America/Vancouver", lateEvening), "2026-10-05");
assert.equal(dateChoiceInZone(1, "America/Vancouver", lateEvening), "2026-10-06");

// Formatting names the local hour.
const label = formatMeetingInZone("2026-10-06T21:00:00.000Z", "America/Vancouver");
assert.match(label, /2:00/);
assert.match(label, /p\.m\./);

console.log("meeting-time-zones: OK");
