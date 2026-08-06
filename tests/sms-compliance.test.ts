/**
 * tests/sms-compliance.test.ts — the SMS rules that decide whether a real
 * person legally receives a message.
 *
 * Researched 2026-08-05 from FCC rules, state statutes and carrier policy.
 * Statutory damages are $500/message and $1,500 willful, with a private right
 * of action and no cap, so these are not style preferences.
 *
 * Two things this file pins:
 *   1. Opt-out detection is PERMISSIVE, not a keyword list. 47 CFR
 *      64.1200(a)(10) requires honoring revocation by "any reasonable means".
 *      A fixed list would miss "take me off your list" and that is a violation.
 *   2. Quiet hours are STATE-specific. The engine currently enforces a flat
 *      federal 8am-9pm, which is illegal in six states.
 */

import assert from "node:assert/strict";
import {
  detectOptOut,
  quietHoursForState,
  isWithinSendWindow,
  maxMessagesPer24h,
} from "../lib/sms/compliance";

// ---------------------------------------------------------------------------
// OPT-OUT DETECTION
// ---------------------------------------------------------------------------

// The regulatory keyword list, 47 CFR 64.1200(a)(10). Non-exhaustive by law.
for (const kw of ["stop", "quit", "end", "revoke", "opt out", "optout", "cancel", "unsubscribe", "stopall"]) {
  assert.equal(detectOptOut(kw).optOut, true, `"${kw}" must be honored`);
  assert.equal(detectOptOut(kw).confidence, "explicit", `"${kw}" is an explicit keyword`);
}

// Case, whitespace and punctuation must not defeat it. Real replies are messy.
assert.equal(detectOptOut("STOP").optOut, true);
assert.equal(detectOptOut("  Stop.  ").optOut, true);
assert.equal(detectOptOut("STOP!").optOut, true);
assert.equal(detectOptOut("Stop please").optOut, true);
assert.equal(detectOptOut("please STOP texting me").optOut, true);
assert.equal(detectOptOut("UNSUBSCRIBE").optOut, true);
assert.equal(detectOptOut("Opt-Out").optOut, true);

// "Any reasonable means" — natural-language revocation that no keyword list
// would catch. These are the ones that become violations.
for (const phrase of [
  "take me off your list",
  "please remove me",
  "do not text me again",
  "don't text me",
  "no more texts",
  "leave me alone",
  "not interested, remove me",
]) {
  const r = detectOptOut(phrase);
  assert.equal(r.optOut, true, `"${phrase}" must be treated as an opt-out`);
  assert.equal(r.confidence, "likely", `"${phrase}" is a likely, human-reviewable opt-out`);
}

// Must NOT fire on ordinary conversation. A false positive silently kills a
// live deal, so precision matters as much as recall.
for (const phrase of [
  "yes please send me the application",
  "what documents do you need",
  "I stopped by the bank today",
  "can you call me",
  "sounds good",
  "my end of month revenue is 40k",
  "I want to cancel my other loan",
]) {
  assert.equal(detectOptOut(phrase).optOut, false, `"${phrase}" must NOT be an opt-out`);
}

// Empty and junk are not opt-outs, and must not throw.
assert.equal(detectOptOut("").optOut, false);
assert.equal(detectOptOut(null as unknown as string).optOut, false);
assert.equal(detectOptOut(undefined as unknown as string).optOut, false);

// ---------------------------------------------------------------------------
// QUIET HOURS BY STATE
// ---------------------------------------------------------------------------

// Federal default.
assert.deepEqual(quietHoursForState("NY"), { startHour: 8, endHour: 21, noSunday: false });
assert.deepEqual(quietHoursForState(null), { startHour: 8, endHour: 21, noSunday: false });
assert.deepEqual(quietHoursForState("zz"), { startHour: 8, endHour: 21, noSunday: false });

// 8pm states.
for (const st of ["FL", "MD", "OK"]) {
  assert.deepEqual(quietHoursForState(st), { startHour: 8, endHour: 20, noSunday: false }, st);
}
// 8pm AND no Sunday.
for (const st of ["AL", "LA", "MS"]) {
  assert.deepEqual(quietHoursForState(st), { startHour: 8, endHour: 20, noSunday: true }, st);
}
// Rhode Island is the strictest.
assert.deepEqual(quietHoursForState("RI"), { startHour: 9, endHour: 18, noSunday: false });
// Texas starts at noon on Sunday — handled by isWithinSendWindow, not the table.
assert.deepEqual(quietHoursForState("TX"), { startHour: 9, endHour: 21, noSunday: false });

// Case-insensitive, whitespace-tolerant, and full names accepted.
assert.equal(quietHoursForState("fl").endHour, 20);
assert.equal(quietHoursForState(" Florida ").endHour, 20);

// ---------------------------------------------------------------------------
// THE SEND WINDOW
// Wednesday 2026-08-05 is a weekday; Sunday 2026-08-09; Saturday 2026-08-08.
// ---------------------------------------------------------------------------
const wed = (h: number) => new Date(Date.UTC(2026, 7, 5, h, 0, 0));
const sun = (h: number) => new Date(Date.UTC(2026, 7, 9, h, 0, 0));
const sat = (h: number) => new Date(Date.UTC(2026, 7, 8, h, 0, 0));

// Federal: 8am-9pm.
assert.equal(isWithinSendWindow("NY", wed(7)).ok, false, "7am is too early everywhere");
assert.equal(isWithinSendWindow("NY", wed(8)).ok, true, "8am is the boundary and is allowed");
assert.equal(isWithinSendWindow("NY", wed(20)).ok, true, "8pm is fine federally");
assert.equal(isWithinSendWindow("NY", wed(21)).ok, false, "9pm is the cutoff, exclusive");

// Florida stops at 8pm — the hour that is legal in NY and illegal in FL.
assert.equal(isWithinSendWindow("FL", wed(20)).ok, false, "8pm is ILLEGAL in Florida");
assert.equal(isWithinSendWindow("FL", wed(19)).ok, true);

// Alabama: no Sunday at all.
assert.equal(isWithinSendWindow("AL", sun(12)).ok, false, "no Sunday sends in Alabama");
assert.equal(isWithinSendWindow("AL", wed(12)).ok, true);

// Texas: noon start on Sunday, 9am other days.
assert.equal(isWithinSendWindow("TX", sun(10)).ok, false, "10am Sunday is too early in Texas");
assert.equal(isWithinSendWindow("TX", sun(13)).ok, true, "1pm Sunday is fine in Texas");
assert.equal(isWithinSendWindow("TX", wed(10)).ok, true);
assert.equal(isWithinSendWindow("TX", wed(8)).ok, false, "Texas does not open until 9am");

// Rhode Island: 9-6 weekdays, 9-5 Saturday.
assert.equal(isWithinSendWindow("RI", wed(17)).ok, true);
assert.equal(isWithinSendWindow("RI", wed(18)).ok, false, "RI closes at 6pm");
assert.equal(isWithinSendWindow("RI", sat(16)).ok, true);
assert.equal(isWithinSendWindow("RI", sat(17)).ok, false, "RI closes at 5pm Saturday");

// A refusal explains itself so a hold reason can be logged.
assert.match(isWithinSendWindow("FL", wed(20)).reason || "", /quiet_hours|window/i);

// ---------------------------------------------------------------------------
// FREQUENCY CAP — law in FL, MD, OK; applied nationally as the safe default.
// ---------------------------------------------------------------------------
assert.equal(maxMessagesPer24h("FL"), 3);
assert.equal(maxMessagesPer24h("MD"), 3);
assert.equal(maxMessagesPer24h("OK"), 3);
assert.equal(maxMessagesPer24h("NY"), 3, "applied nationally as the conservative default");

console.log("sms-compliance.test.ts — all assertions passed ✓");
