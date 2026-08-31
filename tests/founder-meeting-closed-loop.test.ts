import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createClient } from "@libsql/client";
import {
  buildFounderMeetingMessages,
  FOUNDER_MEETING_TRANSITION_HOLD_MINUTES,
  founderMeetingDedupeKey,
  meetingNotificationDecision,
  minutesUntilMeeting,
  normalizeFounderMeetingContact,
  reminderDueAt,
} from "../lib/website-sales-meeting";
import {
  buildGmailRawMessage,
  gmailAddressesMatch,
  gmailFailureReason,
  gmailMessageIdForIdempotencyKey,
} from "../lib/integrations/gmail-oauth-send";

const migrationPath = "database/turso/167_founder_meeting_closed_loop.turso.sql";
const migration = readFileSync(migrationPath, "utf8");
const lifecycle = readFileSync("app/pipeline/[id]/LeadLifecycleActions.tsx", "utf8");
const workflow = readFileSync("app/api/website-sales/[leadId]/route.ts", "utf8");
const meetingService = readFileSync("lib/website-sales-founder-meeting.ts", "utf8");
const cron = readFileSync("app/api/cron/dispatch-founder-meeting-reminders/route.ts", "utf8");
const gmailSender = readFileSync("lib/integrations/gmail-oauth-send.ts", "utf8");
const cronRegistry = readFileSync("config/cron-registry.json", "utf8");
const driver = readFileSync(".github/workflows/cron-driver.yml", "utf8");

const contact = normalizeFounderMeetingContact({
  name: "  Taylor Smith  ",
  company: "  North Star Dental ",
  email: " TAYLOR@Example.COM ",
  phone: " +1 (416) 555-0101 ",
  website: "northstardental.ca",
});
assert.deepEqual(contact, {
  name: "Taylor Smith",
  company: "North Star Dental",
  email: "taylor@example.com",
  phone: "+14165550101",
  website: "https://northstardental.ca/",
});
assert.throws(
  () => normalizeFounderMeetingContact({ email: "not-an-email" }),
  /client_email_required/,
  "founder booking must fail closed without a deliverable client email",
);

const meetingAt = "2026-09-01T20:00:00.000Z";
assert.equal(
  reminderDueAt(meetingAt, 10),
  "2026-09-01T19:50:00.000Z",
  "the client reminder is due exactly ten minutes before the verified event",
);
assert.equal(
  meetingNotificationDecision({
    workflowStatus: "pending_transition",
    appointmentStatus: "scheduled",
    calendarStatus: "verified",
    appointmentRevision: 1,
    notificationRevision: 1,
    meetingAt,
    now: "2026-09-01T19:40:00.000Z",
    transitionStartedAt: "2026-09-01T19:39:00.000Z",
  }),
  "hold",
);
assert.equal(
  meetingNotificationDecision({
    workflowStatus: "pending_transition",
    appointmentStatus: "scheduled",
    calendarStatus: "verified",
    appointmentRevision: 1,
    notificationRevision: 1,
    meetingAt: "2026-09-01T19:39:00.000Z",
    now: "2026-09-01T19:40:00.000Z",
    transitionStartedAt: "2026-09-01T19:39:30.000Z",
  }),
  "skip",
  "a pending transition cannot hold a reminder after the meeting has started",
);
assert.equal(
  meetingNotificationDecision({
    workflowStatus: "pending_transition",
    appointmentStatus: "scheduled",
    calendarStatus: "verified",
    appointmentRevision: 1,
    notificationRevision: 1,
    meetingAt,
    now: "2026-09-01T19:40:00.000Z",
    transitionStartedAt: "2026-09-01T19:20:00.000Z",
  }),
  "skip",
  "an abandoned pending transition stops holding after the bounded transition window",
);
assert.equal(FOUNDER_MEETING_TRANSITION_HOLD_MINUTES, 15);
assert.equal(
  meetingNotificationDecision({
    workflowStatus: "active",
    appointmentStatus: "rescheduled",
    calendarStatus: "verified",
    appointmentRevision: 2,
    notificationRevision: 1,
    meetingAt,
    now: "2026-09-01T19:40:00.000Z",
  }),
  "skip",
  "an old reminder cannot fire after reschedule",
);
assert.equal(
  meetingNotificationDecision({
    workflowStatus: "active",
    appointmentStatus: "scheduled",
    calendarStatus: "verified",
    appointmentRevision: 2,
    notificationRevision: 2,
    meetingAt,
    now: "2026-09-01T19:40:00.000Z",
  }),
  "send",
);
assert.equal(
  founderMeetingDedupeKey("appointment-1", 2, "ten_minute", "email"),
  "appointment-1:2:ten_minute:email",
);

const messages = buildFounderMeetingMessages({
  company: "North Star Dental",
  contactName: "Taylor Smith",
  meetingAt,
  timezone: "America/Toronto",
  meetLink: "https://meet.google.com/abc-defg-hij",
  clientAgenda: "Review the current site and the online booking workflow.",
  reminderMinutesBefore: 7,
});
assert.match(messages.reminder.subject, /7 minutes/i);
assert.doesNotMatch(messages.reminder.subject, /10 minutes/i);
assert.match(messages.reminder.body, /meet\.google\.com\/abc-defg-hij/);
assert.doesNotMatch(messages.reminder.body, /internal|handoff/i);
assert.match(messages.confirmationSms, /^OASIS AI:/);
assert.match(messages.reminder.sms, /^OASIS AI:/);
assert.match(messages.reminder.sms, /meet\.google\.com\/abc-defg-hij/);
assert.equal(
  minutesUntilMeeting(meetingAt, "2026-09-01T19:53:15.000Z"),
  7,
  "delivery copy is based on the minutes actually remaining when the worker sends",
);

const firstMessageId = gmailMessageIdForIdempotencyKey("attempt-123");
const repeatedMessageId = gmailMessageIdForIdempotencyKey("attempt-123");
const differentMessageId = gmailMessageIdForIdempotencyKey("attempt-456");
assert.equal(firstMessageId, repeatedMessageId, "one delivery attempt has a deterministic RFC Message-ID");
assert.notEqual(firstMessageId, differentMessageId, "separate delivery attempts cannot share a Message-ID");
assert.match(firstMessageId, /^<oasis-[a-f0-9]{64}@oasisai\.work>$/);
assert(gmailAddressesMatch(" Rep@OasisAI.Work ", "rep@oasisai.work"));
assert(!gmailAddressesMatch("adon.personal@gmail.com", "rep@oasisai.work"));
assert.equal(gmailFailureReason(0), "delivery_unknown");
assert.equal(gmailFailureReason(503), "delivery_unknown");
assert.equal(gmailFailureReason(400), "send_failed");
const rawMessage = Buffer.from(buildGmailRawMessage({
  from: "rep@oasisai.work",
  to: "client@example.com",
  subject: "Reminder",
  body: "Meeting reminder",
  messageId: firstMessageId,
}), "base64url").toString("utf8");
assert.match(rawMessage, new RegExp(`Message-ID: ${firstMessageId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));

async function main() {
// Execute the real Turso migration against libSQL. The uniqueness constraints
// are the never-double-book / never-double-remind backstop, not UI convention.
const db = createClient({ url: ":memory:" });
await db.executeMultiple(`
  CREATE TABLE call_appointments (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    lead_id TEXT NOT NULL,
    entity_type TEXT NOT NULL DEFAULT 'lead',
    scheduled_for TEXT NOT NULL,
    assigned_to TEXT,
    status TEXT NOT NULL DEFAULT 'scheduled',
    pre_call_note TEXT,
    outcome_note TEXT,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TEXT
  );
  CREATE TABLE lead_interactions (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    agent_source TEXT,
    metadata TEXT
  );
  ${migration}
`);

const appointmentColumns = await db.execute("PRAGMA table_info(call_appointments)");
const columnNames = new Set(appointmentColumns.rows.map((row) => String(row.name)));
for (const name of [
  "meeting_kind",
  "timezone",
  "client_email_snapshot",
  "client_agenda",
  "handoff_note",
  "google_event_id",
  "google_meet_link",
  "calendar_status",
  "booking_request_id",
  "last_reschedule_request_id",
  "last_cancel_request_id",
  "revision",
  "sms_consent",
  "previous_status",
  "previous_workflow_status",
  "pending_compensation_applied_at",
]) {
  assert(columnNames.has(name), `call_appointments is missing ${name}`);
}

const tables = await db.execute(
  "SELECT name FROM sqlite_master WHERE type='table' AND name='website_sales_meeting_notifications'",
);
assert.equal(tables.rows.length, 1, "the durable meeting-notification outbox exists");
const notificationColumns = await db.execute("PRAGMA table_info(website_sales_meeting_notifications)");
const notificationColumnNames = new Set(notificationColumns.rows.map((row) => String(row.name)));
for (const name of ["tracking_status", "tracking_attempts", "tracking_last_error", "tracked_at"]) {
  assert(notificationColumnNames.has(name), `meeting notifications are missing ${name}`);
}

assert(!lifecycle.includes("calendarConfirmed"), "the UI cannot assert that a Calendar event exists");
assert(!lifecycle.includes("googleCalendarAuditUrl"), "booking is server-side, not a browser Calendar draft");
assert(lifecycle.includes("Book meeting & send invite"), "one action completes the verified handoff");
assert(workflow.includes("createVerifiedFounderMeeting"), "the route creates a provider-verified event");
assert(workflow.includes("rescheduleVerifiedFounderMeeting"), "rescheduling updates the verified Calendar event");
assert(workflow.includes("cancelVerifiedFounderMeeting"), "lost deals cancel the verified Calendar event");
assert(workflow.includes("closeVerifiedFounderMeeting"), "completed/no-show meetings close their reminder workflow");
assert(meetingService.includes("updateGoogleFounderMeeting"), "rescheduling uses the Google Calendar API");
assert(meetingService.includes("cancelGoogleFounderMeeting"), "cancellation uses the Google Calendar API");
assert(
  meetingService.includes('appointment_revision", Number(appointment.revision)'),
  "closing a meeting cancels reminders for its current revision",
);
assert(
  workflow.indexOf("createVerifiedFounderMeeting") < workflow.indexOf('rpc("transition_pipeline_lead"'),
  "the lead cannot move before Calendar returns an event and Meet receipt",
);
const cancellationReservation = workflow.indexOf("prepareVerifiedFounderMeetingCancellation({");
const lifecycleCommit = workflow.lastIndexOf('rpc("transition_pipeline_lead"');
const providerCancellation = workflow.lastIndexOf("cancelVerifiedFounderMeeting({");
assert(
  cancellationReservation >= 0 &&
    cancellationReservation < lifecycleCommit &&
    lifecycleCommit < providerCancellation,
  "closing a lead lost reserves cancellation before the lead transaction and mutates Google only after commit",
);
assert(
  workflow.includes("Calendar cancellation is safely reserved and the background worker is finishing it."),
  "a committed lead transition reports a recoverable pending Calendar cancellation honestly",
);
assert(cron.includes("website_sales_meeting_notifications"), "the worker drains the durable outbox");
assert(cron.includes("reconcileFounderMeetingSagas"), "the worker repairs stale meeting sagas before delivery");
assert(
  cron.indexOf("reconcileFounderMeetingSagas") < cron.indexOf('const due = await db.from("website_sales_meeting_notifications")'),
  "saga reconciliation runs before the reminder queue is read",
);
assert(cron.includes("appointment_revision"), "stale reminders are suppressed after reschedule");
assert(cron.includes("notification_lease_token"), "provider delivery is serialized with an appointment lease");
assert(
  cron.includes("const APPOINTMENT_LEASE_MS = STALE_CLAIM_MS") && cron.includes("retainLeaseUntilRecovery"),
  "an unknown provider outcome keeps the lifecycle lock until terminal stale recovery",
);
assert(cron.includes("attempt_token"), "every provider attempt is durably identified");
assert(
  cron.includes("attempt_token: row.attempt_token"),
  "the canonical touch links back to the exact durable provider attempt",
);
assert(
  cron.includes("delivery_state_unknown_after_worker_interruption"),
  "an interrupted provider attempt becomes terminal-unknown instead of being resent",
);
assert(
  cron.includes("(deliveryUnknown.data?.length || 0)"),
  "terminal-unknown deliveries degrade worker health instead of being reported as healthy",
);
assert(
  cron.includes("provider_accepted_but_status_unknown") && cron.includes("DeliveryStateUnknownError"),
  "a provider receipt followed by a database error must never return to the external-send retry path",
);
assert(
  cron.includes('eq("tracking_status", "pending")') &&
    cron.includes("persistReminderTracking") &&
    cron.includes("markTrackingComplete"),
  "provider-accepted reminders retry their touch ledger without repeating the external send",
);
assert(
  migration.includes("lead_interactions_meeting_notification_uidx"),
  "tracking retries are idempotent by durable notification id",
);
assert(
  cron.includes("reconciliation.failed + trackingFailures"),
  "a poisoned saga degrades health but cannot starve unrelated reminder deliveries",
);
assert(
  cron.includes("subject: deliveryRow.subject") && cron.includes("body: deliveryRow.body"),
  "the outbox records the truthful reminder copy that was actually delivered",
);
assert(
  !/status:\s*["']pending["'][\s\S]{0,160}\.eq\(["']status["'],\s*["']sending["']\)\s*\.lt\(["']claimed_at["']/.test(cron),
  "stale sending rows must never be recycled to pending",
);
assert(
  gmailSender.includes("expectedFromAddress") && gmailSender.includes('reason: "sender_mismatch"'),
  "the Gmail path fails closed when the connected mailbox is not the approved organizer",
);
assert(
  cron.includes('sent.reason === "delivery_unknown"'),
  "ambiguous Gmail transport failures are terminal instead of risking a duplicate retry",
);
assert(cronRegistry.includes("dispatch-founder-meeting-reminders"), "the cron registry registers the meeting worker");
assert(driver.includes("dispatch-founder-meeting-reminders"), "the live GitHub cron driver runs the worker");

await db.close();
console.log("founder-meeting-closed-loop: OK");
}

void main();
