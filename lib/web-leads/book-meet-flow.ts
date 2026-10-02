/**
 * Book the Meet from the call screen: the draft, its readiness, the request
 * ids, the server calls in order, and the words a rep sees. Pure and
 * client-safe; IO is injected so tests can force every failure.
 *
 * ORDER (book-the-meet plan, D1): log the call as Interested, re-read the
 * lead (GET /api/web-leads/[id]?view=booking), then book_founder with the four
 * gates inline. Every step is idempotent by a request id the caller holds
 * across retries.
 *
 * DO-NOT-CALL (Adon, 2026-10-02: "allow"). A do-not-call lead is booked only
 * when the owner asked for the meeting on this call, confirmed by an explicit
 * tick sent as confirmations.ownerRequestedMeeting (the booking route stores
 * who ticked it and when). Logging the call refuses do-not-call leads
 * (lib/leads/rep-lead-access.ts), so the flow skips that step for them; the
 * booking is the record. Every do_not_call refusal comes back as a "fix" on
 * the dnc field, so the panel shows the tick-box instead of a dead end.
 *
 * CONFIRMATIONS ARE NEVER INFERRED. Each is an explicit tick by the rep, the
 * same rule tests/founder-booking-ui.test.ts pins for Pipeline.
 */
import { PAIN_WORDS_MAX, QUALIFICATION_GATE_KEYS, type QualificationGateKey } from "@/lib/sales-qualification";
import { meetingIsoInZone } from "@/lib/meeting-time";

export type BookMeetContact = { name: string; company: string; email: string; phone: string; website: string };
export type BookMeetConfirmations = {
  contactConfirmed: boolean;
  clientAgreedToTime: boolean;
  handoffComplete: boolean;
  /** Only read when the lead is do-not-call. */
  ownerRequestedMeeting: boolean;
};
export type BookMeetDraft = {
  leadId: string;
  gates: Record<QualificationGateKey, boolean>;
  painWords: string;
  timeZone: string;
  meetingDate: string;
  meetingTime: string;
  hostUserId: string;
  contact: BookMeetContact;
  agenda: string;
  hostNote: string;
  /** From the booking view's doNotCall, or set when a refusal says so. */
  doNotCall: boolean;
  confirmations: BookMeetConfirmations;
  smsConsent: boolean;
};
export type BookMeetField = "email" | "phone" | "website" | "time" | "host" | "agenda" | "note" | "sms" | "dnc";
export type BookedMeeting = { meetingAt: string; meetLink: string | null; calendarUrl: string | null };
export type BookMeetResult =
  | { kind: "booked"; meeting: BookedMeeting }
  | { kind: "booked_finish"; code: string; message: string }
  | { kind: "fix"; code: string; message: string; field: BookMeetField | null }
  | { kind: "blocked"; code: string; message: string }
  | { kind: "retry_safe"; code: string; message: string }
  | { kind: "unconfirmed"; code: string; message: string };
export type HttpResult = { status: number; body: Record<string, unknown> } | { networkError: true };
export type FlowIO = {
  postOutcome(leadId: string, body: Record<string, unknown>): Promise<HttpResult>;
  getContext(leadId: string): Promise<HttpResult>;
  patchBooking(leadId: string, body: Record<string, unknown>): Promise<HttpResult>;
};

/** What the client sees in the Calendar invite unless the rep edits it. Client-safe words only. */
export const DEFAULT_CLIENT_AGENDA =
  "A 15-minute look at how calls, quotes, jobs and follow-ups run in your business today, and where time or money is slipping. No preparation needed.";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const digits = (s: string) => s.replace(/\D/g, "");

export function meetingAtOf(d: BookMeetDraft): string | null {
  return meetingIsoInZone(d.meetingDate, d.meetingTime, d.timeZone);
}

export function composeHandoffNote(d: BookMeetDraft): string {
  const words = d.painWords.trim();
  return [words ? `In their words: "${words}"` : "", d.hostNote.trim()].filter(Boolean).join("\n\n");
}

/** The first thing stopping a booking, in the order a rep fixes it, or null. */
export function bookMeetBlockedReason(d: BookMeetDraft, now: number): string | null {
  if (!QUALIFICATION_GATE_KEYS.every((k) => d.gates[k])) return "Tick all four checks before booking.";
  if (!d.painWords.trim()) return "Type the problem in their words under the second check.";
  if (d.painWords.trim().length > PAIN_WORDS_MAX) return "Keep their words under 500 characters.";
  if (!d.meetingDate || !d.meetingTime) return "Pick a day and a time.";
  const at = meetingAtOf(d);
  if (!at) return "That time does not exist on that day because the clocks change. Pick another time.";
  if (Date.parse(at) <= now) return "That time has already passed. Pick a later time.";
  if (!d.hostUserId) return "Pick who hosts the Meet.";
  if (!EMAIL.test(d.contact.email.trim())) return "Ask: what is the best email for the calendar invite?";
  const phone = digits(d.contact.phone);
  if (phone.length < 10 || phone.length > 15) return "Enter their phone number with 10 to 15 digits.";
  if (!d.contact.name.trim() && !d.contact.company.trim()) return "Enter their name or the business name.";
  if (!d.agenda.trim()) return "Write what they will see in the invite.";
  if (d.agenda.trim().length > 500) return "Keep the invite text under 500 characters.";
  if (composeHandoffNote(d).length > 4000) return "Keep the note for the host under 4,000 characters.";
  if (!d.confirmations.contactConfirmed) return "Read the email back to them and tick that it is right.";
  if (!d.confirmations.clientAgreedToTime) return "Tick that they agreed to this day and time.";
  if (!d.confirmations.handoffComplete) return "Tick that the note for the host is done.";
  if (d.doNotCall && !d.confirmations.ownerRequestedMeeting) {
    return "This business is on the do-not-call list. Tick that the owner asked for this meeting.";
  }
  return null;
}

/** Everything the engine compares on a replay (founder-meeting.ts:238-268). Confirmations excluded on purpose. */
export function bookingSignature(d: BookMeetDraft): string {
  return JSON.stringify([
    d.leadId, d.hostUserId, meetingAtOf(d), d.contact.name.trim(), d.contact.company.trim(),
    d.contact.email.trim().toLowerCase(), d.contact.phone.trim(), d.contact.website.trim(),
    d.agenda.trim(), composeHandoffNote(d), d.smsConsent,
    QUALIFICATION_GATE_KEYS.map((k) => d.gates[k]), d.painWords.trim(),
  ]);
}

/** What the outcome route compares on a replay: the note and, for safety, the callback instant. */
export function outcomeSignature(d: BookMeetDraft): string {
  return JSON.stringify([d.leadId, outcomeNote(d), meetingAtOf(d)]);
}

function outcomeNote(d: BookMeetDraft): string {
  const words = d.painWords.trim();
  return `Booked a meeting from the call screen.${words ? ` In their words: "${words}"` : ""}`.slice(0, 4000);
}

export function buildOutcomeBody(d: BookMeetDraft, requestId: string): Record<string, unknown> {
  return { outcome: "interested", note: outcomeNote(d), requestId, nextActionAt: meetingAtOf(d) };
}

export function buildBookFounderBody(
  d: BookMeetDraft,
  o: { requestId: string; expectedStage: string; smsConsentArtifact: Record<string, unknown> | null },
): Record<string, unknown> {
  const phone = d.contact.phone.trim();
  return {
    action: "book_founder",
    requestId: o.requestId,
    expectedStage: o.expectedStage,
    founderUserId: d.hostUserId,
    meetingAt: meetingAtOf(d),
    timezone: d.timeZone,
    promisedDemo: d.agenda.trim(),
    note: composeHandoffNote(d),
    contact: {
      name: d.contact.name.trim(),
      company: d.contact.company.trim(),
      email: d.contact.email.trim(),
      phone,
      website: d.contact.website.trim(),
    },
    qualification: {
      ...Object.fromEntries(QUALIFICATION_GATE_KEYS.map((k) => [k, d.gates[k] === true])),
      operationsPainInTheirWords: d.painWords.trim(),
    },
    confirmations: {
      contactConfirmed: d.confirmations.contactConfirmed,
      clientAgreedToTime: d.confirmations.clientAgreedToTime,
      handoffComplete: d.confirmations.handoffComplete,
      // Same shape as Pipeline (app/pipeline/[id]/LeadLifecycleActions.tsx): sent
      // only for a do-not-call lead, and only as the rep's literal tick.
      ...(d.doNotCall ? { ownerRequestedMeeting: d.confirmations.ownerRequestedMeeting === true } : {}),
    },
    smsConsent: Boolean(phone && d.smsConsent),
    smsConsentArtifact: d.smsConsent ? o.smsConsentArtifact : null,
  };
}

/* ── Copy ─────────────────────────────────────────────────────────────── */

export const BOOK_MEET_COPY: Record<string, string> = {
  network: "We could not reach the server.",
  unauthorized: "Your sign-in expired. Sign in again in another tab, then come back.",
  not_found: "This lead no longer exists or is not yours to see.",
  forbidden: "This lead belongs to another workspace.",
  forbidden_role: "This lead is not in your book.",
  lead_not_assigned_to_agent: "This lead is not in your book.",
  not_yours: "This lead is not in your book.",
  forbidden_sales_role: "Your role cannot book meetings.",
  sales_role_required: "Your role cannot book meetings.",
  builder_not_assigned_to_lead: "Your role cannot book meetings on this lead.",
  builder_delivery_stage_only: "Your role cannot book meetings on this lead.",
  builder_delivery_action_only: "Your role cannot book meetings on this lead.",
  do_not_call: "This business is on the do-not-call list. Book only if the owner asked for this meeting, and tick that box.",
  claim_released: "Your hold on this lead ran out and it went back to the Leads pool. Claim it again first.",
  claim_first: "Claim this lead before booking it.",
  not_cold_outbound: "This lead did not come from cold calling, so book it from Pipeline.",
  not_cold_outbound_lead: "This lead did not come from cold calling, so book it from Pipeline.",
  not_website_sales_lead: "This lead is not part of the OASIS sales program, so it cannot be booked here.",
  already_booked: "A meeting is already booked for this lead.",
  lost: "This lead is marked lost. Re-open it in Pipeline first.",
  qualify_before_booking: "All four checks must be ticked.",
  qualification_incomplete: "All four checks must be ticked.",
  stage_changed_refresh: "This lead changed in another window.",
  owner_changed_refresh: "This lead changed owners while you were booking.",
  ownership_changed: "This lead changed owners while the call was saving.",
  request_id_conflict: "The call log changed after you pressed Book. Reload the page.",
  booking_confirmations_required: "Tick the three read-back boxes.",
  handoff_note_required: "Write the note for the host.",
  transition_note_too_long: "The note for the host is too long. Keep it under 4,000 characters.",
  invalid_handoff: "Pick a host, a day and a time.",
  meeting_must_be_in_future: "That time has already passed. Pick a later time.",
  next_action_required: "Pick a meeting time in the future.",
  next_action_invalid: "Pick a meeting time in the future.",
  next_action_not_future: "Pick a meeting time in the future.",
  note_too_long: "Their words are too long. Shorten them.",
  promised_demo_too_long: "The invite text is too long. Keep it under 500 characters.",
  client_agenda_required: "Write what they will see in the invite.",
  client_email_required: "The invite needs a real email address. Ask: what is the best email for the calendar invite?",
  client_phone_required: "Enter their phone number with 10 to 15 digits.",
  invalid_client_phone: "Enter their phone number with 10 to 15 digits.",
  invalid_client_website: "That website address is not valid. Fix it or clear it.",
  sms_consent_requires_phone: "Text reminders need their phone number. Add it or untick text reminders.",
  invalid_sms_consent_artifact: "The text-reminder consent could not be saved. Untick it and tick it again after reading the words to them.",
  sales_roster_unavailable: "We could not load this week's sales roster.",
  audit_host_not_on_cycle_roster: "That host is not on this week's sales roster. Pick another host, or ask an admin to add them.",
  audit_host_lookup_failed: "We could not check that host just now.",
  audit_host_not_authorized: "That person cannot host meetings. Pick another host.",
  audit_host_email_required: "That host has no email on their account. Pick another host.",
  google_calendar_not_connected: "That host's Google Calendar is not connected. Pick another host, or they reconnect Google in Settings.",
  calendar_scope_required: "That host must reconnect Google once to allow calendar access. Pick another host for now.",
  token_refresh_failed: "Google rejected that host's saved sign-in. Pick another host, or they reconnect Google in Settings.",
  // Raised before Google is called, OR after Google created the event under the
  // wrong account (lib/website-sales-founder-meeting.ts assertOrganizer). In the
  // second case the event is cancelled at once, or by the booking saga if that
  // cancel fails, so the client may briefly see an invite. Say so.
  calendar_organizer_mismatch: "That host's Google account is not their OASIS email. If an invite reached the client, it is cancelled automatically within 20 minutes. Pick another host, or they reconnect with their OASIS email.",
  workspace_calendar_token_invalid: "Booking is down for everyone because the shared Google connection failed. Tell an admin.",
  google_oauth_config_missing: "Booking is down for everyone because Google sign-in is not set up on this server. Tell an admin.",
  idempotency_check_failed: "We could not check whether this booking already exists.",
  tenant_lookup_failed: "We could not check your workspace just now.",
  access_check_failed: "We could not check whether you may book this lead.",
  lead_read_failed: "We could not read this lead just now.",
  lead_update_failed: "The call did not finish saving.",
  resume_failed: "The call did not finish saving.",
  tracking_failed: "The call saved but its timeline entry did not.",
  outcome_log_failed: "The call did not save.",
  calendar_create_failed: "Google or our records did not finish the booking.",
  calendar_reconcile_failed: "Google accepted the booking but we could not read it back.",
  calendar_read_failed: "Google Calendar could not be read just now.",
  google_meet_link_missing: "Google created the event but has not returned the Meet link yet.",
  invalid_request: "Google rejected the booking details.",
  meeting_intent_lookup_failed: "Our records did not finish the booking.",
  meeting_intent_insert_failed: "Our records did not finish the booking.",
  meeting_intent_missing: "Our records did not finish the booking.",
  meeting_notification_insert_failed: "The meeting reminders could not be set up, so the booking was undone.",
  meeting_transition_pending: "Another attempt at this booking is still finishing. Wait a few seconds.",
  lifecycle_transition_failed: "Google may have booked it, but the lead did not update.",
  meeting_activation_failed: "Reminders for this meeting did not switch on.",
  booking_request_mismatch: "The details changed after you pressed Book.",
  booking_request_cancelled: "That booking attempt was cancelled.",
  request_id_reused_for_different_lead: "This screen sent an invalid request. Reload the page.",
  request_id_reused_for_different_action: "This screen sent an invalid request. Reload the page.",
  request_id_required: "This screen sent an invalid request. Reload the page.",
  expected_stage_required: "This screen sent an invalid request. Reload the page.",
  invalid_body: "This screen sent an invalid request. Reload the page.",
  invalid_lead_id: "This screen sent an invalid request. Reload the page.",
};

export const KIND_SENTENCE: Record<BookMeetResult["kind"], string> = {
  booked: "Booked. The invite is on its way.",
  booked_finish: "The meeting is booked and the invite was sent. Press Try again to switch on the reminders.",
  fix: "Nothing was booked. Fix it and press Book again.",
  blocked: "Nothing was booked.",
  retry_safe: "Nothing was booked yet. Press Try again.",
  unconfirmed:
    "The meeting is not confirmed. Press Try again now: it reuses the same booking and will not send a second invite. If it is not finished within 20 minutes, any invite already sent is cancelled automatically.",
};

export function bookMeetMessage(code: string, kind: BookMeetResult["kind"]): string {
  const what = BOOK_MEET_COPY[code] ?? "Something went wrong.";
  return `${what} ${KIND_SENTENCE[kind]}`;
}

/* ── Classification ───────────────────────────────────────────────────── */

const FIELD_FOR: Record<string, BookMeetField> = {
  client_email_required: "email",
  client_phone_required: "phone",
  invalid_client_phone: "phone",
  invalid_client_website: "website",
  meeting_must_be_in_future: "time",
  invalid_handoff: "time",
  promised_demo_too_long: "agenda",
  client_agenda_required: "agenda",
  handoff_note_required: "note",
  transition_note_too_long: "note",
  sms_consent_requires_phone: "sms",
  invalid_sms_consent_artifact: "sms",
  audit_host_not_on_cycle_roster: "host",
  audit_host_not_authorized: "host",
  audit_host_email_required: "host",
  google_calendar_not_connected: "host",
  calendar_scope_required: "host",
  token_refresh_failed: "host",
  calendar_organizer_mismatch: "host",
  // Refused before anything reaches Google: tick the owner-asked box and book again.
  do_not_call: "dnc",
};
const FIX_CODES = new Set([...Object.keys(FIELD_FOR), "booking_confirmations_required", "qualify_before_booking", "booking_request_mismatch"]);
/** Refused BEFORE any Google call: safe to retry with the same ids. */
const RETRY_SAFE_CODES = new Set([
  "stage_changed_refresh", "sales_roster_unavailable", "audit_host_lookup_failed", "idempotency_check_failed",
  "tenant_lookup_failed",
]);

const str = (v: unknown) => (typeof v === "string" ? v : "");

const dncFix = (): BookMeetResult => ({
  kind: "fix",
  code: "do_not_call",
  field: "dnc",
  message: bookMeetMessage("do_not_call", "fix"),
});

function classifyBooking(r: HttpResult): BookMeetResult {
  if ("networkError" in r) return { kind: "unconfirmed", code: "network", message: bookMeetMessage("network", "unconfirmed") };
  const body = r.body;
  if (r.status === 200 && body.ok === true) {
    const m = (body.meeting ?? {}) as Record<string, unknown>;
    return {
      kind: "booked",
      meeting: { meetingAt: str(m.meetingAt), meetLink: str(m.meetLink) || null, calendarUrl: str(m.calendarUrl) || null },
    };
  }
  const code = str(body.error) || `http_${r.status}`;
  if (body.stageUpdated === true) return { kind: "booked_finish", code, message: bookMeetMessage(code, "booked_finish") };
  if (FIX_CODES.has(code)) return { kind: "fix", code, field: FIELD_FOR[code] ?? null, message: bookMeetMessage(code, "fix") };
  if (RETRY_SAFE_CODES.has(code)) return { kind: "retry_safe", code, message: bookMeetMessage(code, "retry_safe") };
  if (r.status >= 500) return { kind: "unconfirmed", code, message: bookMeetMessage(code, "unconfirmed") };
  return { kind: "blocked", code, message: bookMeetMessage(code, "blocked") };
}

/* ── The flow ─────────────────────────────────────────────────────────── */

export async function runBookMeetFlow(
  d: BookMeetDraft,
  ids: { outcomeRequestId: string; bookingRequestId: string },
  progress: { outcomeSaved: boolean },
  io: FlowIO,
  smsConsentArtifact: Record<string, unknown> | null,
  onStep?: (step: "call" | "check" | "booking") => void,
): Promise<{ result: BookMeetResult; outcomeSaved: boolean }> {
  let outcomeSaved = progress.outcomeSaved;

  // A do-not-call lead's call cannot be logged (the outcome route refuses it),
  // so its booking skips straight to the re-read; the booking is the record.
  if (!outcomeSaved && !d.doNotCall) {
    onStep?.("call");
    const r = await io.postOutcome(d.leadId, buildOutcomeBody(d, ids.outcomeRequestId));
    if ("networkError" in r) {
      return { result: { kind: "retry_safe", code: "network", message: bookMeetMessage("lead_update_failed", "retry_safe") }, outcomeSaved };
    }
    if (r.status !== 200 || r.body.ok !== true) {
      const code = str(r.body.error) || `http_${r.status}`;
      if (code === "do_not_call") return { result: dncFix(), outcomeSaved };
      const retrySafe = r.status >= 500 && r.body.retrySafe !== false;
      return {
        result: retrySafe
          ? { kind: "retry_safe", code, message: bookMeetMessage(code, "retry_safe") }
          : { kind: "blocked", code, message: bookMeetMessage(code, "blocked") },
        outcomeSaved,
      };
    }
    outcomeSaved = true;
  }

  onStep?.("check");
  const ctx = await io.getContext(d.leadId);
  if ("networkError" in ctx || ctx.status !== 200 || ctx.body.ok !== true) {
    const code = "networkError" in ctx ? "network" : str(ctx.body.error) || "lead_read_failed";
    return { result: { kind: "retry_safe", code, message: bookMeetMessage(code, "retry_safe") }, outcomeSaved };
  }
  if (ctx.body.canBook !== true) {
    const code = str(ctx.body.blocked) || "claim_first";
    return { result: { kind: "blocked", code, message: bookMeetMessage(code, "blocked") }, outcomeSaved };
  }
  // The lead turned do-not-call since the panel opened: never send a booking
  // without the owner-asked tick; the panel shows the box.
  if (ctx.body.doNotCall === true && !(d.doNotCall && d.confirmations.ownerRequestedMeeting)) {
    return { result: dncFix(), outcomeSaved };
  }

  onStep?.("booking");
  const booking = await io.patchBooking(
    d.leadId,
    buildBookFounderBody(d, { requestId: ids.bookingRequestId, expectedStage: str(ctx.body.stage), smsConsentArtifact }),
  );
  return { result: classifyBooking(booking), outcomeSaved };
}

/**
 * Where Call Mode's cursor goes after a booking. Booking hands the lead to the
 * host (route.ts:736), so a queue refresh may already have removed it, and the
 * cursor then points at the NEXT lead. Moving again would skip a lead nobody
 * called. Move only when the booked lead is still where the cursor is.
 */
export function cursorAfterBooking(leads: readonly { id: string }[], cursor: number, bookedLeadId: string): number {
  return leads[cursor]?.id === bookedLeadId ? cursor + 1 : cursor;
}
