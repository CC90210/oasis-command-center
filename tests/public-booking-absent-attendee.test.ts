/**
 * tests/public-booking-absent-attendee.test.ts - an attendee who has not
 * connected their work calendar is left off their days instead of closing them.
 *
 * CC, 2026-10-16: no founder had a Google connection in production, so Adon's
 * days (Sunday to Thursday) offered nothing. CC chose: until Adon connects his
 * work Google account, those days book with CC alone, and Adon is back on them
 * by himself once his calendar reads. The booking engine's rules for it:
 *   - only an UNCONNECTED calendar leaves the slot (none, revoked, another
 *     account, no calendar permission); a Google hiccup still closes it;
 *   - a readable, busy attendee still closes the slot;
 *   - the organizer rule is unchanged;
 *   - a slot without the attendee lists only the organizer, so only the
 *     organizer is invited (app/api/forms/booking/route.ts takes the attendee
 *     from the slot's hosts; tests/public-booking.test.ts pins that, and
 *     tests/founder-meeting-calendar.test.ts shows a booking with no attendee
 *     invites only the visitor and the OASIS inbox).
 */
import assert from "node:assert/strict";
import { defaultOasisBookingSettings } from "../lib/booking/hours";
import type { BookingSettings } from "../lib/booking/hours";
import { GoogleCalendarIntegrationError } from "../lib/integrations/google-calendar";

type Busy = { start: string; end: string };
type Call = { organizerUserId: string };

// Never let a test reach Google, whatever the developer's shell holds.
for (const key of Object.keys(process.env)) {
  if (/^GOOGLE_/.test(key)) delete process.env[key];
}

const CC = "founder-cc";
const ADON = "founder-adon";
const settings: BookingSettings = defaultOasisBookingSettings({ organizerUserId: CC, attendeeUserId: ADON });
const roster = [
  { auth_user_id: CC, email: "cc@example.com", full_name: "CC", display_name: null },
  { auth_user_id: ADON, email: "adon@example.com", full_name: "Adon", display_name: null },
];

// Thursday 2026-10-15 14:00 Toronto (EDT).
const NOW = Date.parse("2026-10-15T18:00:00.000Z");
const MON = "2026-10-19T16:00:00.000Z"; // Monday 12:00 EDT: both founders are on duty
const FRI = "2026-10-16T16:00:00.000Z"; // Friday 12:00 EDT: CC alone

function refreshFailed(status: number | undefined, body: string): GoogleCalendarIntegrationError {
  return new GoogleCalendarIntegrationError(
    "token_refresh_failed",
    `Google access-token refresh failed: ${body}`,
    status === undefined ? {} : { httpStatus: status },
  );
}

async function main(): Promise<void> {
  const { loadPublicBookingAvailability } = await import("../lib/forms/public-booking");

  const load = (ccRead: () => Promise<Busy[]>, adonRead: () => Promise<Busy[]>) =>
    loadPublicBookingAvailability(
      { tenantId: "t", durationMinutes: 15, now: NOW },
      {
        loadSettings: async () => ({ settings }),
        roster: async () => roster as never,
        listGoogleBusy: (async (args: Call): Promise<Busy[]> => (args.organizerUserId === ADON ? adonRead() : ccRead())) as never,
        listScheduleEvents: async () => [],
      },
    );
  const free = async (): Promise<Busy[]> => [];
  const hostsAt = (slots: Array<{ start: string; hosts: Array<{ userId: string }> }>, start: string) =>
    slots.find((slot) => slot.start === start)?.hosts.map((host) => host.userId) ?? null;

  // Control: both calendars read, both founders are on Monday and CC alone on Friday.
  const connected = await load(free, free);
  assert.deepEqual(hostsAt(connected, MON), [CC, ADON]);
  assert.deepEqual(hostsAt(connected, FRI), [CC]);
  console.log("  ok - with both calendars read, Monday is both founders and Friday is CC alone");

  const unconnected: Array<[string, GoogleCalendarIntegrationError]> = [
    ["nothing connected", new GoogleCalendarIntegrationError("google_calendar_not_connected", "not connected")],
    ["another Google account", new GoogleCalendarIntegrationError("calendar_organizer_mismatch", "wrong account")],
    ["no calendar permission", new GoogleCalendarIntegrationError("calendar_scope_required", "gmail only")],
    ["a revoked grant", refreshFailed(400, '{"error":"invalid_grant","error_description":"Token has been expired or revoked."}')],
  ];
  for (const [why, error] of unconnected) {
    const slots = await load(free, async () => { throw error; });
    assert.deepEqual(hostsAt(slots, MON), [CC], `${why}: Monday must book with CC alone`);
    assert.deepEqual(hostsAt(slots, FRI), [CC], `${why}: Friday is unchanged`);
    for (const slot of slots) assert.deepEqual(slot.hosts.map((host) => host.userId), [CC], `${why}: ${slot.start} still lists Adon`);
  }
  console.log("  ok - an attendee with no connected calendar is left off: every slot is CC alone");

  const hiccups: Array<[string, Error]> = [
    ["a network error on the refresh", refreshFailed(undefined, "fetch failed")],
    ["Google 503 on the refresh", refreshFailed(503, "backend error")],
    ["a 400 that is not invalid_grant", refreshFailed(400, '{"error":"invalid_request"}')],
    ["a failed calendar read", new GoogleCalendarIntegrationError("calendar_availability_failed", "500", { httpStatus: 500 })],
    ["a dead workspace credential", new GoogleCalendarIntegrationError("workspace_calendar_token_invalid", "both rejected")],
    ["an unexpected error", new Error("boom")],
  ];
  for (const [why, error] of hiccups) {
    const slots = await load(free, async () => { throw error; });
    assert.equal(hostsAt(slots, MON), null, `${why}: Monday must stay closed, Adon may be connected and busy`);
    assert.deepEqual(hostsAt(slots, FRI), [CC], `${why}: CC's solo Friday stays bookable`);
  }
  console.log("  ok - a connected attendee's failed read still closes their days (fail closed)");

  const busyMonday = async (): Promise<Busy[]> => [{ start: MON, end: "2026-10-19T17:00:00.000Z" }];
  const adonBusy = await load(free, busyMonday);
  assert.equal(hostsAt(adonBusy, MON), null, "a readable, busy attendee closes the slot");
  assert.deepEqual(hostsAt(adonBusy, "2026-10-19T17:00:00.000Z"), [CC, ADON]);
  console.log("  ok - a readable, busy attendee still closes the slot");

  const ccBusy = await load(busyMonday, async () => { throw unconnected[0][1]; });
  assert.equal(hostsAt(ccBusy, MON), null, "the organizer's busy time closes a slot the attendee is left off");
  await assert.rejects(
    load(async () => { throw unconnected[0][1]; }, free),
    (error: unknown) => error instanceof GoogleCalendarIntegrationError && error.code === "google_calendar_not_connected",
    "an unconnected ORGANIZER is never left off: availability fails with the reason",
  );
  console.log("  ok - the organizer rule is unchanged: busy closes, unconnected fails");

  console.log("public-booking-absent-attendee: all passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
