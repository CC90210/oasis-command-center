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
  loadPublicBookingAvailability,
  mirrorPublicBookingToSchedules,
  publicBookingCreateSchema,
  publicBookingFounders,
  publicBookingHostsById,
  publicBookingOwnershipPatch,
  stringList,
  type PublicBookingSlot,
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
import { getTursoClient } from "@/lib/turso";
import { GoogleCalendarIntegrationError } from "@/lib/integrations/google-calendar";
import {
  claimPublicBooking,
  publicBookingVisitorKey,
  releasePublicBooking,
  type PublicBookingClaim,
} from "@/lib/forms/public-booking-cap";
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
/**
 * Thrown by createVerifiedFounderMeeting (lib/website-sales-founder-meeting.ts)
 * BEFORE its Google call: this attempt booked nothing, so it gives back its
 * hold on the cap place (lib/forms/public-booking-cap.ts). The place itself is
 * freed only once no attempt of the request holds it, so a retry that hits one
 * of these never frees the place of an attempt still booking. That includes
 * the ones a racing retry gets while a sibling attempt owns the booking
 * (meeting_transition_pending, meeting_notification_in_progress,
 * meeting_booking_conflict; Codex review of #670): the sibling keeps its own
 * hold. tests/public-booking-cap.test.ts fails when the service throws a code
 * before its Google call that is neither here nor handled above. Codes not
 * listed keep the hold.
 */
const PRE_PROVIDER_ERRORS = new Set([
  "meeting_transition_pending",
  "meeting_notification_in_progress",
  "meeting_booking_conflict",
  "meeting_intent_missing",
  "booking_request_mismatch",
  "booking_confirmations_required",
  "client_agenda_required",
  "handoff_note_required",
  "audit_host_email_required",
  "meeting_must_be_in_future",
  "sms_consent_requires_phone",
  "invalid_client_website",
  "meeting_duration_invalid",
  "meeting_offer_label_invalid",
  "meeting_intent_lookup_failed",
  "meeting_intent_insert_failed",
]);
/**
 * Thrown by the Google calendar code (lib/integrations/google-calendar.ts) while
 * it sets up, before it sends Google any request: the input check, a host with no
 * connected or wrongly scoped work account, an account that is not the approved
 * one. No event can exist, so the hold goes back (Codex review of #670, pass 6).
 * Token failures are NOT here: a token is refreshed again on a 401 in the middle
 * of a call, after an event may exist. tests/public-booking-cap.test.ts fails if
 * one of these codes is ever thrown once a request can have gone out.
 */
const CALENDAR_SETUP_ERRORS = new Set([
  "invalid_request",
  "google_calendar_not_connected",
  "calendar_scope_required",
  "calendar_organizer_mismatch",
]);
/** The service's limit on a handoff note (boundedRequired in lib/website-sales-founder-meeting.ts). */
const HANDOFF_NOTE_MAX = 4000;

/** The meeting failed in the calendar code's setup, so Google was never asked (CALENDAR_SETUP_ERRORS). */
function calendarNeverAsked(error: unknown): boolean {
  const cause = error instanceof Error ? error.cause : undefined;
  return cause instanceof GoogleCalendarIntegrationError && !cause.eventId && CALENDAR_SETUP_ERRORS.has(cause.code);
}

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
      // The hosts this booking was made with (stored on the lead), so a replay
      // repairs the same Schedule copies the first request wrote. A booking
      // made before hosts were stored was always both founders, so it
      // replays with both (Codex review of #628), never the organizer alone.
      const storedHostIds = stringList(context.lead.public_booking_host_ids);
      const hosts = await publicBookingHostsById(
        context.tenantId,
        storedHostIds.length ? storedHostIds : [founders.host.auth_user_id, founders.opener.auth_user_id],
      );
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
        hosts,
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

  let available: PublicBookingSlot[];
  try {
    available = await loadPublicBookingAvailability({
      tenantId: context.tenantId,
      durationMinutes,
    });
  } catch (error) {
    console.error("[public-booking.live-availability]", error);
    return NextResponse.json({ ok: false, error: "availability_unavailable" }, { status: 503 });
  }
  const slot = available.find((item) => item.start === startsAt);
  // The hosts on duty for THIS slot (lib/booking/hours.ts): the organizer owns
  // the Google event; an on-duty attendee (Adon, Sunday to Thursday) is invited.
  // On Friday and Saturday the organizer is on duty alone and nobody else is.
  const organizer = slot?.hosts.find((host) => host.role === "organizer");
  if (!slot || !organizer) {
    return NextResponse.json({ ok: false, error: "slot_unavailable" }, { status: 409 });
  }
  const attendee = slot.hosts.find((host) => host.role === "attendee") ?? null;

  // One of today's places for this visitor and booking request
  // (lib/forms/public-booking-cap.ts): held atomically before anything
  // reaches Google, and given back only by the failures below that leave
  // nothing booked. A booking that succeeds keeps its hold for good. A replay
  // of a booking already made returned above and never claims. A claim the
  // database cannot answer refuses the booking rather than book uncapped (a
  // missing claims schema, before migrations 228 and 229, books uncapped and
  // says so).
  let claim: Extract<PublicBookingClaim, { ok: true }>;
  try {
    const claimed = await claimPublicBooking(getTursoClient(), {
      tenantId: context.tenantId,
      visitorKey: publicBookingVisitorKey(getClientIp(req)),
      requestId,
      now: new Date(),
    });
    if (!claimed.ok) {
      return NextResponse.json({ ok: false, error: "daily_booking_limit" }, { status: 429 });
    }
    claim = claimed;
  } catch (error) {
    console.error("[public-booking.cap] claim failed", error);
    return NextResponse.json({ ok: false, error: "availability_unavailable" }, { status: 503 });
  }
  const giveBackClaim = () => releasePublicBooking(getTursoClient(), claim);

  const endAt = new Date(Date.parse(startsAt) + durationMinutes * 60_000).toISOString();
  let meeting: Awaited<ReturnType<typeof createVerifiedFounderMeeting>> | null = null;
  try {
    meeting = await createVerifiedFounderMeeting({
      tenantId: context.tenantId,
      leadId: context.leadId,
      actorUserId: organizer.userId,
      hostUserId: organizer.userId,
      requestId,
      meetingAt: startsAt,
      durationMinutes,
      offerLabel,
      contact: buildPublicBookingContact(combined),
      clientAgenda: `A ${durationMinutes}-minute ${context.formName} call with OASIS AI Solutions.`,
      // A form answer has no length limit on the server, and one over the
      // service's limit would refuse this lead's every booking.
      handoffNote: (bottleneck || `Public ${context.formSlug} booking.`).slice(0, HANDOFF_NOTE_MAX),
      smsConsent: false,
      expectedOrganizerEmail: organizer.email,
      openerAttendee: attendee ? { email: attendee.email, displayName: attendee.displayName } : null,
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
      hosts: slot.hosts,
    });
  } catch (error) {
    const errorCode = error instanceof Error ? error.message.split(":", 1)[0] : "";
    if (CONTACT_ERRORS.has(errorCode)) {
      // Thrown by the service's own validation before any row or event exists:
      // nothing to compensate, and nothing booked, so the place goes back.
      await giveBackClaim();
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
      await giveBackClaim();
      return NextResponse.json({ ok: false, error: "slot_unavailable" }, { status: 409 });
    }
    if (compensated || errorCode === "booking_compensated" || errorCode === "booking_request_cancelled") {
      await giveBackClaim();
      return NextResponse.json({ ok: false, error: "retry_required" }, { status: 503 });
    }
    // Refused by the meeting service before this attempt called Google (Codex
    // review of #670): it booked nothing, so its hold goes back. `!meeting`
    // keeps that true: the codes count only when the service itself threw,
    // never a later step's. So does a calendar failure in its setup, before
    // Google was asked (calendarNeverAsked). Anything else (a provider error,
    // a token failure, an unknown one) may have left an event, so the hold stays.
    if (!meeting && (PRE_PROVIDER_ERRORS.has(errorCode) || calendarNeverAsked(error))) await giveBackClaim();
    const code = safeErrorCode(error, PROVIDER_ERRORS, "booking_create_failed");
    return NextResponse.json({ ok: false, error: code }, { status: 503 });
  }
  if (!meeting) {
    await compensatePublicBooking({ db, tenantId: context.tenantId, leadId: context.leadId, requestId });
    await giveBackClaim();
    return NextResponse.json({ ok: false, error: "booking_create_failed" }, { status: 503 });
  }

  const occurredAt = new Date().toISOString();
  const ownership = publicBookingOwnershipPatch(context.lead, {
    organizer: organizer.userId,
    collaborators: [
      ...slot.hosts.map((host) => host.userId),
      founders.host.auth_user_id,
      founders.opener.auth_user_id,
    ],
  });
  const leadPatch = {
    ...buildPublicFunnelLeadPatch(combined, "meeting_booked", occurredAt),
    stage: "founder_meeting_booked",
    ...ownership,
    booked_founder: organizer.userId,
    audit_host_user_id: organizer.userId,
    audit_host_email: organizer.email,
    public_booking_host_ids: slot.hosts.map((host) => host.userId),
    audit_host_role: "owner",
    audit_duration_minutes: durationMinutes,
    calendar_event_status: "verified",
    calendar_confirmation_method: "server_google_calendar_api",
    calendar_confirmed_at: occurredAt,
    calendar_confirmed_by: organizer.userId,
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
    p_actor_user_id: organizer.userId,
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
    // Only a booking undone gives its place back; one left standing keeps it.
    if (compensated) await giveBackClaim();
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
