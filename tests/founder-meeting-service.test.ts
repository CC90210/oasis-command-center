import assert from "node:assert/strict";
import { createClient, type Client } from "@libsql/client";
import { createTursoPostgrest } from "../lib/turso-postgrest";
import {
  activateVerifiedFounderMeeting,
  backfillFounderMeetingNotifications,
  cancelVerifiedFounderMeeting,
  closeVerifiedFounderMeeting,
  createVerifiedFounderMeeting,
  founderMeetingSmsConsentErrorResponse,
  founderMeetingBackfillChunkStart,
  grantFounderMeetingSmsConsent,
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
`;

type CalendarCalls = {
  created: number;
  updated: string[];
  cancelled: string[];
};

type InstrumentationHooks = {
  onSelect?: (table: string, columns: string) => void;
  onUpdate?: (table: string) => void;
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
          hooks.onUpdate?.(table);
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
  const [migration167, migration169] = await import("node:fs").then(({ readFileSync }) => [
    readFileSync("database/turso/167_founder_meeting_closed_loop.turso.sql", "utf8"),
    readFileSync("database/turso/169_founder_meeting_reminder_tiers.turso.sql", "utf8"),
  ]);
  await raw.executeMultiple(`${BASE_SCHEMA}\n${migration167}\n${migration169}`);
  const db = createTursoPostgrest(raw);
  const calls: CalendarCalls = { created: 0, updated: [], cancelled: [] };
  const deps = {
    db: db as never,
    now: () => NOW,
    createCalendar: async () => {
      calls.created += 1;
      return {
        calendarId: "primary",
        eventId: "event12345",
        htmlLink: "https://calendar.google.com/calendar/event?eid=test",
        meetLink: "https://meet.google.com/abc-defg-hij",
        iCalUID: "ical-1",
        organizerEmail: ORGANIZER,
      };
    },
    updateCalendar: async (input: { meetingAt: string }) => {
      calls.updated.push(input.meetingAt);
      return {
        calendarId: "primary",
        eventId: "event12345",
        htmlLink: "https://calendar.google.com/calendar/event?eid=test",
        meetLink: "https://meet.google.com/abc-defg-hij",
        iCalUID: "ical-1",
        organizerEmail: ORGANIZER,
      };
    },
    cancelCalendar: async (input: { eventId: string }) => {
      calls.cancelled.push(input.eventId);
    },
  };
  return { raw, db, deps, calls };
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
}) {
  const eventId = `event-${values.id}`;
  await raw.execute({
    sql: `INSERT INTO call_appointments (
      id, tenant_id, lead_id, entity_type, scheduled_for, assigned_to, status,
      created_by, meeting_kind, duration_minutes, timezone, client_name_snapshot,
      company_snapshot, client_email_snapshot, client_phone_snapshot, website_snapshot,
      client_agenda, handoff_note, google_calendar_id, google_event_id,
      google_event_html_link, google_meet_link, google_ical_uid, calendar_status,
      organizer_email_snapshot, booking_request_id, revision, workflow_status,
      sms_consent, pending_request_id, pending_operation, pending_meeting_at,
      pending_started_at, pending_lease_token, previous_scheduled_for
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [
      values.id, values.tenantId ?? TENANT, values.leadId ?? LEAD, "lead", values.scheduledFor ?? FUTURE, HOST,
      values.status ?? "scheduled", ACTOR, "founder_audit", 15, "America/Toronto",
      "Taylor Smith", "North Star Dental", "taylor@example.com", "+14165550101",
      "https://northstardental.ca/", "Review the site.", "Qualified handoff.",
      "primary", eventId, "https://calendar.google.com/calendar/event?eid=test",
      "https://meet.google.com/abc-defg-hij", "ical-1", "verified", ORGANIZER,
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
  const compensated = await reconcileFounderMeetingSagas({
    tenantId: TENANT, now: new Date(NOW), staleAfterMs: 60_000,
  }, deps);
  assert.equal(compensated.cancelled, 1);
  assert(calls.cancelled.includes("event-meeting-book-orphan"));
  assert.equal((await appointment(raw, "meeting-book-orphan")).workflow_status, "cancelled");

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
  await testBoundedSameRequestTakeoverAndActivationGuard();
  await testCancellationPreservesHistory();
  await testCancellationReservationPrecedesProviderMutation();
  await testSagaReconciliation();
  await testNoShowCompensationRestoresTerminalHistory();
  await testReconcilerClaimsBeforeProviderMutation();
  await testRescheduleReconciliationUsesPendingTarget();
  await testNotificationFailureKeepsCompensationSaga();
  await testFinalCompensationConflictLeavesRemindersRecoverable();

  console.log("founder-meeting-service: OK");
}

void main();
