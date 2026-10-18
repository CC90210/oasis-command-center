import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bookingMeetRoomDeps, bookingMeetRoomTitle, liveBookingMeetRooms } from "../lib/booking/meet-room";
import { MEET_RECORDING_NOTICE } from "../lib/meet/recording-notice";
import {
  createGoogleFounderMeeting,
  founderMeetingEventId,
  updateGoogleFounderMeeting,
  type GoogleCalendarDependencies,
} from "../lib/integrations/google-calendar";

const TENANT = "tenant-oasis";
const HOST = "founder-a";
const ORGANIZER = "founder@oasisai.work";
const REQUEST = "11111111-1111-4111-8111-111111111111";
const START = "2026-10-20T16:00:00.000Z";
const ROOM_URL = "https://oasisai.work/meet/abc-defg-hjk";

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function dependencies(fetchImpl: typeof fetch): GoogleCalendarDependencies {
  return {
    fetchImpl,
    getBundle: async () => ({
      refresh_token: "refresh-token",
      access_token: "access-token",
      expires_at: "2026-10-20T18:00:00.000Z",
      scope: "https://www.googleapis.com/auth/calendar.events",
      gmail_address: ORGANIZER,
    }),
    setValue: async () => ({ ok: true, id: "credential" }),
    now: () => Date.parse("2026-10-20T14:00:00.000Z"),
    sleep: async () => undefined,
    pollAttempts: 2,
    pollIntervalMs: 0,
    oauthClientId: "client-id",
    oauthClientSecret: "client-secret",
  };
}

function providerEvent(eventId: string, payload: Record<string, unknown>) {
  return {
    ...payload,
    id: eventId,
    status: "confirmed",
    htmlLink: `https://calendar.google.com/calendar/event?eid=${eventId}`,
    iCalUID: `${eventId}@google.com`,
    organizer: { email: ORGANIZER },
  };
}

async function testCreateUsesOasisRoomWithoutGoogleConference(): Promise<void> {
  const calls: Array<{ url: string; payload: Record<string, unknown> }> = [];
  const eventId = founderMeetingEventId(TENANT, HOST, REQUEST);
  const receipt = await createGoogleFounderMeeting({
    tenantId: TENANT,
    hostUserId: HOST,
    expectedOrganizerEmail: ORGANIZER,
    requestId: REQUEST,
    meetingAt: START,
    timezone: "America/Toronto",
    durationMinutes: 15,
    offerLabel: "website audit",
    clientEmail: "client@example.com",
    clientName: "Taylor Client",
    company: "Acme",
    website: "https://acme.example",
    clientAgenda: "Review the booking workflow.",
    meetingLink: ROOM_URL,
  }, dependencies(async (input, init) => {
    const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ url: String(input), payload });
    return response(providerEvent(eventId, payload));
  }));

  assert.equal(calls.length, 1, "an Oasis room needs no Meet provisioning poll");
  const url = new URL(calls[0].url);
  assert.equal(url.searchParams.get("sendUpdates"), "all");
  assert.equal(url.searchParams.has("conferenceDataVersion"), false);
  assert.equal(calls[0].payload.location, ROOM_URL);
  assert.equal("conferenceData" in calls[0].payload, false);
  assert.equal(
    calls[0].payload.description,
    `A 15-minute website audit with OASIS AI Solutions.\n\nAgenda:\nReview the booking workflow.\n\nWebsite: https://acme.example/\n\nJoin the video call: ${ROOM_URL}`,
  );
  assert.equal(receipt.meetLink, ROOM_URL);
}

async function testRescheduleKeepsOasisRoomWithoutConference(): Promise<void> {
  const eventId = founderMeetingEventId(TENANT, HOST, REQUEST);
  let call: { url: string; payload: Record<string, unknown> } | null = null;
  const receipt = await updateGoogleFounderMeeting({
    tenantId: TENANT,
    hostUserId: HOST,
    expectedOrganizerEmail: ORGANIZER,
    eventId,
    meetingAt: "2026-10-20T17:00:00.000Z",
    timezone: "America/Toronto",
    durationMinutes: 15,
    offerLabel: "website audit",
    clientEmail: "client@example.com",
    clientName: "Taylor Client",
    company: "Acme",
    website: "https://acme.example",
    clientAgenda: "Review the moved call.",
    meetingLink: ROOM_URL,
  }, dependencies(async (input, init) => {
    const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
    call = { url: String(input), payload };
    return response(providerEvent(eventId, payload));
  }));

  assert(call);
  const url = new URL(call.url);
  assert.equal(url.searchParams.get("sendUpdates"), "all");
  assert.equal(url.searchParams.has("conferenceDataVersion"), false);
  assert.equal(call.payload.location, ROOM_URL);
  assert.match(String(call.payload.description), /Join the video call: https:\/\/oasisai\.work\/meet\/abc-defg-hjk$/);
  assert.equal(receipt.meetLink, ROOM_URL);
}

async function testRecordedRoomInviteCarriesTheNotice(): Promise<void> {
  // Maven's line, directly under the link, when the room records; on the create and the move alike.
  const eventId = founderMeetingEventId(TENANT, HOST, REQUEST);
  const payloads: Array<Record<string, unknown>> = [];
  const capture = dependencies(async (_input, init) => {
    const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
    payloads.push(payload);
    return response(providerEvent(eventId, payload));
  });
  const base = {
    tenantId: TENANT,
    hostUserId: HOST,
    expectedOrganizerEmail: ORGANIZER,
    timezone: "America/Toronto",
    durationMinutes: 30,
    offerLabel: "discovery call",
    clientEmail: "client@example.com",
    clientAgenda: "A 30-minute discovery call with OASIS AI Solutions.",
    meetingLink: ROOM_URL,
  };
  await createGoogleFounderMeeting({ ...base, requestId: REQUEST, meetingAt: START, meetingRecorded: true }, capture);
  await updateGoogleFounderMeeting({ ...base, eventId, meetingAt: "2026-10-20T17:00:00.000Z", meetingRecorded: true }, capture);
  for (const payload of payloads) {
    assert.ok(
      String(payload.description).endsWith(`\n\nJoin the video call: ${ROOM_URL}\n${MEET_RECORDING_NOTICE}`),
      `the notice sits directly under the link: ${JSON.stringify(payload.description)}`,
    );
  }
  // A room that does not record, or a Google Meet invite, never says so.
  payloads.length = 0;
  await createGoogleFounderMeeting({ ...base, requestId: REQUEST, meetingAt: START, meetingRecorded: false }, capture);
  assert.equal(String(payloads[0].description).includes(MEET_RECORDING_NOTICE), false);
}

function testLivePortUsesTheLeadTitleRule(): void {
  assert.equal(typeof liveBookingMeetRooms, "function");
  assert.equal(bookingMeetRoomTitle("Taylor", "OASIS call with Fallback"), "OASIS call with Taylor");
  assert.equal(bookingMeetRoomTitle(null, "OASIS call with Fallback"), "OASIS call with Fallback");
}

function testNoTursoMeansNoRoomPort() {
  // Codex on the booking PR: building the port called getTursoClient(), which throws without Turso, so a Google-only
  // deployment could not book at all. Without Turso the routes get no port and take the Google Meet path.
  const keys = ["TURSO_DB_PATH", "TURSO_DATABASE_URL", "TURSO_DB_URL", "EMPIRE_DATA_BACKEND"] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  try {
    assert.deepEqual(bookingMeetRoomDeps(), {});
    process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
    assert.deepEqual(bookingMeetRoomDeps(), {}, "turso_cloud with no Turso configured");
    // Turso configured while appointments live on Supabase (a rollback): those rows have no meet_room_id column, so
    // no port either (Codex on the booking PR).
    process.env.TURSO_DB_PATH = `file:${join(tmpdir(), "booking-meet-room-never-opened.db")}`;
    for (const backend of ["supabase_cloud", ""]) {
      process.env.EMPIRE_DATA_BACKEND = backend;
      assert.deepEqual(bookingMeetRoomDeps(), {}, `backend ${JSON.stringify(backend)} got the room port`);
    }
  } finally {
    for (const k of keys) delete process.env[k];
    for (const k of keys) if (saved[k] !== undefined) process.env[k] = saved[k];
  }
}

async function main() {
  await testCreateUsesOasisRoomWithoutGoogleConference();
  await testRescheduleKeepsOasisRoomWithoutConference();
  await testRecordedRoomInviteCarriesTheNotice();
  testLivePortUsesTheLeadTitleRule();
  testNoTursoMeansNoRoomPort();
  console.log("booking-oasis-meet-calendar: OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});