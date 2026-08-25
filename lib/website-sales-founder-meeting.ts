import "server-only";

import { randomUUID } from "node:crypto";
import { getServiceSupabase } from "@/lib/supabase-server";
import {
  buildFounderMeetingMessages,
  FOUNDER_MEETING_DURATION_MINUTES,
  FOUNDER_MEETING_TIMEZONE,
  founderMeetingDedupeKey,
  normalizeFounderMeetingContact,
  reminderDueAt,
  type FounderMeetingContact,
} from "@/lib/website-sales-meeting";
import {
  cancelGoogleFounderMeeting,
  createGoogleFounderMeeting,
  systemOrganizerEmail,
  updateGoogleFounderMeeting,
  type GoogleCalendarReceipt,
} from "@/lib/integrations/google-calendar";

type Db = ReturnType<typeof getServiceSupabase>;

const OPERATION_LEASE_MS = 2 * 60_000;
const DEFAULT_RECONCILE_STALE_MS = 15 * 60_000;
const DEFAULT_RECONCILE_LIMIT = 100;

type AppointmentRow = {
  id: string;
  tenant_id: string;
  lead_id: string;
  scheduled_for: string;
  assigned_to: string | null;
  created_by: string;
  status: string;
  client_name_snapshot: string | null;
  company_snapshot: string | null;
  client_email_snapshot: string | null;
  client_phone_snapshot: string | null;
  website_snapshot: string | null;
  client_agenda: string | null;
  handoff_note: string | null;
  google_calendar_id: string | null;
  google_event_id: string | null;
  google_event_html_link: string | null;
  google_meet_link: string | null;
  google_ical_uid: string | null;
  calendar_status: string;
  calendar_error: string | null;
  booking_request_id: string | null;
  last_reschedule_request_id: string | null;
  last_cancel_request_id: string | null;
  revision: number;
  workflow_status: string;
  sms_consent: number | boolean;
  sms_consent_at: string | null;
  organizer_email_snapshot: string | null;
  contact_confirmed_at: string | null;
  time_confirmed_at: string | null;
  handoff_confirmed_at: string | null;
  confirmed_by: string | null;
  pending_request_id: string | null;
  pending_operation: string | null;
  pending_meeting_at: string | null;
  pending_started_at: string | null;
  pending_lease_token: string | null;
  previous_scheduled_for: string | null;
  previous_status: string | null;
  previous_workflow_status: string | null;
  pending_provider_applied_at: string | null;
  pending_compensation_applied_at: string | null;
  notification_lease_token: string | null;
  notification_lease_expires_at: string | null;
  updated_at: string;
};

export type FounderMeetingConfirmations = {
  contactConfirmed: true;
  clientAgreedToTime: true;
  handoffComplete: true;
};

export type VerifiedFounderMeeting = {
  appointmentId: string;
  requestId: string;
  meetingAt: string;
  timezone: string;
  contact: FounderMeetingContact;
  receipt: GoogleCalendarReceipt;
  revision: number;
};

export type FounderMeetingCancellationResult = {
  disposition: "cancelled" | "preserved" | "pending";
  appointmentId: string;
  requestId: string;
  error?: string;
};

export type FounderMeetingReconciliationResult = {
  considered: number;
  activated: number;
  cancelled: number;
  compensated: number;
  released: number;
  failed: number;
  /** Stable machine codes only: never names, email addresses, notes, or lead data. */
  errors: string[];
};

export type FounderMeetingServiceDependencies = {
  db: Db;
  now: () => number;
  createCalendar: typeof createGoogleFounderMeeting;
  updateCalendar: typeof updateGoogleFounderMeeting;
  cancelCalendar: typeof cancelGoogleFounderMeeting;
};

function dependencies(
  overrides: Partial<FounderMeetingServiceDependencies> = {},
): FounderMeetingServiceDependencies {
  return {
    db: overrides.db ?? getServiceSupabase(),
    now: overrides.now ?? Date.now,
    createCalendar: overrides.createCalendar ?? createGoogleFounderMeeting,
    updateCalendar: overrides.updateCalendar ?? updateGoogleFounderMeeting,
    cancelCalendar: overrides.cancelCalendar ?? cancelGoogleFounderMeeting,
  };
}

function boundedRequired(value: unknown, max: number, error: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new Error(error);
  if (normalized.length > max) throw new Error(`${error}_too_long`);
  return normalized;
}

function normalizedEmail(value: unknown, error: string): string {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) throw new Error(error);
  return email;
}

function errorCode(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : fallback;
  return raw.split(":", 1)[0].slice(0, 120) || fallback;
}

function asReceipt(row: AppointmentRow): GoogleCalendarReceipt | null {
  if (
    row.calendar_status !== "verified" ||
    !row.google_calendar_id ||
    !row.google_event_id ||
    !row.google_event_html_link ||
    !row.google_meet_link ||
    !row.google_ical_uid ||
    !row.organizer_email_snapshot
  ) return null;
  return {
    calendarId: row.google_calendar_id,
    eventId: row.google_event_id,
    htmlLink: row.google_event_html_link,
    meetLink: row.google_meet_link,
    iCalUID: row.google_ical_uid,
    organizerEmail: row.organizer_email_snapshot,
  };
}

function assertOrganizer(receipt: GoogleCalendarReceipt, expectedOrganizerEmail: string): void {
  const organizer = receipt.organizerEmail.trim().toLowerCase();
  if (organizer === expectedOrganizerEmail) return;
  // Workspace fallback (2026-08-25): when the booking ran on the workspace
  // identity because the host has no personal work connection, Google reports
  // the workspace address as organizer. That is the sanctioned shape, not a
  // mismatch — reject only an unexpected third identity.
  const systemAddress = systemOrganizerEmail();
  if (systemAddress && organizer === systemAddress) return;
  throw new Error("calendar_organizer_mismatch");
}

function assertConfirmations(value: unknown): asserts value is FounderMeetingConfirmations {
  const confirmations = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
  if (
    !confirmations ||
    confirmations.contactConfirmed !== true ||
    confirmations.clientAgreedToTime !== true ||
    confirmations.handoffComplete !== true
  ) {
    throw new Error("booking_confirmations_required");
  }
}

function assertSameRequest(row: AppointmentRow, input: {
  leadId: string;
  actorUserId: string;
  hostUserId: string;
  meetingAt: string;
  contact: FounderMeetingContact;
  clientAgenda: string;
  handoffNote: string;
  smsConsent: boolean;
  expectedOrganizerEmail: string;
}) {
  const same =
    row.lead_id === input.leadId &&
    row.created_by === input.actorUserId &&
    row.assigned_to === input.hostUserId &&
    row.scheduled_for === input.meetingAt &&
    row.client_name_snapshot === input.contact.name &&
    row.company_snapshot === input.contact.company &&
    row.client_email_snapshot === input.contact.email &&
    row.client_phone_snapshot === input.contact.phone &&
    row.website_snapshot === input.contact.website &&
    row.client_agenda === input.clientAgenda &&
    row.handoff_note === input.handoffNote &&
    Boolean(row.sms_consent) === input.smsConsent &&
    row.organizer_email_snapshot === input.expectedOrganizerEmail &&
    row.confirmed_by === input.actorUserId &&
    Boolean(row.contact_confirmed_at) &&
    Boolean(row.time_confirmed_at) &&
    Boolean(row.handoff_confirmed_at);
  if (!same) throw new Error("booking_request_mismatch");
}

async function loadByRequest(
  db: Db,
  tenantId: string,
  requestId: string,
): Promise<AppointmentRow | null> {
  const result = await db
    .from("call_appointments")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("booking_request_id", requestId)
    .maybeSingle();
  if (result.error) throw new Error(`meeting_intent_lookup_failed:${result.error.message}`);
  return (result.data as AppointmentRow | null) || null;
}

async function loadById(
  db: Db,
  tenantId: string,
  appointmentId: string,
  leadId?: string,
): Promise<AppointmentRow> {
  let query = db
    .from("call_appointments")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("id", appointmentId);
  if (leadId) query = query.eq("lead_id", leadId);
  const result = await query.maybeSingle();
  if (result.error) throw new Error(`meeting_lookup_failed:${result.error.message}`);
  if (!result.data) throw new Error("verified_meeting_required");
  return result.data as AppointmentRow;
}

async function cancelOutstandingNotifications(
  db: Db,
  appointment: AppointmentRow,
  reason: string,
  nowIso: string,
): Promise<void> {
  const result = await db
    .from("website_sales_meeting_notifications")
    .update({
      status: "cancelled",
      claimed_at: null,
      last_error: reason,
      updated_at: nowIso,
    })
    .eq("tenant_id", appointment.tenant_id)
    .eq("appointment_id", appointment.id)
    .lte("appointment_revision", Number(appointment.revision))
    .in("status", ["pending", "sending"]);
  if (result.error) throw new Error(`meeting_notification_cancel_failed:${result.error.message}`);
}

async function ensureNotificationRows(
  db: Db,
  meeting: VerifiedFounderMeeting,
  tenantId: string,
  leadId: string,
  hostUserId: string,
  agenda: string,
  nowMs: number,
) {
  const messages = buildFounderMeetingMessages({
    company: meeting.contact.company,
    contactName: meeting.contact.name,
    meetingAt: meeting.meetingAt,
    timezone: meeting.timezone,
    meetLink: meeting.receipt.meetLink,
    clientAgenda: agenda,
  });
  const now = new Date(nowMs).toISOString();
  const reminderAt = reminderDueAt(meeting.meetingAt, 10);
  const rows: Array<Record<string, unknown>> = [
    {
      id: randomUUID(), tenant_id: tenantId, appointment_id: meeting.appointmentId,
      lead_id: leadId, kind: "confirmation", channel: "email", due_at: now,
      recipient: meeting.contact.email, sender_user_id: hostUserId,
      subject: "Google Calendar invitation",
      body: "Google Calendar sent the verified event invitation.", status: "sent",
      attempts: 1, appointment_revision: meeting.revision,
      dedupe_key: founderMeetingDedupeKey(meeting.appointmentId, meeting.revision, "confirmation", "email"),
      provider: "google_calendar", provider_receipt: meeting.receipt.eventId,
      sent_at: now, updated_at: now,
    },
    {
      id: randomUUID(), tenant_id: tenantId, appointment_id: meeting.appointmentId,
      lead_id: leadId, kind: "ten_minute", channel: "email", due_at: reminderAt,
      recipient: meeting.contact.email, sender_user_id: hostUserId,
      subject: messages.reminder.subject, body: messages.reminder.body,
      appointment_revision: meeting.revision,
      dedupe_key: founderMeetingDedupeKey(meeting.appointmentId, meeting.revision, "ten_minute", "email"),
      updated_at: now,
    },
  ];
  if (meeting.contact.phone) {
    rows.push(
      {
        id: randomUUID(), tenant_id: tenantId, appointment_id: meeting.appointmentId,
        lead_id: leadId, kind: "confirmation", channel: "sms", due_at: now,
        recipient: meeting.contact.phone, sender_user_id: hostUserId,
        body: messages.confirmationSms, status: "pending",
        appointment_revision: meeting.revision,
        dedupe_key: founderMeetingDedupeKey(meeting.appointmentId, meeting.revision, "confirmation", "sms"),
        updated_at: now,
      },
      {
        id: randomUUID(), tenant_id: tenantId, appointment_id: meeting.appointmentId,
        lead_id: leadId, kind: "ten_minute", channel: "sms", due_at: reminderAt,
        recipient: meeting.contact.phone, sender_user_id: hostUserId,
        body: messages.reminder.sms, status: "pending",
        appointment_revision: meeting.revision,
        dedupe_key: founderMeetingDedupeKey(meeting.appointmentId, meeting.revision, "ten_minute", "sms"),
        updated_at: now,
      },
    );
  }

  // This context read used to filter only by appointment id. Service-role reads
  // bypass RLS, so the tenant predicate is mandatory even for a UUID lookup.
  const contextResult = await db
    .from("call_appointments")
    .select("tenant_id,lead_id,sms_consent")
    .eq("tenant_id", tenantId)
    .eq("id", meeting.appointmentId)
    .eq("lead_id", leadId)
    .maybeSingle();
  if (contextResult.error || !contextResult.data) throw new Error("meeting_notification_context_failed");
  const context = contextResult.data as {
    tenant_id: string;
    lead_id: string;
    sms_consent: number | boolean;
  };
  for (const row of rows) {
    if (row.channel === "sms" && !context.sms_consent) continue;
    const existing = await db
      .from("website_sales_meeting_notifications")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("appointment_id", meeting.appointmentId)
      .eq("dedupe_key", row.dedupe_key as string)
      .maybeSingle();
    if (existing.error) throw new Error(`meeting_notification_lookup_failed:${existing.error.message}`);
    if (existing.data) continue;
    const inserted = await db.from("website_sales_meeting_notifications").insert(row);
    if (inserted.error && !String(inserted.error.message).toLowerCase().includes("unique")) {
      throw new Error(`meeting_notification_insert_failed:${inserted.error.message}`);
    }
  }
}

function contactFromAppointment(appointment: AppointmentRow): FounderMeetingContact {
  return normalizeFounderMeetingContact({
    name: appointment.client_name_snapshot,
    company: appointment.company_snapshot,
    email: appointment.client_email_snapshot,
    phone: appointment.client_phone_snapshot,
    website: appointment.website_snapshot,
  });
}

function meetingFromAppointment(
  appointment: AppointmentRow,
  requestId: string,
): VerifiedFounderMeeting {
  const receipt = asReceipt(appointment);
  if (!receipt) throw new Error("verified_meeting_required");
  if (!appointment.organizer_email_snapshot) throw new Error("calendar_organizer_mismatch");
  assertOrganizer(receipt, appointment.organizer_email_snapshot);
  return {
    appointmentId: appointment.id,
    requestId,
    meetingAt: appointment.scheduled_for,
    timezone: FOUNDER_MEETING_TIMEZONE,
    contact: contactFromAppointment(appointment),
    receipt,
    revision: Number(appointment.revision || 1),
  };
}

type NullableFilterQuery<T> = {
  is(column: string, value: null): T;
  eq(column: string, value: string): T;
};

function nullableMatch<T extends NullableFilterQuery<T>>(
  query: T,
  column: string,
  value: string | null,
): T {
  return value === null ? query.is(column, null) : query.eq(column, value);
}

function leaseIsFresh(startedAt: string | null, nowMs: number): boolean {
  if (!startedAt) return false;
  const started = Date.parse(startedAt);
  return Number.isFinite(started) && nowMs - started < OPERATION_LEASE_MS;
}

function notificationLeaseIsFresh(appointment: AppointmentRow, nowMs: number): boolean {
  if (!appointment.notification_lease_token || !appointment.notification_lease_expires_at) return false;
  const expires = Date.parse(appointment.notification_lease_expires_at);
  return Number.isFinite(expires) && expires > nowMs;
}

async function reserveOperation(
  db: Db,
  appointment: AppointmentRow,
  operation: "reschedule" | "cancel",
  requestId: string,
  targetMeetingAt: string,
  nowMs: number,
): Promise<{ appointment: AppointmentRow; leaseToken: string }> {
  if (notificationLeaseIsFresh(appointment, nowMs)) {
    throw new Error("meeting_notification_in_progress");
  }
  if (appointment.pending_request_id) {
    const sameRequest =
      appointment.pending_request_id === requestId &&
      appointment.pending_operation === operation &&
      appointment.pending_meeting_at === targetMeetingAt;
    if (!sameRequest) throw new Error("meeting_transition_pending");
    if (leaseIsFresh(appointment.pending_started_at, nowMs)) {
      throw new Error("meeting_transition_pending");
    }
  }

  const leaseToken = randomUUID();
  const nowIso = new Date(nowMs).toISOString();
  let query = db
    .from("call_appointments")
    .update({
      workflow_status: "pending_transition",
      pending_request_id: requestId,
      pending_operation: operation,
      pending_meeting_at: targetMeetingAt,
      pending_started_at: nowIso,
      pending_lease_token: leaseToken,
      previous_scheduled_for: appointment.previous_scheduled_for || appointment.scheduled_for,
      previous_status: appointment.previous_status || appointment.status,
      previous_workflow_status: appointment.previous_workflow_status || appointment.workflow_status,
      pending_provider_applied_at: null,
      pending_compensation_applied_at: null,
      notification_lease_token: null,
      notification_lease_expires_at: null,
      calendar_error: null,
      updated_at: nowIso,
    })
    .eq("tenant_id", appointment.tenant_id)
    .eq("id", appointment.id)
    .eq("lead_id", appointment.lead_id)
    .eq("revision", Number(appointment.revision))
    .eq("status", appointment.status)
    .eq("workflow_status", appointment.workflow_status)
    .eq("scheduled_for", appointment.scheduled_for);
  query = nullableMatch(query, "pending_request_id", appointment.pending_request_id);
  query = nullableMatch(query, "pending_lease_token", appointment.pending_lease_token);
  query = nullableMatch(query, "pending_started_at", appointment.pending_started_at);
  query = nullableMatch(query, "notification_lease_token", appointment.notification_lease_token);
  query = nullableMatch(query, "notification_lease_expires_at", appointment.notification_lease_expires_at);
  const held = await query.select("*").maybeSingle();
  if (held.error || !held.data) {
    throw new Error(`meeting_${operation}_conflict:${held.error?.message || "row_changed"}`);
  }
  return { appointment: held.data as AppointmentRow, leaseToken };
}

function clearPendingFields(nowIso: string): Record<string, unknown> {
  return {
    pending_request_id: null,
    pending_operation: null,
    pending_meeting_at: null,
    pending_started_at: null,
    pending_lease_token: null,
    previous_scheduled_for: null,
    previous_status: null,
    previous_workflow_status: null,
    pending_provider_applied_at: null,
    pending_compensation_applied_at: null,
    calendar_error: null,
    last_reconciled_at: nowIso,
    updated_at: nowIso,
  };
}

async function markPendingError(
  db: Db,
  appointment: AppointmentRow,
  leaseToken: string,
  error: string,
  nowIso: string,
): Promise<void> {
  const saved = await db.from("call_appointments").update({
    calendar_error: error.slice(0, 500),
    updated_at: nowIso,
  }).eq("tenant_id", appointment.tenant_id)
    .eq("id", appointment.id)
    .eq("pending_lease_token", leaseToken)
    .select("id")
    .maybeSingle();
  if (saved.error || !saved.data) {
    throw new Error(`meeting_pending_error_write_failed:${saved.error?.message || "row_changed"}`);
  }
}

export async function createVerifiedFounderMeeting(input: {
  tenantId: string;
  leadId: string;
  actorUserId: string;
  hostUserId: string;
  requestId: string;
  meetingAt: string;
  contact: Record<string, unknown>;
  clientAgenda: unknown;
  handoffNote: unknown;
  smsConsent: boolean;
  expectedOrganizerEmail: string;
  confirmations: FounderMeetingConfirmations;
}, dependencyOverrides: Partial<FounderMeetingServiceDependencies> = {}): Promise<VerifiedFounderMeeting> {
  const deps = dependencies(dependencyOverrides);
  const db = deps.db;
  assertConfirmations(input.confirmations);
  const contact = normalizeFounderMeetingContact(input.contact);
  const clientAgenda = boundedRequired(input.clientAgenda, 500, "client_agenda_required");
  const handoffNote = boundedRequired(input.handoffNote, 4000, "handoff_note_required");
  const expectedOrganizerEmail = normalizedEmail(
    input.expectedOrganizerEmail,
    "audit_host_email_required",
  );
  const meetingEpoch = Date.parse(input.meetingAt);
  if (!Number.isFinite(meetingEpoch) || meetingEpoch <= deps.now()) {
    throw new Error("meeting_must_be_in_future");
  }
  if (input.smsConsent && !contact.phone) throw new Error("sms_consent_requires_phone");
  const meetingAt = new Date(meetingEpoch).toISOString();
  const nowIso = new Date(deps.now()).toISOString();
  let leaseToken: string | null = null;

  let appointment = await loadByRequest(db, input.tenantId, input.requestId);
  if (appointment) {
    assertSameRequest(appointment, {
      leadId: input.leadId,
      actorUserId: input.actorUserId,
      hostUserId: input.hostUserId,
      meetingAt,
      contact,
      clientAgenda,
      handoffNote,
      smsConsent: input.smsConsent,
      expectedOrganizerEmail,
    });
    if (appointment.workflow_status === "cancelled" || appointment.status === "cancelled") {
      throw new Error("booking_request_cancelled");
    }
    if (!asReceipt(appointment)) {
      if (leaseIsFresh(appointment.pending_started_at, deps.now())) {
        throw new Error("meeting_transition_pending");
      }
      const takeover = await reserveBookingTakeover(db, appointment, input.requestId, meetingAt, deps.now());
      appointment = takeover.appointment;
      leaseToken = takeover.leaseToken;
    }
  } else {
    const appointmentId = randomUUID();
    leaseToken = randomUUID();
    const inserted = await db.from("call_appointments").insert({
      id: appointmentId,
      tenant_id: input.tenantId,
      lead_id: input.leadId,
      entity_type: "lead",
      scheduled_for: meetingAt,
      assigned_to: input.hostUserId,
      status: "scheduled",
      pre_call_note: handoffNote,
      created_by: input.actorUserId,
      meeting_kind: "founder_audit",
      duration_minutes: FOUNDER_MEETING_DURATION_MINUTES,
      timezone: FOUNDER_MEETING_TIMEZONE,
      client_name_snapshot: contact.name,
      company_snapshot: contact.company,
      client_email_snapshot: contact.email,
      client_phone_snapshot: contact.phone,
      website_snapshot: contact.website,
      client_agenda: clientAgenda,
      handoff_note: handoffNote,
      google_calendar_id: "primary",
      calendar_status: "creating",
      booking_request_id: input.requestId,
      revision: 1,
      workflow_status: "pending_transition",
      sms_consent: input.smsConsent ? 1 : 0,
      sms_consent_at: input.smsConsent ? nowIso : null,
      organizer_email_snapshot: expectedOrganizerEmail,
      contact_confirmed_at: nowIso,
      time_confirmed_at: nowIso,
      handoff_confirmed_at: nowIso,
      confirmed_by: input.actorUserId,
      pending_request_id: input.requestId,
      pending_operation: "book",
      pending_meeting_at: meetingAt,
      pending_started_at: nowIso,
      pending_lease_token: leaseToken,
      previous_scheduled_for: null,
    });
    if (inserted.error) {
      appointment = await loadByRequest(db, input.tenantId, input.requestId);
      if (!appointment) throw new Error(`meeting_intent_insert_failed:${inserted.error.message}`);
      assertSameRequest(appointment, {
        leadId: input.leadId,
        actorUserId: input.actorUserId,
        hostUserId: input.hostUserId,
        meetingAt,
        contact,
        clientAgenda,
        handoffNote,
        smsConsent: input.smsConsent,
        expectedOrganizerEmail,
      });
      const existing = asReceipt(appointment);
      if (!existing) throw new Error("meeting_transition_pending");
      leaseToken = null;
    } else {
      appointment = await loadByRequest(db, input.tenantId, input.requestId);
    }
  }
  if (!appointment) throw new Error("meeting_intent_missing");

  let receipt = asReceipt(appointment);
  if (!receipt) {
    if (!leaseToken) throw new Error("meeting_transition_pending");
    let providerReceipt: GoogleCalendarReceipt | null = null;
    try {
      const calendarInput = {
        tenantId: input.tenantId,
        hostUserId: input.hostUserId,
        requestId: input.requestId,
        meetingAt,
        timezone: FOUNDER_MEETING_TIMEZONE,
        durationMinutes: FOUNDER_MEETING_DURATION_MINUTES,
        clientEmail: contact.email,
        clientName: contact.name || undefined,
        company: contact.company || undefined,
        website: contact.website || undefined,
        clientAgenda,
        expectedOrganizerEmail,
      };
      providerReceipt = await deps.createCalendar(calendarInput);
      assertOrganizer(providerReceipt, expectedOrganizerEmail);
      const saved = await db.from("call_appointments").update({
        google_calendar_id: providerReceipt.calendarId,
        google_event_id: providerReceipt.eventId,
        google_event_html_link: providerReceipt.htmlLink,
        google_meet_link: providerReceipt.meetLink,
        google_ical_uid: providerReceipt.iCalUID || null,
        organizer_email_snapshot: expectedOrganizerEmail,
        calendar_status: "verified",
        calendar_error: null,
        pending_provider_applied_at: nowIso,
        updated_at: nowIso,
      }).eq("tenant_id", input.tenantId)
        .eq("id", appointment.id)
        .eq("pending_request_id", input.requestId)
        .eq("pending_operation", "book")
        .eq("pending_lease_token", leaseToken)
        .select("*")
        .maybeSingle();
      if (saved.error || !saved.data) {
        throw new Error(`meeting_receipt_write_failed:${saved.error?.message || "row_changed"}`);
      }
      appointment = saved.data as AppointmentRow;
      receipt = providerReceipt;
    } catch (error) {
      const eventId = providerReceipt?.eventId || (
        error && typeof error === "object" && "eventId" in error && typeof error.eventId === "string"
          ? error.eventId
          : null
      );
      let compensated = false;
      if (eventId) {
        try {
          const cancelInput = {
            tenantId: input.tenantId,
            hostUserId: input.hostUserId,
            eventId,
            expectedOrganizerEmail,
          };
          await deps.cancelCalendar(cancelInput);
          compensated = true;
        } catch (compensationError) {
          console.error("[founder-meeting] booking compensation failed", {
            code: errorCode(compensationError, "calendar_cancel_failed"),
          });
        }
      }
      const reason = errorCode(error, "calendar_create_failed");
      const failurePatch = compensated
        ? {
            status: "cancelled",
            workflow_status: "cancelled",
            calendar_status: "cancelled",
            google_event_id: eventId,
            ...clearPendingFields(nowIso),
          }
        : {
            calendar_status: "failed",
            calendar_error: reason.slice(0, 500),
            ...(eventId ? { google_event_id: eventId } : {}),
            updated_at: nowIso,
          };
      const failure = await db.from("call_appointments").update(failurePatch)
        .eq("tenant_id", input.tenantId)
        .eq("id", appointment.id)
        .eq("pending_request_id", input.requestId)
        .eq("pending_lease_token", leaseToken);
      if (failure.error) {
        throw new Error(`meeting_failure_write_failed:${failure.error.message}`, { cause: error });
      }
      throw new Error(reason, { cause: error });
    }
  }

  assertOrganizer(receipt, expectedOrganizerEmail);
  const meeting: VerifiedFounderMeeting = {
    appointmentId: appointment.id,
    requestId: input.requestId,
    meetingAt,
    timezone: FOUNDER_MEETING_TIMEZONE,
    contact,
    receipt,
    revision: Number(appointment.revision || 1),
  };
  try {
    await ensureNotificationRows(
      db,
      meeting,
      input.tenantId,
      input.leadId,
      input.hostUserId,
      clientAgenda,
      deps.now(),
    );
  } catch (error) {
    // No lead transition has happened yet. Cancel the externally visible invite
    // instead of leaving a booking whose reminder workflow could never run.
    try {
      const cancelInput = {
        tenantId: input.tenantId,
        hostUserId: input.hostUserId,
        eventId: receipt.eventId,
        expectedOrganizerEmail,
      };
      await deps.cancelCalendar(cancelInput);
      await cancelOutstandingNotifications(db, appointment, "booking_compensated", nowIso);
      await db.from("call_appointments").update({
        status: "cancelled",
        workflow_status: "cancelled",
        calendar_status: "cancelled",
        ...clearPendingFields(nowIso),
      }).eq("tenant_id", input.tenantId).eq("id", appointment.id);
    } catch (compensationError) {
      console.error("[founder-meeting] notification compensation failed", {
        code: errorCode(compensationError, "meeting_notification_compensation_failed"),
      });
    }
    throw new Error(errorCode(error, "meeting_notification_insert_failed"), { cause: error });
  }
  return meeting;
}

async function reserveBookingTakeover(
  db: Db,
  appointment: AppointmentRow,
  requestId: string,
  meetingAt: string,
  nowMs: number,
): Promise<{ appointment: AppointmentRow; leaseToken: string }> {
  if (
    appointment.pending_request_id !== requestId ||
    appointment.pending_operation !== "book" ||
    appointment.pending_meeting_at !== meetingAt
  ) {
    throw new Error("meeting_transition_pending");
  }
  if (notificationLeaseIsFresh(appointment, nowMs)) {
    throw new Error("meeting_notification_in_progress");
  }
  const leaseToken = randomUUID();
  const nowIso = new Date(nowMs).toISOString();
  let query = db.from("call_appointments").update({
    pending_started_at: nowIso,
    pending_lease_token: leaseToken,
    notification_lease_token: null,
    notification_lease_expires_at: null,
    updated_at: nowIso,
  }).eq("tenant_id", appointment.tenant_id)
    .eq("id", appointment.id)
    .eq("pending_request_id", requestId)
    .eq("pending_operation", "book")
    .eq("pending_meeting_at", meetingAt)
    .eq("revision", Number(appointment.revision));
  query = nullableMatch(query, "pending_lease_token", appointment.pending_lease_token);
  query = nullableMatch(query, "pending_started_at", appointment.pending_started_at);
  query = nullableMatch(query, "notification_lease_token", appointment.notification_lease_token);
  query = nullableMatch(query, "notification_lease_expires_at", appointment.notification_lease_expires_at);
  const saved = await query.select("*").maybeSingle();
  if (saved.error || !saved.data) throw new Error("meeting_booking_conflict");
  return { appointment: saved.data as AppointmentRow, leaseToken };
}

export async function activateVerifiedFounderMeeting(
  tenantId: string,
  appointmentId: string,
  dependencyOverrides: Partial<FounderMeetingServiceDependencies> = {},
): Promise<void> {
  const deps = dependencies(dependencyOverrides);
  const appointment = await loadById(deps.db, tenantId, appointmentId);
  if (
    appointment.workflow_status === "active" &&
    appointment.status === "scheduled" &&
    appointment.calendar_status === "verified" &&
    !appointment.pending_request_id
  ) return;
  if (
    appointment.status !== "scheduled" ||
    appointment.calendar_status !== "verified" ||
    appointment.workflow_status !== "pending_transition" ||
    !["book", "reschedule"].includes(appointment.pending_operation || "") ||
    !asReceipt(appointment)
  ) {
    throw new Error("meeting_activation_failed:appointment_not_activatable");
  }
  const nowIso = new Date(deps.now()).toISOString();
  const result = await deps.db.from("call_appointments")
    .update({ workflow_status: "active", ...clearPendingFields(nowIso) })
    .eq("tenant_id", tenantId)
    .eq("id", appointmentId)
    .eq("lead_id", appointment.lead_id)
    .eq("revision", Number(appointment.revision))
    .eq("status", "scheduled")
    .eq("calendar_status", "verified")
    .eq("workflow_status", "pending_transition")
    .eq("pending_request_id", appointment.pending_request_id)
    .eq("pending_lease_token", appointment.pending_lease_token)
    .select("id")
    .maybeSingle();
  if (result.error || !result.data) {
    const raced = await loadById(deps.db, tenantId, appointmentId);
    if (
      raced.workflow_status === "active" &&
      raced.status === "scheduled" &&
      raced.calendar_status === "verified" &&
      !raced.pending_request_id
    ) return;
    throw new Error(`meeting_activation_failed:${result.error?.message || "row_changed"}`);
  }
}

export async function rescheduleVerifiedFounderMeeting(input: {
  tenantId: string;
  leadId: string;
  appointmentId: string;
  requestId: string;
  meetingAt: string;
}, dependencyOverrides: Partial<FounderMeetingServiceDependencies> = {}): Promise<VerifiedFounderMeeting> {
  const deps = dependencies(dependencyOverrides);
  const db = deps.db;
  const meetingEpoch = Date.parse(input.meetingAt);
  if (!Number.isFinite(meetingEpoch) || meetingEpoch <= deps.now()) {
    throw new Error("meeting_must_be_in_future");
  }
  const meetingAt = new Date(meetingEpoch).toISOString();
  let appointment = await loadById(db, input.tenantId, input.appointmentId, input.leadId);
  if (appointment.last_reschedule_request_id === input.requestId) {
    if (appointment.scheduled_for !== meetingAt) throw new Error("reschedule_request_mismatch");
    const meeting = meetingFromAppointment(appointment, input.requestId);
    await ensureNotificationRows(
      db,
      meeting,
      input.tenantId,
      input.leadId,
      appointment.assigned_to || appointment.created_by,
      boundedRequired(appointment.client_agenda, 500, "client_agenda_required"),
      deps.now(),
    );
    return meeting;
  }
  if (
    !(
      (appointment.status === "scheduled" && appointment.workflow_status === "active") ||
      (appointment.status === "no_answer" && appointment.workflow_status === "no_show") ||
      (
        appointment.workflow_status === "pending_transition" &&
        appointment.pending_request_id === input.requestId &&
        appointment.pending_operation === "reschedule"
      )
    )
  ) {
    if (appointment.workflow_status === "pending_transition") throw new Error("meeting_transition_pending");
    throw new Error("meeting_no_longer_reschedulable");
  }
  const existingReceipt = asReceipt(appointment);
  if (!existingReceipt || !appointment.google_event_id || !appointment.assigned_to || !appointment.organizer_email_snapshot) {
    throw new Error("verified_meeting_required");
  }
  const expectedOrganizerEmail = normalizedEmail(
    appointment.organizer_email_snapshot,
    "calendar_organizer_mismatch",
  );
  const hostUserId = appointment.assigned_to;
  const googleEventId = appointment.google_event_id;
  const reservation = await reserveOperation(
    db,
    appointment,
    "reschedule",
    input.requestId,
    meetingAt,
    deps.now(),
  );
  appointment = reservation.appointment;
  const leaseToken = reservation.leaseToken;
  const contact = contactFromAppointment(appointment);
  const clientAgenda = boundedRequired(appointment.client_agenda, 500, "client_agenda_required");
  const currentRevision = Number(appointment.revision || 1);
  const nowIso = new Date(deps.now()).toISOString();

  let receipt: GoogleCalendarReceipt;
  try {
    const calendarInput = {
      tenantId: input.tenantId,
      hostUserId,
      eventId: googleEventId,
      meetingAt,
      timezone: FOUNDER_MEETING_TIMEZONE,
      durationMinutes: FOUNDER_MEETING_DURATION_MINUTES,
      clientEmail: contact.email,
      clientName: contact.name || undefined,
      company: contact.company || undefined,
      website: contact.website || undefined,
      clientAgenda,
      expectedOrganizerEmail,
    };
    receipt = await deps.updateCalendar(calendarInput);
    assertOrganizer(receipt, expectedOrganizerEmail);
  } catch (error) {
    const reason = errorCode(error, "calendar_update_failed");
    await markPendingError(db, appointment, leaseToken, reason, nowIso);
    throw new Error(reason, { cause: error });
  }

  const nextRevision = currentRevision + 1;
  const saved = await db.from("call_appointments").update({
    scheduled_for: meetingAt,
    status: "scheduled",
    google_calendar_id: receipt.calendarId,
    google_event_id: receipt.eventId,
    google_event_html_link: receipt.htmlLink,
    google_meet_link: receipt.meetLink,
    google_ical_uid: receipt.iCalUID || null,
    organizer_email_snapshot: expectedOrganizerEmail,
    calendar_status: "verified",
    calendar_error: null,
    revision: nextRevision,
    workflow_status: "pending_transition",
    last_reschedule_request_id: input.requestId,
    last_rescheduled_at: nowIso,
    pending_provider_applied_at: nowIso,
    updated_at: nowIso,
  }).eq("tenant_id", input.tenantId)
    .eq("id", appointment.id)
    .eq("lead_id", input.leadId)
    .eq("revision", currentRevision)
    .eq("pending_request_id", input.requestId)
    .eq("pending_operation", "reschedule")
    .eq("pending_lease_token", leaseToken)
    .select("*")
    .maybeSingle();
  if (saved.error || !saved.data) {
    throw new Error(`meeting_reschedule_write_failed:${saved.error?.message || "row_changed"}`);
  }
  appointment = saved.data as AppointmentRow;
  await cancelOutstandingNotifications(
    db,
    { ...appointment, revision: currentRevision },
    "meeting_rescheduled",
    nowIso,
  );
  const meeting = meetingFromAppointment(appointment, input.requestId);
  await ensureNotificationRows(
    db,
    meeting,
    input.tenantId,
    input.leadId,
    hostUserId,
    clientAgenda,
    deps.now(),
  );
  return meeting;
}

function cancellationPreservesHistory(appointment: AppointmentRow, nowMs: number): boolean {
  const scheduledAt = Date.parse(appointment.scheduled_for);
  return (
    ["completed", "no_answer", "cancelled", "rescheduled"].includes(appointment.status) ||
    ["completed", "no_show", "cancelled"].includes(appointment.workflow_status) ||
    !Number.isFinite(scheduledAt) ||
    scheduledAt <= nowMs
  );
}

async function finalizeCancellation(
  db: Db,
  appointment: AppointmentRow,
  requestId: string,
  leaseToken: string,
  nowIso: string,
  pendingOperation = "cancel",
): Promise<AppointmentRow | null> {
  const notificationsAppointment = { ...appointment };
  await cancelOutstandingNotifications(db, notificationsAppointment, "meeting_cancelled", nowIso);
  const cancelled = await db.from("call_appointments").update({
    status: "cancelled",
    workflow_status: "cancelled",
    calendar_status: "cancelled",
    last_cancel_request_id: requestId,
    cancelled_at: nowIso,
    ...clearPendingFields(nowIso),
  }).eq("tenant_id", appointment.tenant_id)
    .eq("id", appointment.id)
    .eq("lead_id", appointment.lead_id)
    .eq("revision", Number(appointment.revision))
    .eq("pending_request_id", requestId)
    .eq("pending_operation", pendingOperation)
    .eq("pending_lease_token", leaseToken)
    .select("*")
    .maybeSingle();
  if (cancelled.error || !cancelled.data) return null;
  return cancelled.data as AppointmentRow;
}

export async function cancelVerifiedFounderMeeting(input: {
  tenantId: string;
  leadId: string;
  appointmentId: string;
  requestId: string;
}, dependencyOverrides: Partial<FounderMeetingServiceDependencies> = {}): Promise<FounderMeetingCancellationResult> {
  const deps = dependencies(dependencyOverrides);
  const db = deps.db;
  let appointment = await loadById(db, input.tenantId, input.appointmentId, input.leadId);
  if (
    appointment.last_cancel_request_id === input.requestId &&
    appointment.calendar_status === "cancelled" &&
    appointment.workflow_status === "cancelled"
  ) {
    return { disposition: "cancelled", appointmentId: appointment.id, requestId: input.requestId };
  }
  if (cancellationPreservesHistory(appointment, deps.now())) {
    return { disposition: "preserved", appointmentId: appointment.id, requestId: input.requestId };
  }
  if (!asReceipt(appointment) || !appointment.google_event_id || !appointment.assigned_to) {
    throw new Error("verified_meeting_required");
  }
  const alreadyReserved =
    appointment.workflow_status === "pending_transition" &&
    appointment.pending_request_id === input.requestId &&
    appointment.pending_operation === "cancel" &&
    Boolean(appointment.pending_lease_token);
  if (!(appointment.workflow_status === "active" || alreadyReserved)) {
    throw new Error("meeting_transition_pending");
  }
  let leaseToken: string;
  if (alreadyReserved && leaseIsFresh(appointment.pending_started_at, deps.now())) {
    leaseToken = appointment.pending_lease_token!;
  } else {
    const reservation = await reserveOperation(
      db,
      appointment,
      "cancel",
      input.requestId,
      appointment.scheduled_for,
      deps.now(),
    );
    appointment = reservation.appointment;
    leaseToken = reservation.leaseToken;
  }
  const nowIso = new Date(deps.now()).toISOString();
  try {
    const cancelInput = {
      tenantId: input.tenantId,
      hostUserId: appointment.assigned_to!,
      eventId: appointment.google_event_id!,
      expectedOrganizerEmail: appointment.organizer_email_snapshot!,
    };
    await deps.cancelCalendar(cancelInput);
    const providerMark = await db.from("call_appointments").update({
      pending_provider_applied_at: nowIso,
      updated_at: nowIso,
    }).eq("tenant_id", input.tenantId)
      .eq("id", appointment.id)
      .eq("pending_request_id", input.requestId)
      .eq("pending_lease_token", leaseToken)
      .select("*")
      .maybeSingle();
    if (providerMark.error || !providerMark.data) {
      return {
        disposition: "pending",
        appointmentId: appointment.id,
        requestId: input.requestId,
        error: "meeting_cancel_receipt_write_failed",
      };
    }
    appointment = providerMark.data as AppointmentRow;
    const saved = await finalizeCancellation(db, appointment, input.requestId, leaseToken, nowIso);
    if (!saved) {
      return {
        disposition: "pending",
        appointmentId: appointment.id,
        requestId: input.requestId,
        error: "meeting_cancel_write_failed",
      };
    }
    return { disposition: "cancelled", appointmentId: appointment.id, requestId: input.requestId };
  } catch (error) {
    const code = errorCode(error, "calendar_cancel_failed");
    try {
      await markPendingError(db, appointment, leaseToken, code, nowIso);
    } catch (writeError) {
      return {
        disposition: "pending",
        appointmentId: appointment.id,
        requestId: input.requestId,
        error: errorCode(writeError, "meeting_pending_error_write_failed"),
      };
    }
    return {
      disposition: "pending",
      appointmentId: appointment.id,
      requestId: input.requestId,
      error: code,
    };
  }
}

/** Reserve a future invite before the lead is durably closed lost. */
export async function prepareVerifiedFounderMeetingCancellation(input: {
  tenantId: string;
  leadId: string;
  appointmentId: string;
  requestId: string;
}, dependencyOverrides: Partial<FounderMeetingServiceDependencies> = {}): Promise<FounderMeetingCancellationResult> {
  const deps = dependencies(dependencyOverrides);
  let appointment = await loadById(
    deps.db,
    input.tenantId,
    input.appointmentId,
    input.leadId,
  );
  if (
    appointment.last_cancel_request_id === input.requestId &&
    appointment.calendar_status === "cancelled" &&
    appointment.workflow_status === "cancelled"
  ) {
    return { disposition: "cancelled", appointmentId: appointment.id, requestId: input.requestId };
  }
  if (cancellationPreservesHistory(appointment, deps.now())) {
    return { disposition: "preserved", appointmentId: appointment.id, requestId: input.requestId };
  }
  if (!asReceipt(appointment) || !appointment.google_event_id || !appointment.assigned_to) {
    throw new Error("verified_meeting_required");
  }
  if (
    appointment.workflow_status === "pending_transition" &&
    appointment.pending_request_id === input.requestId &&
    appointment.pending_operation === "cancel" &&
    appointment.pending_lease_token
  ) {
    return { disposition: "pending", appointmentId: appointment.id, requestId: input.requestId };
  }
  if (appointment.workflow_status !== "active" || appointment.status !== "scheduled") {
    throw new Error("meeting_transition_pending");
  }
  const reservation = await reserveOperation(
    deps.db,
    appointment,
    "cancel",
    input.requestId,
    appointment.scheduled_for,
    deps.now(),
  );
  appointment = reservation.appointment;
  return { disposition: "pending", appointmentId: appointment.id, requestId: input.requestId };
}

export async function closeVerifiedFounderMeeting(input: {
  tenantId: string;
  leadId: string;
  appointmentId: string;
  outcome: "completed" | "no_show";
}, dependencyOverrides: Partial<FounderMeetingServiceDependencies> = {}): Promise<void> {
  const deps = dependencies(dependencyOverrides);
  const db = deps.db;
  let appointment = await loadById(db, input.tenantId, input.appointmentId, input.leadId);
  const canonicalStatus = input.outcome === "no_show" ? "no_answer" : "completed";
  if (input.outcome === "no_show" && Date.parse(appointment.scheduled_for) > deps.now()) {
    throw new Error("meeting_not_started");
  }
  if (appointment.status === canonicalStatus && appointment.workflow_status === input.outcome) {
    await cancelOutstandingNotifications(
      db,
      appointment,
      `meeting_${input.outcome}`,
      new Date(deps.now()).toISOString(),
    );
    return;
  }
  if (
    appointment.workflow_status !== "active" ||
    appointment.status !== "scheduled" ||
    appointment.pending_request_id ||
    notificationLeaseIsFresh(appointment, deps.now())
  ) {
    throw new Error("meeting_close_conflict");
  }
  const nowIso = new Date(deps.now()).toISOString();
  let closeQuery = db.from("call_appointments").update({
    status: canonicalStatus,
    workflow_status: input.outcome,
    ...(input.outcome === "completed" ? { completed_at: nowIso } : {}),
    updated_at: nowIso,
  }).eq("tenant_id", input.tenantId)
    .eq("id", appointment.id)
    .eq("lead_id", input.leadId)
    .eq("revision", Number(appointment.revision))
    .eq("status", "scheduled")
    .eq("workflow_status", "active")
    .is("pending_request_id", null);
  closeQuery = nullableMatch(
    closeQuery,
    "notification_lease_token",
    appointment.notification_lease_token,
  );
  closeQuery = nullableMatch(
    closeQuery,
    "notification_lease_expires_at",
    appointment.notification_lease_expires_at,
  );
  const closed = await closeQuery.select("*").maybeSingle();
  if (closed.error || !closed.data) {
    throw new Error(`meeting_close_failed:${closed.error?.message || "row_changed"}`);
  }
  appointment = closed.data as AppointmentRow;
  await cancelOutstandingNotifications(db, appointment, `meeting_${input.outcome}`, nowIso);
}

function emptyReconciliation(): FounderMeetingReconciliationResult {
  return {
    considered: 0,
    activated: 0,
    cancelled: 0,
    compensated: 0,
    released: 0,
    failed: 0,
    errors: [],
  };
}

function mergeReconciliation(
  target: FounderMeetingReconciliationResult,
  source: FounderMeetingReconciliationResult,
): FounderMeetingReconciliationResult {
  target.considered += source.considered;
  target.activated += source.activated;
  target.cancelled += source.cancelled;
  target.compensated += source.compensated;
  target.released += source.released;
  target.failed += source.failed;
  target.errors.push(...source.errors);
  return target;
}

function leadData(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function leadConfirmsAppointment(
  appointment: AppointmentRow,
  lead: Record<string, unknown>,
  operation = appointment.pending_operation,
): boolean {
  if (operation === "cancel") {
    return lead.stage === "lost" || lead.deal_outcome === "lost";
  }
  const expectedMeetingAt = operation === "reschedule"
    ? appointment.pending_meeting_at
    : appointment.scheduled_for;
  return (
    lead.stage === "founder_meeting_booked" &&
    lead.calendar_appointment_id === appointment.id &&
    typeof lead.founder_meeting_at === "string" &&
    Boolean(expectedMeetingAt) &&
    new Date(lead.founder_meeting_at).toISOString() === expectedMeetingAt
  );
}

type SagaOperation = "book" | "reschedule" | "cancel";

function sagaOperation(value: string | null): SagaOperation | null {
  const normalized = value?.startsWith("compensating_")
    ? value.slice("compensating_".length)
    : value;
  return normalized === "book" || normalized === "reschedule" || normalized === "cancel"
    ? normalized
    : null;
}

async function acquireSagaReconciliationLease(
  db: Db,
  appointment: AppointmentRow,
  staleBefore: string,
  nowMs: number,
): Promise<{ appointment: AppointmentRow; operation: SagaOperation } | null> {
  const operation = sagaOperation(appointment.pending_operation);
  if (
    !operation ||
    appointment.workflow_status !== "pending_transition" ||
    !appointment.pending_request_id ||
    !appointment.pending_lease_token ||
    !appointment.pending_started_at ||
    appointment.pending_started_at > staleBefore
  ) return null;

  const leaseToken = randomUUID();
  const nowIso = new Date(nowMs).toISOString();
  const claimed = await db.from("call_appointments").update({
    pending_operation: `compensating_${operation}`,
    pending_started_at: nowIso,
    pending_lease_token: leaseToken,
    updated_at: nowIso,
  }).eq("tenant_id", appointment.tenant_id)
    .eq("id", appointment.id)
    .eq("lead_id", appointment.lead_id)
    .eq("revision", Number(appointment.revision))
    .eq("workflow_status", "pending_transition")
    .eq("pending_request_id", appointment.pending_request_id)
    .eq("pending_operation", appointment.pending_operation!)
    .eq("pending_started_at", appointment.pending_started_at)
    .eq("pending_lease_token", appointment.pending_lease_token)
    .lte("pending_started_at", staleBefore)
    .select("*")
    .maybeSingle();
  if (claimed.error) throw new Error(`meeting_saga_claim_failed:${claimed.error.message}`);
  if (!claimed.data) return null;
  return { appointment: claimed.data as AppointmentRow, operation };
}

async function finalizeConfirmedSaga(
  db: Db,
  appointment: AppointmentRow,
  operation: "book" | "reschedule",
  nowIso: string,
): Promise<boolean> {
  if (!asReceipt(appointment) || appointment.status !== "scheduled") return false;
  const finalized = await db.from("call_appointments").update({
    workflow_status: "active",
    ...clearPendingFields(nowIso),
  }).eq("tenant_id", appointment.tenant_id)
    .eq("id", appointment.id)
    .eq("lead_id", appointment.lead_id)
    .eq("revision", Number(appointment.revision))
    .eq("status", "scheduled")
    .eq("calendar_status", "verified")
    .eq("workflow_status", "pending_transition")
    .eq("pending_request_id", appointment.pending_request_id!)
    .eq("pending_operation", `compensating_${operation}`)
    .eq("pending_lease_token", appointment.pending_lease_token!)
    .select("id")
    .maybeSingle();
  return !finalized.error && Boolean(finalized.data);
}

async function releaseCancellationReservation(
  db: Db,
  appointment: AppointmentRow,
  nowIso: string,
): Promise<boolean> {
  const released = await db.from("call_appointments").update({
    workflow_status: "active",
    ...clearPendingFields(nowIso),
  }).eq("tenant_id", appointment.tenant_id)
    .eq("id", appointment.id)
    .eq("lead_id", appointment.lead_id)
    .eq("revision", Number(appointment.revision))
    .eq("pending_request_id", appointment.pending_request_id)
    .eq("pending_operation", appointment.pending_operation)
    .eq("pending_lease_token", appointment.pending_lease_token)
    .select("id")
    .maybeSingle();
  return !released.error && Boolean(released.data);
}

async function compensateReschedule(
  appointment: AppointmentRow,
  deps: FounderMeetingServiceDependencies,
  nowMs: number,
): Promise<boolean> {
  if (
    appointment.pending_operation !== "compensating_reschedule" ||
    !appointment.previous_scheduled_for ||
    !appointment.assigned_to ||
    !appointment.google_event_id ||
    !appointment.organizer_email_snapshot ||
    !appointment.pending_request_id ||
    !appointment.pending_lease_token
  ) return false;
  const contact = contactFromAppointment(appointment);
  const clientAgenda = boundedRequired(appointment.client_agenda, 500, "client_agenda_required");
  const expectedOrganizerEmail = normalizedEmail(
    appointment.organizer_email_snapshot,
    "calendar_organizer_mismatch",
  );
  const calendarInput = {
    tenantId: appointment.tenant_id,
    hostUserId: appointment.assigned_to,
    eventId: appointment.google_event_id,
    meetingAt: appointment.previous_scheduled_for,
    timezone: FOUNDER_MEETING_TIMEZONE,
    durationMinutes: FOUNDER_MEETING_DURATION_MINUTES,
    clientEmail: contact.email,
    clientName: contact.name || undefined,
    company: contact.company || undefined,
    website: contact.website || undefined,
    clientAgenda,
    expectedOrganizerEmail,
  };
  const nowIso = new Date(nowMs).toISOString();
  let working = appointment;
  let receipt = asReceipt(working);
  if (!working.pending_compensation_applied_at) {
    receipt = await deps.updateCalendar(calendarInput);
    assertOrganizer(receipt, expectedOrganizerEmail);
    const phaseRevision = Number(working.revision) + 1;
    const phase = await deps.db.from("call_appointments").update({
      scheduled_for: working.previous_scheduled_for,
      status: working.previous_status || "scheduled",
      workflow_status: "pending_transition",
      google_calendar_id: receipt.calendarId,
      google_event_id: receipt.eventId,
      google_event_html_link: receipt.htmlLink,
      google_meet_link: receipt.meetLink,
      google_ical_uid: receipt.iCalUID,
      organizer_email_snapshot: expectedOrganizerEmail,
      calendar_status: "verified",
      revision: phaseRevision,
      last_compensated_request_id: working.pending_request_id,
      last_reschedule_request_id: null,
      pending_compensation_applied_at: nowIso,
      updated_at: nowIso,
    }).eq("tenant_id", working.tenant_id)
      .eq("id", working.id)
      .eq("lead_id", working.lead_id)
      .eq("revision", Number(working.revision))
      .eq("pending_request_id", working.pending_request_id)
      .eq("pending_operation", working.pending_operation)
      .eq("pending_lease_token", working.pending_lease_token)
      .select("*")
      .maybeSingle();
    if (phase.error || !phase.data) return false;
    working = phase.data as AppointmentRow;
  }
  receipt = asReceipt(working);
  if (!receipt) return false;
  assertOrganizer(receipt, expectedOrganizerEmail);
  const restoredRevision = Number(working.revision);
  await cancelOutstandingNotifications(
    deps.db,
    { ...working, revision: Math.max(1, restoredRevision - 1) },
    "reschedule_compensated",
    nowIso,
  );
  if (
    (working.previous_status || "scheduled") === "scheduled" &&
    (working.previous_workflow_status || "active") === "active"
  ) {
    await ensureNotificationRows(
      deps.db,
      {
        appointmentId: working.id,
        requestId: working.pending_request_id!,
        meetingAt: working.previous_scheduled_for!,
        timezone: FOUNDER_MEETING_TIMEZONE,
        contact,
        receipt,
        revision: restoredRevision,
      },
      working.tenant_id,
      working.lead_id,
      working.assigned_to!,
      clientAgenda,
      nowMs,
    );
  }
  const restored = await deps.db.from("call_appointments").update({
    workflow_status: working.previous_workflow_status || "active",
    ...clearPendingFields(nowIso),
  }).eq("tenant_id", working.tenant_id)
    .eq("id", working.id)
    .eq("lead_id", working.lead_id)
    .eq("revision", restoredRevision)
    .eq("workflow_status", "pending_transition")
    .eq("pending_request_id", working.pending_request_id!)
    .eq("pending_operation", working.pending_operation!)
    .eq("pending_lease_token", working.pending_lease_token!)
    .eq("pending_compensation_applied_at", working.pending_compensation_applied_at!)
    .select("*")
    .maybeSingle();
  if (restored.error || !restored.data) return false;
  return true;
}

async function reconcileTenantFounderMeetingSagas(
  tenantId: string,
  nowMs: number,
  staleAfterMs: number,
  limit: number,
  deps: FounderMeetingServiceDependencies,
): Promise<FounderMeetingReconciliationResult> {
  const result = emptyReconciliation();
  const staleBefore = new Date(nowMs - staleAfterMs).toISOString();
  const pending = await deps.db.from("call_appointments")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("workflow_status", "pending_transition")
    .in("pending_operation", [
      "book", "reschedule", "cancel",
      "compensating_book", "compensating_reschedule", "compensating_cancel",
    ])
    .lte("pending_started_at", staleBefore)
    .order("pending_started_at", { ascending: true })
    .limit(limit);
  if (pending.error) {
    result.failed += 1;
    result.errors.push("meeting_saga_lookup_failed");
    return result;
  }
  for (const raw of (pending.data || []) as AppointmentRow[]) {
    result.considered += 1;
    try {
      const loaded = await loadById(deps.db, tenantId, raw.id, raw.lead_id);
      const claim = await acquireSagaReconciliationLease(
        deps.db,
        loaded,
        staleBefore,
        nowMs,
      );
      if (!claim) continue;
      let appointment = claim.appointment;
      const operation = claim.operation;
      const leadResult = await deps.db.from("tenant_records")
        .select("id,data")
        .eq("tenant_id", tenantId)
        .eq("id", appointment.lead_id)
        .eq("entity_type", "lead")
        .maybeSingle();
      if (leadResult.error) throw new Error("meeting_saga_lead_lookup_failed");
      const lead = leadData((leadResult.data as { data?: unknown } | null)?.data);
      const confirmed = Boolean(leadResult.data) && leadConfirmsAppointment(appointment, lead, operation);
      const nowIso = new Date(nowMs).toISOString();
      if (confirmed && (operation === "book" || operation === "reschedule")) {
        if (!await finalizeConfirmedSaga(deps.db, appointment, operation, nowIso)) {
          throw new Error("meeting_saga_activation_conflict");
        }
        result.activated += 1;
        continue;
      }
      if (operation === "book") {
        if (appointment.google_event_id && appointment.assigned_to) {
          const expectedOrganizerEmail = normalizedEmail(
            appointment.organizer_email_snapshot,
            "calendar_organizer_mismatch",
          );
          const cancelInput = {
            tenantId,
            hostUserId: appointment.assigned_to,
            eventId: appointment.google_event_id,
            expectedOrganizerEmail,
          };
          await deps.cancelCalendar(cancelInput);
        }
        await cancelOutstandingNotifications(
          deps.db,
          appointment,
          "booking_saga_compensated",
          nowIso,
        );
        const cancelled = await deps.db.from("call_appointments").update({
          status: "cancelled",
          workflow_status: "cancelled",
          calendar_status: "cancelled",
          last_compensated_request_id: appointment.pending_request_id,
          cancelled_at: nowIso,
          ...clearPendingFields(nowIso),
        }).eq("tenant_id", tenantId)
          .eq("id", appointment.id)
          .eq("lead_id", appointment.lead_id)
          .eq("revision", Number(appointment.revision))
          .eq("pending_request_id", appointment.pending_request_id)
          .eq("pending_operation", "compensating_book")
          .eq("pending_lease_token", appointment.pending_lease_token)
          .select("id")
          .maybeSingle();
        if (cancelled.error || !cancelled.data) throw new Error("meeting_saga_compensation_conflict");
        result.cancelled += 1;
        continue;
      }
      if (operation === "reschedule") {
        if (!await compensateReschedule(appointment, deps, nowMs)) {
          throw new Error("meeting_reschedule_compensation_failed");
        }
        result.compensated += 1;
        continue;
      }
      if (operation === "cancel" && confirmed) {
        if (!appointment.assigned_to || !appointment.google_event_id) {
          throw new Error("verified_meeting_required");
        }
        const expectedOrganizerEmail = normalizedEmail(
          appointment.organizer_email_snapshot,
          "calendar_organizer_mismatch",
        );
        await deps.cancelCalendar({
          tenantId,
          hostUserId: appointment.assigned_to,
          eventId: appointment.google_event_id,
          expectedOrganizerEmail,
        });
        const providerMark = await deps.db.from("call_appointments").update({
          pending_provider_applied_at: nowIso,
          updated_at: nowIso,
        }).eq("tenant_id", tenantId)
          .eq("id", appointment.id)
          .eq("pending_request_id", appointment.pending_request_id)
          .eq("pending_operation", "compensating_cancel")
          .eq("pending_lease_token", appointment.pending_lease_token)
          .select("*")
          .maybeSingle();
        if (providerMark.error || !providerMark.data) {
          throw new Error("meeting_cancel_receipt_write_failed");
        }
        appointment = providerMark.data as AppointmentRow;
        if (!await finalizeCancellation(
          deps.db,
          appointment,
          appointment.pending_request_id!,
          appointment.pending_lease_token!,
          nowIso,
          "compensating_cancel",
        )) {
          throw new Error("meeting_cancel_reconcile_pending");
        }
        result.cancelled += 1;
        continue;
      }
      if (!await releaseCancellationReservation(deps.db, appointment, nowIso)) {
        throw new Error("meeting_cancel_release_conflict");
      }
      result.released += 1;
    } catch (error) {
      result.failed += 1;
      result.errors.push(errorCode(error, "meeting_saga_reconcile_failed"));
    }
  }
  return result;
}

/**
 * Repair stale booking/reschedule/cancel sagas.
 *
 * With tenantId omitted, the system worker enumerates tenant ids first and then
 * calls the exact same tenant-filtered path. No appointment/lead read or write
 * is ever performed without an explicit tenant predicate, and the aggregate
 * result contains only counts plus stable error codes (no PII).
 */
export async function reconcileFounderMeetingSagas(input: {
  tenantId?: string;
  now?: Date;
  staleAfterMs?: number;
  limit?: number;
} = {}, dependencyOverrides: Partial<FounderMeetingServiceDependencies> = {}): Promise<FounderMeetingReconciliationResult> {
  const deps = dependencies(dependencyOverrides);
  const nowMs = input.now?.getTime() ?? deps.now();
  const staleAfterMs = Math.max(OPERATION_LEASE_MS, input.staleAfterMs ?? DEFAULT_RECONCILE_STALE_MS);
  const limit = Math.max(1, Math.min(500, input.limit ?? DEFAULT_RECONCILE_LIMIT));
  if (input.tenantId) {
    return reconcileTenantFounderMeetingSagas(
      input.tenantId,
      nowMs,
      staleAfterMs,
      limit,
      deps,
    );
  }

  const aggregate = emptyReconciliation();
  const tenants = await deps.db.from("tenants").select("id").order("id", { ascending: true });
  if (tenants.error) {
    aggregate.failed = 1;
    aggregate.errors.push("meeting_saga_tenant_enumeration_failed");
    return aggregate;
  }
  for (const row of (tenants.data || []) as Array<{ id?: unknown }>) {
    const tenantId = typeof row.id === "string" ? row.id : "";
    if (!tenantId) continue;
    mergeReconciliation(
      aggregate,
      await reconcileTenantFounderMeetingSagas(tenantId, nowMs, staleAfterMs, limit, deps),
    );
  }
  return aggregate;
}
