/**
 * lib/booking/agent-booking.ts - the booking agent API: an agent outside the app books a founder call through the
 * same engine as /book (CC, 2026-10-18: the Instagram DM setter "pushing the Oasis Meet and the Oasis Calendar
 * Booking and all of our funnels and offers - they need to be interwoven").
 *
 *   POST /api/internal/booking/slots   the open times /book offers, for a call of `duration_minutes`
 *   POST /api/internal/booking/offers  the offer pages live right now, plus the booking page
 *   POST /api/internal/booking/book    book one of those times for a lead; the same request_id replays
 *
 * Auth is lib/booking/agent-auth.ts (a signed request, one secret per producer, one workspace per producer).
 *
 * A booking here is what a website booking is, minus the visitor parts (the form token and the per-visitor daily
 * cap: the setter is one trusted producer with its own run lock):
 *   - the times are loadPublicBookingAvailability's, so the setter never offers a time /book would not;
 *   - createVerifiedFounderMeeting makes the Google event and the Oasis Meet room (bookingMeetRoomDeps), with the
 *     on-duty attendee invited, and its saga compensates a failure;
 *   - the Schedule copies (mirrorPublicBookingToSchedules), the pipeline move to founder_meeting_booked
 *     (transition_pipeline_lead) and the sales-desk alert are the website booking's own.
 * The lead is the setter's CRM lead when it names one (or the request is refused), else a lead matched by email or
 * phone (findExistingLead, so a prospect who already filled a form is not split in two), else a new lead. The form route
 * (app/api/forms/booking/route.ts) is left as it is: its tests pin its source, and only the orchestration differs.
 */
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  authenticateBookingAgentRequest,
  bookingAgentJson,
  bookingAgentRefuse,
} from "@/lib/booking/agent-auth";
import {
  buildPublicBookingContact,
  buildPublicFunnelLeadPatch,
  isBookingRequestId,
  isPublicBookingStageBookable,
  publicBookingOwnershipPatch,
  stringList,
  type PublicBookingHost,
  type PublicBookingSlot,
} from "@/lib/forms/public-booking";
import { BOOK_FORM_SLUG, publicBookingOfferLabel } from "@/lib/forms/public-booking-config";
import { AI_AUDIT_TENANT_SLUG } from "@/lib/forms/oasis-ai-audit-seed";
import { MEET_RECORDING_NOTICE } from "@/lib/meet/recording-notice";
import { bookingSmsConsent } from "@/lib/booking/sms-consent";
import type { createVerifiedFounderMeeting, VerifiedFounderMeeting } from "@/lib/website-sales-founder-meeting";

/** The general call /book offers: 30 minutes (the "book" form's length). */
export const AGENT_BOOKING_DEFAULT_DURATION_MINUTES = 30;
/** How far ahead the setter may ask for times; the booking settings' own horizon still applies. */
export const AGENT_BOOKING_MAX_DAYS = 14;
const NOTE_MAX = 1000;
const HANDOFF_NOTE_MAX = 4000;
const TIME_ZONE = "America/Toronto";

/** Where a booking came from, as the lead and the Schedule show it. Unknown sources are refused. */
export const AGENT_BOOKING_SOURCES = { instagram_dm: "Instagram DM" } as const;
export type AgentBookingSource = keyof typeof AGENT_BOOKING_SOURCES;

/**
 * Codes the meeting service throws about the person's own details, before anything is written: a 422 naming the
 * contact, never a retry (app/api/forms/booking/route.ts CONTACT_ERRORS).
 */
const CONTACT_ERRORS = new Set(["invalid_client_phone", "client_phone_required", "client_email_required", "invalid_client_email"]);

export type AgentLead = { id: string; data: Record<string, unknown> };

export type AgentBookingDeps = {
  env: Record<string, string | undefined>;
  now: () => Date;
  db: SupabaseClient;
  /** The public origin links are built on (https://oasisai.work). */
  baseUrl: string;
  availability: (tenantId: string, durationMinutes: number) => Promise<PublicBookingSlot[]>;
  hostsById: (tenantId: string, ids: string[]) => Promise<PublicBookingHost[]>;
  liveOffers: (tenantId: string) => Promise<Array<{ slug: string; name: string }>>;
  readLead: (tenantId: string, leadId: string) => Promise<AgentLead | null>;
  /**
   * A lead by email or phone. `business` is the company they named: never a match key, but a phone match to a lead
   * of a DIFFERENT business is refused (an owner's cell is shared by every business they own).
   */
  findLead: (tenantId: string, match: { email: string; phone: string; business: string }) => Promise<AgentLead | null>;
  createLead: (tenantId: string, data: Record<string, unknown>) => Promise<{ id: string }>;
  createMeeting: (input: Parameters<typeof createVerifiedFounderMeeting>[0]) => Promise<VerifiedFounderMeeting>;
  /** Undo a booking that cannot complete: the Google event, the room and the Schedule copies. True when it went. */
  compensate: (input: { tenantId: string; leadId: string; requestId: string; appointmentId: string }) => Promise<boolean>;
  mirror: (input: {
    tenantId: string;
    leadId: string;
    appointmentId: string;
    providerEventId: string;
    meetUrl: string;
    startsAt: string;
    endsAt: string;
    prospectName: string;
    company: string;
    formName: string;
    prospectEmail: string;
    hosts: PublicBookingHost[];
  }) => Promise<void>;
  activate: (tenantId: string, appointmentId: string) => Promise<void>;
  callRecorded: (tenantId: string, meetUrl: string) => Promise<boolean>;
  /** The sales-desk alert (CC) for a booked call; resolves whether it was delivered. */
  alert: (input: {
    tenantId: string;
    leadId: string;
    source: AgentBookingSource;
    name: string;
    company: string;
    /** What they want help with, in their words (the alert's "Bottleneck" line). */
    note: string;
    startsAt: string;
    meetUrl: string;
  }) => Promise<void>;
  /** Work that may finish after the answer (after() on the Worker). */
  later: (work: () => Promise<void>) => void;
};

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function errorCode(error: unknown): string {
  return error instanceof Error ? error.message.split(":", 1)[0] : "";
}

function ownKeys(body: Record<string, unknown>, allowed: readonly string[]): string | null {
  return Object.keys(body).find((key) => !allowed.includes(key)) ?? null;
}

/**
 * POST /api/internal/booking/slots: {duration_minutes?: 30, days?: 1..14}. Only the length /book's general call has,
 * the one handleAgentBook books: a time offered for any other length could be refused, or booked short (Codex on the
 * booking agent PR).
 */
export async function handleAgentSlots(req: Request, deps: AgentBookingDeps): Promise<Response> {
  const auth = await authenticateBookingAgentRequest(req, deps.env, deps.now());
  if (!auth.ok) return auth.response;
  const extra = ownKeys(auth.body, ["duration_minutes", "days"]);
  if (extra) return bookingAgentRefuse(422, "unknown_field", { field: extra });
  const duration = auth.body.duration_minutes ?? AGENT_BOOKING_DEFAULT_DURATION_MINUTES;
  if (duration !== AGENT_BOOKING_DEFAULT_DURATION_MINUTES) {
    return bookingAgentRefuse(422, "invalid_field", { field: "duration_minutes" });
  }
  const days = auth.body.days ?? AGENT_BOOKING_MAX_DAYS;
  if (!Number.isInteger(days) || (days as number) < 1 || (days as number) > AGENT_BOOKING_MAX_DAYS) {
    return bookingAgentRefuse(422, "invalid_field", { field: "days" });
  }
  let slots: PublicBookingSlot[];
  try {
    slots = await deps.availability(auth.tenantId, duration as number);
  } catch (error) {
    console.error("[booking-agent.slots] availability failed", error instanceof Error ? error.message : String(error));
    return bookingAgentRefuse(503, "availability_unavailable");
  }
  const until = deps.now().getTime() + (days as number) * 24 * 60 * 60_000;
  const minutes = (duration as number) * 60_000;
  return bookingAgentJson(200, {
    ok: true,
    time_zone: TIME_ZONE,
    duration_minutes: duration,
    slots: slots
      .filter((slot) => Date.parse(slot.start) < until)
      .map((slot) => ({ start: slot.start, end: new Date(Date.parse(slot.start) + minutes).toISOString() })),
  });
}

/** POST /api/internal/booking/offers: {} -> the live offer pages and the booking page. */
export async function handleAgentOffers(req: Request, deps: AgentBookingDeps): Promise<Response> {
  const auth = await authenticateBookingAgentRequest(req, deps.env, deps.now());
  if (!auth.ok) return auth.response;
  const extra = ownKeys(auth.body, []);
  if (extra) return bookingAgentRefuse(422, "unknown_field", { field: extra });
  let offers: Array<{ slug: string; name: string }>;
  try {
    offers = await deps.liveOffers(auth.tenantId);
  } catch (error) {
    console.error("[booking-agent.offers] read failed", error instanceof Error ? error.message : String(error));
    return bookingAgentRefuse(503, "offers_unavailable");
  }
  const base = deps.baseUrl.replace(/\/+$/, "");
  return bookingAgentJson(200, {
    ok: true,
    offers: offers.map((offer) => ({
      slug: offer.slug,
      name: offer.name,
      url: `${base}/f/${AI_AUDIT_TENANT_SLUG}/${encodeURIComponent(offer.slug)}`,
    })),
    booking_url: `${base}/book`,
  });
}

type BookRequest = {
  requestId: string;
  startsAt: string;
  source: AgentBookingSource;
  leadId: string | null;
  contact: { name: string; email: string; phone: string; company: string };
  instagramHandle: string;
  note: string;
};

const BOOK_FIELDS = ["request_id", "starts_at", "source", "lead_id", "contact", "instagram_handle", "note"] as const;
const CONTACT_FIELDS = ["name", "email", "phone", "company"] as const;

function parseBook(body: Record<string, unknown>): { ok: true; value: BookRequest } | { ok: false; field: string } {
  const extra = ownKeys(body, BOOK_FIELDS);
  if (extra) return { ok: false, field: extra };
  const requestId = text(body.request_id);
  if (!isBookingRequestId(requestId)) return { ok: false, field: "request_id" };
  const startsMs = Date.parse(text(body.starts_at));
  if (!Number.isFinite(startsMs) || text(body.starts_at).length > 64) return { ok: false, field: "starts_at" };
  const source = text(body.source);
  if (!Object.prototype.hasOwnProperty.call(AGENT_BOOKING_SOURCES, source)) return { ok: false, field: "source" };
  const leadId = body.lead_id === null || body.lead_id === undefined ? null : text(body.lead_id);
  if (leadId !== null && !/^[0-9a-f-]{8,64}$/i.test(leadId)) return { ok: false, field: "lead_id" };
  const contactRaw = body.contact;
  if (!contactRaw || typeof contactRaw !== "object" || Array.isArray(contactRaw)) return { ok: false, field: "contact" };
  const contactBody = contactRaw as Record<string, unknown>;
  const contactExtra = ownKeys(contactBody, CONTACT_FIELDS);
  if (contactExtra) return { ok: false, field: `contact.${contactExtra}` };
  const name = text(contactBody.name);
  const email = text(contactBody.email).toLowerCase();
  const phone = text(contactBody.phone);
  const company = text(contactBody.company);
  if (!name || name.length > 120) return { ok: false, field: "contact.name" };
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, field: "contact.email" };
  if (!phone || phone.length > 40) return { ok: false, field: "contact.phone" };
  if (company.length > 160) return { ok: false, field: "contact.company" };
  const instagramHandle = text(body.instagram_handle).replace(/^@+/, "");
  if (instagramHandle.length > 64 || /[^A-Za-z0-9._]/.test(instagramHandle)) return { ok: false, field: "instagram_handle" };
  const note = text(body.note);
  if (note.length > NOTE_MAX) return { ok: false, field: "note" };
  return {
    ok: true,
    value: {
      requestId,
      startsAt: new Date(startsMs).toISOString(),
      source: source as AgentBookingSource,
      leadId,
      contact: { name, email, phone, company },
      instagramHandle,
      note,
    },
  };
}

async function resolveLead(tenantId: string, request: BookRequest, deps: AgentBookingDeps): Promise<AgentLead | null> {
  if (request.leadId) {
    return deps.readLead(tenantId, request.leadId);
  }
  return deps.findLead(tenantId, {
    email: request.contact.email,
    phone: request.contact.phone,
    business: request.contact.company,
  });
}

function sourceLabel(source: AgentBookingSource): string {
  return AGENT_BOOKING_SOURCES[source];
}

/** POST /api/internal/booking/book. */
export async function handleAgentBook(req: Request, deps: AgentBookingDeps): Promise<Response> {
  const auth = await authenticateBookingAgentRequest(req, deps.env, deps.now());
  if (!auth.ok) return auth.response;
  const parsed = parseBook(auth.body);
  if (!parsed.ok) return bookingAgentRefuse(422, "invalid_field", { field: parsed.field });
  const request = parsed.value;
  const tenantId = auth.tenantId;
  const durationMinutes = AGENT_BOOKING_DEFAULT_DURATION_MINUTES;
  const offerLabel = publicBookingOfferLabel(BOOK_FORM_SLUG);
  const formName = `${sourceLabel(request.source)} call`;

  let lead: AgentLead | null;
  try {
    lead = await resolveLead(tenantId, request, deps);
  } catch (error) {
    console.error("[booking-agent.book] lead read failed", error instanceof Error ? error.message : String(error));
    return bookingAgentRefuse(503, "lead_unavailable");
  }
  if (request.leadId && !lead) return bookingAgentRefuse(422, "lead_not_found", { field: "lead_id" });

  // A replay of this request answers what the first one booked (and repairs its Schedule copies, as /book does).
  // Any other booking already on the lead refuses a second one.
  if (lead) {
    const priorAppointment = text(lead.data.calendar_appointment_id);
    const priorRequest = text(lead.data.public_booking_request_id);
    if (priorAppointment && priorRequest !== request.requestId) return bookingAgentRefuse(409, "already_booked");
    if (priorAppointment) {
      if (text(lead.data.founder_meeting_at) !== request.startsAt) return bookingAgentRefuse(409, "booking_request_mismatch");
      const meetUrl = text(lead.data.google_meet_link);
      const calendarUrl = text(lead.data.google_calendar_event_url);
      const eventId = text(lead.data.google_calendar_event_id);
      if (!meetUrl || !calendarUrl || !eventId) return bookingAgentRefuse(503, "booking_receipt_unavailable");
      const storedDuration = Number(lead.data.audit_duration_minutes);
      const minutes = Number.isInteger(storedDuration) && storedDuration >= 15 && storedDuration <= 120 ? storedDuration : durationMinutes;
      const endsAt = new Date(Date.parse(request.startsAt) + minutes * 60_000).toISOString();
      try {
        const hosts = await deps.hostsById(tenantId, stringList(lead.data.public_booking_host_ids));
        await deps.mirror({
          tenantId,
          leadId: lead.id,
          appointmentId: priorAppointment,
          providerEventId: eventId,
          meetUrl,
          startsAt: request.startsAt,
          endsAt,
          prospectName: request.contact.name,
          company: request.contact.company,
          formName,
          prospectEmail: request.contact.email,
          hosts,
        });
        await deps.activate(tenantId, priorAppointment);
      } catch (error) {
        console.error("[booking-agent.replay.repair]", error instanceof Error ? error.message : String(error));
        return bookingAgentRefuse(503, "booking_sync_pending");
      }
      const recorded = await deps.callRecorded(tenantId, meetUrl);
      return bookingAgentJson(200, {
        ok: true,
        replayed: true,
        lead_id: lead.id,
        appointment_id: priorAppointment,
        starts_at: request.startsAt,
        ends_at: endsAt,
        meet_url: meetUrl,
        calendar_url: calendarUrl,
        google_event_id: eventId,
        time_zone: TIME_ZONE,
        call_recorded: recorded,
        recording_notice: recorded ? MEET_RECORDING_NOTICE : null,
      });
    }
    if (!isPublicBookingStageBookable(text(lead.data.stage))) return bookingAgentRefuse(409, "lead_stage_not_bookable");
  }

  let available: PublicBookingSlot[];
  try {
    available = await deps.availability(tenantId, durationMinutes);
  } catch (error) {
    console.error("[booking-agent.book] availability failed", error instanceof Error ? error.message : String(error));
    return bookingAgentRefuse(503, "availability_unavailable");
  }
  const slot = available.find((item) => item.start === request.startsAt);
  const organizer = slot?.hosts.find((host) => host.role === "organizer");
  if (!slot || !organizer) return bookingAgentRefuse(409, "slot_unavailable");
  const attendee = slot.hosts.find((host) => host.role === "attendee") ?? null;

  const occurredAt = deps.now().toISOString();
  const answers = {
    name: request.contact.name,
    email: request.contact.email,
    phone: request.contact.phone,
    company_name: request.contact.company,
  };
  if (!lead) {
    // Made only once the time is known to be open, so a refused time leaves no lead behind.
    const data: Record<string, unknown> = {
      ...buildPublicFunnelLeadPatch(answers, "inbound_lead", occurredAt),
      stage: "researched",
      source: request.source,
      booking_source: request.source,
      sales_motion: "inbound_warm",
      assigned_agent_name: "the OASIS AI team",
      ...(request.instagramHandle ? { instagram_handle: request.instagramHandle } : {}),
    };
    try {
      lead = { id: (await deps.createLead(tenantId, data)).id, data };
    } catch (error) {
      console.error("[booking-agent.book] lead create failed", error instanceof Error ? error.message : String(error));
      return bookingAgentRefuse(503, "lead_unavailable");
    }
  }

  const endsAt = new Date(Date.parse(request.startsAt) + durationMinutes * 60_000).toISOString();
  const handoff = request.note || `Booked from ${sourceLabel(request.source)}${request.instagramHandle ? ` (@${request.instagramHandle})` : ""}.`;
  // Texts only if this phone ticked "text me" on a form (the consent ledger).
  const smsConsent = await bookingSmsConsent(deps.db, tenantId, request.contact.phone);
  let meeting: VerifiedFounderMeeting | null = null;
  try {
    meeting = await deps.createMeeting({
      tenantId,
      leadId: lead.id,
      actorUserId: organizer.userId,
      hostUserId: organizer.userId,
      requestId: request.requestId,
      meetingAt: request.startsAt,
      durationMinutes,
      offerLabel,
      contact: buildPublicBookingContact({ ...answers, company: request.contact.company }),
      clientAgenda: `A ${durationMinutes}-minute ${offerLabel} with OASIS AI Solutions.`,
      handoffNote: handoff.slice(0, HANDOFF_NOTE_MAX),
      smsConsent,
      expectedOrganizerEmail: organizer.email,
      openerAttendee: attendee ? { email: attendee.email, displayName: attendee.displayName } : null,
      confirmations: { contactConfirmed: true, clientAgreedToTime: true, handoffComplete: true },
    });
    await deps.mirror({
      tenantId,
      leadId: lead.id,
      appointmentId: meeting.appointmentId,
      providerEventId: meeting.receipt.eventId,
      meetUrl: meeting.receipt.meetLink,
      startsAt: request.startsAt,
      endsAt,
      prospectName: request.contact.name,
      company: request.contact.company,
      formName,
      prospectEmail: request.contact.email,
      hosts: slot.hosts,
    });
  } catch (error) {
    const code = errorCode(error);
    if (!meeting && CONTACT_ERRORS.has(code)) return bookingAgentRefuse(422, code, { field: "contact" });
    // This request_id already holds a booking intent with other details (or another host): no retry of it can ever
    // succeed, so it is a conflict, never a 503 the caller would retry forever (Codex on the booking agent PR).
    if (!meeting && code === "booking_request_mismatch") return bookingAgentRefuse(409, "booking_request_mismatch");
    console.error("[booking-agent.book] meeting failed", error instanceof Error ? error.message : String(error));
    const compensated = meeting
      ? await deps.compensate({ tenantId, leadId: lead.id, requestId: request.requestId, appointmentId: meeting.appointmentId })
      : false;
    if (error instanceof Error && /meeting_intent_insert_failed:.*(?:unique|constraint|founder_slot_overlap)/iu.test(error.message)) {
      return bookingAgentRefuse(409, "slot_unavailable");
    }
    // An undone booking cancels its request for good: the same request_id can never book again, so the caller is told
    // to book with a new one rather than retry this one forever (the form route's rule; Codex on the booking agent PR).
    if (compensated || code === "booking_compensated" || code === "booking_request_cancelled") {
      return bookingAgentRefuse(503, "retry_required");
    }
    return bookingAgentRefuse(503, "booking_create_failed");
  }

  const ownership = publicBookingOwnershipPatch(lead.data, {
    organizer: organizer.userId,
    collaborators: slot.hosts.map((host) => host.userId),
  });
  const leadPatch = {
    ...buildPublicFunnelLeadPatch(answers, "meeting_booked", occurredAt),
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
    founder_meeting_at: request.startsAt,
    next_action_at: request.startsAt,
    public_booking_request_id: request.requestId,
    sales_motion: "inbound_warm",
    booking_source: request.source,
    ...(request.instagramHandle ? { instagram_handle: request.instagramHandle } : {}),
  };
  const transition = await deps.db.rpc("transition_pipeline_lead", {
    p_tenant_id: tenantId,
    p_lead_id: lead.id,
    p_expected_stage: text(lead.data.stage),
    p_expected_owner_id: text(lead.data.assigned_to) || null,
    p_patch: leadPatch,
    p_request_id: request.requestId,
    p_occurred_at: occurredAt,
    p_actor_user_id: organizer.userId,
    p_action: "agent_booking",
    p_interaction_type: "calendar_booking",
    p_subject: `${formName} booked`,
    p_content: `${offerLabel[0].toUpperCase()}${offerLabel.slice(1)} booked from ${sourceLabel(request.source)} for ${request.startsAt}. Video call: ${meeting.receipt.meetLink}`,
    p_is_call: false,
    p_metadata: {
      appointment_id: meeting.appointmentId,
      starts_at: request.startsAt,
      google_event_id: meeting.receipt.eventId,
      meet_url: meeting.receipt.meetLink,
      source: request.source,
    },
  });
  const transitionData = transition.data as { ok?: boolean; error?: string } | null;
  if (transition.error || transitionData?.ok === false) {
    console.error("[booking-agent.transition]", transition.error?.message || transitionData?.error);
    const compensated = await deps.compensate({
      tenantId,
      leadId: lead.id,
      requestId: request.requestId,
      appointmentId: meeting.appointmentId,
    });
    return bookingAgentRefuse(503, compensated ? "retry_required" : "booking_transition_failed");
  }
  try {
    await deps.activate(tenantId, meeting.appointmentId);
  } catch (error) {
    // The lead already carries the receipt; the founder-meeting reconciler activates this saga. A client-visible
    // invite is never cancelled after the lead moved.
    console.error("[booking-agent.activation_pending]", error instanceof Error ? error.message : String(error));
  }
  const bookedLeadId = lead.id;
  const booked = meeting;
  deps.later(() => deps.alert({
    tenantId,
    leadId: bookedLeadId,
    source: request.source,
    name: request.contact.name,
    company: request.contact.company,
    note: request.note,
    startsAt: request.startsAt,
    meetUrl: booked.receipt.meetLink,
  }));
  const recorded = await deps.callRecorded(tenantId, meeting.receipt.meetLink);
  return bookingAgentJson(200, {
    ok: true,
    replayed: false,
    lead_id: lead.id,
    appointment_id: meeting.appointmentId,
    starts_at: request.startsAt,
    ends_at: endsAt,
    meet_url: meeting.receipt.meetLink,
    calendar_url: meeting.receipt.htmlLink,
    google_event_id: meeting.receipt.eventId,
    time_zone: meeting.timezone || TIME_ZONE,
    call_recorded: recorded,
    recording_notice: recorded ? MEET_RECORDING_NOTICE : null,
  });
}
