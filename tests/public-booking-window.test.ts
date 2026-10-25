/**
 * tests/public-booking-window.test.ts - the busy-read window reaches one meeting
 * length past the last slot, so a founder event in that tail blocks the slot.
 *
 * Google's events.list `timeMax` bounds an event's START. The last bookable slot
 * starts at about now + 14 days and runs 15 to 45 minutes beyond that, so a
 * founder event starting inside that tail was never returned: the slot was
 * offered, and the booking route (which re-reads with the same window) accepted
 * it, booking a client over a founder's event. CodeRabbit found it on PR #611.
 *
 * The stub below applies Google's rule (an event is returned only when it starts
 * before timeMax and ends after timeMin), so a window that stops at the last
 * start fails this test. Since 2026-10-16 the hours are per host
 * (lib/booking/hours.ts), so the reads are per host too.
 */
import assert from "node:assert/strict";
import { defaultOasisBookingSettings } from "../lib/booking/hours";
import type { BookingSettings } from "../lib/booking/hours";

type Busy = { start: string; end: string };
type Call = { timeMin: string; timeMax: string; organizerUserId: string };

// Never let a test reach Google, whatever the developer's shell holds.
for (const key of Object.keys(process.env)) {
  if (/^GOOGLE_/.test(key)) delete process.env[key];
}

const calls: Call[] = [];
let events: Busy[] = [];

const settings: BookingSettings = defaultOasisBookingSettings({ organizerUserId: "owner-cc", attendeeUserId: null });
const roster = [
  { auth_user_id: "owner-cc", email: "cc@example.com", full_name: "CC", display_name: null },
];

const deps = {
  loadSettings: async () => ({ settings }),
  roster: async () => roster as never,
  listGoogleBusy: (async (args: Call): Promise<Busy[]> => {
    calls.push(args);
    const min = Date.parse(args.timeMin);
    const max = Date.parse(args.timeMax);
    return events.filter((e) => Date.parse(e.start) < max && Date.parse(e.end) > min);
  }) as never,
  listScheduleEvents: async () => [],
};

async function main(): Promise<void> {
  const { loadPublicBookingAvailability } = await import("../lib/forms/public-booking");
  const starts = async (durationMinutes: number) =>
    (await loadPublicBookingAvailability({ tenantId: "t", durationMinutes, now: NOW }, deps)).map((s) => s.start);

  // Thursday 14:00 Toronto (EDT). Fourteen days on is Thursday 2026-10-29 14:00 EDT:
  // a slot start CC is on duty for, and the edge of the horizon.
  const NOW = Date.parse("2026-10-15T18:00:00.000Z");
  const lastStart = "2026-10-29T18:00:00.000Z";

  for (const durationMinutes of [15, 45]) {
    calls.length = 0;
    events = [];
    await starts(durationMinutes);
    assert.equal(calls.length, 1, "the proprietor's calendar is read");
    const wantMax = new Date(NOW + 14 * 24 * 60 * 60_000 + durationMinutes * 60_000).toISOString();
    for (const call of calls) {
      assert.equal(call.timeMax, wantMax, `the window ends one ${durationMinutes}-minute meeting past the last start`);
    }
  }
  console.log("  ok - the busy-read window reaches one meeting length past the last slot start");

  // Control: with nothing on the calendar the boundary slot IS offered, so the
  // assertion below really is about the event and not about the slot's absence.
  events = [];
  assert.ok((await starts(15)).includes(lastStart), "an empty calendar offers the boundary slot");

  // An event that STARTS after the last start (14:10 > 14:00) but overlaps the
  // boundary slot (14:00-14:15) must block it.
  events = [{ start: "2026-10-29T18:10:00.000Z", end: "2026-10-29T18:50:00.000Z" }];
  assert.ok(!(await starts(15)).includes(lastStart), "the boundary slot must not be offered over a founder's event");
  console.log("  ok - a founder event just past the last start blocks the boundary slot");

  // The same holds for a 45-minute discovery call: the 14:00 start runs to 14:45.
  events = [{ start: "2026-10-29T18:40:00.000Z", end: "2026-10-29T19:30:00.000Z" }];
  assert.ok(!(await starts(45)).includes(lastStart), "a 45-minute call is not offered over an event in its own tail");
  console.log("  ok - the 45-minute tail is covered too");

  console.log("public-booking-window: all passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
