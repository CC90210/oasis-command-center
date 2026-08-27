import assert from "node:assert/strict";
import {
  cancelGoogleFounderMeeting,
  createGoogleFounderMeeting,
  GoogleCalendarIntegrationError,
  founderMeetingConferenceRequestId,
  founderMeetingEventId,
  operatorCalendarStatus,
  updateGoogleFounderMeeting,
  type GoogleCalendarDependencies,
} from "../lib/integrations/google-calendar";

const CALENDAR_EVENTS_SCOPE = "https://www.googleapis.com/auth/calendar.events";

const NOW = Date.parse("2026-08-25T14:00:00.000Z");
const START_AT = "2026-08-26T20:00:00.000Z";
const TENANT_ID = "tenant-oasis";
const ORGANIZER_USER_ID = "user-founder";
const BOOKING_REQUEST_ID = "11111111-1111-4111-8111-111111111111";

type FetchCall = { url: string; init?: RequestInit };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function deterministicEventId(
  requestId = BOOKING_REQUEST_ID,
  tenantId = TENANT_ID,
  hostUserId = ORGANIZER_USER_ID,
): string {
  return founderMeetingEventId(tenantId, hostUserId, requestId);
}

function deterministicConferenceId(
  requestId = BOOKING_REQUEST_ID,
  tenantId = TENANT_ID,
  hostUserId = ORGANIZER_USER_ID,
): string {
  return founderMeetingConferenceRequestId(tenantId, hostUserId, requestId);
}

function eventResponse(eventId: string, meetUrl = "https://meet.google.com/abc-defg-hij") {
  return {
    id: eventId,
    status: "confirmed",
    summary: "OASIS 15-minute website audit — Lakeside Montessori School",
    description:
      "A 15-minute website audit with OASIS AI Solutions.\n\nAgenda:\nReview online enrolment and booking requirements.\n\nWebsite: https://lakesidemontessori.example/",
    attendees: [{ email: "owner@example.com", responseStatus: "needsAction" }],
    htmlLink: `https://calendar.google.com/calendar/event?eid=${eventId}`,
    iCalUID: `${eventId}@google.com`,
    hangoutLink: meetUrl,
    organizer: { email: "founder@oasisai.work" },
    start: { dateTime: START_AT, timeZone: "America/Toronto" },
    end: { dateTime: "2026-08-26T20:15:00.000Z", timeZone: "America/Toronto" },
  };
}

function freshBundle() {
  return {
    refresh_token: "refresh-token",
    access_token: "fresh-access-token",
    expires_at: "2026-08-25T16:00:00.000Z",
    scope: `openid https://www.googleapis.com/auth/gmail.send ${CALENDAR_EVENTS_SCOPE}`,
    gmail_address: "founder@oasisai.work",
  };
}

function baseDependencies(
  fetchImpl: GoogleCalendarDependencies["fetchImpl"],
  overrides: Partial<GoogleCalendarDependencies> = {},
): GoogleCalendarDependencies {
  return {
    fetchImpl,
    getBundle: async () => freshBundle(),
    setValue: async () => ({ ok: true, id: "credential" }),
    now: () => NOW,
    sleep: async () => undefined,
    pollAttempts: 2,
    pollIntervalMs: 0,
    oauthClientId: "google-client-id",
    oauthClientSecret: "google-client-secret",
    ...overrides,
  };
}

function requestArgs() {
  return {
    tenantId: TENANT_ID,
    hostUserId: ORGANIZER_USER_ID,
    expectedOrganizerEmail: "founder@oasisai.work",
    requestId: BOOKING_REQUEST_ID,
    meetingAt: START_AT,
    timezone: "America/Toronto",
    durationMinutes: 15,
    clientEmail: "owner@example.com",
    clientName: "Morgan Owner",
    company: "Lakeside Montessori School",
    website: "https://lakesidemontessori.example",
    clientAgenda: "Review online enrolment and booking requirements.",
  };
}

function updateArgs(eventId = deterministicEventId()) {
  return {
    tenantId: TENANT_ID,
    hostUserId: ORGANIZER_USER_ID,
    expectedOrganizerEmail: "founder@oasisai.work",
    eventId,
    meetingAt: "2026-08-27T18:30:00.000Z",
    timezone: "America/Toronto",
    durationMinutes: 15,
    clientEmail: "new-owner@example.com",
    clientName: "Morgan Owner",
    company: "Lakeside Montessori School",
    website: "https://lakesidemontessori.example/new-audit",
    clientAgenda: "Confirm the revised audit time and review online enrolment.",
  };
}

async function testCreatesFifteenMinuteMeetInviteWithoutInternalNotes() {
  const calls: FetchCall[] = [];
  let requestedService = "";
  const secretHandoff = "Internal only: owner is nervous about budget.";
  const args = { ...requestArgs(), internalHandoffNotes: secretHandoff };

  const receipt = await createGoogleFounderMeeting(
    args,
    baseDependencies(async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      const payload = JSON.parse(String(init?.body)) as { id: string };
      return jsonResponse(eventResponse(payload.id));
    }, {
      getBundle: async (_tenantId, _userId, service) => {
        requestedService = service;
        return freshBundle();
      },
    }),
  );

  assert.equal(requestedService, "gmail_oauth", "Calendar must use the work OAuth bundle");
  assert.equal(calls.length, 1);
  const createCall = calls[0];
  const createUrl = new URL(createCall.url);
  assert.equal(createCall.init?.method, "POST");
  assert.equal(createUrl.pathname, "/calendar/v3/calendars/primary/events");
  assert.equal(createUrl.searchParams.get("sendUpdates"), "all");
  assert.equal(createUrl.searchParams.get("conferenceDataVersion"), "1");
  assert.equal((createCall.init?.headers as Record<string, string>).authorization, "Bearer fresh-access-token");

  const payload = JSON.parse(String(createCall.init?.body)) as {
    id: string;
    summary: string;
    description: string;
    attendees: Array<{ email: string; displayName?: string }>;
    start: { dateTime: string; timeZone: string };
    end: { dateTime: string; timeZone: string };
    conferenceData: { createRequest: { requestId: string; conferenceSolutionKey: { type: string } } };
  };
  assert.match(payload.id, /^[0-9a-v]{5,1024}$/, "Google custom event IDs must use base32hex characters");
  assert.equal(payload.id, deterministicEventId());
  assert.equal(payload.summary, "OASIS 15-minute website audit — Lakeside Montessori School");
  assert.deepEqual(payload.attendees, [
    { email: "owner@example.com", displayName: "Morgan Owner" },
    { email: "conaugh@oasisai.work" },
  ]);
  assert.equal(payload.start.dateTime, START_AT);
  assert.equal(payload.start.timeZone, "America/Toronto");
  assert.equal(Date.parse(payload.end.dateTime) - Date.parse(payload.start.dateTime), 15 * 60 * 1000);
  assert.equal(payload.end.timeZone, "America/Toronto");
  assert.equal(payload.conferenceData.createRequest.conferenceSolutionKey.type, "hangoutsMeet");
  assert.equal(payload.conferenceData.createRequest.requestId, deterministicConferenceId());
  assert.notEqual(
    deterministicConferenceId(),
    deterministicConferenceId("22222222-2222-4222-8222-222222222222"),
    "each booking must have a unique Meet createRequest ID",
  );
  assert.ok(!JSON.stringify(payload).includes(secretHandoff), "internal handoff notes must never reach Google");
  assert.equal(
    payload.description,
    "A 15-minute website audit with OASIS AI Solutions.\n\nAgenda:\nReview online enrolment and booking requirements.\n\nWebsite: https://lakesidemontessori.example/",
  );

  assert.deepEqual(receipt, {
    calendarId: "primary",
    eventId: payload.id,
    htmlLink: `https://calendar.google.com/calendar/event?eid=${payload.id}`,
    meetLink: "https://meet.google.com/abc-defg-hij",
    iCalUID: `${payload.id}@google.com`,
    organizerEmail: "founder@oasisai.work",
  });
}

async function testCopiesOpenerAndCentralInboxAndToleratesOrganizerEcho() {
  const calls: FetchCall[] = [];
  const args = {
    ...requestArgs(),
    openerEmail: " Opener@OasisAI.Work ",
    openerDisplayName: "Opener Rep",
  };

  await createGoogleFounderMeeting(
    args,
    baseDependencies(async (input, init) => {
      calls.push({ url: String(input), init });
      const payload = JSON.parse(String(init?.body)) as { id: string };
      // Google echoes the organizing account among attendees on reads.
      return jsonResponse({
        ...eventResponse(payload.id),
        attendees: [
          { email: "founder@oasisai.work", responseStatus: "accepted", organizer: true },
          { email: "owner@example.com", responseStatus: "needsAction" },
          { email: "opener@oasisai.work", responseStatus: "needsAction" },
          { email: "conaugh@oasisai.work", responseStatus: "needsAction" },
        ],
      });
    }),
  );

  assert.equal(calls.length, 1);
  const payload = JSON.parse(String(calls[0].init?.body)) as {
    attendees: Array<{ email: string; displayName?: string }>;
  };
  // Host (personal mode → organizer, no copy) is skipped; opener precedes the
  // client; the central inbox closes the list; nothing is duplicated.
  assert.deepEqual(payload.attendees, [
    { email: "opener@oasisai.work", displayName: "Opener Rep" },
    { email: "owner@example.com", displayName: "Morgan Owner" },
    { email: "conaugh@oasisai.work" },
  ]);
}

async function testRejectsBundleWithoutCalendarScope() {
  let fetchCount = 0;
  await assert.rejects(
    createGoogleFounderMeeting(
      requestArgs(),
      baseDependencies(async () => {
        fetchCount += 1;
        return jsonResponse({});
      }, {
        getBundle: async () => ({ ...freshBundle(), scope: "https://www.googleapis.com/auth/gmail.send" }),
      }),
    ),
    (error: unknown) => error instanceof Error && error.message === "calendar_scope_required",
  );
  assert.equal(fetchCount, 0, "a Gmail-only token must fail before calling Google Calendar");
}

async function testRejectsWrongGoogleIdentityBeforeProviderCall() {
  let fetchCount = 0;
  await assert.rejects(
    createGoogleFounderMeeting(
      requestArgs(),
      baseDependencies(async () => {
        fetchCount += 1;
        return jsonResponse({});
      }, {
        getBundle: async () => ({ ...freshBundle(), gmail_address: "personal@gmail.com" }),
      }),
    ),
    (error: unknown) => error instanceof Error && error.message === "calendar_organizer_mismatch",
  );
  assert.equal(fetchCount, 0, "a personal Google identity must fail before any Calendar mutation");
}

async function testRefreshesExpiredAccessTokenAndPersistsIt() {
  const calls: FetchCall[] = [];
  const persisted: Array<{ service: string; fieldKey: string; value: string }> = [];
  const eventId = deterministicEventId();

  const receipt = await createGoogleFounderMeeting(
    requestArgs(),
    baseDependencies(async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      if (url === "https://oauth2.googleapis.com/token") {
        return jsonResponse({ access_token: "refreshed-access-token", expires_in: 3600 });
      }
      return jsonResponse(eventResponse(eventId));
    }, {
      getBundle: async () => ({
        ...freshBundle(),
        access_token: "expired-token",
        expires_at: "2026-08-25T13:59:00.000Z",
      }),
      setValue: async (_tenantId, _userId, service, fieldKey, value) => {
        persisted.push({ service, fieldKey, value });
        return { ok: true, id: fieldKey };
      },
    }),
  );

  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://oauth2.googleapis.com/token");
  const tokenBody = new URLSearchParams(String(calls[0].init?.body));
  assert.equal(tokenBody.get("grant_type"), "refresh_token");
  assert.equal(tokenBody.get("refresh_token"), "refresh-token");
  assert.equal(tokenBody.get("client_id"), "google-client-id");
  assert.equal(tokenBody.get("client_secret"), "google-client-secret");
  assert.equal((calls[1].init?.headers as Record<string, string>).authorization, "Bearer refreshed-access-token");
  assert.deepEqual(persisted, [
    { service: "gmail_oauth", fieldKey: "access_token", value: "refreshed-access-token" },
    { service: "gmail_oauth", fieldKey: "expires_at", value: "2026-08-25T15:00:00.000Z" },
  ]);
  assert.equal(receipt.eventId, eventId);
}

async function testRefreshesAndRetriesOnceAfterCalendarRejectsFreshToken() {
  const calls: FetchCall[] = [];
  const eventId = deterministicEventId();
  let calendarAttempts = 0;

  const receipt = await createGoogleFounderMeeting(
    requestArgs(),
    baseDependencies(async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      if (url === "https://oauth2.googleapis.com/token") {
        return jsonResponse({ access_token: "replacement-token", expires_in: 3600 });
      }
      calendarAttempts += 1;
      if (calendarAttempts === 1) return jsonResponse({ error: "invalid_token" }, 401);
      return jsonResponse(eventResponse(eventId));
    }),
  );

  assert.equal(calendarAttempts, 2, "a 401 should receive exactly one refreshed retry");
  assert.equal(calls.filter((call) => call.url === "https://oauth2.googleapis.com/token").length, 1);
  assert.equal((calls[0].init?.headers as Record<string, string>).authorization, "Bearer fresh-access-token");
  assert.equal((calls[2].init?.headers as Record<string, string>).authorization, "Bearer replacement-token");
  assert.equal(receipt.eventId, eventId);
}

async function testReconcilesConflictByReadingDeterministicEvent() {
  const calls: FetchCall[] = [];
  const eventId = deterministicEventId();

  const receipt = await createGoogleFounderMeeting(
    requestArgs(),
    baseDependencies(async (input, init) => {
      calls.push({ url: String(input), init });
      if (init?.method === "POST") return new Response("already exists", { status: 409 });
      return jsonResponse(eventResponse(eventId));
    }),
  );

  assert.equal(calls.filter((call) => call.init?.method === "POST").length, 1);
  assert.equal(calls.filter((call) => call.init?.method === "GET").length, 1);
  assert.match(calls[1].url, new RegExp(`/events/${eventId}$`));
  assert.equal(receipt.eventId, eventId);
}

async function testRejectsMismatchedEventOnConflictReconciliation() {
  const eventId = deterministicEventId();
  const wrongAttendee = {
    ...eventResponse(eventId),
    attendees: [{ email: "different-client@example.com", responseStatus: "accepted" }],
  };
  const wrongTime = {
    ...eventResponse(eventId),
    start: { dateTime: "2026-08-26T21:00:00.000Z", timeZone: "America/Toronto" },
    end: { dateTime: "2026-08-26T21:15:00.000Z", timeZone: "America/Toronto" },
  };

  for (const mismatchedEvent of [wrongAttendee, wrongTime]) {
    await assert.rejects(
      createGoogleFounderMeeting(
        requestArgs(),
        baseDependencies(async (_input, init) => {
          if (init?.method === "POST") return new Response("already exists", { status: 409 });
          return jsonResponse(mismatchedEvent);
        }),
      ),
      (error: unknown) => error instanceof Error && error.message === "calendar_reconcile_failed",
    );
  }
}

async function testRejectsInvalidNormalCreateReceipt() {
  const eventId = deterministicEventId();
  await assert.rejects(
    createGoogleFounderMeeting(
      requestArgs(),
      baseDependencies(async () =>
        jsonResponse({ ...eventResponse(eventId), status: "cancelled" }),
      ),
    ),
    (error: unknown) => error instanceof Error && error.message === "calendar_create_failed",
  );
}

async function testAmbiguousCreateCarriesDeterministicEventIdForCompensation() {
  let caught: unknown;
  try {
    await createGoogleFounderMeeting(
      requestArgs(),
      baseDependencies(async () => {
        throw new TypeError("simulated network interruption");
      }),
    );
  } catch (error) {
    caught = error;
  }
  assert(caught instanceof Error);
  assert.equal(caught.message, "calendar_create_failed");
  assert.equal(
    (caught as Error & { eventId?: string }).eventId,
    deterministicEventId(),
    "a caller can cancel the exact deterministic event even when POST outcome is ambiguous",
  );
}

function testNamespacesDeterministicIdsByTenantAndHost() {
  const otherTenant = "tenant-other";
  const otherHost = "user-other-founder";
  assert.equal(deterministicEventId(), deterministicEventId());
  assert.equal(deterministicConferenceId(), deterministicConferenceId());
  assert.notEqual(
    deterministicEventId(BOOKING_REQUEST_ID, TENANT_ID, ORGANIZER_USER_ID),
    deterministicEventId(BOOKING_REQUEST_ID, otherTenant, ORGANIZER_USER_ID),
    "the same request ID in another tenant must not reuse the Calendar event ID",
  );
  assert.notEqual(
    deterministicEventId(BOOKING_REQUEST_ID, TENANT_ID, ORGANIZER_USER_ID),
    deterministicEventId(BOOKING_REQUEST_ID, TENANT_ID, otherHost),
    "the same request ID under another host must not reuse the Calendar event ID",
  );
  assert.notEqual(
    deterministicConferenceId(BOOKING_REQUEST_ID, TENANT_ID, ORGANIZER_USER_ID),
    deterministicConferenceId(BOOKING_REQUEST_ID, otherTenant, ORGANIZER_USER_ID),
    "the same request ID in another tenant must not reuse the Meet request ID",
  );
  assert.notEqual(
    deterministicConferenceId(BOOKING_REQUEST_ID, TENANT_ID, ORGANIZER_USER_ID),
    deterministicConferenceId(BOOKING_REQUEST_ID, TENANT_ID, otherHost),
    "the same request ID under another host must not reuse the Meet request ID",
  );
}

async function testPollsForMeetProvisioning() {
  const eventId = deterministicEventId();
  let getCount = 0;
  const receipt = await createGoogleFounderMeeting(
    requestArgs(),
    baseDependencies(async (_input, init) => {
      if (init?.method === "POST") {
        const withoutMeet = eventResponse(eventId);
        delete (withoutMeet as Partial<typeof withoutMeet>).hangoutLink;
        return jsonResponse(withoutMeet);
      }
      getCount += 1;
      const polled = eventResponse(eventId);
      if (getCount === 1) delete (polled as Partial<typeof polled>).hangoutLink;
      return jsonResponse(polled);
    }),
  );
  assert.equal(getCount, 2);
  assert.equal(receipt.meetLink, "https://meet.google.com/abc-defg-hij");
}

async function testFailsExplicitlyWhenMeetNeverAppears() {
  const eventId = deterministicEventId();
  let getCount = 0;
  await assert.rejects(
    createGoogleFounderMeeting(
      requestArgs(),
      baseDependencies(async (_input, init) => {
        const withoutMeet = eventResponse(eventId);
        delete (withoutMeet as Partial<typeof withoutMeet>).hangoutLink;
        if (init?.method === "GET") getCount += 1;
        return jsonResponse(withoutMeet);
      }),
    ),
    (error: unknown) => error instanceof Error && error.message === "google_meet_link_missing",
  );
  assert.equal(getCount, 2);
}

async function testReschedulesExistingMeetAndSendsUpdatedInvite() {
  const calls: FetchCall[] = [];
  const eventId = deterministicEventId();
  const secretHandoff = "Internal only: budget objection and rep coaching note.";
  const input = { ...updateArgs(eventId), internalHandoffNotes: secretHandoff };
  const updatedEvent = {
    ...eventResponse(eventId),
    description:
      "A 15-minute website audit with OASIS AI Solutions.\n\nAgenda:\nConfirm the revised audit time and review online enrolment.\n\nWebsite: https://lakesidemontessori.example/new-audit",
    attendees: [{ email: "new-owner@example.com", responseStatus: "needsAction" }],
    start: { dateTime: input.meetingAt, timeZone: input.timezone },
    end: { dateTime: "2026-08-27T18:45:00.000Z", timeZone: input.timezone },
  };

  const receipt = await updateGoogleFounderMeeting(
    input,
    baseDependencies(async (request, init) => {
      calls.push({ url: String(request), init });
      return jsonResponse(updatedEvent);
    }),
  );

  assert.equal(calls.length, 1);
  const patchCall = calls[0];
  const patchUrl = new URL(patchCall.url);
  assert.equal(patchCall.init?.method, "PATCH");
  assert.match(patchUrl.pathname, new RegExp(`/events/${eventId}$`));
  assert.equal(patchUrl.searchParams.get("sendUpdates"), "all");
  assert.equal(patchUrl.searchParams.get("conferenceDataVersion"), "1");
  assert.equal((patchCall.init?.headers as Record<string, string>).authorization, "Bearer fresh-access-token");

  const payload = JSON.parse(String(patchCall.init?.body)) as {
    summary: string;
    description: string;
    attendees: Array<{ email: string; displayName?: string }>;
    start: { dateTime: string; timeZone: string };
    end: { dateTime: string; timeZone: string };
    conferenceData?: unknown;
  };
  assert.equal(payload.summary, "OASIS 15-minute website audit — Lakeside Montessori School");
  assert.deepEqual(payload.attendees, [
    { email: "new-owner@example.com", displayName: "Morgan Owner" },
    { email: "conaugh@oasisai.work" },
  ]);
  assert.equal(payload.start.dateTime, input.meetingAt);
  assert.equal(payload.start.timeZone, input.timezone);
  assert.equal(Date.parse(payload.end.dateTime) - Date.parse(payload.start.dateTime), 15 * 60 * 1000);
  assert.equal(payload.end.timeZone, input.timezone);
  assert.equal(payload.conferenceData, undefined, "rescheduling must preserve the existing Meet room");
  assert.ok(!JSON.stringify(payload).includes(secretHandoff), "internal handoff notes must never reach Google");
  assert.equal(
    payload.description,
    "A 15-minute website audit with OASIS AI Solutions.\n\nAgenda:\nConfirm the revised audit time and review online enrolment.\n\nWebsite: https://lakesidemontessori.example/new-audit",
  );
  assert.deepEqual(receipt, {
    calendarId: "primary",
    eventId,
    htmlLink: `https://calendar.google.com/calendar/event?eid=${eventId}`,
    meetLink: "https://meet.google.com/abc-defg-hij",
    iCalUID: `${eventId}@google.com`,
    organizerEmail: "founder@oasisai.work",
  });
}

async function testRescheduleFailsIfExistingMeetCannotBeVerified() {
  const eventId = deterministicEventId();
  const input = updateArgs(eventId);
  let getCount = 0;
  await assert.rejects(
    updateGoogleFounderMeeting(
      input,
      baseDependencies(async (_request, init) => {
        const withoutMeet = {
          ...eventResponse(eventId),
          description:
            "A 15-minute website audit with OASIS AI Solutions.\n\nAgenda:\nConfirm the revised audit time and review online enrolment.\n\nWebsite: https://lakesidemontessori.example/new-audit",
          attendees: [{ email: "new-owner@example.com", responseStatus: "needsAction" }],
          start: { dateTime: input.meetingAt, timeZone: input.timezone },
          end: { dateTime: "2026-08-27T18:45:00.000Z", timeZone: input.timezone },
        };
        delete (withoutMeet as Partial<typeof withoutMeet>).hangoutLink;
        if (init?.method === "GET") getCount += 1;
        return jsonResponse(withoutMeet);
      }),
    ),
    (error: unknown) => error instanceof Error && error.message === "google_meet_link_missing",
  );
  assert.equal(getCount, 2, "reschedule must briefly poll before declaring the Meet receipt missing");
}

async function testRejectsMismatchedRescheduleReceipt() {
  const eventId = deterministicEventId();
  const input = updateArgs(eventId);
  const expected = {
    ...eventResponse(eventId),
    description:
      "A 15-minute website audit with OASIS AI Solutions.\n\nAgenda:\nConfirm the revised audit time and review online enrolment.\n\nWebsite: https://lakesidemontessori.example/new-audit",
    attendees: [{ email: "new-owner@example.com", responseStatus: "needsAction" }],
    start: { dateTime: input.meetingAt, timeZone: input.timezone },
    end: { dateTime: "2026-08-27T18:45:00.000Z", timeZone: input.timezone },
  };
  const wrongAttendee = {
    ...expected,
    attendees: [{ email: "different-client@example.com", responseStatus: "accepted" }],
  };
  const wrongTime = {
    ...expected,
    start: { dateTime: "2026-08-27T19:30:00.000Z", timeZone: input.timezone },
    end: { dateTime: "2026-08-27T19:45:00.000Z", timeZone: input.timezone },
  };

  for (const mismatchedEvent of [wrongAttendee, wrongTime]) {
    await assert.rejects(
      updateGoogleFounderMeeting(
        input,
        baseDependencies(async () => jsonResponse(mismatchedEvent)),
      ),
      (error: unknown) => error instanceof Error && error.message === "calendar_update_failed",
    );
  }
}

async function testCancelSendsUpdatesAndTreatsMissingEventAsSuccess() {
  const eventId = deterministicEventId();
  const statuses = [204, 404, 410];
  for (const status of statuses) {
    const calls: FetchCall[] = [];
    await cancelGoogleFounderMeeting(
      { tenantId: TENANT_ID, hostUserId: ORGANIZER_USER_ID, expectedOrganizerEmail: "founder@oasisai.work", eventId },
      baseDependencies(async (request, init) => {
        calls.push({ url: String(request), init });
        return new Response(null, { status });
      }),
    );
    assert.equal(calls.length, 1);
    const cancelUrl = new URL(calls[0].url);
    assert.equal(calls[0].init?.method, "DELETE");
    assert.match(cancelUrl.pathname, new RegExp(`/events/${eventId}$`));
    assert.equal(cancelUrl.searchParams.get("sendUpdates"), "all");
    assert.equal((calls[0].init?.headers as Record<string, string>).authorization, "Bearer fresh-access-token");
  }
}

async function testCancelRefreshesTokenAndFailsClosedWithoutCalendarScope() {
  const eventId = deterministicEventId();
  const calls: FetchCall[] = [];
  await cancelGoogleFounderMeeting(
    { tenantId: TENANT_ID, hostUserId: ORGANIZER_USER_ID, expectedOrganizerEmail: "founder@oasisai.work", eventId },
    baseDependencies(async (request, init) => {
      const url = String(request);
      calls.push({ url, init });
      if (url === "https://oauth2.googleapis.com/token") {
        return jsonResponse({ access_token: "cancel-token", expires_in: 3600 });
      }
      return new Response(null, { status: 204 });
    }, {
      getBundle: async () => ({
        ...freshBundle(),
        access_token: "expired-token",
        expires_at: "2026-08-25T13:59:00.000Z",
      }),
    }),
  );
  assert.equal(calls[0].url, "https://oauth2.googleapis.com/token");
  assert.equal((calls[1].init?.headers as Record<string, string>).authorization, "Bearer cancel-token");

  let fetchCount = 0;
  await assert.rejects(
    cancelGoogleFounderMeeting(
      { tenantId: TENANT_ID, hostUserId: ORGANIZER_USER_ID, expectedOrganizerEmail: "founder@oasisai.work", eventId },
      baseDependencies(async () => {
        fetchCount += 1;
        return new Response(null, { status: 204 });
      }, {
        getBundle: async () => ({
          ...freshBundle(),
          scope: "https://www.googleapis.com/auth/gmail.send",
        }),
      }),
    ),
    (error: unknown) => error instanceof Error && error.message === "calendar_scope_required",
  );
  assert.equal(fetchCount, 0);
}

async function main() {
  const connected = await operatorCalendarStatus(
    TENANT_ID,
    ORGANIZER_USER_ID,
    { getBundle: async () => freshBundle() },
  );
  assert.deepEqual(connected, {
    connected: true,
    address: "founder@oasisai.work",
  });
  const needsScope = await operatorCalendarStatus(
    TENANT_ID,
    ORGANIZER_USER_ID,
    {
      getBundle: async () => ({
        ...freshBundle(),
        scope: "https://www.googleapis.com/auth/gmail.send",
      }),
    },
  );
  assert.deepEqual(needsScope, {
    connected: false,
    reason: "calendar_scope_required",
    address: "founder@oasisai.work",
  });
  testNamespacesDeterministicIdsByTenantAndHost();
  assert.equal(deterministicEventId(), deterministicEventId());
  assert.notEqual(
    deterministicEventId(),
    deterministicEventId("22222222-2222-4222-8222-222222222222"),
  );
  await testCreatesFifteenMinuteMeetInviteWithoutInternalNotes();
  await testCopiesOpenerAndCentralInboxAndToleratesOrganizerEcho();
  await testRejectsBundleWithoutCalendarScope();
  await testRejectsWrongGoogleIdentityBeforeProviderCall();
  await testRefreshesExpiredAccessTokenAndPersistsIt();
  await testRefreshesAndRetriesOnceAfterCalendarRejectsFreshToken();
  await testReconcilesConflictByReadingDeterministicEvent();
  await testRejectsMismatchedEventOnConflictReconciliation();
  await testRejectsInvalidNormalCreateReceipt();
  await testAmbiguousCreateCarriesDeterministicEventIdForCompensation();
  await testPollsForMeetProvisioning();
  await testFailsExplicitlyWhenMeetNeverAppears();
  await testReschedulesExistingMeetAndSendsUpdatedInvite();
  await testRejectsMismatchedRescheduleReceipt();
  await testRescheduleFailsIfExistingMeetCannotBeVerified();
  await testCancelSendsUpdatesAndTreatsMissingEventAsSuccess();
  await testCancelRefreshesTokenAndFailsClosedWithoutCalendarScope();
  console.log("founder-meeting-calendar: OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

/**
 * Restore an env var to exactly what it was, including ABSENT.
 *
 * `process.env.FOO = undefined` stores the STRING "undefined", which is truthy
 * and which systemCalendarConfig() would happily accept as a refresh token. A
 * cleanup written that way does not restore the environment, it poisons it for
 * every test that runs afterwards -- which is precisely what happened here: the
 * next test's expected rejection stopped happening because a "configured"
 * workspace calendar had appeared out of a failed teardown.
 */
function restoreEnv(key: string, previous: string | undefined): void {
  if (previous === undefined) delete process.env[key];
  else process.env[key] = previous;
}

async function revokedTokenFallbackChecks() {
// ---------------------------------------------------------------------------
// A REVOKED HOST TOKEN MUST FALL BACK TO THE WORKSPACE CALENDAR, NOT FAIL.
//
// Added 2026-08-26, from a live outage. The workspace fallback triggered on a
// token that was MISSING or WRONG-SCOPED, but not on one that was PRESENT AND
// DEAD -- and revocation is the common case: a host changes their Google
// password or removes the app at myaccount.google.com/permissions, and the
// stored refresh_token stays in the column looking perfectly healthy.
//
// So the booking skipped the fallback, went to refreshAccessToken with a dead
// token, and died with `token_refresh_failed` WHILE A FULLY CONFIGURED
// WORKSPACE CALENDAR SAT UNUSED. The credentials to book were already in
// production the whole time.
{
  const prevToken = process.env.GOOGLE_SYSTEM_CALENDAR_REFRESH_TOKEN;
  const prevAddress = process.env.GOOGLE_SYSTEM_CALENDAR_ADDRESS;
  const prevClientId = process.env.GOOGLE_CLIENT_ID;
  const prevSecret = process.env.GOOGLE_CLIENT_SECRET;
  process.env.GOOGLE_SYSTEM_CALENDAR_REFRESH_TOKEN = "system-refresh-token";
  process.env.GOOGLE_SYSTEM_CALENDAR_ADDRESS = "meetings@oasisai.work";
  process.env.GOOGLE_CLIENT_ID = "google-client-id";
  process.env.GOOGLE_CLIENT_SECRET = "google-client-secret";

  const tokenBodies: string[] = [];
  let created: Record<string, unknown> | null = null;

  const fetchImpl: GoogleCalendarDependencies["fetchImpl"] = async (url, init) => {
    const href = String(url);
    if (href.includes("oauth2.googleapis.com/token")) {
      const body = String((init as RequestInit)?.body || "");
      tokenBodies.push(body);
      // The HOST's token is the revoked one. The SYSTEM token still works.
      if (body.includes("refresh_token=refresh-token")) {
        return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
      }
      return new Response(JSON.stringify({ access_token: "system-access-token", expires_in: 3600 }), { status: 200 });
    }
    if (href.includes("/events")) {
      created = { url: href };
      return new Response(JSON.stringify(eventResponse(deterministicEventId())), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  };

  try {
    // The stored access token must be STALE, or nothing ever calls refresh and
    // the revoked refresh_token is never exercised -- which is exactly the shape
    // of a test that passes while proving nothing.
    const staleBundle = { ...freshBundle(), access_token: "", expires_at: "2026-08-25T13:00:00.000Z" };
    const receipt = await createGoogleFounderMeeting(
      requestArgs(),
      baseDependencies(fetchImpl, { getBundle: async () => staleBundle }),
    );
    // 1. IT BOOKED. Before the fix this threw token_refresh_failed.
    assert.ok(receipt, "a revoked host token must not stop the booking when a workspace calendar is configured");
    // 2. IT TRIED THE HOST FIRST, then the system token. Order matters: the host
    //    should organise their own meeting whenever they still can.
    assert.ok(tokenBodies.length >= 2, `expected a host attempt then a system attempt, saw ${tokenBodies.length}`);
    assert.ok(tokenBodies[0].includes("refresh_token=refresh-token"), "the host's own token must be tried first");
    assert.ok(
      tokenBodies.some((b) => b.includes("refresh_token=system-refresh-token")),
      "the workspace token must be used after the host's is rejected",
    );
    assert.ok(created, "an event must actually have been created");
  } finally {
    restoreEnv("GOOGLE_SYSTEM_CALENDAR_REFRESH_TOKEN", prevToken);
    restoreEnv("GOOGLE_SYSTEM_CALENDAR_ADDRESS", prevAddress);
    restoreEnv("GOOGLE_CLIENT_ID", prevClientId);
    restoreEnv("GOOGLE_CLIENT_SECRET", prevSecret);
  }
}
{
  // AND WITH NO FALLBACK CONFIGURED, THE ORIGINAL ERROR STILL PROPAGATES.
  // Fail-closed behaviour is not traded away for convenience: if there is no
  // workspace calendar to cover, a revoked token is still a hard failure the
  // host must fix.
  const prevToken = process.env.GOOGLE_SYSTEM_CALENDAR_REFRESH_TOKEN;
  const prevAlt = process.env.GOOGLE_SYSTEM_REFRESH_TOKEN;
  delete process.env.GOOGLE_SYSTEM_CALENDAR_REFRESH_TOKEN;
  delete process.env.GOOGLE_SYSTEM_REFRESH_TOKEN;

  const fetchImpl: GoogleCalendarDependencies["fetchImpl"] = async (url) =>
    String(url).includes("oauth2.googleapis.com/token")
      ? new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })
      : new Response("{}", { status: 200 });

  try {
    let code = "";
    try {
      const staleBundle = { ...freshBundle(), access_token: "", expires_at: "2026-08-25T13:00:00.000Z" };
      await createGoogleFounderMeeting(
        requestArgs(),
        baseDependencies(fetchImpl, { getBundle: async () => staleBundle }),
      );
    } catch (error) {
      code = error instanceof GoogleCalendarIntegrationError ? error.code : "unexpected";
    }
    assert.equal(code, "token_refresh_failed", "with no workspace fallback, a revoked token must still fail closed");
  } finally {
    restoreEnv("GOOGLE_SYSTEM_CALENDAR_REFRESH_TOKEN", prevToken);
    restoreEnv("GOOGLE_SYSTEM_REFRESH_TOKEN", prevAlt);
  }
}

console.log("founder-meeting-calendar revoked-token fallback ok");
}

// Chained, NOT fired in parallel: both this and the system-client checks below
// mutate the same GOOGLE_* process.env keys, and concurrent suites clobbering
// each other's env is a race that reports as a bogus assertion failure in
// whichever one loses. Sequence them and each sees the environment it set up.
revokedTokenFallbackChecks()
  .then(systemCalendarUsesItsOwnClientChecks)
  .then(broaderCalendarScopeChecks)
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

// ═══════════════════════════════════════════════════════════════════════════
// THE WORKSPACE CALENDAR IS SPENT WITH ITS OWN OAUTH CLIENT.
//
// Added 2026-08-27. A Google refresh grant is only valid when presented by the
// client that MINTED it. The workspace credential was being refreshed with
// `dependencies.oauthClientId` -- the rep-facing GOOGLE_CLIENT_ID -- so the
// shared calendar could only ever work if its credential happened to be minted
// by the same client as the "Connect Google" button. Nothing said so, and when
// it was not true every fallback booking died with `token_refresh_failed` from
// inside the code path whose entire job is to be the thing that still works.
//
// That coupling is also why standing this up looked like it needed a brand new
// Google Cloud project: the rep-facing client must be a WEB client (https
// redirect for the consent bounce), while the workspace calendar is a headless
// service identity. One client cannot be the best form of both.
async function systemCalendarUsesItsOwnClientChecks() {
{
  const saved = {
    sysRefresh: process.env.GOOGLE_SYSTEM_CALENDAR_REFRESH_TOKEN,
    address: process.env.GOOGLE_SYSTEM_CALENDAR_ADDRESS,
    repId: process.env.GOOGLE_CLIENT_ID,
    repSecret: process.env.GOOGLE_CLIENT_SECRET,
    sysId: process.env.GOOGLE_SYSTEM_CALENDAR_CLIENT_ID,
    sysSecret: process.env.GOOGLE_SYSTEM_CALENDAR_CLIENT_SECRET,
  };
  process.env.GOOGLE_SYSTEM_CALENDAR_REFRESH_TOKEN = "system-refresh-value";
  process.env.GOOGLE_SYSTEM_CALENDAR_ADDRESS = "meetings@oasisai.work";
  process.env.GOOGLE_CLIENT_ID = "rep-facing-web-client";
  process.env.GOOGLE_CLIENT_SECRET = "rep-facing-web-secret";
  process.env.GOOGLE_SYSTEM_CALENDAR_CLIENT_ID = "workspace-desktop-client";
  process.env.GOOGLE_SYSTEM_CALENDAR_CLIENT_SECRET = "workspace-desktop-secret";

  const grantBodies: string[] = [];
  const fetchImpl: GoogleCalendarDependencies["fetchImpl"] = async (url, init) => {
    const href = String(url);
    if (href.includes("oauth2.googleapis.com/token")) {
      const body = String((init as RequestInit)?.body || "");
      grantBodies.push(body);
      // Google's real behaviour: a grant presented by the wrong client is
      // rejected, however valid the credential itself is. Modelling that is the
      // whole point -- a stub that accepts any client proves nothing here.
      if (body.includes("refresh_token=system-refresh-value")) {
        return body.includes("client_id=workspace-desktop-client")
          ? new Response(JSON.stringify({ access_token: "system-access-value", expires_in: 3600 }), { status: 200 })
          : new Response(JSON.stringify({ error: "invalid_client" }), { status: 401 });
      }
      return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
    }
    if (href.includes("/events")) {
      return new Response(JSON.stringify(eventResponse(deterministicEventId())), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  };

  try {
    const staleBundle = { ...freshBundle(), access_token: "", expires_at: "2026-08-25T13:00:00.000Z" };
    const receipt = await createGoogleFounderMeeting(
      requestArgs(),
      baseDependencies(fetchImpl, { getBundle: async () => staleBundle }),
    );
    assert.ok(receipt, "the workspace calendar must book using its own OAuth client");

    const systemAttempt = grantBodies.find((b) => b.includes("refresh_token=system-refresh-value"));
    assert.ok(systemAttempt, "the workspace credential must have been attempted");
    assert.ok(
      systemAttempt.includes("client_id=workspace-desktop-client"),
      "the workspace credential must be presented with GOOGLE_SYSTEM_CALENDAR_CLIENT_ID, not the rep-facing client",
    );
    assert.ok(
      !systemAttempt.includes("client_id=rep-facing-web-client"),
      "the rep-facing client must not be used to spend the workspace credential",
    );
  } finally {
    restoreEnv("GOOGLE_SYSTEM_CALENDAR_REFRESH_TOKEN", saved.sysRefresh);
    restoreEnv("GOOGLE_SYSTEM_CALENDAR_ADDRESS", saved.address);
    restoreEnv("GOOGLE_CLIENT_ID", saved.repId);
    restoreEnv("GOOGLE_CLIENT_SECRET", saved.repSecret);
    restoreEnv("GOOGLE_SYSTEM_CALENDAR_CLIENT_ID", saved.sysId);
    restoreEnv("GOOGLE_SYSTEM_CALENDAR_CLIENT_SECRET", saved.sysSecret);
  }
}
{
  // AND WITH NO DEDICATED CLIENT SET, THE OLD BEHAVIOUR IS UNCHANGED.
  // The override is additive: an existing deployment whose workspace credential
  // was minted by the rep-facing client keeps working untouched.
  const saved = {
    sysRefresh: process.env.GOOGLE_SYSTEM_CALENDAR_REFRESH_TOKEN,
    repId: process.env.GOOGLE_CLIENT_ID,
    repSecret: process.env.GOOGLE_CLIENT_SECRET,
    sysId: process.env.GOOGLE_SYSTEM_CALENDAR_CLIENT_ID,
    sysSecret: process.env.GOOGLE_SYSTEM_CALENDAR_CLIENT_SECRET,
  };
  process.env.GOOGLE_SYSTEM_CALENDAR_REFRESH_TOKEN = "system-refresh-value";
  process.env.GOOGLE_CLIENT_ID = "rep-facing-web-client";
  process.env.GOOGLE_CLIENT_SECRET = "rep-facing-web-secret";
  delete process.env.GOOGLE_SYSTEM_CALENDAR_CLIENT_ID;
  delete process.env.GOOGLE_SYSTEM_CALENDAR_CLIENT_SECRET;

  const grantBodies: string[] = [];
  const fetchImpl: GoogleCalendarDependencies["fetchImpl"] = async (url, init) => {
    const href = String(url);
    if (href.includes("oauth2.googleapis.com/token")) {
      const body = String((init as RequestInit)?.body || "");
      grantBodies.push(body);
      if (body.includes("refresh_token=system-refresh-value")) {
        return new Response(JSON.stringify({ access_token: "system-access-value", expires_in: 3600 }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
    }
    if (href.includes("/events")) {
      return new Response(JSON.stringify(eventResponse(deterministicEventId())), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  };

  try {
    const staleBundle = { ...freshBundle(), access_token: "", expires_at: "2026-08-25T13:00:00.000Z" };
    await createGoogleFounderMeeting(
      requestArgs(),
      baseDependencies(fetchImpl, { getBundle: async () => staleBundle }),
    );
    const systemAttempt = grantBodies.find((b) => b.includes("refresh_token=system-refresh-value"));
    assert.ok(systemAttempt, "the workspace credential must have been attempted");
    assert.ok(
      systemAttempt.includes("client_id=rep-facing-web-client"),
      "with no dedicated client configured, the workspace credential still uses GOOGLE_CLIENT_ID",
    );
  } finally {
    restoreEnv("GOOGLE_SYSTEM_CALENDAR_REFRESH_TOKEN", saved.sysRefresh);
    restoreEnv("GOOGLE_CLIENT_ID", saved.repId);
    restoreEnv("GOOGLE_CLIENT_SECRET", saved.repSecret);
    restoreEnv("GOOGLE_SYSTEM_CALENDAR_CLIENT_ID", saved.sysId);
    restoreEnv("GOOGLE_SYSTEM_CALENDAR_CLIENT_SECRET", saved.sysSecret);
  }
}

console.log("founder-meeting-calendar system-client isolation ok");
}

// Invoked by the chain above, not here -- see the note on that call site.

// ═══════════════════════════════════════════════════════════════════════════
// A BROADER SCOPE SATISFIES A NARROWER ONE.
//
// Added 2026-08-27. hasRequiredScope matched the literal `calendar.events`
// string and nothing else, so a host granted the FULL `auth/calendar` scope --
// which strictly contains calendar.events and can do strictly more -- was
// treated as insufficiently privileged and pushed onto the workspace fallback
// (or refused outright when none was configured).
async function broaderCalendarScopeChecks() {
  const calls: FetchCall[] = [];
  const bundle = {
    ...freshBundle(),
    // The exact shape the OASIS workspace account holds.
    scope: "openid email https://www.googleapis.com/auth/calendar",
  };
  const receipt = await createGoogleFounderMeeting(
    requestArgs(),
    baseDependencies(async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      const payload = JSON.parse(String(init?.body)) as { id: string };
      return jsonResponse(eventResponse(payload.id));
    }, { getBundle: async () => bundle }),
  );

  assert.ok(receipt, "the full calendar scope must be accepted");
  // The decisive assertion: it booked as the HOST, not via the workspace
  // fallback. Falling back would also produce a receipt, so asserting only
  // "it booked" would pass on the broken behaviour too.
  assert.equal(
    receipt.organizerEmail,
    "founder@oasisai.work",
    "a host holding the parent scope must organise their OWN meeting, not be demoted to the shared calendar",
  );
  assert.equal(calls.length, 1, "no extra token round-trip should be needed");

  console.log("founder-meeting-calendar broader-scope acceptance ok");
}
