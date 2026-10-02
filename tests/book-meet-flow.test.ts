/**
 * The call-screen booking flow: call order, partial failures, request ids,
 * readiness, and the words a rep sees. IO is faked so every failure point can
 * be forced; the real routes are covered by book-meet-route and
 * web-leads-booking-context-route.
 *
 * DO-NOT-CALL (Adon, 2026-10-02: "allow"): a do-not-call lead is booked only
 * when the owner asked for the meeting on this call. Logging the call refuses
 * do-not-call leads (lib/leads/rep-lead-access.ts), so the flow skips the call
 * log for them, sends confirmations.ownerRequestedMeeting, and turns every
 * do_not_call refusal into "tick the owner-asked box", never a dead end.
 *
 * Run: node --conditions=react-server --import tsx tests/book-meet-flow.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  BOOK_MEET_COPY,
  DEFAULT_CLIENT_AGENDA,
  KIND_SENTENCE,
  bookMeetBlockedReason,
  bookMeetMessage,
  bookingSignature,
  buildBookFounderBody,
  composeHandoffNote,
  cursorAfterBooking,
  outcomeSignature,
  runBookMeetFlow,
  type BookMeetDraft,
  type FlowIO,
  type HttpResult,
} from "../lib/web-leads/book-meet-flow";

const LEAD = "6f6f6f6f-0000-4000-8000-0000000000aa";
const HOST = "5e5e5e5e-0000-4000-8000-000000000001";
const NOW = Date.parse("2026-10-05T15:00:00.000Z");

const draft = (over: Partial<BookMeetDraft> = {}): BookMeetDraft => ({
  leadId: LEAD,
  gates: { authorityConfirmed: true, websiteProblemConfirmed: true, timingConfirmed: true, minimumInvestmentConfirmed: true },
  painWords: "quotes go out a week late",
  timeZone: "America/Vancouver",
  meetingDate: "2026-10-06",
  meetingTime: "14:00",
  hostUserId: HOST,
  contact: { name: "Pat Owner", company: "[TEST] Canary Plumbing", email: "pat@canary.test", phone: "604-555-0100", website: "" },
  agenda: DEFAULT_CLIENT_AGENDA,
  hostNote: "Owner runs 3 crews.",
  doNotCall: false,
  confirmations: { contactConfirmed: true, clientAgreedToTime: true, handoffComplete: true, ownerRequestedMeeting: false },
  smsConsent: false,
  ...over,
});
const dncDraft = (ownerRequestedMeeting: boolean) =>
  draft({ doNotCall: true, confirmations: { ...draft().confirmations, ownerRequestedMeeting } });

type Call = { op: keyof FlowIO; body?: Record<string, unknown> };
function fakeIO(script: Partial<Record<keyof FlowIO, HttpResult[]>>): { io: FlowIO; calls: Call[] } {
  const calls: Call[] = [];
  const next = (op: keyof FlowIO): HttpResult => {
    const queue = script[op] ?? [];
    return queue.length > 1 ? queue.shift()! : queue[0] ?? { status: 500, body: {} };
  };
  return {
    calls,
    io: {
      postOutcome: async (_id, body) => { calls.push({ op: "postOutcome", body }); return next("postOutcome"); },
      getContext: async () => { calls.push({ op: "getContext" }); return next("getContext"); },
      patchBooking: async (_id, body) => { calls.push({ op: "patchBooking", body }); return next("patchBooking"); },
    },
  };
}
const OK_OUTCOME: HttpResult = { status: 200, body: { ok: true, stageChangedTo: "connected" } };
const CTX: HttpResult = { status: 200, body: { ok: true, stage: "connected", canBook: true, blocked: null, doNotCall: false } };
const DNC_CTX: HttpResult = { status: 200, body: { ok: true, stage: "attempting_contact", canBook: true, blocked: null, doNotCall: true } };
const BOOKED: HttpResult = {
  status: 200,
  body: { ok: true, meeting: { meetingAt: "2026-10-06T21:00:00.000Z", meetLink: "https://meet.google.com/abc-defg-hij", calendarUrl: "https://calendar.google.com/x" } },
};
const ids = { outcomeRequestId: "11111111-1111-4111-8111-111111111111", bookingRequestId: "22222222-2222-4222-8222-222222222222" };

async function main() {
  // 1. Happy path: order, bodies, expectedStage from the fresh read.
  {
    const { io, calls } = fakeIO({ postOutcome: [OK_OUTCOME], getContext: [CTX], patchBooking: [BOOKED] });
    const { result, outcomeSaved } = await runBookMeetFlow(draft(), ids, { outcomeSaved: false }, io, null);
    assert.equal(result.kind, "booked");
    assert.equal(outcomeSaved, true);
    assert.deepEqual(calls.map((c) => c.op), ["postOutcome", "getContext", "patchBooking"]);
    const outcome = calls[0].body!;
    assert.equal(outcome.outcome, "interested");
    assert.equal(outcome.requestId, ids.outcomeRequestId);
    assert.equal(outcome.nextActionAt, "2026-10-06T21:00:00.000Z", "callback is the meeting instant, 2 p.m. Pacific");
    const booking = calls[2].body!;
    assert.equal(booking.action, "book_founder");
    assert.equal(booking.expectedStage, "connected");
    assert.equal(booking.requestId, ids.bookingRequestId);
    assert.equal(booking.meetingAt, "2026-10-06T21:00:00.000Z");
    assert.deepEqual(booking.qualification, {
      authorityConfirmed: true, websiteProblemConfirmed: true, timingConfirmed: true, minimumInvestmentConfirmed: true,
      operationsPainInTheirWords: "quotes go out a week late",
    });
    assert.deepEqual(
      booking.confirmations,
      { contactConfirmed: true, clientAgreedToTime: true, handoffComplete: true },
      "a lead that is not do-not-call never carries the owner-asked confirmation",
    );
    assert.match(String(booking.note), /^In their words: "quotes go out a week late"/);
  }

  // 2. Outcome fails retry-safe: nothing else is called, nothing booked.
  {
    const { io, calls } = fakeIO({ postOutcome: [{ status: 503, body: { ok: false, error: "lead_update_failed", retrySafe: true } }] });
    const { result, outcomeSaved } = await runBookMeetFlow(draft(), ids, { outcomeSaved: false }, io, null);
    assert.equal(result.kind, "retry_safe");
    assert.equal(outcomeSaved, false);
    assert.deepEqual(calls.map((c) => c.op), ["postOutcome"], "booking must never run when the call did not save");
  }

  // 3. Outcome refused terminally: blocked, nothing else called.
  for (const error of ["claim_released", "ownership_changed", "forbidden_role"]) {
    const { io, calls } = fakeIO({ postOutcome: [{ status: 409, body: { ok: false, error, retrySafe: false } }] });
    const { result } = await runBookMeetFlow(draft(), ids, { outcomeSaved: false }, io, null);
    assert.equal(result.kind, "blocked", error);
    assert.equal(calls.length, 1, error);
  }

  // 4. Booking 5xx after the call saved: unconfirmed; a retry skips the outcome and reuses the booking id.
  {
    const { io, calls } = fakeIO({ postOutcome: [OK_OUTCOME], getContext: [CTX], patchBooking: [{ status: 503, body: { ok: false, error: "calendar_create_failed" } }] });
    const first = await runBookMeetFlow(draft(), ids, { outcomeSaved: false }, io, null);
    assert.equal(first.result.kind, "unconfirmed");
    assert.equal(first.outcomeSaved, true);
    const retry = fakeIO({ getContext: [CTX], patchBooking: [BOOKED] });
    const second = await runBookMeetFlow(draft(), ids, { outcomeSaved: true }, retry.io, null);
    assert.equal(second.result.kind, "booked");
    assert.deepEqual(retry.calls.map((c) => c.op), ["getContext", "patchBooking"], "a retry must not log the call twice");
    assert.equal(retry.calls[1].body!.requestId, ids.bookingRequestId);
    assert.equal(calls.length, 3);
  }

  // 5. Network failure on booking is unconfirmed, never "nothing happened".
  {
    const { io } = fakeIO({ postOutcome: [OK_OUTCOME], getContext: [CTX], patchBooking: [{ networkError: true }] });
    assert.equal((await runBookMeetFlow(draft(), ids, { outcomeSaved: false }, io, null)).result.kind, "unconfirmed");
  }

  // 6. Input errors name the field.
  for (const [code, field] of [
    ["client_email_required", "email"], ["invalid_client_phone", "phone"], ["client_phone_required", "phone"],
    ["invalid_client_website", "website"], ["meeting_must_be_in_future", "time"], ["audit_host_not_on_cycle_roster", "host"],
    ["google_calendar_not_connected", "host"], ["handoff_note_required", "note"], ["client_agenda_required", "agenda"],
  ] as const) {
    const { io } = fakeIO({ postOutcome: [OK_OUTCOME], getContext: [CTX], patchBooking: [{ status: code === "audit_host_not_on_cycle_roster" ? 422 : code === "google_calendar_not_connected" ? 409 : 400, body: { ok: false, error: code } }] });
    const { result } = await runBookMeetFlow(draft(), ids, { outcomeSaved: false }, io, null);
    assert.equal(result.kind, "fix", code);
    assert.equal(result.kind === "fix" ? result.field : null, field, code);
  }

  // 7. stageUpdated: booked, reminders need a retry.
  {
    const { io } = fakeIO({ postOutcome: [OK_OUTCOME], getContext: [CTX], patchBooking: [{ status: 503, body: { ok: false, error: "meeting_activation_failed", stageUpdated: true } }] });
    assert.equal((await runBookMeetFlow(draft(), ids, { outcomeSaved: false }, io, null)).result.kind, "booked_finish");
  }

  // 8. The fresh read says the lead can no longer be booked: blocked, no PATCH.
  {
    const { io, calls } = fakeIO({ postOutcome: [OK_OUTCOME], getContext: [{ status: 200, body: { ok: true, stage: "founder_meeting_booked", canBook: false, blocked: "already_booked" } }] });
    const { result } = await runBookMeetFlow(draft(), ids, { outcomeSaved: false }, io, null);
    assert.equal(result.kind, "blocked");
    assert.ok(!calls.some((c) => c.op === "patchBooking"));
  }

  // 9. A stage race is retry-safe (nothing booked yet).
  {
    const { io } = fakeIO({ postOutcome: [OK_OUTCOME], getContext: [CTX], patchBooking: [{ status: 409, body: { ok: false, error: "stage_changed_refresh", currentStage: "qualified" } }] });
    assert.equal((await runBookMeetFlow(draft(), ids, { outcomeSaved: false }, io, null)).result.kind, "retry_safe");
  }

  // 10. Request-id signatures: payload edits renew, confirmation toggles do not.
  assert.notEqual(bookingSignature(draft()), bookingSignature(draft({ contact: { ...draft().contact, email: "x@y.test" } })));
  assert.notEqual(bookingSignature(draft()), bookingSignature(draft({ meetingTime: "14:15" })));
  assert.notEqual(bookingSignature(draft()), bookingSignature(draft({ hostUserId: "5e5e5e5e-0000-4000-8000-000000000009" })));
  assert.equal(
    bookingSignature(draft()),
    bookingSignature(draft({ confirmations: { ...draft().confirmations, contactConfirmed: false } })),
  );
  assert.equal(bookingSignature(dncDraft(false)), bookingSignature(dncDraft(true)), "the owner-asked tick is a confirmation, not payload");
  assert.notEqual(outcomeSignature(draft()), outcomeSignature(draft({ meetingTime: "15:00" })));

  // 11. Readiness: one plain reason at a time, in the order a rep fixes them.
  assert.equal(bookMeetBlockedReason(draft(), NOW), null);
  assert.match(bookMeetBlockedReason(draft({ gates: { ...draft().gates, timingConfirmed: false } }), NOW)!, /Tick all four/);
  assert.match(bookMeetBlockedReason(draft({ painWords: " " }), NOW)!, /their words/i);
  assert.match(bookMeetBlockedReason(draft({ contact: { ...draft().contact, email: "" } }), NOW)!, /best email/i);
  assert.match(bookMeetBlockedReason(draft({ contact: { ...draft().contact, phone: "555" } }), NOW)!, /10 to 15 digits/);
  assert.match(bookMeetBlockedReason(draft({ meetingDate: "2026-10-01" }), NOW)!, /already passed/);
  assert.match(bookMeetBlockedReason(draft({ meetingDate: "2027-03-14", meetingTime: "02:30", timeZone: "America/Toronto" }), NOW)!, /does not exist/);
  assert.match(bookMeetBlockedReason(draft({ hostUserId: "" }), NOW)!, /host/i);
  assert.match(bookMeetBlockedReason(draft({ confirmations: { ...draft().confirmations, clientAgreedToTime: false } }), NOW)!, /agreed/);
  assert.match(bookMeetBlockedReason(dncDraft(false), NOW)!, /owner asked/i, "do-not-call needs the owner-asked tick");
  assert.equal(bookMeetBlockedReason(dncDraft(true), NOW), null);
  assert.equal(
    bookMeetBlockedReason(draft({ confirmations: { ...draft().confirmations, ownerRequestedMeeting: false } }), NOW),
    null,
    "the owner-asked tick is never demanded on a lead that is not do-not-call",
  );
  // Confirmations are never inferred from valid data (tests/founder-booking-ui.test.ts:35-41).
  const src = readFileSync("lib/web-leads/book-meet-flow.ts", "utf8");
  for (const inferred of ["effectiveContactConfirmed", "effectiveClientAgreedToTime", "effectiveHandoffComplete", "effectiveOwnerRequested"]) {
    assert.ok(!src.includes(inferred), `${inferred} must not exist`);
  }

  // 12. Handoff note leads with their words; empty parts are dropped.
  assert.equal(composeHandoffNote(draft({ hostNote: "" })), 'In their words: "quotes go out a week late"');
  assert.equal(buildBookFounderBody(draft(), { requestId: ids.bookingRequestId, expectedStage: "connected", smsConsentArtifact: null }).smsConsent, false);

  // 13. Copy: every code the book_founder path can return has words; none leak a code; no em dash.
  const route = readFileSync("app/api/website-sales/[leadId]/route.ts", "utf8");
  const start = route.indexOf('} else if (body.action === "book_founder") {');
  const end = route.indexOf('} else if (body.action === "complete_audit") {');
  assert.ok(start > 0 && end > start, "could not find the book_founder branch");
  const branch = route.slice(start, end);
  const routeCodes = new Set<string>();
  for (const m of branch.matchAll(/error:"([a-z_]+)"/g)) routeCodes.add(m[1]);
  for (const m of branch.matchAll(/"([a-z_]+)"/g)) if (/_(required|failed|mismatch|future|phone|website|connected|roster|authorized|pending)$/.test(m[1])) routeCodes.add(m[1]);
  for (const code of routeCodes) {
    assert.ok(BOOK_MEET_COPY[code], `no rep-facing words for book_founder error "${code}"`);
  }
  for (const [code, text] of Object.entries(BOOK_MEET_COPY)) {
    assert.doesNotMatch(text, /—/, `${code} copy has an em dash`);
    assert.doesNotMatch(text, /\b[a-z]+_[a-z_]+\b/, `${code} copy leaks a raw code`);
  }
  for (const text of Object.values(KIND_SENTENCE)) assert.doesNotMatch(text, /—/);
  assert.match(bookMeetMessage("something_new", "unconfirmed"), /not confirmed/);
  assert.match(KIND_SENTENCE.unconfirmed, /15 minutes/);
  assert.doesNotMatch(readFileSync("lib/web-leads/book-meet-flow.ts", "utf8"), /—/, "no em dash in the flow module");

  // 14. Call Mode cursor after a booking (Review Focus 2).
  const q = [{ id: "a" }, { id: "b" }, { id: "c" }];
  assert.equal(cursorAfterBooking(q, 1, "b"), 2, "booked lead still in the queue: move past it");
  assert.equal(cursorAfterBooking([{ id: "a" }, { id: "c" }], 1, "b"), 1, "refresh already removed it: the cursor is on the next lead, do not skip");
  assert.equal(cursorAfterBooking([{ id: "b" }, { id: "a" }, { id: "c" }], 1, "b"), 1, "reordered: never jump");

  // 15. Do-not-call, owner asked: the call log is skipped (it refuses do-not-call
  //     leads), the booking carries ownerRequestedMeeting, and it books.
  {
    const { io, calls } = fakeIO({ getContext: [DNC_CTX], patchBooking: [BOOKED] });
    const { result, outcomeSaved } = await runBookMeetFlow(dncDraft(true), ids, { outcomeSaved: false }, io, null);
    assert.equal(result.kind, "booked");
    assert.equal(outcomeSaved, false, "nothing was logged, so nothing may claim it was");
    assert.deepEqual(calls.map((c) => c.op), ["getContext", "patchBooking"]);
    const booking = calls[1].body!;
    assert.equal(booking.expectedStage, "attempting_contact");
    assert.deepEqual(booking.confirmations, {
      contactConfirmed: true, clientAgreedToTime: true, handoffComplete: true, ownerRequestedMeeting: true,
    });
  }

  // 16. Do-not-call refusals are a box to tick, never a dead end.
  {
    // (a) The lead became do-not-call after the panel opened: the call log refuses it.
    const a = fakeIO({ postOutcome: [{ status: 409, body: { ok: false, error: "do_not_call", retrySafe: false } }] });
    const ra = await runBookMeetFlow(draft(), ids, { outcomeSaved: false }, a.io, null);
    assert.equal(ra.result.kind, "fix");
    assert.equal(ra.result.kind === "fix" ? ra.result.field : null, "dnc");
    assert.deepEqual(a.calls.map((c) => c.op), ["postOutcome"]);
    // (b) The fresh read says do-not-call but the draft did not know: no PATCH, tick the box.
    const b = fakeIO({ postOutcome: [OK_OUTCOME], getContext: [DNC_CTX] });
    const rb = await runBookMeetFlow(draft(), ids, { outcomeSaved: false }, b.io, null);
    assert.equal(rb.result.kind === "fix" ? rb.result.field : null, "dnc");
    assert.ok(!b.calls.some((c) => c.op === "patchBooking"), "never PATCH a do-not-call lead without the owner-asked tick");
    // (c) The booking route itself refuses do_not_call.
    const c = fakeIO({ getContext: [DNC_CTX], patchBooking: [{ status: 409, body: { ok: false, error: "do_not_call" } }] });
    const rc = await runBookMeetFlow(dncDraft(true), ids, { outcomeSaved: false }, c.io, null);
    assert.equal(rc.result.kind === "fix" ? rc.result.field : null, "dnc");
    assert.match(BOOK_MEET_COPY.do_not_call, /owner asked/i);
  }

  // An organiser mismatch can follow a created Google event that is then
  // cancelled: the copy must not let a rep tell the client nothing was sent.
  assert.match(BOOK_MEET_COPY.calendar_organizer_mismatch, /cancelled automatically within 15 minutes/);

  console.log("book-meet-flow: OK");
}
main().catch((error) => { console.error(error); process.exit(1); });
