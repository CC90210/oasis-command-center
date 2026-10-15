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
 * before timeMax and ends after timeMin), so the old window fails this test.
 */
import assert from "node:assert/strict";
import { dirname } from "node:path";

type Busy = { start: string; end: string };
type Call = { timeMin: string; timeMax: string; organizerUserId: string };

const calls: Call[] = [];
let events: Busy[] = [];

function stubModule(path: string, exports: Record<string, unknown>) {
  require.cache[path] = {
    id: path,
    filename: path,
    path: dirname(path),
    loaded: true,
    children: [],
    paths: [],
    exports,
  } as unknown as NodeModule;
}

// Never let a test reach Google, whatever the developer's shell holds.
for (const key of Object.keys(process.env)) {
  if (/^GOOGLE_/.test(key)) delete process.env[key];
}

stubModule(require.resolve("../lib/integrations/google-calendar"), {
  listGoogleCalendarBusy: async (args: Call): Promise<Busy[]> => {
    calls.push(args);
    const min = Date.parse(args.timeMin);
    const max = Date.parse(args.timeMax);
    return events.filter((e) => Date.parse(e.start) < max && Date.parse(e.end) > min);
  },
});

const founders = {
  host: { auth_user_id: "founder-cc", email: "cc@example.com" },
  opener: { auth_user_id: "founder-adon", email: "adon@example.com" },
};

async function main(): Promise<void> {
  const { loadPublicBookingSlots, buildPublicBookingSlots } = await import("../lib/forms/public-booking");

  // Thursday 14:00 Toronto (EDT). Fourteen days on is Thursday 2026-10-29 14:00 EDT:
  // a valid slot start, and the boundary the old window stopped at.
  const NOW = Date.parse("2026-10-15T18:00:00.000Z");
  const lastStart = "2026-10-29T18:00:00.000Z";

  for (const durationMinutes of [15, 45]) {
    calls.length = 0;
    events = [];
    await loadPublicBookingSlots({ tenantId: "t", founders, durationMinutes, now: NOW });
    assert.equal(calls.length, 2, "both founders' calendars are read");
    const wantMax = new Date(NOW + 14 * 24 * 60 * 60_000 + durationMinutes * 60_000).toISOString();
    for (const call of calls) {
      assert.equal(call.timeMax, wantMax, `the window ends one ${durationMinutes}-minute meeting past the last start`);
    }
  }
  console.log("  ok - the busy-read window reaches one meeting length past the last slot start");

  // Control: with nothing on the calendar the boundary slot IS offered, so the
  // assertion below really is about the event and not about the slot's absence.
  events = [];
  const open = await loadPublicBookingSlots({ tenantId: "t", founders, durationMinutes: 15, now: NOW });
  assert.ok(open.includes(lastStart), "an empty calendar offers the boundary slot");
  assert.deepEqual(
    open,
    buildPublicBookingSlots({ now: NOW, busy: [], durationMinutes: 15 }),
    "loading adds nothing but the busy intervals",
  );

  // A founder event that STARTS after the old window ended (14:10 > 14:00) but
  // overlaps the boundary slot (14:00-14:15) must block it.
  events = [{ start: "2026-10-29T18:10:00.000Z", end: "2026-10-29T18:50:00.000Z" }];
  const blocked = await loadPublicBookingSlots({ tenantId: "t", founders, durationMinutes: 15, now: NOW });
  assert.ok(!blocked.includes(lastStart), "the boundary slot must not be offered over a founder's event");
  console.log("  ok - a founder event just past the last start blocks the boundary slot");

  // The same holds for a 45-minute discovery call: the 14:00 start runs to 14:45.
  events = [{ start: "2026-10-29T18:40:00.000Z", end: "2026-10-29T19:30:00.000Z" }];
  const blocked45 = await loadPublicBookingSlots({ tenantId: "t", founders, durationMinutes: 45, now: NOW });
  assert.ok(!blocked45.includes(lastStart), "a 45-minute call is not offered over an event in its own tail");
  console.log("  ok - the 45-minute tail is covered too");

  console.log("public-booking-window: all passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
