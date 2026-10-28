/**
 * lib/booking/rebook.ts - a lead picks a new time for a founder meeting that did
 * not happen, from the signed link in their email (lib/booking/rebook-token.ts).
 *
 * The meeting is MOVED, never re-created: rescheduleVerifiedFounderMeeting
 * patches the same Google event, moves or replaces the Oasis Meet room, and
 * writes a fresh set of reminders for the new revision. The lead stays at
 * Founder Meeting with the new time on it, through the same
 * transition_pipeline_lead receipt every other booking writes, so the Pipeline,
 * the AI audit and the timeline all see one record.
 *
 * Which meetings a link may move ("open"):
 *   - closed as a no-show (status no_answer, workflow no_show), or
 *   - still "scheduled" but its start has passed: nobody closed it out yet.
 * And only while the lead is still at founder_meeting_booked and still points
 * at this appointment. A meeting already moved to a future time shows that
 * time ("booked"); a move in flight answers "pending"; anything else is
 * "closed" with a reply-to-us message. The move itself re-checks "still in the
 * past" atomically (rescheduleVerifiedFounderMeeting requireStartedBefore).
 *
 * ASCII only (tests/worker-source-one-byte.test.ts).
 */
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { verifyRebookToken, type RebookClaims } from "@/lib/booking/rebook-token";
import type { PublicBookingSlot } from "@/lib/forms/public-booking";

export const REBOOK_LEAD_STAGE = "founder_meeting_booked";

export type RebookAppointment = {
  id: string;
  tenant_id: string;
  lead_id: string;
  scheduled_for: string;
  status: string;
  workflow_status: string;
  meeting_kind: string | null;
  duration_minutes: number;
  revision: number;
  assigned_to: string | null;
  client_name_snapshot: string | null;
  offer_label: string | null;
  google_meet_link: string | null;
  last_reschedule_request_id: string | null;
  pending_request_id: string | null;
  pending_operation: string | null;
  pending_meeting_at: string | null;
};

export type RebookState =
  | {
      state: "open";
      claims: RebookClaims;
      appointment: RebookAppointment;
      lead: Record<string, unknown>;
      firstName: string;
      offerLabel: string;
      durationMinutes: number;
      missedAt: string;
    }
  | { state: "booked"; claims: RebookClaims; startsAt: string; durationMinutes: number; meetUrl: string | null; firstName: string }
  | { state: "pending" }
  | { state: "closed"; reason: string };

const APPOINTMENT_COLUMNS =
  "id,tenant_id,lead_id,scheduled_for,status,workflow_status,meeting_kind,duration_minutes,revision,assigned_to,client_name_snapshot,offer_label,google_meet_link,last_reschedule_request_id,pending_request_id,pending_operation,pending_meeting_at";

export function record(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function firstNameOf(name: string | null | undefined): string {
  const first = (name || "").trim().split(/\s+/)[0] || "";
  return first.slice(0, 60);
}

function asAppointment(row: Record<string, unknown>): RebookAppointment {
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    lead_id: String(row.lead_id),
    scheduled_for: String(row.scheduled_for),
    status: String(row.status),
    workflow_status: String(row.workflow_status),
    meeting_kind: row.meeting_kind == null ? null : String(row.meeting_kind),
    duration_minutes: Number(row.duration_minutes) || 15,
    revision: Number(row.revision) || 1,
    assigned_to: row.assigned_to == null ? null : String(row.assigned_to),
    client_name_snapshot: row.client_name_snapshot == null ? null : String(row.client_name_snapshot),
    offer_label: row.offer_label == null ? null : String(row.offer_label),
    google_meet_link: row.google_meet_link == null ? null : String(row.google_meet_link),
    last_reschedule_request_id: row.last_reschedule_request_id == null ? null : String(row.last_reschedule_request_id),
    pending_request_id: row.pending_request_id == null ? null : String(row.pending_request_id),
    pending_operation: row.pending_operation == null ? null : String(row.pending_operation),
    pending_meeting_at: row.pending_meeting_at == null ? null : String(row.pending_meeting_at),
  };
}

export async function loadRebookAppointment(
  db: SupabaseClient,
  tenantId: string,
  appointmentId: string,
): Promise<RebookAppointment | null> {
  const result = await db
    .from("call_appointments")
    .select(APPOINTMENT_COLUMNS)
    .eq("tenant_id", tenantId)
    .eq("id", appointmentId)
    .maybeSingle();
  if (result.error) throw new Error(`rebook_appointment_read_failed:${result.error.message}`);
  return result.data ? asAppointment(result.data as Record<string, unknown>) : null;
}

export async function loadRebookLead(
  db: SupabaseClient,
  tenantId: string,
  leadId: string,
): Promise<Record<string, unknown> | null> {
  const result = await db
    .from("tenant_records")
    .select("data")
    .eq("tenant_id", tenantId)
    .eq("entity_type", "lead")
    .eq("id", leadId)
    .maybeSingle();
  if (result.error) throw new Error(`rebook_lead_read_failed:${result.error.message}`);
  return result.data ? record((result.data as { data?: unknown }).data) : null;
}

/** A meeting a rebook link may move: a no-show, or a scheduled meeting whose start has passed. */
export function appointmentIsMissed(appointment: RebookAppointment, nowMs: number): boolean {
  if (appointment.status === "no_answer" && appointment.workflow_status === "no_show") return true;
  const startMs = Date.parse(appointment.scheduled_for);
  return (
    appointment.status === "scheduled" &&
    appointment.workflow_status === "active" &&
    Number.isFinite(startMs) &&
    startMs <= nowMs
  );
}

/**
 * What a rebook link opens to, decided on the server for the page and the
 * route alike. Never throws for a bad link; a database failure throws.
 */
export async function readRebookState(
  db: SupabaseClient,
  token: string | null | undefined,
  nowMs: number = Date.now(),
): Promise<RebookState> {
  const claims = verifyRebookToken(token, { nowMs });
  if (!claims) return { state: "closed", reason: "invalid_or_expired" };
  const appointment = await loadRebookAppointment(db, claims.tenantId, claims.appointmentId);
  if (!appointment || appointment.lead_id !== claims.leadId) return { state: "closed", reason: "not_found" };
  if (appointment.meeting_kind !== "founder_audit") return { state: "closed", reason: "not_a_founder_meeting" };
  const firstName = firstNameOf(appointment.client_name_snapshot);
  const startMs = Date.parse(appointment.scheduled_for);
  if (appointment.workflow_status === "pending_transition") return { state: "pending" };
  if (!appointmentIsMissed(appointment, nowMs)) {
    if (appointment.status === "scheduled" && Number.isFinite(startMs) && startMs > nowMs) {
      return {
        state: "booked",
        claims,
        startsAt: appointment.scheduled_for,
        durationMinutes: appointment.duration_minutes,
        meetUrl: appointment.google_meet_link,
        firstName,
      };
    }
    return { state: "closed", reason: "meeting_not_rebookable" };
  }
  const lead = await loadRebookLead(db, claims.tenantId, claims.leadId);
  if (!lead) return { state: "closed", reason: "lead_not_found" };
  if (text(lead.stage) !== REBOOK_LEAD_STAGE) return { state: "closed", reason: "lead_stage_changed" };
  if (text(lead.calendar_appointment_id) !== appointment.id) return { state: "closed", reason: "lead_has_other_meeting" };
  return {
    state: "open",
    claims,
    appointment,
    lead,
    firstName,
    offerLabel: appointment.offer_label || "call",
    durationMinutes: appointment.duration_minutes,
    missedAt: appointment.scheduled_for,
  };
}

/** The slot a lead picked, if it is still open and the meeting's own host is its organizer. */
export function pickRebookSlot(
  available: PublicBookingSlot[],
  startsAt: string,
  hostUserId: string | null,
): PublicBookingSlot | null {
  const slot = available.find((item) => item.start === startsAt);
  if (!slot) return null;
  const organizer = slot.hosts.find((host) => host.role === "organizer");
  if (!organizer) return null;
  if (hostUserId && organizer.userId !== hostUserId) return null;
  return slot;
}

/** The lead's record after a rebook: the new time and the new invite, same stage. */
export function rebookLeadPatch(input: {
  startsAt: string;
  occurredAt: string;
  receipt: { calendarId: string; eventId: string; htmlLink: string; meetLink: string; iCalUID?: string | null };
  revision: number;
}): Record<string, unknown> {
  return {
    stage: REBOOK_LEAD_STAGE,
    founder_meeting_status: "rescheduled",
    founder_meeting_at: input.startsAt,
    next_action_at: input.startsAt,
    rebooked_at: input.occurredAt,
    rebooked_by: "lead",
    calendar_event_status: "verified",
    google_calendar_id: input.receipt.calendarId,
    google_calendar_event_id: input.receipt.eventId,
    google_calendar_event_url: input.receipt.htmlLink,
    google_meet_link: input.receipt.meetLink,
    google_ical_uid: input.receipt.iCalUID || null,
    calendar_appointment_revision: input.revision,
  };
}
