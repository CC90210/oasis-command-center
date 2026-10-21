/**
 * A stale pre-offboarding attendee setting cannot put a former operator back
 * on OASIS booking slots. Only the proprietor's calendar and identity count.
 */
import assert from "node:assert/strict";
import { defaultOasisBookingSettings } from "../lib/booking/hours";
import type { BookingSettings } from "../lib/booking/hours";
import { GoogleCalendarIntegrationError } from "../lib/integrations/google-calendar";

type Busy = { start: string; end: string };
type Call = { organizerUserId: string };

for (const key of Object.keys(process.env)) {
  if (/^GOOGLE_/.test(key)) delete process.env[key];
}

const CC = "owner-cc";
const FORMER_OPERATOR = "former-operator";
const currentDefault = defaultOasisBookingSettings({
  organizerUserId: CC,
  attendeeUserId: FORMER_OPERATOR,
});
// Model the stale document as it existed before the cutoff. The current
// default intentionally ignores attendeeUserId, so relying on that argument
// would make this test pass without ever exercising a persisted former host.
const settings: BookingSettings = {
  ...currentDefault,
  hosts: [
    currentDefault.hosts[0],
    {
      ...currentDefault.hosts[0],
      userId: FORMER_OPERATOR,
      role: "attendee",
    },
  ],
};
const roster = [
  { auth_user_id: CC, email: "cc@example.com", full_name: "CC", display_name: null },
];

async function main(): Promise<void> {
  const { loadPublicBookingAvailability } = await import("../lib/forms/public-booking");
  const calls: string[] = [];
  const slots = await loadPublicBookingAvailability(
    { tenantId: "t", durationMinutes: 15, now: Date.parse("2026-10-15T18:00:00.000Z") },
    {
      loadSettings: async () => ({ settings }),
      roster: async () => roster as never,
      listGoogleBusy: (async (args: Call): Promise<Busy[]> => {
        calls.push(args.organizerUserId);
        if (args.organizerUserId === FORMER_OPERATOR) throw new Error("former operator calendar must not be read");
        return [];
      }) as never,
      listScheduleEvents: async () => [],
    },
  );
  assert.deepEqual(calls, [CC], "only the proprietor's Google calendar is read");
  assert.ok(slots.length > 0, "the proprietor still has bookable slots");
  for (const slot of slots) {
    assert.deepEqual(slot.hosts.map((host) => host.userId), [CC], `${slot.start} exposed a former operator`);
  }
  console.log("  ok - stale attendee settings cannot restore a former operator");

  await assert.rejects(
    loadPublicBookingAvailability(
      { tenantId: "t", durationMinutes: 15, now: Date.parse("2026-10-15T18:00:00.000Z") },
      {
        loadSettings: async () => ({ settings }),
        roster: async () => roster as never,
        listGoogleBusy: (async () => {
          throw new GoogleCalendarIntegrationError("google_calendar_not_connected", "not connected");
        }) as never,
        listScheduleEvents: async () => [],
      },
    ),
    (error: unknown) => error instanceof GoogleCalendarIntegrationError && error.code === "google_calendar_not_connected",
    "the proprietor's disconnected calendar still fails closed",
  );
  console.log("  ok - the proprietor calendar remains the required source of truth");
  console.log("public-booking-absent-attendee: all passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
