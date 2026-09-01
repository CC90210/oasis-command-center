import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  classifyMeetingReply,
  parseProposedTime,
} from "../lib/sms/meeting-intent";

const NOW = "2026-08-31T16:00:00.000Z"; // 12:00 in America/Toronto.
const TIME_ZONE = "America/Toronto";

// Explicit, deterministic confirmations.
for (const body of ["yes", "confirmed", "see you then", "that works for me"]) {
  assert.deepEqual(classifyMeetingReply(body), {
    intent: "confirm",
    confidence: "high",
    proposedTime: null,
  }, body);
}

// Reschedule intent is independent of whether the proposed time is safe enough
// to execute. An ambiguous hour still routes as a reschedule, but carries no
// datetime for policy code to act on.
assert.deepEqual(
  classifyMeetingReply("Can we move the meeting to tomorrow at 2?", {
    nowIso: NOW,
    timeZone: TIME_ZONE,
  }),
  { intent: "reschedule", confidence: "high", proposedTime: null },
);
assert.deepEqual(
  classifyMeetingReply("Can we reschedule to tomorrow at 2:30 pm?", {
    nowIso: NOW,
    timeZone: TIME_ZONE,
  }),
  {
    intent: "reschedule",
    confidence: "high",
    proposedTime: { isoLocal: "2026-09-01T14:30", source: "relative_datetime" },
  },
);

// Meeting cancellation must name the meeting context. A bare carrier keyword
// remains an opt-out by the explicit D4 policy; the webhook separately queues
// the meeting-cancellation proposal.
assert.equal(classifyMeetingReply("Please cancel our meeting").intent, "cancel");
assert.equal(classifyMeetingReply("Can you cancel our meeting?").intent, "cancel");
assert.equal(classifyMeetingReply("Could you cancel our meeting?").intent, "cancel");
assert.equal(classifyMeetingReply("I need to cancel the appointment").intent, "cancel");
assert.equal(classifyMeetingReply("I need to cancel").intent, "cancel");
assert.equal(classifyMeetingReply("I need you to cancel our meeting").intent, "cancel");
assert.equal(classifyMeetingReply("I want to cancel our meeting").intent, "cancel");
assert.equal(classifyMeetingReply("I have to cancel, sorry").intent, "cancel");
for (const body of [
  "I would like to cancel our meeting",
  "Sorry, can you cancel our meeting?",
  "Can you cancel our meeting, thanks.",
  "Can you cancel our meeting, thank you.",
]) {
  assert.deepEqual(classifyMeetingReply(body), {
    intent: "cancel",
    confidence: "high",
    proposedTime: null,
  }, body);
}
for (const body of [
  "Cancel my meeting and text me alternatives",
  "Please cancel the meeting; message me new times",
  "Cancel our appointment, please text me other options",
  "Can you cancel our meeting and text me?",
]) {
  assert.deepEqual(classifyMeetingReply(body), {
    intent: "cancel",
    confidence: "high",
    proposedTime: null,
  }, body);
}
for (const body of [
  "Cancel our meeting and STOP",
  "Cancel our meeting and unsubscribe",
  "Cancel our meeting and text me no more",
  "Cancel our meeting and no more texts",
]) {
  assert.deepEqual(classifyMeetingReply(body), {
    intent: "opt_out",
    confidence: "high",
    proposedTime: null,
  }, body);
}
assert.deepEqual(classifyMeetingReply("do not cancel our meeting"), {
  intent: "unknown",
  confidence: "low",
  proposedTime: null,
});
assert.equal(classifyMeetingReply("never cancel this call").intent, "unknown");
assert.equal(classifyMeetingReply("I can't cancel our meeting").intent, "unknown");
assert.equal(
  classifyMeetingReply("Please confirm you did not cancel our meeting?").intent,
  "question",
);
for (const body of [
  "I don't want to move the meeting to tomorrow at 2pm",
  "I don't want to reschedule",
  "I don't want to cancel our meeting",
  "I don't think we should cancel the meeting",
]) {
  assert.deepEqual(classifyMeetingReply(body, { nowIso: NOW, timeZone: TIME_ZONE }), {
    intent: "unknown",
    confidence: "low",
    proposedTime: null,
  }, body);
}
for (const body of [
  "Did you cancel our meeting?",
  "Was our meeting cancelled?",
  "Can you confirm the meeting was cancelled?",
  "What happens if I cancel our meeting?",
  "Why did you cancel our meeting?",
]) {
  assert.deepEqual(classifyMeetingReply(body), {
    intent: "question",
    confidence: "high",
    proposedTime: null,
  }, body);
}
for (const body of [
  "I almost cancelled our meeting",
  "I was going to cancel our meeting, but changed my mind",
  "Cancel our meeting? No, don't",
]) {
  assert.deepEqual(classifyMeetingReply(body), {
    intent: "unknown",
    confidence: "low",
    proposedTime: null,
  }, body);
}
for (const body of [
  "Did you reschedule our meeting to tomorrow at 2pm?",
  "Why did you reschedule our meeting to tomorrow at 2pm?",
]) {
  assert.deepEqual(classifyMeetingReply(body, { nowIso: NOW, timeZone: TIME_ZONE }), {
    intent: "question",
    confidence: "high",
    proposedTime: null,
  }, body);
}
for (const body of [
  "I was going to reschedule to tomorrow at 2pm but changed my mind",
  "Reschedule to tomorrow at 2pm? No, don't",
]) {
  assert.deepEqual(classifyMeetingReply(body, { nowIso: NOW, timeZone: TIME_ZONE }), {
    intent: "unknown",
    confidence: "low",
    proposedTime: null,
  }, body);
}
for (const body of [
  "If I cancel our meeting, what happens?",
  "Should I cancel our meeting?",
  "Do you want me to cancel our meeting?",
  "I need to know how to cancel our meeting",
  "Do I need to cancel our meeting?",
  "If I reschedule to tomorrow at 2pm, what happens?",
  "If I reschedule our meeting, would tomorrow at 2pm work?",
  "Should I reschedule to tomorrow at 2pm?",
  "Do I need to reschedule our meeting to tomorrow at 2pm?",
]) {
  assert.deepEqual(classifyMeetingReply(body, { nowIso: NOW, timeZone: TIME_ZONE }), {
    intent: "question",
    confidence: "high",
    proposedTime: null,
  }, body);
}
for (const body of [
  "I might cancel our meeting",
  "I am thinking about cancelling our meeting",
  "I am considering cancelling our meeting",
  "I might need to cancel our meeting",
  "Maybe cancel our meeting",
  "I will probably cancel our meeting",
  "I might reschedule to tomorrow at 2pm",
  "I am considering rescheduling our meeting to tomorrow at 2pm",
  "Maybe reschedule our meeting to tomorrow at 2pm",
  "I will probably reschedule our meeting to tomorrow at 2pm",
  "If tomorrow at 2pm works for you, I could reschedule",
  "I can reschedule if tomorrow at 2pm works",
]) {
  assert.deepEqual(classifyMeetingReply(body, { nowIso: NOW, timeZone: TIME_ZONE }), {
    intent: "unknown",
    confidence: "low",
    proposedTime: null,
  }, body);
}
assert.deepEqual(classifyMeetingReply("I need information on how to cancel our meeting"), {
  intent: "question",
  confidence: "high",
  proposedTime: null,
});
for (const body of [
  "We discussed cancelling our meeting",
  "The contract says cancel our meeting",
  "The email said cancel our meeting",
  "My partner wants me to cancel our meeting",
  "He asked me to cancel our meeting",
  "I was told to cancel our meeting",
  "The instructions say to reschedule to tomorrow at 2pm",
  "We discussed rescheduling to tomorrow at 2pm",
  "My partner wants me to reschedule to tomorrow at 2pm",
]) {
  assert.deepEqual(classifyMeetingReply(body, { nowIso: NOW, timeZone: TIME_ZONE }), {
    intent: "unknown",
    confidence: "low",
    proposedTime: null,
  }, body);
}
for (const tail of [
  "Actually no.",
  "Actually, no.",
  "Scratch that.",
  "Disregard that.",
  "Keep the original time.",
  "Nevermind.",
]) {
  const body = `Please reschedule our meeting to tomorrow at 2pm. ${tail}`;
  assert.deepEqual(classifyMeetingReply(body, { nowIso: NOW, timeZone: TIME_ZONE }), {
    intent: "unknown",
    confidence: "low",
    proposedTime: null,
  }, body);
  assert.equal(parseProposedTime(body, NOW, TIME_ZONE), null, body);
}
for (const body of [
  "Please reschedule our meeting to tomorrow at 2pm, actually don't.",
  "Please reschedule our meeting to tomorrow at 2pm, actually don’t.",
]) {
  assert.deepEqual(classifyMeetingReply(body, { nowIso: NOW, timeZone: TIME_ZONE }), {
    intent: "unknown",
    confidence: "low",
    proposedTime: null,
  }, body);
  assert.equal(parseProposedTime(body, NOW, TIME_ZONE), null, body);
}
for (const tail of [
  "Forget it.",
  "Ignore that.",
  "I take that back.",
  "Leave it as is.",
  "On second thought keep the original.",
]) {
  const body = `Please reschedule our meeting to tomorrow at 2pm. ${tail}`;
  assert.deepEqual(classifyMeetingReply(body, { nowIso: NOW, timeZone: TIME_ZONE }), {
    intent: "unknown",
    confidence: "low",
    proposedTime: null,
  }, body);
  assert.equal(parseProposedTime(body, NOW, TIME_ZONE), null, body);
}
for (const body of [
  "Please reschedule our meeting to tomorrow at 2pm, depending on availability.",
  "Please reschedule our meeting to tomorrow at 2pm, subject to availability.",
  "Please reschedule our meeting to tomorrow at 2pm, provided it is available.",
  "Please reschedule our meeting to tomorrow at 2pm, assuming it is available.",
  "Please reschedule our meeting to tomorrow at 2pm. Do not do that.",
  "Please reschedule our meeting to tomorrow at 2pm, but don't.",
  "Please reschedule our meeting to tomorrow at 2pm unless I say otherwise.",
]) {
  assert.deepEqual(classifyMeetingReply(body, { nowIso: NOW, timeZone: TIME_ZONE }), {
    intent: "unknown",
    confidence: "low",
    proposedTime: null,
  }, body);
  assert.equal(parseProposedTime(body, NOW, TIME_ZONE), null, body);
}
assert.deepEqual(
  classifyMeetingReply("Can we reschedule tomorrow, say at 2pm?", {
    nowIso: NOW,
    timeZone: TIME_ZONE,
  }),
  { intent: "question", confidence: "high", proposedTime: null },
);
assert.equal(
  parseProposedTime("Can we reschedule tomorrow, say at 2pm?", NOW, TIME_ZONE),
  null,
);
assert.deepEqual(
  classifyMeetingReply("Can you reschedule the second item to tomorrow at 2pm before our meeting?", {
    nowIso: NOW,
    timeZone: TIME_ZONE,
  }),
  { intent: "question", confidence: "high", proposedTime: null },
);
for (const body of [
  "Please reschedule the delivery to tomorrow at 2pm",
  "I need to reschedule my dentist appointment to tomorrow at 2pm before our meeting.",
]) {
  assert.deepEqual(classifyMeetingReply(body, { nowIso: NOW, timeZone: TIME_ZONE }), {
    intent: "unknown",
    confidence: "low",
    proposedTime: null,
  }, body);
}
for (const body of [
  "Can you reschedule the second item to tomorrow at 2pm before our meeting?",
  "Please reschedule the delivery to tomorrow at 2pm",
  "I need to reschedule my dentist appointment to tomorrow at 2pm before our meeting.",
]) {
  assert.equal(parseProposedTime(body, NOW, TIME_ZONE), null, body);
}
assert.deepEqual(
  classifyMeetingReply("Could we reschedule to tomorrow at 2pm?", {
    nowIso: NOW,
    timeZone: TIME_ZONE,
  }),
  {
    intent: "reschedule",
    confidence: "high",
    proposedTime: { isoLocal: "2026-09-01T14:00", source: "relative_datetime" },
  },
);
for (const body of [
  "I would like to reschedule our meeting to tomorrow at 2pm",
  "Sorry, can you reschedule our meeting to tomorrow at 2pm?",
  "Can you reschedule our meeting to tomorrow at 2pm, thanks.",
  "Can you reschedule our meeting to tomorrow at 2pm, thank you.",
]) {
  assert.deepEqual(classifyMeetingReply(body, { nowIso: NOW, timeZone: TIME_ZONE }), {
    intent: "reschedule",
    confidence: "high",
    proposedTime: { isoLocal: "2026-09-01T14:00", source: "relative_datetime" },
  }, body);
  assert.equal(parseProposedTime(body, NOW, TIME_ZONE), "2026-09-01T14:00", body);
}
for (const body of [
  "I would like to cancel our meeting because of a conflict.",
  "I would like to reschedule our meeting to tomorrow at 2pm because of a conflict.",
]) {
  assert.deepEqual(classifyMeetingReply(body, { nowIso: NOW, timeZone: TIME_ZONE }), {
    intent: "unknown",
    confidence: "low",
    proposedTime: null,
  }, body);
}
assert.equal(
  parseProposedTime(
    "I would like to reschedule our meeting to tomorrow at 2pm because of a conflict.",
    NOW,
    TIME_ZONE,
  ),
  null,
);
for (const body of [
  "Please reschedule our meeting.",
  "Can we reschedule?",
  "Could you move the meeting?",
  "I need to change the meeting time.",
]) {
  assert.deepEqual(classifyMeetingReply(body, { nowIso: NOW, timeZone: TIME_ZONE }), {
    intent: "reschedule",
    confidence: "high",
    proposedTime: null,
  }, body);
}
for (const body of [
  "Reschedule our meeting to tomorrow at 2pm",
  "I need to reschedule our meeting to tomorrow at 2pm",
  "I want to reschedule our meeting to tomorrow at 2pm",
  "I have to reschedule our meeting to tomorrow at 2pm",
  "We want you to reschedule our meeting to tomorrow at 2pm",
]) {
  assert.equal(
    classifyMeetingReply(body, { nowIso: NOW, timeZone: TIME_ZONE }).proposedTime?.isoLocal,
    "2026-09-01T14:00",
    body,
  );
}
assert.deepEqual(classifyMeetingReply("cancel"), {
  intent: "opt_out",
  confidence: "high",
  proposedTime: null,
});

for (const body of ["STOP", "unsubscribe", "please stop texting me", "take me off your list"]) {
  assert.equal(classifyMeetingReply(body).intent, "opt_out", body);
}
assert.equal(classifyMeetingReply("reschedule STOP").intent, "opt_out");
assert.equal(classifyMeetingReply("cancel our meeting STOP").intent, "opt_out");

// False positives with money and consent attached: neither phrase authorizes
// an opt-out or a calendar mutation.
assert.notEqual(classifyMeetingReply("stop by at 3").intent, "opt_out");
assert.equal(classifyMeetingReply("stop by at 3").intent, "unknown");
assert.equal(classifyMeetingReply("cancel the second item").intent, "unknown");
const itemCancellation = classifyMeetingReply("can you cancel the second item");
assert.notEqual(itemCancellation.intent, "cancel");
assert.notEqual(itemCancellation.intent, "opt_out");
const incidentalMeeting = classifyMeetingReply("Can you cancel the second item before our meeting?");
assert.notEqual(incidentalMeeting.intent, "cancel");
assert.equal(classifyMeetingReply("Please move the second item to the top").intent, "unknown");
assert.equal(classifyMeetingReply("stop by and unsubscribe").intent, "opt_out");

assert.equal(classifyMeetingReply("I'm running about 10 minutes late").intent, "running_late");
assert.equal(classifyMeetingReply("I'm running 10 minutes late").intent, "running_late");
assert.equal(classifyMeetingReply("I'll join 15 minutes late").intent, "running_late");
for (const body of [
  "Are you running late?",
  "I'm not running late",
  "I was running late but I'm on time now",
]) {
  assert.notEqual(classifyMeetingReply(body).intent, "running_late", body);
}
assert.equal(classifyMeetingReply("Can you send me the Meet link?").intent, "question");
assert.equal(classifyMeetingReply("banana").intent, "unknown");

// A bare number is inert unless the durable conversation state says the agent
// has already offered slots. Even then, the selected slot must exist and be a
// valid local ISO minute before it can become a proposed reschedule.
assert.equal(classifyMeetingReply("2").intent, "unknown");
assert.equal(
  classifyMeetingReply("2", { state: "awaiting_slot_choice" }).intent,
  "unknown",
);
assert.deepEqual(
  classifyMeetingReply("2", {
    state: "awaiting_slot_choice",
    proposedSlots: ["2026-09-01T09:00", "2026-09-01T10:15", "2026-09-01T11:30"],
  }),
  {
    intent: "reschedule",
    confidence: "high",
    proposedTime: { isoLocal: "2026-09-01T10:15", source: "slot_choice" },
  },
);
assert.equal(
  classifyMeetingReply("4", {
    state: "awaiting_slot_choice",
    proposedSlots: ["2026-09-01T09:00", "2026-09-01T10:15", "2026-09-01T11:30"],
  }).intent,
  "unknown",
);

// Datetime parsing fails closed on every ambiguous or invalid shape.
assert.equal(parseProposedTime("tomorrow at 2pm", NOW, TIME_ZONE), "2026-09-01T14:00");
assert.equal(
  parseProposedTime("May we reschedule to tomorrow at 2pm?", NOW, TIME_ZONE),
  "2026-09-01T14:00",
);
assert.equal(parseProposedTime("tomorrow at 14:30", NOW, TIME_ZONE), "2026-09-01T14:30");
assert.equal(parseProposedTime("today at 3:15 pm", NOW, TIME_ZONE), "2026-08-31T15:15");
assert.equal(parseProposedTime("tomorrow at 2", NOW, TIME_ZONE), null, "2 is AM/PM ambiguous");
assert.equal(parseProposedTime("tomorrow afternoon", NOW, TIME_ZONE), null);
assert.equal(parseProposedTime("tomorrow at 2pm or 3pm", NOW, TIME_ZONE), null);
assert.equal(parseProposedTime("tomorrow at 2pm / 3pm", NOW, TIME_ZONE), null);
assert.equal(
  parseProposedTime("I don't want to move the meeting to tomorrow at 2pm", NOW, TIME_ZONE),
  null,
);
assert.equal(
  parseProposedTime("I don’t want to reschedule to tomorrow at 2pm", NOW, TIME_ZONE),
  null,
);
for (const body of [
  "Did you reschedule our meeting to tomorrow at 2pm?",
  "Why did you reschedule our meeting to tomorrow at 2pm?",
  "I was going to reschedule to tomorrow at 2pm but changed my mind",
  "Reschedule to tomorrow at 2pm? No, don't",
]) {
  assert.equal(parseProposedTime(body, NOW, TIME_ZONE), null, body);
}
for (const body of [
  "If I reschedule to tomorrow at 2pm, what happens?",
  "I might reschedule to tomorrow at 2pm",
  "I am considering rescheduling our meeting to tomorrow at 2pm",
  "Maybe reschedule our meeting to tomorrow at 2pm",
  "I will probably reschedule our meeting to tomorrow at 2pm",
  "Should I reschedule to tomorrow at 2pm?",
  "Do I need to reschedule our meeting to tomorrow at 2pm?",
  "If I reschedule our meeting, would tomorrow at 2pm work?",
  "If tomorrow at 2pm works for you, I could reschedule",
  "I can reschedule if tomorrow at 2pm works",
]) {
  assert.equal(parseProposedTime(body, NOW, TIME_ZONE), null, body);
}
for (const body of [
  "The instructions say to reschedule to tomorrow at 2pm",
  "We discussed rescheduling to tomorrow at 2pm",
  "My partner wants me to reschedule to tomorrow at 2pm",
]) {
  assert.equal(parseProposedTime(body, NOW, TIME_ZONE), null, body);
}
assert.equal(
  parseProposedTime("not tomorrow at 2pm, move it to Friday", NOW, TIME_ZONE),
  null,
  "negated time plus an alternate weekday",
);
assert.equal(parseProposedTime("tomorrow at 2pm instead", NOW, TIME_ZONE), null);
assert.equal(parseProposedTime("anything except tomorrow at 2pm", NOW, TIME_ZONE), null);
assert.equal(parseProposedTime("tomorrow at 2pm; Friday works too", NOW, TIME_ZONE), null);
assert.equal(parseProposedTime("tomorrow at 2pm doesn't work", NOW, TIME_ZONE), null);
assert.equal(parseProposedTime("can't do tomorrow at 2pm", NOW, TIME_ZONE), null);
assert.equal(parseProposedTime("tomorrow at 2pm UTC", NOW, TIME_ZONE), null);
assert.equal(parseProposedTime("tomorrow at 2pm -0700", NOW, TIME_ZONE), null);
assert.equal(parseProposedTime("today at 11am", NOW, TIME_ZONE), null, "past local time");
assert.equal(parseProposedTime("tomorrow at 2pm", "not-an-instant", TIME_ZONE), null);
assert.equal(parseProposedTime("tomorrow at 2pm", NOW, "Mars/Olympus_Mons"), null);

// A local time skipped or repeated by DST is not a unique instant and must
// never be handed to calendar mutation code.
assert.equal(
  parseProposedTime("2027-03-14T02:30", "2027-03-01T12:00:00.000Z", TIME_ZONE),
  null,
  "spring-forward gap",
);
assert.equal(
  parseProposedTime("2026-11-01T01:30", NOW, TIME_ZONE),
  null,
  "fall-back duplicate hour",
);
assert.equal(
  parseProposedTime("2026-09-03T14:45", NOW, TIME_ZONE),
  "2026-09-03T14:45",
);

// This module is intentionally safe to import in tests and workers alike.
const source = readFileSync("lib/sms/meeting-intent.ts", "utf8");
assert.doesNotMatch(source, /server-only|process\.env|getServiceSupabase|\bfetch\s*\(/);

console.log("sms-meeting-intent.test.ts - all assertions passed");
