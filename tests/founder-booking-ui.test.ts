import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync("app/pipeline/[id]/LeadLifecycleActions.tsx", "utf8");

assert.match(source, /const FOUNDER_TIMEZONE = "America\/Toronto"/);
assert.match(source, /type="date"/, "founder booking uses a dedicated date control");
assert.match(source, /FOUNDER_TIME_OPTIONS/, "founder booking exposes deliberate time choices");
assert.match(source, /15-minute/, "the UI explains the booking interval");
for (const shortcut of ["Today", "Tomorrow", "In 2 days"]) {
  assert(source.includes(shortcut), `founder booking includes the ${shortcut} quick date choice`);
}

for (const field of ["name", "company", "email", "phone", "website"]) {
  assert.match(
    source,
    new RegExp(`contact:\\s*\\{[\\s\\S]*?${field}:`),
    `the server booking payload includes contact.${field}`,
  );
}
assert.match(source, /timezone:\s*FOUNDER_TIMEZONE/);
assert.match(source, /qualification:\s*\{/);
assert.match(source, /confirmations:\s*\{/);
for (const key of [
  "contactConfirmed",
  "clientAgreedToTime",
  "handoffComplete",
] as const) {
  assert.match(
    source,
    new RegExp(`confirmations:\\s*\\{[\\s\\S]*?${key}(?:,|\\s*:)`),
    `booking payload must send the operator's explicit ${key} checkbox state`,
  );
}
for (const inferred of [
  "effectiveContactConfirmed",
  "effectiveClientAgreedToTime",
  "effectiveHandoffComplete",
]) {
  assert(!source.includes(inferred), `${inferred} must not infer a confirmation from valid form data`);
}
assert.match(source, /smsConsent:\s*Boolean\(/);
assert.match(source, /requestId:\s*founderBookingRequestId/);

assert.match(source, /Client-facing meeting agenda/i);
assert.match(source, /Internal founder handoff note/i);
assert.match(source, /never sent to the client/i);
assert.match(source, /confirmed the client(?:'|&apos;)s contact details and email/i);
assert.match(source, /client agreed to this date and time/i);
assert.match(source, /internal founder handoff note is complete/i);
assert.match(source, /Create Google Meet & send invite/);
assert(!source.includes('type="datetime-local"'), "all lifecycle dates use explicit date and time controls");
assert.match(source, /LifecycleDateTimeFields/, "follow-ups and reschedules share the guided Eastern-time control");
assert.match(source, /Rescheduling updates the existing Google invite/i);
assert.match(source, /outcomeConfirmed/);
for (const step of ["Contact", "Host & time", "Agenda", "Confirm", "Review"]) {
  assert(source.includes(step), `guided booking includes the ${step} step`);
}
assert.match(source, /aria-current=\{bookingStep === index \? "step"/);
assert.match(source, /type="checkbox"/, "confirmations use native keyboard-accessible controls");

assert(!source.includes("window.open"), "booking must not depend on the rep's browser Google account");
assert(!source.includes("googleCalendarAuditUrl"), "the client must not construct a Calendar draft URL");
assert(!source.includes("calendarDraftOpened"), "booking is a single server-backed action");
assert(!source.includes("calendarConfirmed"), "the browser cannot claim a Calendar event was created");
assert(!source.includes("Open prefilled Google Calendar"), "the old two-step draft flow is removed");
assert(!source.includes("I saved the event"), "the old unverifiable confirmation is removed");

console.log("founder-booking-ui: OK");
