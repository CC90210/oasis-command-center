import { after, NextRequest, NextResponse } from "next/server";
import { getClientIp } from "@/lib/api-helpers";
import { bookingCallRecorded, bookingMeetRoomDeps } from "@/lib/booking/meet-room";
import {
  loadRebookAppointment,
  loadRebookLead,
  pickRebookSlot,
  readRebookState,
  REBOOK_LEAD_STAGE,
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
}): Promise<{ ok: true } | { ok: false; error: string }> {
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
  const data = transition.data as { ok?: boolean; error?: string } | null;
  if (transition.error || data?.ok === false) {
    return { ok: false, error: transition.error?.message || data?.error || "refused" };
  }
  return { ok: true };
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
    // A REPLAY of this request (the page retried after a dropped connection):
    // the meeting already moved under this id, so finish the same steps again,
    // each idempotent, instead of refusing a link whose revision moved on.
    const current = await loadRebookAppointment(db, claims.tenantId, claims.appointmentId);
    if (current && current.lead_id === claims.leadId && current.last_reschedule_request_id === requestId) {
      if (current.scheduled_for !== startsAt) {
        return NextResponse.json({ ok: false, error: "booking_request_mismatch" }, { status: 409 });
      }
      const meeting = await rescheduleVerifiedFounderMeeting(
        { tenantId: claims.tenantId, leadId: claims.leadId, appointmentId: claims.appointmentId, requestId, meetingAt: startsAt },
        bookingMeetRoomDeps(),
      );
      const lead = await loadRebookLead(db, claims.tenantId, claims.leadId);
      const recorded = await recordLead({
        tenantId: claims.tenantId,
        leadId: claims.leadId,
        requestId,
        meeting,
        missedAt: String(current.scheduled_for),
        occurredAt: new Date().toISOString(),
        expectedOwnerId: lead && typeof lead.assigned_to === "string" ? lead.assigned_to : null,
      });
      if (!recorded.ok) console.error("[public-rebook.replay.transition]", recorded.error);
      await activateVerifiedFounderMeeting(claims.tenantId, claims.appointmentId);
      return await answerBooked(claims.tenantId, meeting);
    }

    const state = await readRebookState(db, token);
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
    if (!pickRebookSlot(available, startsAt, state.appointment.assigned_to)) {
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
        },
        bookingMeetRoomDeps(),
      );
    } catch (error) {
      const code = codeOf(error, "calendar_update_failed");
      console.error("[public-rebook.reschedule]", code);
      if (RESCHEDULE_BAD_REQUEST.has(code)) return NextResponse.json({ ok: false, error: code }, { status: 400 });
      if (code === "founder_slot_overlap") return NextResponse.json({ ok: false, error: "slot_unavailable" }, { status: 409 });
      if (RESCHEDULE_CONFLICT.has(code)) return NextResponse.json({ ok: false, error: "rebook_unavailable" }, { status: 409 });
      return NextResponse.json({ ok: false, error: "retry_required" }, { status: 503 });
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

    after(async () => {
      const company = typeof state.lead.company === "string" ? state.lead.company : typeof state.lead.company_name === "string" ? state.lead.company_name : "";
      const sent = await pushWorkspaceAlert(
        state.claims.tenantId,
        buildRebookedLeadAlert({
          offerName: meeting.offerLabel || "Founder meeting",
          name: state.appointment.client_name_snapshot || "",
          company,
          missedAt: state.missedAt,
          startsAt: meeting.meetingAt,
          meetUrl: meeting.receipt.meetLink,
          leadUrl: pipelineLeadUrl(state.claims.leadId),
        }),
        { desk: "sales" },
      );
      if (!sent.delivered) {
        await recordAlertFailure({
          db,
          tenantId: state.claims.tenantId,
          leadId: state.claims.leadId,
          source: AI_AUDIT_ALERT_SOURCE,
          label: `${meeting.offerLabel || "Founder meeting"} (rebooked)`,
          reason: sent.outcome,
          extra: "The new time is on the calendar; the Meet link is on the lead.",
          tag: "public-rebook.alert",
        });
      }
    });

    return await answerBooked(state.claims.tenantId, meeting);
  } catch (error) {
    const code = codeOf(error, "rebook_failed");
    console.error("[public-rebook]", code);
    return NextResponse.json({ ok: false, error: "retry_required" }, { status: 503 });
  }
}
