/**
 * Spawned by tests/book-meet-panel.test.ts as a PLAIN node process: the suite
 * runs under --conditions=react-server, where a client component cannot be
 * rendered (same reason as web-leads-automations-catalogue.render.ts).
 * Prints one JSON object { state: markup }.
 */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BookMeetForm, type BookMeetFormProps } from "../components/web-leads/BookMeetPanel";
import { DEFAULT_CLIENT_AGENDA, type BookMeetDraft } from "../lib/web-leads/book-meet-flow";

const draft: BookMeetDraft = {
  leadId: "6f6f6f6f-0000-4000-8000-0000000000aa",
  gates: { authorityConfirmed: false, websiteProblemConfirmed: false, timingConfirmed: false, minimumInvestmentConfirmed: false },
  painWords: "",
  timeZone: "America/Vancouver",
  meetingDate: "2026-10-06",
  meetingTime: "14:00",
  hostUserId: "host-1",
  contact: { name: "Pat Owner", company: "[TEST] Canary Plumbing", email: "pat@canary.test", phone: "604-555-0100", website: "" },
  agenda: DEFAULT_CLIENT_AGENDA,
  hostNote: "",
  doNotCall: false,
  confirmations: { contactConfirmed: false, clientAgreedToTime: false, handoffComplete: false, ownerRequestedMeeting: false },
  smsConsent: false,
};
const base: BookMeetFormProps = {
  variant: "card",
  businessName: "[TEST] Canary Plumbing",
  draft,
  zone: { timeZone: "America/Vancouver", label: "Pacific time", known: true },
  hosts: [{ userId: "host-1", name: "Adon", email: "adon@oasisai.work", calendarReady: true, identityMismatch: false, connectedAddress: null }],
  hostState: "ready",
  systemCalendarFallback: false,
  altEmails: ["info@canary.test"],
  altPhone: null,
  status: { kind: "idle" },
  blockedReason: "Tick all four checks before booking.",
  blocked: null,
  existingMeeting: null,
  now: Date.parse("2026-10-05T15:00:00.000Z"),
  onDraft: () => undefined,
  onSubmit: () => undefined,
  onUnlock: () => undefined,
};
const states: Record<string, BookMeetFormProps> = {
  idle: base,
  noEmail: { ...base, draft: { ...draft, contact: { ...draft.contact, email: "" } }, altEmails: [] },
  blocked: { ...base, blocked: { code: "claim_released", message: "Your hold on this lead ran out and it went back to the Leads pool. Claim it again first. Nothing was booked." } },
  working: { ...base, blockedReason: null, status: { kind: "working", step: "booking" } },
  unconfirmed: { ...base, blockedReason: null, status: { kind: "unconfirmed", code: "calendar_create_failed", message: "Google or our records did not finish the booking. The meeting is not confirmed. Press Try again now: it reuses the same booking and will not send a second invite. If it is not finished within 15 minutes, any invite already sent is cancelled automatically." } },
  retrySafe: { ...base, blockedReason: null, status: { kind: "retry_safe", code: "network", message: "The call did not save. Nothing was booked yet. Press Try again." } },
  fixEmail: { ...base, blockedReason: null, status: { kind: "fix", code: "client_email_required", field: "email", message: "The invite needs a real email address. Nothing was booked." } },
  dnc: {
    ...base,
    draft: { ...draft, doNotCall: true },
    blockedReason: "This business is on the do-not-call list. Tick that the owner asked for this meeting.",
    status: { kind: "fix", code: "do_not_call", field: "dnc", message: "This business is on the do-not-call list. Book only if the owner asked for this meeting, and tick that box. Nothing was booked." },
  },
  booked: { ...base, blockedReason: null, status: { kind: "booked", meeting: { meetingAt: "2026-10-06T21:00:00.000Z", meetLink: "https://meet.google.com/abc-defg-hij", calendarUrl: "https://calendar.google.com/x" } } },
  callmodeBooked: { ...base, variant: "callmode", onNextLead: () => undefined, blockedReason: null, status: { kind: "booked", meeting: { meetingAt: "2026-10-06T21:00:00.000Z", meetLink: "https://meet.google.com/abc-defg-hij", calendarUrl: null } } },
};
const out: Record<string, string> = {};
for (const [name, props] of Object.entries(states)) out[name] = renderToStaticMarkup(React.createElement(BookMeetForm, props));
process.stdout.write(JSON.stringify(out));
