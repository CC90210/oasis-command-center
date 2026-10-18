import assert from "node:assert/strict";
import { createClient, type Client } from "@libsql/client";
import { createTursoPostgrest } from "../lib/turso-postgrest";
import type { BookingMeetRooms } from "../lib/booking/meet-room";
import {
  activateVerifiedFounderMeeting,
  backfillFounderMeetingNotifications,
  cancelVerifiedFounderMeeting,
  closeVerifiedFounderMeeting,
  compensatePendingFounderMeetingBooking,
  createVerifiedFounderMeeting,
  founderMeetingSmsConsentErrorResponse,
  founderMeetingBackfillChunkStart,
  grantFounderMeetingSmsConsent,
  meetRoomForBooking,
  prepareVerifiedFounderMeetingCancellation,
  reconcileFounderMeetingSagas,
  rescheduleVerifiedFounderMeeting,
} from "../lib/website-sales-founder-meeting";

const TENANT = "tenant-a";
const LEAD = "lead-a";
const ACTOR = "rep-a";
const HOST = "founder-a";
const ORGANIZER = "founder@oasisai.work";
const NOW = Date.parse("2026-09-01T14:00:00.000Z");
const FUTURE = "2026-09-01T16:00:00.000Z";
const LATER = "2026-09-01T17:00:00.000Z";

const BASE_SCHEMA = `
  CREATE TABLE tenants (
    id TEXT PRIMARY KEY
  );
  CREATE TABLE call_appointments (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    lead_id TEXT NOT NULL,
    entity_type TEXT NOT NULL DEFAULT 'lead',
    scheduled_for TEXT NOT NULL,
    assigned_to TEXT,
    status TEXT NOT NULL DEFAULT 'scheduled'
      CHECK (status IN ('scheduled', 'completed', 'no_answer', 'cancelled', 'rescheduled')),
    pre_call_note TEXT,
    outcome_note TEXT,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TEXT
  );
  CREATE TABLE tenant_records (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE lead_interactions (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    agent_source TEXT,
    metadata TEXT
  );
  CREATE TABLE calendar_events (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    appointment_id TEXT,
    start_at TEXT,
    end_at TEXT,
    description TEXT,
    location TEXT,
    updated_at TEXT
  );
`;

type CalendarCalls = {
  created: number;
  createdDurations: number[];
  createdOfferLabels: string[];
  createdMeetingLinks: Array<string | undefined>;
  createdMeetingRecorded: Array<boolean | undefined>;
  updated: string[];
  updatedMeetingLinks: Array<string | undefined>;
  updatedMeetingRecorded: Array<boolean | undefined>;
  cancelled: string[];
};

type InstrumentationHooks = {
  onSelect?: (table: string, columns: string) => void;
  onUpdate?: (table: string, values: Record<string, unknown>) => void;
  beforeMaybeSingle?: (table: string, columns: string | null) => Promise<unknown> | null;
  beforeExecute?: (table: string, columns: string | null) => Promise<unknown> | null;
};

function instrumentDb(db: unknown, hooks: InstrumentationHooks): unknown {
  const target = db as {
    from(table: string): {
      select(columns?: string, options?: unknown): unknown;
      update(values: Record<string, unknown>, options?: unknown): unknown;
      maybeSingle(): PromiseLike<unknown>;
      then(
        onFulfilled?: ((value: unknown) => unknown) | null,
        onRejected?: ((reason: unknown) => unknown) | null,
      ): Promise<unknown>;
    };
  };
  return new Proxy(target, {
    get(object, property, receiver) {
      if (property !== "from") {
        const value = Reflect.get(object, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(object) : value;
      }
      return (table: string) => {
        const builder = object.from(table);
        let selectedColumns: string | null = null;
        const originalSelect = builder.select.bind(builder);
        builder.select = (columns = "*", options?: unknown) => {
          selectedColumns = columns;
          hooks.onSelect?.(table, columns);
          return originalSelect(columns, options);
        };
        const originalUpdate = builder.update.bind(builder);
        builder.update = (values: Record<string, unknown>, options?: unknown) => {
          hooks.onUpdate?.(table, values);
          return originalUpdate(values, options);
        };
        const originalMaybeSingle = builder.maybeSingle.bind(builder);
        builder.maybeSingle = () => {
          const query = originalMaybeSingle();
          const before = hooks.beforeMaybeSingle?.(table, selectedColumns) ?? null;
          if (!before) return query;
          return {
            then(onFulfilled, onRejected) {
              return Promise.resolve(before).then(() => query).then(onFulfilled, onRejected);
            },
          };
        };
        const originalThen = builder.then.bind(builder);
        builder.then = (onFulfilled, onRejected) => {
          const before = hooks.beforeExecute?.(table, selectedColumns) ?? null;
          if (!before) return originalThen(onFulfilled, onRejected);
          return Promise.resolve(before).then(() => originalThen(onFulfilled, onRejected));
        };
        return builder;
      };
    },
  });
}

async function fixture() {
  const raw = createClient({ url: ":memory:" });
  const [migration167, migration169, migration224, migration232] = await import("node:fs").then(({ readFileSync }) => [
    readFileSync("database/turso/167_founder_meeting_closed_loop.turso.sql", "utf8"),
    readFileSync("database/turso/169_founder_meeting_reminder_tiers.turso.sql", "utf8"),
    readFileSync("database/turso/bravo__224_public_booking_offer_label.sql", "utf8"),
    readFileSync("database/turso/bravo__232_booking_meet_room.sql", "utf8"),
  ]);
  await raw.executeMultiple(`${BASE_SCHEMA}\n${migration167}\n${migration169}\n${migration224}\n${migration232}`);
  const db = createTursoPostgrest(raw);
  const calls: CalendarCalls = {
    created: 0,
    createdDurations: [],
    createdOfferLabels: [],
    createdMeetingLinks: [],
    createdMeetingRecorded: [],
    updated: [],
    updatedMeetingLinks: [],
    updatedMeetingRecorded: [],
    cancelled: [],
  };
  const deps = {
    db: db as never,
    now: () => NOW,
    createCalendar: async (input: { durationMinutes: number; offerLabel?: string; meetingLink?: string; meetingRecorded?: boolean }) => {
      calls.created += 1;
      calls.createdDurations.push(input.durationMinutes);
      calls.createdOfferLabels.push(input.offerLabel || "");
      calls.createdMeetingLinks.push(input.meetingLink);
      calls.createdMeetingRecorded.push(input.meetingRecorded);
      return {
        calendarId: "primary",
        eventId: "event12345",
        htmlLink: "https://calendar.google.com/calendar/event?eid=test",
        meetLink: input.meetingLink || "https://meet.google.com/abc-defg-hij",
        iCalUID: "ical-1",
        organizerEmail: ORGANIZER,
      };
    },
    updateCalendar: async (input: { meetingAt: string; meetingLink?: string; meetingRecorded?: boolean }) => {
      calls.updated.push(input.meetingAt);
      calls.updatedMeetingLinks.push(input.meetingLink);
      calls.updatedMeetingRecorded.push(input.meetingRecorded);
      return {
        calendarId: "primary",
        eventId: "event12345",
        htmlLink: "https://calendar.google.com/calendar/event?eid=test",
        meetLink: input.meetingLink || "https://meet.google.com/abc-defg-hij",
        iCalUID: "ical-1",
        organizerEmail: ORGANIZER,
      };
    },
    cancelCalendar: async (input: { eventId: string }) => {
      calls.cancelled.push(input.eventId);
    },
    memberStanding: async () => ({ standing: "active" as const, member: null }),
  };
  return { raw, db, deps, calls };
}

type FakeMeetRooms = BookingMeetRooms & {
  calls: {
    created: Array<{ id: string; title: string; startsAt: string }>;
    found: string[];
    rescheduled: Array<{ id: string; startsAt: string }>;
    removed: string[];
  };
  rescheduleOutcomes: boolean[];
  createErrors: Error[];
  removeErrors: Error[];
  seed(roomId: string, url?: string): void;
  end(roomId: string): void;
};

function fakeMeetRooms(isReady = true, records = true): FakeMeetRooms {
  const rooms = new Map<string, { id: string; url: string; status: string; recorded: boolean }>();
  const calls: FakeMeetRooms["calls"] = {
    created: [],
    found: [],
    rescheduled: [],
    removed: [],
  };
  const rescheduleOutcomes: boolean[] = [];
  const createErrors: Error[] = [];
  const removeErrors: Error[] = [];
  const codes = ["aaa-bbbb-ccc", "ddd-eeee-fff", "ggg-hhhh-jjj"];
  return {
    calls,
    rescheduleOutcomes,
    createErrors,
    removeErrors,
    seed: (roomId, url = "https://oasisai.work/meet/aaa-bbbb-ccc") => {
      rooms.set(roomId, { id: roomId, url, status: "scheduled", recorded: records });
    },
    end: (roomId) => {
      const room = rooms.get(roomId);
      if (room) room.status = "ended";
    },
    ready: () => isReady,
    create: async (input) => {
      const createError = createErrors.shift();
      if (createError) throw createError;
      const id = `room-${calls.created.length + 1}`;
      const url = `https://oasisai.work/meet/${codes[calls.created.length] || "mmm-nnnn-ooo"}`;
      calls.created.push({ id, title: input.title, startsAt: input.startsAt });
      rooms.set(id, { id, url, status: "scheduled", recorded: records });
      return { id, url, recorded: records };
    },
    find: async (_tenantId, roomId) => {
      calls.found.push(roomId);
      return rooms.get(roomId) || null;
    },
    reschedule: async (_tenantId, roomId, startsAt) => {
      calls.rescheduled.push({ id: roomId, startsAt });
      const outcome = rescheduleOutcomes.length ? rescheduleOutcomes.shift()! : rooms.has(roomId);
      return outcome;
    },
    remove: async (_tenantId, roomId) => {
      calls.removed.push(roomId);
      const removeError = removeErrors.shift();
      if (removeError) throw removeError;
      rooms.delete(roomId);
    },
  };
}
function bookingInput(requestId = "book-request-1") {
  return {
    tenantId: TENANT,
    leadId: LEAD,
    actorUserId: ACTOR,
    hostUserId: HOST,
    requestId,
    meetingAt: FUTURE,
    contact: {
      name: "Taylor Smith",
      company: "North Star Dental",
      email: "taylor@example.com",
      phone: "+14165550101",
      website: "https://northstardental.ca/",
    },
    clientAgenda: "Review the site and online booking workflow.",
    handoffNote: "Decision maker confirmed and wants online scheduling.",
    smsConsent: true,
    expectedOrganizerEmail: ORGANIZER,
    confirmations: {
      contactConfirmed: true as const,
      clientAgreedToTime: true as const,
      handoffComplete: true as const,
    },
  };
}

async function appointment(raw: Client, id: string) {
  const result = await raw.execute({ sql: "SELECT * FROM call_appointments WHERE id = ?", args: [id] });
  assert.equal(result.rows.length, 1);
  return result.rows[0];
}

async function insertVerifiedAppointment(raw: Client, values: {
  id: string;
  tenantId?: string;
  leadId?: string;
  scheduledFor?: string;
  status?: string;
  workflowStatus?: string;
  revision?: number;
  pendingRequestId?: string | null;
  pendingOperation?: string | null;
  pendingMeetingAt?: string | null;
  pendingStartedAt?: string | null;
  pendingLeaseToken?: string | null;
  previousScheduledFor?: string | null;
  meetRoomId?: string | null;
  googleMeetLink?: string | null;
}) {
  const eventId = `event-${values.id}`;
  await raw.execute({
    sql: `INSERT INTO call_appointments (
      id, tenant_id, lead_id, entity_type, scheduled_for, assigned_to, status,
      created_by, meeting_kind, duration_minutes, timezone, client_name_snapshot,
      company_snapshot, client_email_snapshot, client_phone_snapshot, website_snapshot,
      client_agenda, handoff_note, google_calendar_id, google_event_id,
      google_event_html_link, google_meet_link, meet_room_id, google_ical_uid, calendar_status,
      organizer_email_snapshot, booking_request_id, revision, workflow_status,
      sms_consent, pending_request_id, pending_operation, pending_meeting_at,
      pending_started_at, pending_lease_token, previous_scheduled_for
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [
      values.id, values.tenantId ?? TENANT, values.leadId ?? LEAD, "lead", values.scheduledFor ?? FUTURE, HOST,
      values.status ?? "scheduled", ACTOR, "founder_audit", 15, "America/Toronto",
      "Taylor Smith", "North Star Dental", "taylor@example.com", "+14165550101",
      "https://northstardental.ca/", "Review the site.", "Qualified handoff.",
      "primary", eventId, "https://calendar.google.com/calendar/event?eid=test",
      values.googleMeetLink ?? "https://meet.google.com/abc-defg-hij", values.meetRoomId ?? null,
      "ical-1", "verified", ORGANIZER,
      `booking-${values.id}`, values.revision ?? 1, values.workflowStatus ?? "active", 1,
      values.pendingRequestId ?? null, values.pendingOperation ?? null,
      values.pendingMeetingAt ?? null, values.pendingStartedAt ?? null,
      values.pendingLeaseToken ?? null, values.previousScheduledFor ?? null,
    ],
  });
}

async function setLead(raw: Client, data: Record<string, unknown>) {
  await raw.execute({
    sql: `INSERT INTO tenant_records (id, tenant_id, entity_type, data)
          VALUES (?, ?, 'lead', ?)
          ON CONFLICT(id) DO UPDATE SET data=excluded.data`,
    args: [LEAD, TENANT, JSON.stringify(data)],
  });
}

async function testCreateAuditAndFullIdempotency() {
  const { raw, deps, calls } = await fixture();
  const meeting = await createVerifiedFounderMeeting(bookingInput(), deps);
  assert.equal(calls.created, 1);
  assert.deepEqual(calls.createdDurations, [15]);
  const row = await appointment(raw, meeting.appointmentId);
  assert.equal(row.organizer_email_snapshot, ORGANIZER);
  assert.equal(row.confirmed_by, ACTOR);
  assert.ok(row.contact_confirmed_at);
  assert.ok(row.time_confirmed_at);
  assert.ok(row.handoff_confirmed_at);
  assert.equal(row.pending_operation, "book");
  assert.equal(row.workflow_status, "pending_transition");

  const notificationRows = await raw.execute({
    sql: `SELECT channel, kind, reminder_minutes_before
          FROM website_sales_meeting_notifications
          WHERE appointment_id = ?
          ORDER BY reminder_minutes_before DESC, channel`,
    args: [meeting.appointmentId],
  });
  assert.equal(notificationRows.rows.length, 8, "confirmation plus three email/SMS reminder tiers are planned");
  const reminders = notificationRows.rows.filter((notification) => notification.reminder_minutes_before !== null);
  assert.equal(reminders.length, 6);
  assert.deepEqual(
    [...new Set(reminders.map((notification) => Number(notification.reminder_minutes_before)))].sort((a, b) => b - a),
    [60, 30, 10],
  );

  await createVerifiedFounderMeeting(bookingInput(), deps);
  assert.equal(calls.created, 1, "a byte-equivalent retry reuses the verified receipt");
  for (const [field, value] of [
    ["name", "Another Name"],
    ["company", "Another Company"],
    ["website", "https://another.example/"],
  ] as const) {
    const changed = bookingInput();
    changed.contact[field] = value;
    await assert.rejects(createVerifiedFounderMeeting(changed, deps), /booking_request_mismatch/);
  }
  await assert.rejects(
    createVerifiedFounderMeeting({ ...bookingInput(), smsConsent: false }, deps),
    /booking_request_mismatch/,
  );
  await raw.close();
}

async function testOasisMeetRoomLifecycle() {
  const { raw, deps, calls } = await fixture();
  const meetRooms = fakeMeetRooms();
  const liveDeps = { ...deps, meetRooms };
  const input = bookingInput("oasis-room-lifecycle");
  const meeting = await createVerifiedFounderMeeting(input, liveDeps);
  const createdRow = await appointment(raw, meeting.appointmentId);
  assert.equal(meetRooms.calls.created.length, 1);
  assert.equal(meetRooms.calls.created[0].title, "OASIS call with Taylor");
  assert.equal(createdRow.meet_room_id, "room-1");
  assert.deepEqual(calls.createdMeetingLinks, ["https://oasisai.work/meet/aaa-bbbb-ccc"]);
  assert.equal(meeting.receipt.meetLink, "https://oasisai.work/meet/aaa-bbbb-ccc");

  const replay = await createVerifiedFounderMeeting(input, liveDeps);
  assert.equal(replay.appointmentId, meeting.appointmentId);
  assert.equal(meetRooms.calls.created.length, 1, "a replay never creates a second room");

  await activateVerifiedFounderMeeting(TENANT, meeting.appointmentId, liveDeps);
  await raw.execute({
    sql: "INSERT INTO calendar_events (id, tenant_id, appointment_id, description, location) VALUES (?, ?, ?, ?, ?)",
    args: [
      "moved-room-mirror",
      TENANT,
      meeting.appointmentId,
      "Lead lead-a\nhttps://oasisai.work/meet/aaa-bbbb-ccc",
      "https://oasisai.work/meet/aaa-bbbb-ccc",
    ],
  });
  const moved = await rescheduleVerifiedFounderMeeting({
    tenantId: TENANT,
    leadId: LEAD,
    appointmentId: meeting.appointmentId,
    requestId: "oasis-room-move",
    meetingAt: LATER,
  }, liveDeps);
  assert.equal(meetRooms.calls.rescheduled.at(-1)?.id, "room-1");
  assert.equal(meetRooms.calls.rescheduled.at(-1)?.startsAt, LATER);
  assert.equal(calls.updatedMeetingLinks.at(-1), "https://oasisai.work/meet/aaa-bbbb-ccc");
  assert.equal(moved.receipt.meetLink, "https://oasisai.work/meet/aaa-bbbb-ccc");
  const movedMirror = await raw.execute({
    sql: "SELECT description, location FROM calendar_events WHERE id = ?",
    args: ["moved-room-mirror"],
  });
  assert.deepEqual({ ...movedMirror.rows[0] }, {
    description: "Lead lead-a\nhttps://oasisai.work/meet/aaa-bbbb-ccc",
    location: "https://oasisai.work/meet/aaa-bbbb-ccc",
  });

  await activateVerifiedFounderMeeting(TENANT, meeting.appointmentId, liveDeps);
  const cancelled = await cancelVerifiedFounderMeeting({
    tenantId: TENANT,
    leadId: LEAD,
    appointmentId: meeting.appointmentId,
    requestId: "oasis-room-cancel",
  }, liveDeps);
  assert.equal(cancelled.disposition, "cancelled");
  assert.deepEqual(meetRooms.calls.removed, ["room-1"]);
  assert.equal((await appointment(raw, meeting.appointmentId)).meet_room_id, null);
  await raw.close();
}

async function testOasisMeetRoomReplacementAndFallback() {
  const replacement = await fixture();
  const replacementRooms = fakeMeetRooms();
  const replacementDeps = { ...replacement.deps, meetRooms: replacementRooms };
  const booked = await createVerifiedFounderMeeting(bookingInput("oasis-room-replace"), replacementDeps);
  await activateVerifiedFounderMeeting(TENANT, booked.appointmentId, replacementDeps);
  await replacement.raw.execute({
    sql: "INSERT INTO calendar_events (id, tenant_id, appointment_id, description, location) VALUES (?, ?, ?, ?, ?)",
    args: [
      "replacement-mirror",
      TENANT,
      booked.appointmentId,
      "Lead lead-a\nhttps://oasisai.work/meet/aaa-bbbb-ccc",
      "https://oasisai.work/meet/aaa-bbbb-ccc",
    ],
  });
  replacementRooms.rescheduleOutcomes.push(false);
  const moved = await rescheduleVerifiedFounderMeeting({
    tenantId: TENANT,
    leadId: LEAD,
    appointmentId: booked.appointmentId,
    requestId: "oasis-room-replace-move",
    meetingAt: LATER,
  }, replacementDeps);
  assert.equal(replacementRooms.calls.created.length, 2, "an ended room is replaced once");
  assert.equal((await appointment(replacement.raw, booked.appointmentId)).meet_room_id, "room-2");
  assert.equal(moved.receipt.meetLink, "https://oasisai.work/meet/ddd-eeee-fff");
  assert.equal(replacement.calls.updatedMeetingLinks.at(-1), "https://oasisai.work/meet/ddd-eeee-fff");
  const replacementMirror = await replacement.raw.execute({
    sql: "SELECT description, location FROM calendar_events WHERE id = ?",
    args: ["replacement-mirror"],
  });
  assert.deepEqual({ ...replacementMirror.rows[0] }, {
    description: "Lead lead-a\nhttps://oasisai.work/meet/ddd-eeee-fff",
    location: "https://oasisai.work/meet/ddd-eeee-fff",
  });
  await replacement.raw.close();

  const fallback = await fixture();
  const unavailableRooms = fakeMeetRooms(false);
  const fallbackMeeting = await createVerifiedFounderMeeting(
    bookingInput("oasis-room-not-ready"),
    { ...fallback.deps, meetRooms: unavailableRooms },
  );
  assert.equal(unavailableRooms.calls.created.length, 0);
  assert.equal((await appointment(fallback.raw, fallbackMeeting.appointmentId)).meet_room_id, null);
  assert.deepEqual(fallback.calls.createdMeetingLinks, [undefined]);
  assert.equal(fallbackMeeting.receipt.meetLink, "https://meet.google.com/abc-defg-hij");
  // Moved after Oasis Meet came up: it keeps its Google Meet. A room now would put a second link in an invite that
  // already carries one.
  const readyRooms = fakeMeetRooms();
  const readyDeps = { ...fallback.deps, meetRooms: readyRooms };
  await activateVerifiedFounderMeeting(TENANT, fallbackMeeting.appointmentId, readyDeps);
  const kept = await rescheduleVerifiedFounderMeeting({
    tenantId: TENANT,
    leadId: LEAD,
    appointmentId: fallbackMeeting.appointmentId,
    requestId: "oasis-room-not-ready-move",
    meetingAt: LATER,
  }, readyDeps);
  assert.equal(readyRooms.calls.created.length, 0, "a Google Meet booking got a room on reschedule");
  assert.equal(fallback.calls.updatedMeetingLinks.at(-1), undefined);
  assert.equal(kept.receipt.meetLink, "https://meet.google.com/abc-defg-hij");
  assert.equal((await appointment(fallback.raw, fallbackMeeting.appointmentId)).meet_room_id, null);
  await fallback.raw.close();
}

async function testOasisMeetRoomCalendarFailureCompensates() {
  const { raw, deps } = await fixture();
  const meetRooms = fakeMeetRooms();
  await assert.rejects(
    createVerifiedFounderMeeting(bookingInput("oasis-room-calendar-failure"), {
      ...deps,
      meetRooms,
      createCalendar: async () => {
        throw new Error("calendar_create_failed");
      },
    }),
    /calendar_create_failed/,
  );
  const failed = await raw.execute({
    sql: "SELECT meet_room_id FROM call_appointments WHERE booking_request_id = ?",
    args: ["oasis-room-calendar-failure"],
  });
  assert.equal(failed.rows[0].meet_room_id, null);
  assert.deepEqual(meetRooms.calls.removed, ["room-1"]);
  await raw.close();
}
async function testOasisMeetRoomRemovalRetriesAfterFailure() {
  const { raw, deps } = await fixture();
  const meetRooms = fakeMeetRooms();
  const liveDeps = { ...deps, meetRooms };
  const meeting = await createVerifiedFounderMeeting(bookingInput("oasis-room-remove-retry"), liveDeps);
  await activateVerifiedFounderMeeting(TENANT, meeting.appointmentId, liveDeps);
  meetRooms.removeErrors.push(new Error("room_delete_failed"));

  const logs: unknown[][] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => { logs.push(args); };
  try {
    const cancelled = await cancelVerifiedFounderMeeting({
      tenantId: TENANT,
      leadId: LEAD,
      appointmentId: meeting.appointmentId,
      requestId: "oasis-room-remove-retry-cancel",
    }, liveDeps);
    assert.equal(cancelled.disposition, "cancelled");
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal((await appointment(raw, meeting.appointmentId)).meet_room_id, "room-1");
  assert.match(JSON.stringify(logs), /Oasis room removal failed/);
  await cancelVerifiedFounderMeeting({
    tenantId: TENANT,
    leadId: LEAD,
    appointmentId: meeting.appointmentId,
    requestId: "oasis-room-remove-retry-cancel",
  }, liveDeps);
  assert.deepEqual(meetRooms.calls.removed, ["room-1", "room-1"]);
  assert.equal((await appointment(raw, meeting.appointmentId)).meet_room_id, null);
  await raw.close();
}

async function testOasisMeetRoomSurvivesLiveCalendarCompensation() {
  const { raw, deps } = await fixture();
  const meetRooms = fakeMeetRooms();
  await raw.execute(
    "CREATE TRIGGER reject_oasis_receipt_once BEFORE UPDATE ON call_appointments " +
    "WHEN OLD.booking_request_id = 'oasis-room-live-event' AND OLD.calendar_status = 'creating' " +
    "AND NEW.calendar_status = 'verified' BEGIN SELECT RAISE(ABORT, 'receipt-write-failure'); END",
  );
  let cancelAttempts = 0;
  const liveDeps = {
    ...deps,
    meetRooms,
    cancelCalendar: async (input: { eventId: string }) => {
      cancelAttempts += 1;
      if (cancelAttempts === 1) throw new Error("calendar_cancel_failed");
      return deps.cancelCalendar(input);
    },
  };

  const originalConsoleError = console.error;
  console.error = () => undefined;
  try {
    await assert.rejects(
      createVerifiedFounderMeeting(bookingInput("oasis-room-live-event"), liveDeps),
      /meeting_receipt_write_failed/,
    );
  } finally {
    console.error = originalConsoleError;
  }
  const failed = await raw.execute({
    sql: "SELECT id, meet_room_id FROM call_appointments WHERE booking_request_id = ?",
    args: ["oasis-room-live-event"],
  });
  const appointmentId = String(failed.rows[0].id);
  assert.equal(failed.rows[0].meet_room_id, "room-1");
  assert.deepEqual(meetRooms.calls.removed, [], "the room stays while its Google event may still be live");

  const reconciled = await reconcileFounderMeetingSagas({
    tenantId: TENANT,
    now: new Date("2026-09-01T14:20:00.000Z"),
    staleAfterMs: 60_000,
  }, liveDeps);
  assert.equal(reconciled.cancelled, 1);
  assert.equal(cancelAttempts, 2);
  assert.deepEqual(meetRooms.calls.removed, ["room-1"]);
  assert.equal((await appointment(raw, appointmentId)).meet_room_id, null);
  await raw.close();
}

async function testOasisMeetRoomCreationFailuresFallBack() {
  const createFailure = await fixture();
  const createRooms = fakeMeetRooms();
  createRooms.createErrors.push(new Error("room_create_failed"));
  const originalConsoleError = console.error;
  console.error = () => undefined;
  let created: Awaited<ReturnType<typeof createVerifiedFounderMeeting>>;
  try {
    created = await createVerifiedFounderMeeting(
      bookingInput("oasis-room-create-fallback"),
      { ...createFailure.deps, meetRooms: createRooms },
    );
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(created.receipt.meetLink, "https://meet.google.com/abc-defg-hij");
  assert.deepEqual(createFailure.calls.createdMeetingLinks, [undefined]);
  assert.equal((await appointment(createFailure.raw, created.appointmentId)).meet_room_id, null);
  await createFailure.raw.close();

  const storeFailure = await fixture();
  const storeRooms = fakeMeetRooms();
  await storeFailure.raw.execute(
    "CREATE TRIGGER reject_oasis_room_store BEFORE UPDATE ON call_appointments " +
    "WHEN OLD.booking_request_id = 'oasis-room-store-fallback' AND NEW.meet_room_id IS NOT NULL " +
    "BEGIN SELECT RAISE(ABORT, 'room-store-failure'); END",
  );
  console.error = () => undefined;
  let stored: Awaited<ReturnType<typeof createVerifiedFounderMeeting>>;
  try {
    stored = await createVerifiedFounderMeeting(
      bookingInput("oasis-room-store-fallback"),
      { ...storeFailure.deps, meetRooms: storeRooms },
    );
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(stored.receipt.meetLink, "https://meet.google.com/abc-defg-hij");
  assert.deepEqual(storeRooms.calls.removed, ["room-1"], "an unpersisted room is removed before Google fallback");
  assert.equal((await appointment(storeFailure.raw, stored.appointmentId)).meet_room_id, null);
  await storeFailure.raw.close();
}

async function testOasisMeetRoomRescheduleRollback() {
  const movedFixture = await fixture();
  const movedRooms = fakeMeetRooms();
  const movedDeps = { ...movedFixture.deps, meetRooms: movedRooms };
  const movedMeeting = await createVerifiedFounderMeeting(bookingInput("oasis-room-move-rollback"), movedDeps);
  await activateVerifiedFounderMeeting(TENANT, movedMeeting.appointmentId, movedDeps);
  await assert.rejects(
    rescheduleVerifiedFounderMeeting({
      tenantId: TENANT,
      leadId: LEAD,
      appointmentId: movedMeeting.appointmentId,
      requestId: "oasis-room-move-rollback-request",
      meetingAt: LATER,
    }, {
      ...movedDeps,
      updateCalendar: async () => { throw new Error("calendar_update_failed"); },
    }),
    /calendar_update_failed/,
  );
  assert.deepEqual(movedRooms.calls.rescheduled, [
    { id: "room-1", startsAt: LATER },
    { id: "room-1", startsAt: FUTURE },
  ]);
  assert.equal((await appointment(movedFixture.raw, movedMeeting.appointmentId)).meet_room_id, "room-1");
  await movedFixture.raw.close();

  const replacedFixture = await fixture();
  const replacedRooms = fakeMeetRooms();
  const replacedDeps = { ...replacedFixture.deps, meetRooms: replacedRooms };
  const replacedMeeting = await createVerifiedFounderMeeting(bookingInput("oasis-room-replace-rollback"), replacedDeps);
  await activateVerifiedFounderMeeting(TENANT, replacedMeeting.appointmentId, replacedDeps);
  replacedRooms.rescheduleOutcomes.push(false);
  await assert.rejects(
    rescheduleVerifiedFounderMeeting({
      tenantId: TENANT,
      leadId: LEAD,
      appointmentId: replacedMeeting.appointmentId,
      requestId: "oasis-room-replace-rollback-request",
      meetingAt: LATER,
    }, {
      ...replacedDeps,
      updateCalendar: async () => { throw new Error("calendar_update_failed"); },
    }),
    /calendar_update_failed/,
  );
  assert.deepEqual(replacedRooms.calls.removed, ["room-2"]);
  assert.equal((await appointment(replacedFixture.raw, replacedMeeting.appointmentId)).meet_room_id, "room-1");
  await replacedFixture.raw.close();
}

async function testOasisMeetRoomMovesWhenMediaIsUnavailable() {
  const { raw, deps, calls } = await fixture();
  const bookingRooms = fakeMeetRooms();
  const booked = await createVerifiedFounderMeeting(
    bookingInput("oasis-room-media-down"),
    { ...deps, meetRooms: bookingRooms },
  );
  await activateVerifiedFounderMeeting(TENANT, booked.appointmentId, { ...deps, meetRooms: bookingRooms });

  const unavailableRooms = fakeMeetRooms(false);
  unavailableRooms.seed("room-1", booked.receipt.meetLink);
  const moved = await rescheduleVerifiedFounderMeeting({
    tenantId: TENANT,
    leadId: LEAD,
    appointmentId: booked.appointmentId,
    requestId: "oasis-room-media-down-move",
    meetingAt: LATER,
  }, { ...deps, meetRooms: unavailableRooms });
  assert.deepEqual(unavailableRooms.calls.rescheduled, [{ id: "room-1", startsAt: LATER }]);
  assert.equal(calls.updatedMeetingLinks.at(-1), booked.receipt.meetLink);
  assert.equal(moved.receipt.meetLink, booked.receipt.meetLink);
  assert.equal((await appointment(raw, booked.appointmentId)).meet_room_id, "room-1");
  await raw.close();
}

async function testOasisMeetRoomFourthReviewFixes() {
  // (a) Media down and the room cannot move (gone or ended): the move is refused before Google, never confirmed
  //     with a dead link.
  const refused = await fixture();
  const bookingRooms = fakeMeetRooms();
  const booked = await createVerifiedFounderMeeting(bookingInput("oasis-room-unmovable"), { ...refused.deps, meetRooms: bookingRooms });
  await activateVerifiedFounderMeeting(TENANT, booked.appointmentId, { ...refused.deps, meetRooms: bookingRooms });
  const before = await appointment(refused.raw, booked.appointmentId);
  const updatesBefore = refused.calls.updatedMeetingLinks.length;
  const downRooms = fakeMeetRooms(false); // knows no room-1: it cannot move it
  const originalConsoleError = console.error;
  console.error = () => undefined;
  try {
    await assert.rejects(
      rescheduleVerifiedFounderMeeting({
        tenantId: TENANT,
        leadId: LEAD,
        appointmentId: booked.appointmentId,
        requestId: "oasis-room-unmovable-move",
        meetingAt: LATER,
      }, { ...refused.deps, meetRooms: downRooms }),
      /meet_room_unavailable/,
    );
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(refused.calls.updatedMeetingLinks.length, updatesBefore, "Google was asked to move a meeting with a dead link");
  const after = await appointment(refused.raw, booked.appointmentId);
  assert.equal(after.scheduled_for, before.scheduled_for);
  assert.equal(after.meet_room_id, "room-1");
  await refused.raw.close();

  // (b) A booking's stored room that has ended is never reused: it is removed and replaced.
  const reuse = await fixture();
  const reuseRooms = fakeMeetRooms();
  const reused = await createVerifiedFounderMeeting(bookingInput("oasis-room-ended-reuse"), { ...reuse.deps, meetRooms: reuseRooms });
  reuseRooms.end("room-1");
  const row = await appointment(reuse.raw, reused.appointmentId);
  const chosen = await meetRoomForBooking(row as never, { ...reuse.deps, meetRooms: reuseRooms } as never, {
    hostUserId: String(row.assigned_to),
    startsAt: String(row.scheduled_for),
    clientName: "Taylor Client",
  });
  assert.equal(chosen.room?.id, "room-2", "an ended room was reused");
  assert.deepEqual(reuseRooms.calls.removed, ["room-1"]);
  assert.equal((await appointment(reuse.raw, reused.appointmentId)).meet_room_id, "room-2");
  await reuse.raw.close();

  // (c) A cancelled meeting whose room delete failed is retried by the reconciler until it goes through.
  const retry = await fixture();
  const retryRooms = fakeMeetRooms();
  const retryDeps = { ...retry.deps, meetRooms: retryRooms };
  const meeting = await createVerifiedFounderMeeting(bookingInput("oasis-room-cleanup-retry"), retryDeps);
  await activateVerifiedFounderMeeting(TENANT, meeting.appointmentId, retryDeps);
  retryRooms.removeErrors.push(new Error("room_delete_failed"));
  console.error = () => undefined;
  try {
    await cancelVerifiedFounderMeeting({
      tenantId: TENANT,
      leadId: LEAD,
      appointmentId: meeting.appointmentId,
      requestId: "oasis-room-cleanup-retry-cancel",
    }, retryDeps);
    assert.equal((await appointment(retry.raw, meeting.appointmentId)).meet_room_id, "room-1");
    retryRooms.removeErrors.push(new Error("room_delete_failed"));
    const stillFailing = await reconcileFounderMeetingSagas({ tenantId: TENANT }, retryDeps);
    assert.ok(stillFailing.errors.includes("meeting_room_cleanup_failed"));
    assert.equal((await appointment(retry.raw, meeting.appointmentId)).meet_room_id, "room-1");
  } finally {
    console.error = originalConsoleError;
  }
  await reconcileFounderMeetingSagas({ tenantId: TENANT }, retryDeps);
  assert.equal((await appointment(retry.raw, meeting.appointmentId)).meet_room_id, null, "the reconciler never retried the room delete");
  assert.deepEqual(retryRooms.calls.removed, ["room-1", "room-1", "room-1"]);
  await retry.raw.close();
}

async function testRecordingNoticeFollowsTheRoom() {
  // Maven's recording notice goes on the invite only when the call's room records (CC, 2026-10-18), on the booking
  // and on every rewrite of the invite: a move, a move while media is down, and the reconciler's move back.
  const recorded = await fixture();
  const rooms = fakeMeetRooms();
  const deps = { ...recorded.deps, meetRooms: rooms };
  const meeting = await createVerifiedFounderMeeting(bookingInput("notice-records"), deps);
  assert.deepEqual(recorded.calls.createdMeetingRecorded, [true], "the booking invite carries the notice");
  await activateVerifiedFounderMeeting(TENANT, meeting.appointmentId, deps);
  await rescheduleVerifiedFounderMeeting({
    tenantId: TENANT, leadId: LEAD, appointmentId: meeting.appointmentId, requestId: "notice-move", meetingAt: LATER,
  }, deps);
  assert.equal(recorded.calls.updatedMeetingRecorded.at(-1), true, "a moved room keeps the notice");
  await activateVerifiedFounderMeeting(TENANT, meeting.appointmentId, deps);
  const down = fakeMeetRooms(false);
  down.seed("room-1");
  await rescheduleVerifiedFounderMeeting({
    tenantId: TENANT, leadId: LEAD, appointmentId: meeting.appointmentId, requestId: "notice-move-down", meetingAt: FUTURE,
  }, { ...recorded.deps, meetRooms: down });
  assert.equal(recorded.calls.updatedMeetingRecorded.at(-1), true, "a move while media is down keeps the notice");
  await recorded.raw.close();

  // A room that does not record never carries it, and neither does a Google Meet booking.
  const quiet = await fixture();
  await createVerifiedFounderMeeting(bookingInput("notice-quiet"), { ...quiet.deps, meetRooms: fakeMeetRooms(true, false) });
  assert.deepEqual(quiet.calls.createdMeetingRecorded, [false]);
  await quiet.raw.close();
  const google = await fixture();
  await createVerifiedFounderMeeting(bookingInput("notice-google"), { ...google.deps, meetRooms: fakeMeetRooms(false) });
  assert.deepEqual(google.calls.createdMeetingRecorded, [undefined], "a Google Meet invite has no room and no notice");
  await google.raw.close();
}

async function testOasisMeetRoomFinalReviewFixes() {
  const originalConsoleError = console.error;
  const booking = { clientName: "Taylor Client" };
  const roomInput = (row: Record<string, unknown>) => ({
    hostUserId: String(row.assigned_to),
    startsAt: String(row.scheduled_for),
    ...booking,
  });

  // (a) A stored reference to a room that is gone, or ended, is cleared before the fall back to Google, even when no
  //     replacement can be made: a later reschedule would read the Google booking as an Oasis one.
  for (const [label, prepare] of [
    ["gone", (_rooms: FakeMeetRooms) => undefined],
    ["ended", (rooms: FakeMeetRooms) => { rooms.seed("room-1"); rooms.end("room-1"); }],
  ] as const) {
    const stale = await fixture();
    const booked = await createVerifiedFounderMeeting(
      bookingInput(`oasis-room-${label}-fallback`),
      { ...stale.deps, meetRooms: fakeMeetRooms() },
    );
    const row = await appointment(stale.raw, booked.appointmentId);
    assert.equal(row.meet_room_id, "room-1");
    const rooms = fakeMeetRooms();
    prepare(rooms);
    rooms.createErrors.push(new Error("room_create_failed"));
    console.error = () => undefined;
    let chosen;
    try {
      chosen = await meetRoomForBooking(row as never, { ...stale.deps, meetRooms: rooms } as never, roomInput(row));
    } finally {
      console.error = originalConsoleError;
    }
    assert.equal(chosen.room, null, `${label}: no room, so Google Meet`);
    assert.equal(chosen.appointment.meet_room_id, null, `${label}: the caller was handed the stale reference`);
    assert.equal((await appointment(stale.raw, booked.appointmentId)).meet_room_id, null, `${label}: the reference survived the fallback`);
    if (label === "ended") assert.deepEqual(rooms.calls.removed, ["room-1"]);

    // A reference that cannot be cleared fails the booking rather than fall back with it.
    const unclearable = fakeMeetRooms();
    await assert.rejects(
      meetRoomForBooking(
        { ...row, meet_room_id: "room-9", revision: Number(row.revision) + 7 } as never,
        { ...stale.deps, meetRooms: unclearable } as never,
        roomInput(row),
      ),
      /meet_room_write_failed/,
    );
    assert.equal(unclearable.calls.created.length, 0, `${label}: a room was made over a stale reference`);
    await stale.raw.close();
  }

  // (b) An earlier attempt that reached Google with no room booked Google Meet; its retry keeps Google Meet, since
  //     the retry finds that event by its fixed id and checks it matches.
  const retried = await fixture();
  const googleBooked = await createVerifiedFounderMeeting(bookingInput("oasis-room-google-retry"), retried.deps);
  const googleRow = await appointment(retried.raw, googleBooked.appointmentId);
  assert.ok(googleRow.google_event_id);
  assert.equal(googleRow.meet_room_id, null);
  const retryRooms = fakeMeetRooms();
  const kept = await meetRoomForBooking(
    googleRow as never,
    { ...retried.deps, meetRooms: retryRooms } as never,
    roomInput(googleRow),
  );
  assert.equal(kept.room, null, "a retry of a Google booking was given a room");
  assert.equal(retryRooms.calls.created.length, 0);
  await retried.raw.close();

  // (c) The Schedule copy's link follows the appointment on every meeting change, not only when that change made a
  //     room: a copy left on an old link (by a retry or a compensation) is repaired by the next change.
  const mirror = await fixture();
  const mirrorRooms = fakeMeetRooms();
  const mirrorDeps = { ...mirror.deps, meetRooms: mirrorRooms };
  const mirrored = await createVerifiedFounderMeeting(bookingInput("oasis-room-mirror-repair"), mirrorDeps);
  await activateVerifiedFounderMeeting(TENANT, mirrored.appointmentId, mirrorDeps);
  await mirror.raw.execute({
    sql: "INSERT INTO calendar_events (id, tenant_id, appointment_id, description, location) VALUES (?, ?, ?, ?, ?)",
    args: [
      "stale-link-mirror",
      TENANT,
      mirrored.appointmentId,
      "Lead lead-a\nhttps://oasisai.work/meet/zzz-zzzz-zzz",
      "https://oasisai.work/meet/zzz-zzzz-zzz",
    ],
  });
  await rescheduleVerifiedFounderMeeting({
    tenantId: TENANT,
    leadId: LEAD,
    appointmentId: mirrored.appointmentId,
    requestId: "oasis-room-mirror-repair-move",
    meetingAt: LATER,
  }, mirrorDeps);
  assert.equal(mirrorRooms.calls.created.length, 1, "the room moved; no new one");
  const repaired = await mirror.raw.execute({
    sql: "SELECT description, location FROM calendar_events WHERE id = ?",
    args: ["stale-link-mirror"],
  });
  assert.deepEqual({ ...repaired.rows[0] }, {
    description: "Lead lead-a\nhttps://oasisai.work/meet/aaa-bbbb-ccc",
    location: "https://oasisai.work/meet/aaa-bbbb-ccc",
  }, "the Schedule copy kept a dead link");
  await mirror.raw.close();

  // (d) The booking carries the cleared row on. A retry whose stored room is gone, whose new room cannot be made and
  //     whose Google call fails ends with no reference: its failure write must not put the stale one back.
  const carried = await fixture();
  const failingGoogle = async () => {
    throw new Error("calendar_create_failed");
  };
  const firstRooms = fakeMeetRooms();
  firstRooms.removeErrors.push(new Error("room_delete_failed"));
  const carriedRoomId = async () =>
    (await carried.raw.execute({
      sql: "SELECT meet_room_id FROM call_appointments WHERE booking_request_id = ?",
      args: ["oasis-room-carried"],
    })).rows[0].meet_room_id;
  console.error = () => undefined;
  try {
    await assert.rejects(
      createVerifiedFounderMeeting(bookingInput("oasis-room-carried"), {
        ...carried.deps, meetRooms: firstRooms, createCalendar: failingGoogle,
      }),
      /calendar_create_failed/,
    );
    assert.equal(await carriedRoomId(), "room-1", "the first attempt's failed delete keeps its reference");
    await carried.raw.execute({
      sql: "UPDATE call_appointments SET pending_started_at = ? WHERE booking_request_id = ?",
      args: ["2026-09-01T13:00:00.000Z", "oasis-room-carried"],
    });
    const secondRooms = fakeMeetRooms();
    secondRooms.createErrors.push(new Error("room_create_failed"));
    await assert.rejects(
      createVerifiedFounderMeeting(bookingInput("oasis-room-carried"), {
        ...carried.deps, meetRooms: secondRooms, createCalendar: failingGoogle,
      }),
      /calendar_create_failed/,
    );
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(await carriedRoomId(), null, "the failure wrote the stale room reference back");
  await carried.raw.close();
}

async function testGoogleOnlyRoomWritesAreOmitted() {
  const first = await fixture();
  const guardedUpdates: Record<string, unknown>[] = [];
  const guardedDb = instrumentDb(first.db, {
    onUpdate: (table, values) => {
      if (table !== "call_appointments") return;
      guardedUpdates.push(values);
      if (Object.hasOwn(values, "meet_room_id")) throw new Error("meet_room_id_column_was_named");
    },
  });
  const guardedDeps = { ...first.deps, db: guardedDb as never };
  await insertVerifiedAppointment(first.raw, { id: "google-only-cancel" });
  const cancelled = await cancelVerifiedFounderMeeting({
    tenantId: TENANT,
    leadId: LEAD,
    appointmentId: "google-only-cancel",
    requestId: "google-only-cancel-request",
  }, guardedDeps);
  assert.equal(cancelled.disposition, "cancelled");

  await insertVerifiedAppointment(first.raw, {
    id: "google-only-compensation",
    pendingRequestId: "google-only-book",
    pendingOperation: "book",
    pendingMeetingAt: FUTURE,
    pendingStartedAt: "2026-09-01T13:59:00.000Z",
    pendingLeaseToken: "google-only-worker",
    workflowStatus: "pending_transition",
  });
  await compensatePendingFounderMeetingBooking({
    tenantId: TENANT,
    leadId: LEAD,
    appointmentId: "google-only-compensation",
    requestId: "google-only-book",
  }, guardedDeps);
  assert(guardedUpdates.length > 0);
  assert(guardedUpdates.every((patch) => !Object.hasOwn(patch, "meet_room_id")));
  await first.raw.close();
}

async function testCreatePreservesCustomDuration() {
  const { raw, deps, calls } = await fixture();
  const meeting = await createVerifiedFounderMeeting({
    ...bookingInput("book-request-45"),
    durationMinutes: 45,
    offerLabel: "COMMAND discovery call",
  }, deps);
  const row = await appointment(raw, meeting.appointmentId);
  assert.equal(Number(row.duration_minutes), 45);
  assert.equal(meeting.durationMinutes, 45);
  assert.equal(meeting.offerLabel, "COMMAND discovery call");
  assert.equal(row.offer_label, "COMMAND discovery call");
  assert.deepEqual(calls.createdDurations, [45]);
  assert.deepEqual(calls.createdOfferLabels, ["COMMAND discovery call"]);
  await raw.close();
}

async function testReceiptWriteCompensationInvalidatesTheRequestId() {
  const { raw, deps, calls } = await fixture();
  await raw.execute(`CREATE TRIGGER reject_verified_receipt_once
    BEFORE UPDATE ON call_appointments
    WHEN OLD.booking_request_id = 'book-receipt-failure'
      AND OLD.calendar_status = 'creating'
      AND NEW.calendar_status = 'verified'
    BEGIN SELECT RAISE(ABORT, 'receipt-write-failure'); END`);
  const input = bookingInput("book-receipt-failure");
  await assert.rejects(
    createVerifiedFounderMeeting(input, deps),
    /booking_compensated:meeting_receipt_write_failed/,
  );
  assert.deepEqual(calls.cancelled, ["event12345"], "the provider invite is rolled back");
  const cancelled = await raw.execute({
    sql: "SELECT status, workflow_status, calendar_status FROM call_appointments WHERE booking_request_id = ?",
    args: ["book-receipt-failure"],
  });
  assert.deepEqual(
    { ...cancelled.rows[0] },
    { status: "cancelled", workflow_status: "cancelled", calendar_status: "cancelled" },
  );
  await assert.rejects(
    createVerifiedFounderMeeting(input, deps),
    /booking_request_cancelled/,
    "a lost retry_required response remains classifiable on the next request",
  );
  await raw.close();
}

async function testPendingBookingCompensationCancelsProviderAndMirror() {
  const { raw, deps, calls } = await fixture();
  const meetRooms = fakeMeetRooms();
  meetRooms.seed("room-pending-compensation");
  await insertVerifiedAppointment(raw, {
    id: "meeting-pending-compensation",
    meetRoomId: "room-pending-compensation",
    googleMeetLink: "https://oasisai.work/meet/aaa-bbbb-ccc",
    pendingRequestId: "book-pending-compensation",
    pendingOperation: "book",
    pendingMeetingAt: FUTURE,
    pendingStartedAt: "2026-09-01T13:59:00.000Z",
    pendingLeaseToken: "pending-worker",
    workflowStatus: "pending_transition",
  });
  await raw.execute({
    sql: "INSERT INTO calendar_events (id, tenant_id, appointment_id) VALUES (?, ?, ?)",
    args: ["mirror-pending", TENANT, "meeting-pending-compensation"],
  });
  await compensatePendingFounderMeetingBooking({
    tenantId: TENANT,
    leadId: LEAD,
    appointmentId: "meeting-pending-compensation",
    requestId: "book-pending-compensation",
  }, { ...deps, meetRooms });
  assert(calls.cancelled.includes("event-meeting-pending-compensation"));
  assert.deepEqual(meetRooms.calls.removed, ["room-pending-compensation"]);
  assert.equal((await appointment(raw, "meeting-pending-compensation")).workflow_status, "cancelled");
  assert.equal((await appointment(raw, "meeting-pending-compensation")).meet_room_id, null);
  const mirrors = await raw.execute({
    sql: "SELECT COUNT(*) AS n FROM calendar_events WHERE appointment_id = ?",
    args: ["meeting-pending-compensation"],
  });
  assert.equal(Number(mirrors.rows[0].n), 0);
  await raw.close();
}

async function testCompensationStaysDurableWhenMirrorCleanupFails() {
  const { raw, deps } = await fixture();
  const input = bookingInput("book-cleanup-failure");
  const meeting = await createVerifiedFounderMeeting(input, deps);
  await raw.execute({
    sql: "INSERT INTO calendar_events (id, tenant_id, appointment_id) VALUES (?, ?, ?)",
    args: ["mirror-cleanup-failure", TENANT, meeting.appointmentId],
  });
  await raw.execute(`CREATE TRIGGER reject_compensated_mirror_delete
    BEFORE DELETE ON calendar_events
    WHEN OLD.appointment_id = '${meeting.appointmentId}'
    BEGIN SELECT RAISE(ABORT, 'mirror-cleanup-failure'); END`);
  const logs: unknown[][] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => { logs.push(args); };
  try {
    await compensatePendingFounderMeetingBooking({
      tenantId: TENANT,
      leadId: LEAD,
      appointmentId: meeting.appointmentId,
      requestId: input.requestId,
    }, deps);
  } finally {
    console.error = originalConsoleError;
  }
  const row = await appointment(raw, meeting.appointmentId);
  assert.equal(row.status, "cancelled");
  assert.equal(row.workflow_status, "cancelled");
  assert.equal(row.calendar_status, "cancelled");
  assert.match(JSON.stringify(logs), /mirror cleanup failed/);
  await assert.rejects(
    createVerifiedFounderMeeting(input, deps),
    /booking_request_cancelled/,
    "best-effort cleanup cannot resurrect a provider-cancelled receipt",
  );
  await raw.close();
}

async function testBackfillHydratesLatePhoneAndRepairsTiers() {
  const { raw, deps } = await fixture();
  await insertVerifiedAppointment(raw, { id: "meeting-backfill", workflowStatus: "active" });
  await raw.execute({
    sql: `UPDATE call_appointments
          SET client_phone_snapshot = NULL, sms_consent = 1
          WHERE tenant_id = ? AND id = ?`,
    args: [TENANT, "meeting-backfill"],
  });
  await setLead(raw, { phone: "+14165550101" });

  const result = await backfillFounderMeetingNotifications({
    tenantId: TENANT,
    now: new Date(NOW),
    horizonMs: 48 * 60 * 60_000,
    limit: 25,
  }, deps);
  assert.equal(result.considered, 1);
  assert.equal(result.repaired, 1);
  assert.equal(result.failed, 0);

  const repaired = await appointment(raw, "meeting-backfill");
  assert.equal(repaired.client_phone_snapshot, "+14165550101", "late phone data is copied into the immutable send snapshot");
  const reminders = await raw.execute({
    sql: `SELECT channel, reminder_minutes_before
          FROM website_sales_meeting_notifications
          WHERE appointment_id = ? AND reminder_minutes_before IS NOT NULL`,
    args: ["meeting-backfill"],
  });
  assert.equal(reminders.rows.length, 6);
  assert.equal(reminders.rows.filter((row) => row.channel === "sms").length, 3);
  await raw.close();
}

async function testBackfillLimitScansPastAlreadyCompleteAppointments() {
  const { raw, deps } = await fixture();
  await insertVerifiedAppointment(raw, {
    id: "meeting-backfill-complete-first",
    scheduledFor: "2026-09-01T15:30:00.000Z",
    workflowStatus: "active",
  });
  await insertVerifiedAppointment(raw, {
    id: "meeting-backfill-missing-second",
    scheduledFor: "2026-09-01T16:00:00.000Z",
    workflowStatus: "active",
  });

  await backfillFounderMeetingNotifications({
    tenantId: TENANT,
    now: new Date(NOW),
    horizonMs: 48 * 60 * 60_000,
    limit: 1,
  }, deps);
  const initiallyMissing = await raw.execute({
    sql: `SELECT count(*) AS count
          FROM website_sales_meeting_notifications
          WHERE appointment_id = ? AND reminder_minutes_before IS NOT NULL`,
    args: ["meeting-backfill-missing-second"],
  });
  assert.equal(Number(initiallyMissing.rows[0].count), 0, "the first bounded pass repairs only the earliest meeting");

  const secondPass = await backfillFounderMeetingNotifications({
    tenantId: TENANT,
    now: new Date(NOW),
    horizonMs: 48 * 60 * 60_000,
    limit: 1,
  }, deps);
  assert.equal(secondPass.repaired, 1);
  assert.equal(secondPass.considered, 2, "the scan moves past the complete first appointment");
  const repairedLater = await raw.execute({
    sql: `SELECT count(*) AS count
          FROM website_sales_meeting_notifications
          WHERE appointment_id = ? AND reminder_minutes_before IS NOT NULL`,
    args: ["meeting-backfill-missing-second"],
  });
  assert.equal(Number(repairedLater.rows[0].count), 6, "the later missing appointment is not starved by the limit");
  await raw.close();
}

async function testBackfillLimitIsGlobalAcrossTenants() {
  const { raw, deps } = await fixture();
  await raw.batch([
    { sql: "INSERT INTO tenants (id) VALUES (?)", args: [TENANT] },
    { sql: "INSERT INTO tenants (id) VALUES (?)", args: ["tenant-b"] },
  ]);
  await insertVerifiedAppointment(raw, {
    id: "meeting-global-limit-a",
    tenantId: TENANT,
    leadId: LEAD,
    workflowStatus: "active",
  });
  await insertVerifiedAppointment(raw, {
    id: "meeting-global-limit-b",
    tenantId: "tenant-b",
    leadId: "lead-b",
    workflowStatus: "active",
  });
  await backfillFounderMeetingNotifications({
    tenantId: TENANT,
    now: new Date(NOW),
    horizonMs: 48 * 60 * 60_000,
    limit: 1,
  }, deps);

  const result = await backfillFounderMeetingNotifications({
    now: new Date(NOW),
    horizonMs: 48 * 60 * 60_000,
    limit: 1,
  }, deps);
  assert.equal(result.considered, 1, "the candidate budget applies to the whole multi-tenant run");
  assert.equal(result.repaired, 0, "a complete first-tenant candidate still consumes the global budget");
  const laterTenantRows = await raw.execute({
    sql: `SELECT count(*) AS count
          FROM website_sales_meeting_notifications
          WHERE appointment_id = ?`,
    args: ["meeting-global-limit-b"],
  });
  assert.equal(Number(laterTenantRows.rows[0].count), 0, "later tenants cannot receive a fresh copy of the limit");
  await raw.close();
}

async function testBackfillBatchSkipsCompleteAppointments() {
  const { raw, deps } = await fixture();
  await insertVerifiedAppointment(raw, {
    id: "meeting-batch-complete-a",
    scheduledFor: "2026-09-01T15:30:00.000Z",
    workflowStatus: "active",
  });
  await insertVerifiedAppointment(raw, {
    id: "meeting-batch-complete-b",
    scheduledFor: "2026-09-01T16:00:00.000Z",
    workflowStatus: "active",
  });
  await backfillFounderMeetingNotifications({
    tenantId: TENANT,
    now: new Date(NOW),
    limit: 2,
  }, deps);

  let notificationReads = 0;
  let perAppointmentContextReads = 0;
  const instrumentedDb = instrumentDb(deps.db, {
    onSelect(table, columns) {
      if (table === "website_sales_meeting_notifications") notificationReads += 1;
      if (table === "call_appointments" && columns.includes("sms_consent")) {
        perAppointmentContextReads += 1;
      }
    },
  });
  const result = await backfillFounderMeetingNotifications({
    tenantId: TENANT,
    now: new Date(NOW),
    limit: 1,
  }, { ...deps, db: instrumentedDb as never });
  assert.equal(result.repaired, 0);
  assert.equal(result.considered, 2);
  assert.equal(notificationReads, 1, "one page-level outbox read replaces per-appointment dedupe reads");
  assert.equal(perAppointmentContextReads, 0, "complete appointments never enter ensureNotificationRows");
  await raw.close();
}

async function testIdempotentConsentReplayCannotRecreateRowsDuringTransition() {
  const { raw, deps } = await fixture();
  await insertVerifiedAppointment(raw, {
    id: "meeting-consent-race",
    scheduledFor: "2026-09-01T16:00:00.000Z",
    workflowStatus: "active",
  });
  let guardedAppointmentUpdates = 0;
  let transitionInjected = false;
  const instrumentedDb = instrumentDb(deps.db, {
    onUpdate(table) {
      if (table === "call_appointments") guardedAppointmentUpdates += 1;
    },
    beforeMaybeSingle(table, columns) {
      if (
        transitionInjected ||
        table !== "call_appointments" ||
        !columns?.includes("sms_consent") ||
        columns === "*"
      ) return null;
      transitionInjected = true;
      return raw.execute({
        sql: `UPDATE call_appointments
              SET workflow_status = 'pending_transition',
                  pending_request_id = 'consent-race',
                  pending_operation = 'cancel',
                  pending_started_at = ?
              WHERE tenant_id = ? AND id = ?`,
        args: ["2026-09-01T14:01:00.000Z", TENANT, "meeting-consent-race"],
      });
    },
  });

  await assert.rejects(
    grantFounderMeetingSmsConsent({
      tenantId: TENANT,
      leadId: LEAD,
      appointmentId: "meeting-consent-race",
      consentedPhone: "+14165550101",
      capturedAt: new Date(NOW),
    }, { ...deps, db: instrumentedDb as never }),
    /meeting_notification_context_failed/,
  );
  assert.equal(guardedAppointmentUpdates, 2, "an already-consented replay acquires and releases the guarded lease");
  const notifications = await raw.execute({
    sql: "SELECT count(*) AS count FROM website_sales_meeting_notifications WHERE appointment_id = ?",
    args: ["meeting-consent-race"],
  });
  assert.equal(Number(notifications.rows[0].count), 0, "the pending transition prevents reminder recreation");
  const failedAppointment = await appointment(raw, "meeting-consent-race");
  assert.equal(failedAppointment.notification_lease_token, null, "a failed consent replay releases its notification lease");
  assert.equal(failedAppointment.notification_lease_expires_at, null);
  await raw.close();
}

async function testConsentLeaseSerializesCancellationAfterContextRead() {
  const { raw, deps } = await fixture();
  await insertVerifiedAppointment(raw, {
    id: "meeting-consent-lease",
    scheduledFor: "2026-09-01T16:00:00.000Z",
    workflowStatus: "active",
  });
  let cancellationAttempted = false;
  let cancellationError = "";
  const instrumentedDb = instrumentDb(deps.db, {
    beforeExecute(table, columns) {
      if (
        cancellationAttempted ||
        table !== "website_sales_meeting_notifications" ||
        columns !== "dedupe_key"
      ) return null;
      cancellationAttempted = true;
      return prepareVerifiedFounderMeetingCancellation({
        tenantId: TENANT,
        leadId: LEAD,
        appointmentId: "meeting-consent-lease",
        requestId: "cancel-during-consent",
      }, deps).then(
        () => undefined,
        (error: unknown) => {
          cancellationError = error instanceof Error ? error.message : String(error);
        },
      );
    },
  });

  await grantFounderMeetingSmsConsent({
    tenantId: TENANT,
    leadId: LEAD,
    appointmentId: "meeting-consent-lease",
    consentedPhone: "+14165550101",
    capturedAt: new Date(NOW),
  }, { ...deps, db: instrumentedDb as never });
  assert(cancellationAttempted, "the cancellation was interleaved after context validation");
  assert.match(cancellationError, /meeting_notification_in_progress/);

  const succeeded = await appointment(raw, "meeting-consent-lease");
  assert.equal(succeeded.workflow_status, "active");
  assert.equal(succeeded.pending_request_id, null, "cancellation never acquired the transition reservation");
  assert.equal(succeeded.notification_lease_token, null, "successful consent releases its notification lease");
  assert.equal(succeeded.notification_lease_expires_at, null);
  const notifications = await raw.execute({
    sql: "SELECT count(*) AS count FROM website_sales_meeting_notifications WHERE appointment_id = ?",
    args: ["meeting-consent-lease"],
  });
  assert(Number(notifications.rows[0].count) > 0);
  await raw.close();
}

async function testConsentTimestampRejectsFutureAndOverYearOldEvidence() {
  const { raw, deps } = await fixture();
  await insertVerifiedAppointment(raw, {
    id: "meeting-invalid-consent-time",
    workflowStatus: "active",
  });
  const consent = (capturedAt: Date) => grantFounderMeetingSmsConsent({
    tenantId: TENANT,
    leadId: LEAD,
    appointmentId: "meeting-invalid-consent-time",
    consentedPhone: "+14165550101",
    capturedAt,
  }, deps);

  await assert.rejects(consent(new Date(NOW + 1)), /invalid_sms_consent_timestamp/);
  await assert.rejects(
    consent(new Date(NOW - 365 * 24 * 60 * 60_000 - 1)),
    /invalid_sms_consent_timestamp/,
  );
  await raw.close();
}

function testConsentReplayErrorResponseClassification() {
  const invalid = founderMeetingSmsConsentErrorResponse(new Error("invalid_sms_consent_artifact"));
  assert.deepEqual(invalid, {
    status: 400,
    body: {
      ok: false,
      error: "invalid_sms_consent_artifact",
      detail: "invalid_sms_consent_artifact",
    },
  });
  assert.equal("stageUpdated" in invalid.body, false, "idempotent replay errors must not claim a stage mutation");

  for (const detail of [
    "client_phone_required",
    "invalid_sms_consent_timestamp",
    "verified_meeting_required",
    "meeting_notification_in_progress",
    "meeting_sms_consent_phone_mismatch",
    "meeting_sms_consent_update_failed:row_changed",
    "meeting_notification_context_failed:row_changed",
  ]) {
    assert.equal(
      founderMeetingSmsConsentErrorResponse(new Error(detail)).status,
      409,
      `${detail} is a state conflict`,
    );
  }
  assert.equal(
    founderMeetingSmsConsentErrorResponse(new Error("meeting_lookup_failed:database unavailable")).status,
    503,
    "database failures remain retryable infrastructure errors",
  );
}

async function testConsentPreservesOperationErrorWhenLeaseReleaseAlsoFails() {
  const { raw, deps } = await fixture();
  await insertVerifiedAppointment(raw, {
    id: "meeting-operation-and-release-fail",
    workflowStatus: "active",
  });
  await raw.execute({
    sql: "UPDATE call_appointments SET assigned_to = NULL WHERE id = ?",
    args: ["meeting-operation-and-release-fail"],
  });
  await raw.execute(`CREATE TRIGGER reject_consent_release_after_operation_error
    BEFORE UPDATE ON call_appointments
    WHEN OLD.id = 'meeting-operation-and-release-fail'
      AND OLD.notification_lease_token IS NOT NULL
      AND NEW.notification_lease_token IS NULL
    BEGIN SELECT RAISE(ABORT, 'release-secret-value'); END`);

  const logs: unknown[][] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => { logs.push(args); };
  try {
    await assert.rejects(
      grantFounderMeetingSmsConsent({
        tenantId: TENANT,
        leadId: LEAD,
        appointmentId: "meeting-operation-and-release-fail",
        consentedPhone: "+14165550101",
        capturedAt: new Date(NOW),
      }, deps),
      /meeting_host_missing/,
      "the original operation failure must win over cleanup failure",
    );
  } finally {
    console.error = originalConsoleError;
  }
  const logged = JSON.stringify(logs);
  assert.match(logged, /lease release failed/);
  assert.doesNotMatch(logged, /release-secret-value/, "cleanup diagnostics must not log provider/database detail");
  await raw.close();
}

async function testConsentSuccessfulOperationStillSurfacesLeaseReleaseFailure() {
  const { raw, deps } = await fixture();
  await insertVerifiedAppointment(raw, {
    id: "meeting-release-only-fail",
    workflowStatus: "active",
  });
  await raw.execute(`CREATE TRIGGER reject_consent_release_after_success
    BEFORE UPDATE ON call_appointments
    WHEN OLD.id = 'meeting-release-only-fail'
      AND OLD.notification_lease_token IS NOT NULL
      AND NEW.notification_lease_token IS NULL
    BEGIN SELECT RAISE(ABORT, 'release-secret-value'); END`);

  await assert.rejects(
    grantFounderMeetingSmsConsent({
      tenantId: TENANT,
      leadId: LEAD,
      appointmentId: "meeting-release-only-fail",
      consentedPhone: "+14165550101",
      capturedAt: new Date(NOW),
    }, deps),
    (error: unknown) => error instanceof Error && error.message === "meeting_notification_lease_release_failed",
    "a successful operation is not reported as successful when cleanup failed",
  );
  await raw.close();
}

function testBackfillChunkRotatesBeyondFirstFiveHundred() {
  assert.equal(founderMeetingBackfillChunkStart(500, NOW), 0);
  const successiveStarts = [
    founderMeetingBackfillChunkStart(501, NOW),
    founderMeetingBackfillChunkStart(501, NOW + 5 * 60_000),
  ].sort((a, b) => a - b);
  assert.deepEqual(
    successiveStarts,
    [0, 500],
    "successive five-minute runs rotate into the bounded chunk containing candidate 501",
  );
}

async function testOrganizerMismatchCompensates() {
  const { raw, deps, calls } = await fixture();
  await assert.rejects(
    createVerifiedFounderMeeting(bookingInput("organizer-mismatch"), {
      ...deps,
      createCalendar: async () => ({
        calendarId: "primary",
        eventId: "wrongorg1",
        htmlLink: "https://calendar.google.com/calendar/event?eid=wrong",
        meetLink: "https://meet.google.com/wrong-org-id",
        iCalUID: "wrong-ical",
        organizerEmail: "personal@gmail.com",
      }),
    }),
    /calendar_organizer_mismatch/,
  );
  assert.deepEqual(calls.cancelled, ["wrongorg1"], "a wrong-sender invite is immediately cancelled");
  await raw.close();
}

async function testNoShowUsesCanonicalStatusAndTimeGuard() {
  const { raw, deps } = await fixture();
  await insertVerifiedAppointment(raw, { id: "meeting-no-show", scheduledFor: FUTURE });
  await assert.rejects(
    closeVerifiedFounderMeeting({
      tenantId: TENANT, leadId: LEAD, appointmentId: "meeting-no-show", outcome: "no_show",
    }, deps),
    /meeting_not_started/,
  );
  await raw.execute({
    sql: "UPDATE call_appointments SET scheduled_for = ? WHERE id = ?",
    args: ["2026-09-01T13:45:00.000Z", "meeting-no-show"],
  });
  await closeVerifiedFounderMeeting({
    tenantId: TENANT, leadId: LEAD, appointmentId: "meeting-no-show", outcome: "no_show",
  }, deps);
  const row = await appointment(raw, "meeting-no-show");
  assert.equal(row.status, "no_answer", "the canonical appointment CHECK never receives no_show");
  assert.equal(row.workflow_status, "no_show");
  await raw.close();
}

async function testExclusiveReservationAndNoShowRebook() {
  const { raw, deps, calls } = await fixture();
  await insertVerifiedAppointment(raw, {
    id: "meeting-race",
    scheduledFor: "2026-09-01T13:45:00.000Z",
    status: "no_answer",
    workflowStatus: "no_show",
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const slowDeps = {
    ...deps,
    updateCalendar: async (input: { meetingAt: string }) => {
      calls.updated.push(input.meetingAt);
      await gate;
      return deps.updateCalendar(input);
    },
  };
  const first = rescheduleVerifiedFounderMeeting({
    tenantId: TENANT, leadId: LEAD, appointmentId: "meeting-race", requestId: "reschedule-a", meetingAt: FUTURE,
  }, slowDeps);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = rescheduleVerifiedFounderMeeting({
    tenantId: TENANT, leadId: LEAD, appointmentId: "meeting-race", requestId: "reschedule-b", meetingAt: LATER,
  }, slowDeps);
  await assert.rejects(second, /meeting_transition_pending|meeting_reschedule_conflict/);
  release();
  const result = await first;
  assert.equal(result.meetingAt, FUTURE);
  assert.equal(calls.updated.filter((time) => time === FUTURE).length, 2);
  assert.equal(calls.updated.includes(LATER), false, "the losing reservation never reaches Google");
  const row = await appointment(raw, "meeting-race");
  assert.equal(row.status, "scheduled");
  assert.equal(row.workflow_status, "pending_transition");
  assert.equal(row.pending_request_id, "reschedule-a");
  await raw.close();
}

// Codex review of PR #611: bravo__223's overlap triggers refuse the final write of
// a reschedule into an occupied founder interval, but a reschedule reaches that
// write only AFTER Google has moved the event, leaving the client's invite on a
// time the database never accepted. The check now runs first.
async function testRescheduleIntoAnOccupiedFounderSlotIsRefusedBeforeGoogle() {
  const OASIS = "ef8d389e-3f15-43f2-ae00-3660f69a1452";
  const { raw, deps, calls } = await fixture();
  // Mine: 16:00Z for 15 minutes. Another founder call: 17:00Z for 15 minutes.
  await insertVerifiedAppointment(raw, { id: "mine", tenantId: OASIS, leadId: LEAD, scheduledFor: FUTURE });
  await insertVerifiedAppointment(raw, { id: "theirs", tenantId: OASIS, leadId: "lead-b", scheduledFor: LATER });

  // Straight onto the other call: refused, nothing reserved, Google never touched.
  await assert.rejects(
    rescheduleVerifiedFounderMeeting({
      tenantId: OASIS, leadId: LEAD, appointmentId: "mine", requestId: "overlap-1", meetingAt: LATER,
    }, deps),
    /founder_slot_overlap/,
  );
  assert.deepEqual(calls.updated, [], "an occupied target never reaches Google");
  const row = await appointment(raw, "mine");
  assert.equal(row.workflow_status, "active", "nothing was reserved");
  assert.equal(row.pending_request_id, null);
  assert.equal(row.scheduled_for, FUTURE);

  // A partial overlap (starts 10 minutes into the other call) is refused too.
  await assert.rejects(
    rescheduleVerifiedFounderMeeting({
      tenantId: OASIS, leadId: LEAD, appointmentId: "mine", requestId: "overlap-2", meetingAt: "2026-09-01T17:10:00.000Z",
    }, deps),
    /founder_slot_overlap/,
  );
  // Back-to-back is not an overlap: 17:15 starts as the other call ends.
  const adjacent = await rescheduleVerifiedFounderMeeting({
    tenantId: OASIS, leadId: LEAD, appointmentId: "mine", requestId: "adjacent", meetingAt: "2026-09-01T17:15:00.000Z",
  }, deps);
  assert.equal(adjacent.meetingAt, "2026-09-01T17:15:00.000Z");
  assert.deepEqual(calls.updated, ["2026-09-01T17:15:00.000Z"], "only the free target reached Google");
  await raw.close();

  // The same two times in another workspace are allowed: only OASIS shares one
  // founder calendar, and the trigger has the same scope.
  const other = await fixture();
  await insertVerifiedAppointment(other.raw, { id: "mine", tenantId: TENANT, leadId: LEAD, scheduledFor: FUTURE });
  await insertVerifiedAppointment(other.raw, { id: "theirs", tenantId: TENANT, leadId: "lead-b", scheduledFor: LATER });
  const moved = await rescheduleVerifiedFounderMeeting({
    tenantId: TENANT, leadId: LEAD, appointmentId: "mine", requestId: "other-ws", meetingAt: LATER,
  }, other.deps);
  assert.equal(moved.meetingAt, LATER);
  await other.raw.close();
}

// Codex review of PR #611: the founders' Schedule copies of a public booking were
// written once and never touched again, so a reschedule left the old time on both
// calendars and a cancelled call kept showing.
async function testScheduleMirrorsFollowRescheduleAndCancellation() {
  const { raw, deps } = await fixture();
  await insertVerifiedAppointment(raw, { id: "mirrored", leadId: LEAD, scheduledFor: FUTURE });
  await insertVerifiedAppointment(raw, { id: "bystander", leadId: "lead-b", scheduledFor: "2026-09-02T16:00:00.000Z" });
  const mirror = async (id: string, appointmentId: string) =>
    raw.execute({
      sql: "INSERT INTO calendar_events (id, tenant_id, appointment_id, start_at, end_at) VALUES (?, ?, ?, ?, ?)",
      args: [id, TENANT, appointmentId, FUTURE, "2026-09-01T16:15:00.000Z"],
    });
  await mirror("cc-copy", "mirrored");
  await mirror("adon-copy", "mirrored");
  await mirror("other-copy", "bystander");
  const copies = async (appointmentId: string) =>
    (await raw.execute({
      sql: "SELECT id, start_at, end_at FROM calendar_events WHERE appointment_id = ? ORDER BY id",
      args: [appointmentId],
    })).rows;

  // Reschedule: both founders' copies move to the new time, the bystander's does not.
  await rescheduleVerifiedFounderMeeting({
    tenantId: TENANT, leadId: LEAD, appointmentId: "mirrored", requestId: "move-1", meetingAt: LATER,
  }, deps);
  const moved = await copies("mirrored");
  assert.equal(moved.length, 2);
  for (const row of moved) {
    assert.equal(row.start_at, LATER, "the copy follows the reschedule");
    assert.equal(row.end_at, "2026-09-01T17:15:00.000Z", "and keeps the call's 15-minute length");
  }
  const untouched = await copies("bystander");
  assert.equal(untouched[0].start_at, FUTURE, "another appointment's copy is not touched");

  // Cancellation: both copies leave Schedule; the bystander's stays. (The route
  // activates a rescheduled call once its lifecycle update lands, then it can be cancelled.)
  await activateVerifiedFounderMeeting(TENANT, "mirrored", deps);
  await cancelVerifiedFounderMeeting({
    tenantId: TENANT, leadId: LEAD, appointmentId: "mirrored", requestId: "cancel-1",
  }, deps);
  assert.equal((await copies("mirrored")).length, 0, "a cancelled call no longer shows on Schedule");
  assert.equal((await copies("bystander")).length, 1);
  await raw.close();
}

async function testBoundedSameRequestTakeoverAndActivationGuard() {
  const { raw, deps } = await fixture();
  await insertVerifiedAppointment(raw, {
    id: "meeting-takeover",
    pendingRequestId: "reschedule-retry",
    pendingOperation: "reschedule",
    pendingMeetingAt: LATER,
    pendingStartedAt: "2026-09-01T13:50:00.000Z",
    pendingLeaseToken: "dead-worker",
    previousScheduledFor: FUTURE,
    workflowStatus: "pending_transition",
  });
  const result = await rescheduleVerifiedFounderMeeting({
    tenantId: TENANT, leadId: LEAD, appointmentId: "meeting-takeover",
    requestId: "reschedule-retry", meetingAt: LATER,
  }, deps);
  assert.equal(result.meetingAt, LATER);
  await activateVerifiedFounderMeeting(TENANT, "meeting-takeover", deps);
  assert.equal((await appointment(raw, "meeting-takeover")).workflow_status, "active");

  await insertVerifiedAppointment(raw, {
    id: "meeting-terminal", status: "completed", workflowStatus: "completed",
  });
  await assert.rejects(
    activateVerifiedFounderMeeting(TENANT, "meeting-terminal", deps),
    /meeting_activation_failed/,
  );
  await raw.close();
}

async function testCancellationPreservesHistory() {
  const { raw, deps, calls } = await fixture();
  await insertVerifiedAppointment(raw, {
    id: "meeting-history", scheduledFor: "2026-09-01T13:00:00.000Z",
    status: "completed", workflowStatus: "completed",
  });
  const result = await cancelVerifiedFounderMeeting({
    tenantId: TENANT, leadId: LEAD, appointmentId: "meeting-history", requestId: "cancel-history",
  }, deps);
  assert.equal(result.disposition, "preserved");
  assert.equal(calls.cancelled.length, 0);
  assert.equal((await appointment(raw, "meeting-history")).calendar_status, "verified");
  await raw.close();
}

async function testCancellationReservationPrecedesProviderMutation() {
  const { raw, deps, calls } = await fixture();
  await insertVerifiedAppointment(raw, { id: "meeting-cancel-safe" });
  const prepared = await prepareVerifiedFounderMeetingCancellation({
    tenantId: TENANT,
    leadId: LEAD,
    appointmentId: "meeting-cancel-safe",
    requestId: "cancel-safe",
  }, deps);
  assert.equal(prepared.disposition, "pending");
  assert.equal(calls.cancelled.length, 0, "reservation cannot delete the invite before the lead transaction");
  const reserved = await appointment(raw, "meeting-cancel-safe");
  assert.equal(reserved.workflow_status, "pending_transition");
  assert.equal(reserved.pending_operation, "cancel");
  assert.equal(reserved.pending_request_id, "cancel-safe");

  const cancelled = await cancelVerifiedFounderMeeting({
    tenantId: TENANT,
    leadId: LEAD,
    appointmentId: "meeting-cancel-safe",
    requestId: "cancel-safe",
  }, deps);
  assert.equal(cancelled.disposition, "cancelled");
  assert.equal(calls.cancelled.length, 1);
  await raw.close();
}

async function testSagaReconciliation() {
  const { raw, deps, calls } = await fixture();
  await insertVerifiedAppointment(raw, {
    id: "meeting-book-reconcile", pendingRequestId: "book-reconcile",
    pendingOperation: "book", pendingMeetingAt: FUTURE,
    pendingStartedAt: "2026-09-01T13:30:00.000Z", pendingLeaseToken: "book-worker",
    workflowStatus: "pending_transition",
  });
  await setLead(raw, {
    stage: "founder_meeting_booked",
    calendar_appointment_id: "meeting-book-reconcile",
    founder_meeting_at: FUTURE,
  });
  const activated = await reconcileFounderMeetingSagas({
    tenantId: TENANT, now: new Date(NOW), staleAfterMs: 60_000,
  }, deps);
  assert.equal(activated.activated, 1);
  assert.equal((await appointment(raw, "meeting-book-reconcile")).workflow_status, "active");

  await raw.execute("DELETE FROM tenant_records");
  await insertVerifiedAppointment(raw, {
    id: "meeting-book-orphan", pendingRequestId: "book-orphan",
    pendingOperation: "book", pendingMeetingAt: FUTURE,
    pendingStartedAt: "2026-09-01T13:30:00.000Z", pendingLeaseToken: "book-orphan-worker",
    workflowStatus: "pending_transition",
  });
  await raw.execute({
    sql: "INSERT INTO calendar_events (id, tenant_id, appointment_id) VALUES (?, ?, ?)",
    args: ["mirror-orphan", TENANT, "meeting-book-orphan"],
  });
  const compensated = await reconcileFounderMeetingSagas({
    tenantId: TENANT, now: new Date(NOW), staleAfterMs: 60_000,
  }, deps);
  assert.equal(compensated.cancelled, 1);
  assert(calls.cancelled.includes("event-meeting-book-orphan"));
  assert.equal((await appointment(raw, "meeting-book-orphan")).workflow_status, "cancelled");
  const orphanMirrors = await raw.execute({
    sql: "SELECT COUNT(*) AS n FROM calendar_events WHERE appointment_id = ?",
    args: ["meeting-book-orphan"],
  });
  assert.equal(Number(orphanMirrors.rows[0].n), 0);

  await insertVerifiedAppointment(raw, {
    id: "meeting-reschedule-orphan", scheduledFor: LATER, revision: 2,
    pendingRequestId: "reschedule-orphan", pendingOperation: "reschedule",
    pendingMeetingAt: LATER, pendingStartedAt: "2026-09-01T13:30:00.000Z",
    pendingLeaseToken: "reschedule-worker", previousScheduledFor: FUTURE,
    workflowStatus: "pending_transition",
  });
  const restored = await reconcileFounderMeetingSagas({
    tenantId: TENANT, now: new Date(NOW), staleAfterMs: 60_000,
  }, deps);
  assert.equal(restored.compensated, 1);
  const restoredRow = await appointment(raw, "meeting-reschedule-orphan");
  assert.equal(restoredRow.scheduled_for, FUTURE);
  assert.equal(restoredRow.workflow_status, "active");

  await insertVerifiedAppointment(raw, {
    id: "meeting-cancel-reconcile", pendingRequestId: "cancel-reconcile",
    pendingOperation: "cancel", pendingMeetingAt: FUTURE,
    pendingStartedAt: "2026-09-01T13:30:00.000Z", pendingLeaseToken: "cancel-worker",
    workflowStatus: "pending_transition",
  });
  await setLead(raw, { stage: "lost", deal_outcome: "lost" });
  const cancelled = await reconcileFounderMeetingSagas({
    tenantId: TENANT, now: new Date(NOW), staleAfterMs: 60_000,
  }, deps);
  assert.equal(cancelled.cancelled, 1);
  assert.equal((await appointment(raw, "meeting-cancel-reconcile")).workflow_status, "cancelled");

  await insertVerifiedAppointment(raw, {
    id: "meeting-client-cancel-reconcile", pendingRequestId: "client-cancel-reconcile",
    pendingOperation: "cancel", pendingMeetingAt: FUTURE,
    pendingStartedAt: "2026-09-01T13:30:00.000Z", pendingLeaseToken: "client-cancel-worker",
    workflowStatus: "pending_transition",
  });
  await setLead(raw, {
    stage: "qualified",
    deal_outcome: null,
    founder_meeting_status: "cancelled_by_client",
  });
  const clientCancelled = await reconcileFounderMeetingSagas({
    tenantId: TENANT, now: new Date(NOW), staleAfterMs: 60_000,
  }, deps);
  assert.equal(clientCancelled.cancelled, 1);
  assert.equal((await appointment(raw, "meeting-client-cancel-reconcile")).workflow_status, "cancelled");
  await raw.close();
}

async function testSagaRoomCompensation() {
  const { raw, deps } = await fixture();
  const meetRooms = fakeMeetRooms();
  meetRooms.seed("room-book-saga", "https://oasisai.work/meet/aaa-bbbb-ccc");
  await insertVerifiedAppointment(raw, {
    id: "meeting-book-room-saga",
    pendingRequestId: "book-room-saga",
    pendingOperation: "book",
    pendingMeetingAt: FUTURE,
    pendingStartedAt: "2026-09-01T13:30:00.000Z",
    pendingLeaseToken: "book-room-worker",
    workflowStatus: "pending_transition",
    meetRoomId: "room-book-saga",
    googleMeetLink: "https://oasisai.work/meet/aaa-bbbb-ccc",
  });
  const cancelled = await reconcileFounderMeetingSagas({
    tenantId: TENANT,
    now: new Date("2026-09-01T14:20:00.000Z"),
    staleAfterMs: 60_000,
  }, { ...deps, meetRooms });
  assert.equal(cancelled.cancelled, 1);
  assert.deepEqual(meetRooms.calls.removed, ["room-book-saga"]);
  assert.equal((await appointment(raw, "meeting-book-room-saga")).meet_room_id, null);

  meetRooms.seed("room-reschedule-saga", "https://oasisai.work/meet/ddd-eeee-fff");
  await insertVerifiedAppointment(raw, {
    id: "meeting-reschedule-room-saga",
    scheduledFor: LATER,
    revision: 2,
    pendingRequestId: "reschedule-room-saga",
    pendingOperation: "reschedule",
    pendingMeetingAt: LATER,
    pendingStartedAt: "2026-09-01T13:30:00.000Z",
    pendingLeaseToken: "reschedule-room-worker",
    previousScheduledFor: FUTURE,
    workflowStatus: "pending_transition",
    meetRoomId: "room-reschedule-saga",
    googleMeetLink: "https://oasisai.work/meet/ddd-eeee-fff",
  });
  const restored = await reconcileFounderMeetingSagas({
    tenantId: TENANT,
    now: new Date("2026-09-01T14:20:00.000Z"),
    staleAfterMs: 60_000,
  }, { ...deps, meetRooms });
  assert.equal(restored.compensated, 1);
  assert.deepEqual(meetRooms.calls.rescheduled.at(-1), {
    id: "room-reschedule-saga",
    startsAt: FUTURE,
  });
  assert.equal((await appointment(raw, "meeting-reschedule-room-saga")).scheduled_for, FUTURE);
  await raw.close();
}

async function testNoShowCompensationRestoresTerminalHistory() {
  const { raw, deps } = await fixture();
  await insertVerifiedAppointment(raw, {
    id: "meeting-no-show-compensation",
    scheduledFor: "2026-09-01T13:45:00.000Z",
    status: "no_answer",
    workflowStatus: "no_show",
  });
  await rescheduleVerifiedFounderMeeting({
    tenantId: TENANT,
    leadId: LEAD,
    appointmentId: "meeting-no-show-compensation",
    requestId: "reschedule-no-show",
    meetingAt: FUTURE,
  }, deps);
  const pending = await appointment(raw, "meeting-no-show-compensation");
  assert.equal(pending.previous_status, "no_answer");
  assert.equal(pending.previous_workflow_status, "no_show");

  const reconciled = await reconcileFounderMeetingSagas({
    tenantId: TENANT,
    now: new Date("2026-09-01T14:20:00.000Z"),
    staleAfterMs: 60_000,
  }, deps);
  assert.equal(reconciled.compensated, 1);
  const restored = await appointment(raw, "meeting-no-show-compensation");
  assert.equal(restored.scheduled_for, "2026-09-01T13:45:00.000Z");
  assert.equal(restored.status, "no_answer");
  assert.equal(restored.workflow_status, "no_show");
  await raw.close();
}

async function testReconcilerClaimsBeforeProviderMutation() {
  const { raw, deps } = await fixture();
  await insertVerifiedAppointment(raw, {
    id: "meeting-reconcile-fenced",
    pendingRequestId: "book-fenced",
    pendingOperation: "book",
    pendingMeetingAt: FUTURE,
    pendingStartedAt: "2026-09-01T13:30:00.000Z",
    pendingLeaseToken: "stale-worker",
    workflowStatus: "pending_transition",
  });
  let observedOperation = "";
  const result = await reconcileFounderMeetingSagas({
    tenantId: TENANT,
    now: new Date("2026-09-01T14:20:00.000Z"),
    staleAfterMs: 60_000,
  }, {
    ...deps,
    cancelCalendar: async () => {
      observedOperation = String((await appointment(raw, "meeting-reconcile-fenced")).pending_operation);
    },
  });
  assert.equal(observedOperation, "compensating_book");
  assert.equal(result.cancelled, 1);
  await raw.close();
}

async function testRescheduleReconciliationUsesPendingTarget() {
  const { raw, deps } = await fixture();
  await insertVerifiedAppointment(raw, {
    id: "meeting-reschedule-target",
    scheduledFor: FUTURE,
    pendingRequestId: "reschedule-target",
    pendingOperation: "reschedule",
    pendingMeetingAt: LATER,
    pendingStartedAt: "2026-09-01T13:30:00.000Z",
    pendingLeaseToken: "stale-rescheduler",
    previousScheduledFor: FUTURE,
    workflowStatus: "pending_transition",
  });
  await setLead(raw, {
    stage: "founder_meeting_booked",
    calendar_appointment_id: "meeting-reschedule-target",
    founder_meeting_at: FUTURE,
  });
  const reconciled = await reconcileFounderMeetingSagas({
    tenantId: TENANT,
    now: new Date("2026-09-01T14:20:00.000Z"),
    staleAfterMs: 60_000,
  }, deps);
  assert.equal(reconciled.activated, 0, "the old lead time cannot confirm a new Google time");
  assert.equal(reconciled.compensated, 1);
  await raw.close();
}

async function testNotificationFailureKeepsCompensationSaga() {
  const { raw, deps } = await fixture();
  await insertVerifiedAppointment(raw, {
    id: "meeting-reminder-repair",
    scheduledFor: LATER,
    pendingRequestId: "reschedule-reminder-repair",
    pendingOperation: "reschedule",
    pendingMeetingAt: LATER,
    pendingStartedAt: "2026-09-01T13:30:00.000Z",
    pendingLeaseToken: "stale-reminder-worker",
    previousScheduledFor: FUTURE,
    workflowStatus: "pending_transition",
  });
  await raw.execute(`CREATE TRIGGER reject_repaired_reminder
    BEFORE INSERT ON website_sales_meeting_notifications
    WHEN NEW.appointment_revision = 2
    BEGIN SELECT RAISE(ABORT, 'simulated notification write failure'); END`);
  const reconciled = await reconcileFounderMeetingSagas({
    tenantId: TENANT,
    now: new Date("2026-09-01T14:20:00.000Z"),
    staleAfterMs: 60_000,
  }, deps);
  assert.equal(reconciled.failed, 1);
  const held = await appointment(raw, "meeting-reminder-repair");
  assert.equal(held.workflow_status, "pending_transition");
  assert.equal(held.pending_operation, "compensating_reschedule");
  assert.equal(held.scheduled_for, FUTURE, "the provider receipt is durable before reminder repair retries");
  assert.equal(Number(held.revision), 2);
  assert.ok(held.pending_compensation_applied_at);
  await raw.close();
}

async function testFinalCompensationConflictLeavesRemindersRecoverable() {
  const { raw, deps } = await fixture();
  await insertVerifiedAppointment(raw, {
    id: "meeting-finalize-repair",
    scheduledFor: LATER,
    pendingRequestId: "reschedule-finalize-repair",
    pendingOperation: "reschedule",
    pendingMeetingAt: LATER,
    pendingStartedAt: "2026-09-01T13:30:00.000Z",
    pendingLeaseToken: "stale-finalizer",
    previousScheduledFor: FUTURE,
    workflowStatus: "pending_transition",
  });
  await raw.execute(`CREATE TRIGGER reject_compensation_finalize
    BEFORE UPDATE ON call_appointments
    WHEN OLD.id = 'meeting-finalize-repair'
      AND OLD.pending_compensation_applied_at IS NOT NULL
      AND NEW.pending_request_id IS NULL
    BEGIN SELECT RAISE(ABORT, 'simulated final CAS failure'); END`);
  const reconciled = await reconcileFounderMeetingSagas({
    tenantId: TENANT,
    now: new Date("2026-09-01T14:20:00.000Z"),
    staleAfterMs: 60_000,
  }, deps);
  assert.equal(reconciled.failed, 1);
  const held = await appointment(raw, "meeting-finalize-repair");
  assert.equal(held.workflow_status, "pending_transition");
  assert.equal(held.pending_operation, "compensating_reschedule");
  assert.equal(Number(held.revision), 2);
  const reminders = await raw.execute({
    sql: `SELECT status FROM website_sales_meeting_notifications
          WHERE appointment_id = ? AND appointment_revision = 2 AND status = 'pending'`,
    args: ["meeting-finalize-repair"],
  });
  assert(reminders.rows.length > 0, "next-revision reminders remain pending while the saga is held");
  await raw.close();
}

async function main() {
  testBackfillChunkRotatesBeyondFirstFiveHundred();
  testConsentReplayErrorResponseClassification();
  await testCreateAuditAndFullIdempotency();
  await testOasisMeetRoomLifecycle();
  await testOasisMeetRoomReplacementAndFallback();
  await testOasisMeetRoomCalendarFailureCompensates();
  await testOasisMeetRoomRemovalRetriesAfterFailure();
  await testOasisMeetRoomSurvivesLiveCalendarCompensation();
  await testOasisMeetRoomCreationFailuresFallBack();
  await testOasisMeetRoomRescheduleRollback();
  await testOasisMeetRoomMovesWhenMediaIsUnavailable();
  await testOasisMeetRoomFourthReviewFixes();
  await testOasisMeetRoomFinalReviewFixes();
  await testRecordingNoticeFollowsTheRoom();
  await testGoogleOnlyRoomWritesAreOmitted();
  await testCreatePreservesCustomDuration();
  await testReceiptWriteCompensationInvalidatesTheRequestId();
  await testPendingBookingCompensationCancelsProviderAndMirror();
  await testCompensationStaysDurableWhenMirrorCleanupFails();
  await testBackfillHydratesLatePhoneAndRepairsTiers();
  await testBackfillLimitScansPastAlreadyCompleteAppointments();
  await testBackfillLimitIsGlobalAcrossTenants();
  await testIdempotentConsentReplayCannotRecreateRowsDuringTransition();
  await testConsentLeaseSerializesCancellationAfterContextRead();
  await testConsentTimestampRejectsFutureAndOverYearOldEvidence();
  await testConsentPreservesOperationErrorWhenLeaseReleaseAlsoFails();
  await testConsentSuccessfulOperationStillSurfacesLeaseReleaseFailure();
  await testBackfillBatchSkipsCompleteAppointments();
  await testOrganizerMismatchCompensates();
  await testNoShowUsesCanonicalStatusAndTimeGuard();
  await testExclusiveReservationAndNoShowRebook();
  await testRescheduleIntoAnOccupiedFounderSlotIsRefusedBeforeGoogle();
  await testScheduleMirrorsFollowRescheduleAndCancellation();
  await testBoundedSameRequestTakeoverAndActivationGuard();
  await testCancellationPreservesHistory();
  await testCancellationReservationPrecedesProviderMutation();
  await testSagaReconciliation();
  await testSagaRoomCompensation();
  await testNoShowCompensationRestoresTerminalHistory();
  await testReconcilerClaimsBeforeProviderMutation();
  await testRescheduleReconciliationUsesPendingTarget();
  await testNotificationFailureKeepsCompensationSaga();
  await testFinalCompensationConflictLeavesRemindersRecoverable();

  console.log("founder-meeting-service: OK");
}

void main();
