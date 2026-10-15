import { after, NextRequest, NextResponse } from "next/server";
import { getClientIp } from "@/lib/api-helpers";
import { sameOrigin } from "@/lib/calendar/http";
import { AI_AUDIT_ALERT_SOURCE, ensureAiAuditSalesEvent } from "@/lib/forms/ai-audit-notify";
import { recordAlertFailure } from "@/lib/forms/alert-failure";
import {
  bookedLeadFacts,
  buildPublicBookingContact,
  buildPublicFunnelLeadPatch,
  ensurePublicFunnelBookingEvent,
  isPublicBookingStageBookable,
  loadPublicBookingSlots,
  mirrorPublicBookingToSchedules,
  publicBookingCreateSchema,
  publicBookingFounders,
  publicBookingOwnershipPatch,
  readPublicBookingJson,
  removePublicBookingScheduleMirrors,
  resolvePublicFunnelBooking,
} from "@/lib/forms/public-booking";
import { publicBookingDurationMinutes, publicBookingOfferLabel } from "@/lib/forms/public-booking-config";
import { pushWorkspaceAlert } from "@/lib/notify/alert-route";
import { buildBookedLeadAlert } from "@/lib/forms/public-booking-alert";
import { pipelineLeadUrl } from "@/lib/forms/lead-link";
import { rateLimit } from "@/lib/rate-limit";
import { getServiceSupabase } from "@/lib/supabase-server";
import {
  activateVerifiedFounderMeeting,
  compensatePendingFounderMeetingBooking,
  createVerifiedFounderMeeting,
} from "@/lib/website-sales-founder-meeting";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RESOLUTION_ERRORS = new Set([
  "booking_form_not_found",
  "booking_form_not_completed",
  "booking_submission_read_failed",
  "booking_lead_not_found",
  "public_booking_founders_unavailable",
]);
const PROVIDER_ERRORS = new Set([
  "google_calendar_not_connected",
  "calendar_scope_required",
  "calendar_organizer_mismatch",
  "workspace_calendar_token_invalid",
  "calendar_create_failed",
  "calendar_read_failed",
  "google_meet_link_missing",
  "public_booking_schedule_calendar_missing",
  "public_booking_schedule_write_failed",
]);
/**
 * The visitor's own details cannot make a call: refused BEFORE anything is written, with
 * a code the calendar can explain, instead of the generic "availability unavailable" that
 * no retry could ever fix.
 */
const CONTACT_ERRORS = new Set(["invalid_client_phone", "client_phone_required", "client_email_required"]);

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function safeErrorCode(error: unknown, allowed: Set<string>, fallback: string): string {
  const raw = error instanceof Error ? error.message.split(":", 1)[0] : "";
  if (raw.startsWith("token_")) return "invalid_booking_token";
  return allowed.has(raw) ? raw : fallback;
}

async function compensatePublicBooking(input: {
  db: ReturnType<typeof getServiceSupabase>;
  tenantId: string;
  leadId: string;
  requestId: string;
  appointmentId?: string | null;
}): Promise<boolean> {
  const { db, tenantId, leadId, requestId, appointmentId } = input;
  if (!appointmentId) return false;
  let providerCompensated = false;
  try {
    await compensatePendingFounderMeetingBooking({
      tenantId,
      leadId,
      appointmentId,
      requestId,
    });
    providerCompensated = true;
  } catch (error) {
    console.error("[public-booking.compensate.calendar]", error);
  }
  try {
    await removePublicBookingScheduleMirrors({ db, tenantId, appointmentId });
  } catch (error) {
    console.error("[public-booking.compensate.schedule]", error);
  }
  return providerCompensated;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!sameOrigin(req)) {
    return NextResponse.json({ ok: false, error: "cross_origin_refused" }, { status: 403 });
  }
  const limit = rateLimit({
    key: `public-booking-create:${getClientIp(req)}`,
    capacity: 6,
    refillPerSec: 1 / 60,
  });
  if (!limit.allowed) {
    return NextResponse.json(
      { ok: false, error: "rate_limited", retry_in_sec: limit.resetIn },
      { status: 429 },
    );
  }
  const parsed = publicBookingCreateSchema.safeParse(await readPublicBookingJson(req));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  const body = parsed.data;

  const db = getServiceSupabase();
  const requestId = body.request_id;
  const startsAtMs = Date.parse(body.starts_at);
  if (!Number.isFinite(startsAtMs)) {
    return NextResponse.json({ ok: false, error: "invalid_booking_request" }, { status: 400 });
  }
  const startsAt = new Date(startsAtMs).toISOString();
  let context: Awaited<ReturnType<typeof resolvePublicFunnelBooking>>;
  let founders: Awaited<ReturnType<typeof publicBookingFounders>>;
  try {
    context = await resolvePublicFunnelBooking(db, body.token);
    founders = await publicBookingFounders(context.tenantId);
  } catch (error) {
    const code = safeErrorCode(error, RESOLUTION_ERRORS, "booking_unavailable");
    const status = code === "invalid_booking_token" || code === "booking_form_not_completed" ? 400 : code.includes("not_found") ? 404 : 503;
    if (status >= 500) console.error("[public-booking.resolve]", error);
    return NextResponse.json({ ok: false, error: code }, { status });
  }
  const durationMinutes = publicBookingDurationMinutes(context.formSlug);
  const offerLabel = publicBookingOfferLabel(context.formSlug);
  const combined = { ...context.answers, ...context.lead };
  const company = text(combined.company_name) || text(combined.company);
  const prospectName = text(combined.name);
  const prospectEmail = text(combined.email).toLowerCase();
  const { revenue, bottleneck } = bookedLeadFacts(combined);

  const priorAppointment = text(context.lead.calendar_appointment_id);
  const priorRequest = text(context.lead.public_booking_request_id);
  if (priorAppointment && priorRequest !== requestId) {
    return NextResponse.json({ ok: false, error: "already_booked" }, { status: 409 });
  }
  if (priorAppointment && priorRequest === requestId) {
    const bookedStart = text(context.lead.founder_meeting_at);
    if (bookedStart !== startsAt) {
      return NextResponse.json({ ok: false, error: "booking_request_mismatch" }, { status: 409 });
    }
    const meetUrl = text(context.lead.google_meet_link);
    const calendarUrl = text(context.lead.google_calendar_event_url);
    const providerEventId = text(context.lead.google_calendar_event_id);
    if (!meetUrl || !calendarUrl || !providerEventId) {
      console.error("[public-booking.replay] stored booking is missing its Google receipt", {
        leadId: context.leadId,
        appointmentId: priorAppointment,
      });
      return NextResponse.json({ ok: false, error: "booking_receipt_unavailable" }, { status: 503 });
    }
    const storedDuration = Number(context.lead.audit_duration_minutes);
    const replayDuration = Number.isInteger(storedDuration) && storedDuration >= 15 && storedDuration <= 120
      ? storedDuration
      : durationMinutes;
    try {
      await mirrorPublicBookingToSchedules({
        db,
        tenantId: context.tenantId,
        leadId: context.leadId,
        appointmentId: priorAppointment,
        providerEventId,
        meetUrl,
        startsAt,
        endsAt: new Date(startsAtMs + replayDuration * 60_000).toISOString(),
        prospectName,
        company,
        formName: context.formName,
        prospectEmail,
        founders,
      });
      await activateVerifiedFounderMeeting(context.tenantId, priorAppointment);
    } catch (error) {
      console.error("[public-booking.replay.repair]", error);
      return NextResponse.json({ ok: false, error: "booking_sync_pending" }, { status: 503 });
    }
    return NextResponse.json({
      ok: true,
      starts_at: startsAt,
      ends_at: new Date(startsAtMs + replayDuration * 60_000).toISOString(),
      meet_url: meetUrl,
      calendar_url: calendarUrl,
      time_zone: "America/Toronto",
    });
  }

  const currentStage = text(context.lead.stage);
  if (!isPublicBookingStageBookable(currentStage)) {
    return NextResponse.json({ ok: false, error: "lead_stage_not_bookable" }, { status: 409 });
  }

  let available: string[];
  try {
    available = await loadPublicBookingSlots({
      tenantId: context.tenantId,
      founders,
      durationMinutes,
    });
  } catch (error) {
    console.error("[public-booking.live-availability]", error);
    return NextResponse.json({ ok: false, error: "availability_unavailable" }, { status: 503 });
  }
  if (!available.includes(startsAt)) {
    return NextResponse.json({ ok: false, error: "slot_unavailable" }, { status: 409 });
  }

  const endAt = new Date(Date.parse(startsAt) + durationMinutes * 60_000).toISOString();
  let meeting: Awaited<ReturnType<typeof createVerifiedFounderMeeting>> | null = null;
  try {
    meeting = await createVerifiedFounderMeeting({
      tenantId: context.tenantId,
      leadId: context.leadId,
      actorUserId: founders.host.auth_user_id,
      hostUserId: founders.host.auth_user_id,
      requestId,
      meetingAt: startsAt,
      durationMinutes,
      offerLabel,
      contact: buildPublicBookingContact(combined),
      clientAgenda: `A ${durationMinutes}-minute ${context.formName} call with OASIS AI Solutions.`,
      handoffNote: bottleneck || `Public ${context.formSlug} booking.`,
      smsConsent: false,
      expectedOrganizerEmail: founders.host.email,
      openerAttendee: {
        email: founders.opener.email,
        displayName: founders.opener.full_name || founders.opener.display_name || "Adon",
      },
      confirmations: {
        contactConfirmed: true,
        clientAgreedToTime: true,
        handoffComplete: true,
      },
    });
    await mirrorPublicBookingToSchedules({
      db,
      tenantId: context.tenantId,
      leadId: context.leadId,
      appointmentId: meeting.appointmentId,
      providerEventId: meeting.receipt.eventId,
      meetUrl: meeting.receipt.meetLink,
      startsAt,
      endsAt: endAt,
      prospectName,
      company,
      formName: context.formName,
      prospectEmail,
      founders,
    });
  } catch (error) {
    const errorCode = error instanceof Error ? error.message.split(":", 1)[0] : "";
    if (CONTACT_ERRORS.has(errorCode)) {
      // Thrown by the service's own validation before any row or event exists:
      // nothing to compensate.
      return NextResponse.json({ ok: false, error: errorCode }, { status: 422 });
    }
    const compensated = await compensatePublicBooking({
      db,
      tenantId: context.tenantId,
      leadId: context.leadId,
      requestId,
      appointmentId: meeting?.appointmentId,
    });
    console.error("[public-booking.provider]", error);
    if (error instanceof Error && /meeting_intent_insert_failed:.*(?:unique|constraint|founder_slot_overlap)/iu.test(error.message)) {
      return NextResponse.json({ ok: false, error: "slot_unavailable" }, { status: 409 });
    }
    if (compensated || errorCode === "booking_compensated" || errorCode === "booking_request_cancelled") {
      return NextResponse.json({ ok: false, error: "retry_required" }, { status: 503 });
    }
    const code = safeErrorCode(error, PROVIDER_ERRORS, "booking_create_failed");
    return NextResponse.json({ ok: false, error: code }, { status: 503 });
  }
  if (!meeting) {
    await compensatePublicBooking({ db, tenantId: context.tenantId, leadId: context.leadId, requestId });
    return NextResponse.json({ ok: false, error: "booking_create_failed" }, { status: 503 });
  }

  const occurredAt = new Date().toISOString();
  const ownership = publicBookingOwnershipPatch(context.lead, founders);
  const leadPatch = {
    ...buildPublicFunnelLeadPatch(combined, "meeting_booked", occurredAt),
    stage: "founder_meeting_booked",
    ...ownership,
    booked_founder: founders.host.auth_user_id,
    audit_host_user_id: founders.host.auth_user_id,
    audit_host_email: founders.host.email,
    audit_host_role: "owner",
    audit_duration_minutes: durationMinutes,
    calendar_event_status: "verified",
    calendar_confirmation_method: "server_google_calendar_api",
    calendar_confirmed_at: occurredAt,
    calendar_confirmed_by: founders.host.auth_user_id,
    calendar_appointment_id: meeting.appointmentId,
    google_calendar_id: meeting.receipt.calendarId,
    google_calendar_event_id: meeting.receipt.eventId,
    google_calendar_event_url: meeting.receipt.htmlLink,
    google_meet_link: meeting.receipt.meetLink,
    google_ical_uid: meeting.receipt.iCalUID || null,
    founder_meeting_at: startsAt,
    next_action_at: startsAt,
    public_booking_request_id: requestId,
    sales_motion: "inbound_warm",
  };
  const transition = await db.rpc("transition_pipeline_lead", {
    p_tenant_id: context.tenantId,
    p_lead_id: context.leadId,
    p_expected_stage: currentStage,
    p_expected_owner_id: typeof context.lead.assigned_to === "string" ? context.lead.assigned_to : null,
    p_patch: leadPatch,
    p_request_id: requestId,
    p_occurred_at: occurredAt,
    p_actor_user_id: founders.host.auth_user_id,
    p_action: "public_funnel_booking",
    p_interaction_type: "calendar_booking",
    p_subject: `${context.formName} booked`,
    p_content: `${context.formName} booked for ${startsAt}. Google Meet: ${meeting.receipt.meetLink}`,
    p_is_call: false,
    p_metadata: {
      appointment_id: meeting.appointmentId,
      starts_at: startsAt,
      google_event_id: meeting.receipt.eventId,
      meet_url: meeting.receipt.meetLink,
      source: "public_oasis_funnel_calendar",
      form_id: context.formId,
      form_slug: context.formSlug,
    },
  });
  const transitionData = transition.data as { ok?: boolean; error?: string } | null;
  if (transition.error || transitionData?.ok === false) {
    const compensated = await compensatePublicBooking({
      db,
      tenantId: context.tenantId,
      leadId: context.leadId,
      requestId,
      appointmentId: meeting.appointmentId,
    });
    console.error("[public-booking.transition]", {
      error: transition.error?.message || transitionData?.error,
    });
    return NextResponse.json(
      { ok: false, error: compensated ? "retry_required" : "booking_transition_failed" },
      { status: 503 },
    );
  }
  try {
    await activateVerifiedFounderMeeting(context.tenantId, meeting.appointmentId);
  } catch (error) {
    // The durable lead receipt lets the existing founder-meeting reconciler
    // activate this pending saga. Do not cancel a client-visible invite after
    // the lead transition already committed.
    console.error("[public-booking.activation_pending]", error);
  }
  after(async () => {
    if (context.formSlug === "ai-audit") {
      const salesEvent = await ensureAiAuditSalesEvent({
        db,
        tenantId: context.tenantId,
        formId: context.formId,
        leadId: context.leadId,
        event: "booked",
        booking: { startsAt, meetUrl: meeting.receipt.meetLink, appointmentId: meeting.appointmentId },
      });
      if (!salesEvent.ok) console.error("[public-booking.sales-event]", salesEvent.error);
    } else {
      const salesEvent = await ensurePublicFunnelBookingEvent({
        db,
        tenantId: context.tenantId,
        formId: context.formId,
        formSlug: context.formSlug,
        leadId: context.leadId,
        startsAt,
        meetUrl: meeting.receipt.meetLink,
        appointmentId: meeting.appointmentId,
      });
      if (!salesEvent.ok) console.error("[public-booking.sales-event]", salesEvent.error);
    }
    // The sales desk (CC + Adon). Which chat that is comes from the workspace in
    // lib/notify/alert-route.ts; a call booked is the alert they most need fast.
    const sent = await pushWorkspaceAlert(
      context.tenantId,
      buildBookedLeadAlert({
        offerName: context.formName,
        name: prospectName,
        company,
        revenue,
        bottleneck,
        startsAt,
        meetUrl: meeting.receipt.meetLink,
        leadUrl: pipelineLeadUrl(context.leadId),
      }),
      { desk: "sales" },
    );
    if (!sent.delivered) {
      // Same durable marker the started and completed alerts leave: on the lead's own
      // timeline, where it is seen, not in a log nobody reads.
      await recordAlertFailure({
        db,
        tenantId: context.tenantId,
        leadId: context.leadId,
        source: AI_AUDIT_ALERT_SOURCE,
        label: `${context.formName} (booked)`,
        reason: sent.outcome,
        extra: "The call is on the calendar; the Meet link is on the lead.",
        tag: "public-booking.telegram",
      });
    }
  });

  return NextResponse.json({
    ok: true,
    starts_at: startsAt,
    ends_at: endAt,
    meet_url: meeting.receipt.meetLink,
    calendar_url: meeting.receipt.htmlLink,
    time_zone: meeting.timezone,
  });
}
