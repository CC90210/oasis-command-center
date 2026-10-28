import { after, NextRequest, NextResponse } from "next/server";
import { getClientIp } from "@/lib/api-helpers";
import { bookingCallRecorded, bookingMeetRoomDeps } from "@/lib/booking/meet-room";
import {
  loadRebookAppointment,
  loadRebookLead,
  pickRebookSlot,
  readRebookState,
  REBOOK_LEAD_STAGE,
  rebookHosts,
  rebookLeadPatch,
} from "@/lib/booking/rebook";
import { RebookNotConfiguredError, verifyRebookToken } from "@/lib/booking/rebook-token";
import { sameOrigin } from "@/lib/calendar/http";
import { recordAlertFailure } from "@/lib/forms/alert-failure";
import { AI_AUDIT_ALERT_SOURCE } from "@/lib/forms/ai-audit-notify";
import { pipelineLeadUrl } from "@/lib/forms/lead-link";
import {
  loadPublicBookingAvailability,
  publicBookingCreateSchema,
  readPublicBookingJson,
  type PublicBookingSlot,
} from "@/lib/forms/public-booking";
import { buildRebookedLeadAlert } from "@/lib/forms/public-booking-alert";
import { pushWorkspaceAlert } from "@/lib/notify/alert-route";
import { rateLimit } from "@/lib/rate-limit";
import { getServiceSupabase } from "@/lib/supabase-server";
import {
  activateVerifiedFounderMeeting,
  rescheduleVerifiedFounderMeeting,
  type VerifiedFounderMeeting,
} from "@/lib/website-sales-founder-meeting";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/forms/booking/rebook {token, starts_at, request_id}
 *
 * A lead whose founder meeting did not happen picks a new time from the signed
 * link in their email (app/book/rebook/[token], lib/booking/rebook.ts). The
 * SAME meeting moves: rescheduleVerifiedFounderMeeting patches the Google event,
 * moves or replaces the Oasis Meet room and queues the new revision's
 * reminders; the lead stays at Founder Meeting with the new time, through the
 * same transition_pipeline_lead receipt as every booking; then the meeting is
 * activated and the sales desk is told.
 *
 * One request id per chosen time (the page's), so a retry after a dropped
 * connection replays instead of moving the meeting twice.
 */
const RESCHEDULE_BAD_REQUEST = new Set(["meeting_must_be_in_future", "reschedule_request_mismatch"]);
const RESCHEDULE_CONFLICT = new Set([
  "verified_meeting_required",
  "meeting_no_longer_reschedulable",
  "meeting_transition_pending",
  "google_calendar_not_connected",
  "calendar_scope_required",
  "meeting_host_deactivated",
  "founder_slot_overlap",
  "meet_room_unavailable",
]);

function codeOf(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message.split(":", 1)[0] || fallback : fallback;
}

async function recordLead(input: {
  tenantId: string;
  leadId: string;
  requestId: string;
  meeting: VerifiedFounderMeeting;
  missedAt: string;
  occurredAt: string;
  expectedOwnerId: string | null;
}): Promise<{ ok: true; applied: boolean } | { ok: false; error: string }> {
  const db = getServiceSupabase();
  const transition = await db.rpc("transition_pipeline_lead", {
    p_tenant_id: input.tenantId,
    p_lead_id: input.leadId,
    p_expected_stage: REBOOK_LEAD_STAGE,
    p_expected_owner_id: input.expectedOwnerId,
    p_patch: rebookLeadPatch({
      startsAt: input.meeting.meetingAt,
      occurredAt: input.occurredAt,
      receipt: input.meeting.receipt,
      revision: input.meeting.revision,
    }),
    p_request_id: input.requestId,
    p_occurred_at: input.occurredAt,
    p_actor_user_id: "system:public-rebook",
    p_action: "public_rebook",
    p_interaction_type: "calendar_booking",
    p_subject: `${input.meeting.offerLabel} rebooked`,
    p_content: `The lead picked a new time from their rebook link: ${input.meeting.meetingAt} (missed ${input.missedAt}). Video call: ${input.meeting.receipt.meetLink}`,
    p_is_call: false,
    p_metadata: {
      appointment_id: input.meeting.appointmentId,
      starts_at: input.meeting.meetingAt,
      missed_meeting_at: input.missedAt,
      google_event_id: input.meeting.receipt.eventId,
      meet_url: input.meeting.receipt.meetLink,
      source: "public_rebook_link",
    },
  });
  const data = transition.data as { ok?: boolean; error?: string; idempotent?: boolean } | null;
  if (transition.error || data?.ok === false) {
    return { ok: false, error: transition.error?.message || data?.error || "refused" };
  }
  // `applied`: this call wrote the receipt (a replay answers idempotent), so the
  // sales desk is told exactly once, by whichever attempt recorded the rebook.
  return { ok: true, applied: data?.idempotent !== true };
}

/** Tell the sales desk once the lead record shows the new time (after the response). */
function alertRebooked(input: {
  tenantId: string;
  leadId: string;
  lead: Record<string, unknown> | null;
  clientName: string | null;
  missedAt: string;
  meeting: VerifiedFounderMeeting;
}): void {
  after(async () => {
    const db = getServiceSupabase();
    const lead = input.lead ?? {};
    const company = typeof lead.company === "string" ? lead.company : typeof lead.company_name === "string" ? lead.company_name : "";
    const label = input.meeting.offerLabel || "Founder meeting";
    const sent = await pushWorkspaceAlert(
      input.tenantId,
      buildRebookedLeadAlert({
        offerName: label,
        name: input.clientName || "",
        company,
        missedAt: input.missedAt,
        startsAt: input.meeting.meetingAt,
        meetUrl: input.meeting.receipt.meetLink,
        leadUrl: pipelineLeadUrl(input.leadId),
      }),
      { desk: "sales" },
    );
    if (!sent.delivered) {
      await recordAlertFailure({
        db,
        tenantId: input.tenantId,
        leadId: input.leadId,
        source: AI_AUDIT_ALERT_SOURCE,
        label: `${label} (rebooked)`,
        reason: sent.outcome,
        extra: "The new time is on the calendar; the Meet link is on the lead.",
        tag: "public-rebook.alert",
      });
    }
  });
}

async function answerBooked(tenantId: string, meeting: VerifiedFounderMeeting): Promise<NextResponse> {
  return NextResponse.json({
    ok: true,
    starts_at: meeting.meetingAt,
    ends_at: new Date(Date.parse(meeting.meetingAt) + meeting.durationMinutes * 60_000).toISOString(),
    meet_url: meeting.receipt.meetLink,
    time_zone: meeting.timezone,
    call_recorded: await bookingCallRecorded(tenantId, meeting.receipt.meetLink),
  });
}

function openerOf(slot: PublicBookingSlot | null): { email: string; displayName?: string } | null {
  const attendee = slot?.hosts.find((host) => host.role === "attendee");
  return attendee ? { email: attendee.email, displayName: attendee.displayName } : null;
}

function rescheduleFailure(error: unknown): NextResponse {
  const code = codeOf(error, "calendar_update_failed");
  console.error("[public-rebook.reschedule]", code);
  if (RESCHEDULE_BAD_REQUEST.has(code)) return NextResponse.json({ ok: false, error: code }, { status: 400 });
  if (code === "founder_slot_overlap") return NextResponse.json({ ok: false, error: "slot_unavailable" }, { status: 409 });
  if (code === "meeting_transition_pending") return NextResponse.json({ ok: false, error: "rebook_in_progress" }, { status: 409 });
  if (RESCHEDULE_CONFLICT.has(code)) return NextResponse.json({ ok: false, error: "rebook_unavailable" }, { status: 409 });
  // Uncertain (a provider error after the move was reserved): the page retries
  // under the SAME request id, which resumes it above.
  return NextResponse.json({ ok: false, error: "retry_required" }, { status: 503 });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!sameOrigin(req)) {
    return NextResponse.json({ ok: false, error: "cross_origin_refused" }, { status: 403 });
  }
  const limit = rateLimit({ key: `public-rebook:${getClientIp(req)}`, capacity: 6, refillPerSec: 1 / 60 });
  if (!limit.allowed) {
    return NextResponse.json({ ok: false, error: "rate_limited", retry_in_sec: limit.resetIn }, { status: 429 });
  }
  const parsed = publicBookingCreateSchema.safeParse(await readPublicBookingJson(req));
  if (!parsed.success) return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  const { token, request_id: requestId } = parsed.data;
  const startsMs = Date.parse(parsed.data.starts_at);
  if (!Number.isFinite(startsMs)) return NextResponse.json({ ok: false, error: "invalid_booking_request" }, { status: 400 });
  const startsAt = new Date(startsMs).toISOString();
  const db = getServiceSupabase();

  let claims: ReturnType<typeof verifyRebookToken>;
  try {
    claims = verifyRebookToken(token);
  } catch (error) {
    if (error instanceof RebookNotConfiguredError) {
      console.error("[public-rebook] rebook key not set");
      return NextResponse.json({ ok: false, error: "booking_unavailable" }, { status: 503 });
    }
    throw error;
  }
  if (!claims) return NextResponse.json({ ok: false, error: "rebook_closed" }, { status: 409 });

  try {
    const current = await loadRebookAppointment(db, claims.tenantId, claims.appointmentId);
    // THIS REQUEST AGAIN (the page retried after a dropped connection or a 503):
    // either the meeting already moved under this id, or the move was reserved
    // under it and did not finish. Both resume the same steps, each idempotent;
    // a link is never refused for a move its own request started.
    const moved = current?.last_reschedule_request_id === requestId;
    const reserved = current?.pending_request_id === requestId && current?.pending_operation === "reschedule";
    if (current && current.lead_id === claims.leadId && (moved || reserved)) {
      const target = moved ? current.scheduled_for : current.pending_meeting_at;
      if (target !== startsAt) {
        return NextResponse.json({ ok: false, error: "booking_request_mismatch" }, { status: 409 });
      }
      // The lead must still be one this link may rebook BEFORE anything is
      // resumed: a lead marked lost since the first attempt keeps its meeting
      // where it is, and the reconciler settles the stale reservation.
      const lead = await loadRebookLead(db, claims.tenantId, claims.leadId);
      if (
        !lead ||
        lead.stage !== REBOOK_LEAD_STAGE ||
        lead.calendar_appointment_id !== claims.appointmentId
      ) {
        return NextResponse.json({ ok: false, error: "rebook_closed" }, { status: 409 });
      }
      // A move reserved but not applied resumes only into a time still open with
      // the same hosts. Anything else (the time was taken since, or Google moved
      // the event before its receipt was saved) is the reconciler's to settle,
      // never a second write into a slot that may be double-booked.
      let slot: PublicBookingSlot | null = null;
      if (!moved) {
        slot = pickRebookSlot(
          await loadPublicBookingAvailability({ tenantId: claims.tenantId, durationMinutes: current.duration_minutes }),
          startsAt,
          rebookHosts(lead, current),
        );
        if (!slot) return NextResponse.json({ ok: false, error: "rebook_in_progress" }, { status: 409 });
      }
      let meeting: VerifiedFounderMeeting;
      try {
        meeting = await rescheduleVerifiedFounderMeeting(
          {
            tenantId: claims.tenantId,
            leadId: claims.leadId,
            appointmentId: claims.appointmentId,
            requestId,
            meetingAt: startsAt,
            openerAttendee: openerOf(slot),
            requireStartedBefore: new Date().toISOString(),
          },
          bookingMeetRoomDeps(),
        );
      } catch (error) {
        return rescheduleFailure(error);
      }
      // The lead still carries the missed time until this write replaces it.
      const missedAt = typeof lead.founder_meeting_at === "string" ? lead.founder_meeting_at : current.scheduled_for;
      const recorded = await recordLead({
        tenantId: claims.tenantId,
        leadId: claims.leadId,
        requestId,
        meeting,
        missedAt,
        occurredAt: new Date().toISOString(),
        expectedOwnerId: typeof lead.assigned_to === "string" ? lead.assigned_to : null,
      });
      if (!recorded.ok) {
        // Never activate a meeting the lead record does not show: the
        // reconciler can still settle it, and the next retry finishes it.
        console.error("[public-rebook.replay.transition]", recorded.error);
        return NextResponse.json({ ok: false, error: "booking_sync_pending" }, { status: 503 });
      }
      await activateVerifiedFounderMeeting(claims.tenantId, claims.appointmentId);
      if (recorded.applied) {
        alertRebooked({ tenantId: claims.tenantId, leadId: claims.leadId, lead, clientName: current.client_name_snapshot, missedAt, meeting });
      }
      return await answerBooked(claims.tenantId, meeting);
    }

    const state = await readRebookState(db, token);
    if (state.state === "pending") {
      return NextResponse.json({ ok: false, error: "rebook_in_progress" }, { status: 409 });
    }
    if (state.state !== "open") {
      return NextResponse.json(
        { ok: false, error: state.state === "booked" ? "already_rebooked" : "rebook_closed" },
        { status: 409 },
      );
    }
    const available = await loadPublicBookingAvailability({
      tenantId: state.claims.tenantId,
      durationMinutes: state.durationMinutes,
    });
    const slot = pickRebookSlot(available, startsAt, rebookHosts(state.lead, state.appointment));
    if (!slot) {
      return NextResponse.json({ ok: false, error: "slot_unavailable" }, { status: 409 });
    }

    let meeting: VerifiedFounderMeeting;
    try {
      meeting = await rescheduleVerifiedFounderMeeting(
        {
          tenantId: state.claims.tenantId,
          leadId: state.claims.leadId,
          appointmentId: state.appointment.id,
          requestId,
          meetingAt: startsAt,
          // The slot's second host, if it has one: Google replaces the whole
          // attendee list on a move, so they are passed again or dropped.
          openerAttendee: openerOf(slot),
          // Only a meeting still in the past moves: checked on the row the
          // reservation compare-and-swaps on, so two tabs cannot both move it.
          requireStartedBefore: new Date().toISOString(),
        },
        bookingMeetRoomDeps(),
      );
    } catch (error) {
      return rescheduleFailure(error);
    }

    const occurredAt = new Date().toISOString();
    const recorded = await recordLead({
      tenantId: state.claims.tenantId,
      leadId: state.claims.leadId,
      requestId,
      meeting,
      missedAt: state.missedAt,
      occurredAt,
      expectedOwnerId: typeof state.lead.assigned_to === "string" ? state.lead.assigned_to : null,
    });
    if (!recorded.ok) {
      // The invite already moved: never undo a time the lead was just shown.
      // The reconciler activates the pending meeting from the appointment row,
      // and a retry of this request finishes the lead record (replay above).
      console.error("[public-rebook.transition]", recorded.error);
      return NextResponse.json({ ok: false, error: "booking_sync_pending" }, { status: 503 });
    }
    try {
      await activateVerifiedFounderMeeting(state.claims.tenantId, state.appointment.id);
    } catch (error) {
      console.error("[public-rebook.activation_pending]", codeOf(error, "meeting_activation_failed"));
    }

    if (recorded.applied) {
      alertRebooked({
        tenantId: state.claims.tenantId,
        leadId: state.claims.leadId,
        lead: state.lead,
        clientName: state.appointment.client_name_snapshot,
        missedAt: state.missedAt,
        meeting,
      });
    }

    return await answerBooked(state.claims.tenantId, meeting);
  } catch (error) {
    const code = codeOf(error, "rebook_failed");
    console.error("[public-rebook]", code);
    return NextResponse.json({ ok: false, error: "retry_required" }, { status: 503 });
  }
}
