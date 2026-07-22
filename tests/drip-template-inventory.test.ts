import assert from "node:assert/strict";
import {
  cumulativeSchedule,
  formatDelayMinutes,
  sequenceSearchText,
} from "../lib/drips/template-inventory";
import {
  extractCopyTokens,
  sequenceDroppedTokens,
  smsStopRemoved,
  stepCopyJoined,
} from "../lib/drips/edit-guard-core";
import type { DripStep } from "../lib/drips/types";

// Template inventory + edit-guard pure logic (2026-07-22 drip visibility/editor build).

// --- formatDelayMinutes ---
assert.equal(formatDelayMinutes(0), "immediately");
assert.equal(formatDelayMinutes(10), "10 min");
assert.equal(formatDelayMinutes(60), "1 h");
assert.equal(formatDelayMinutes(90), "1 h 30 min");
assert.equal(formatDelayMinutes(60 * 24), "1 d");
assert.equal(formatDelayMinutes(60 * 36), "1 d 12 h");
assert.equal(formatDelayMinutes(-5), "immediately", "negative clamps");

// --- cumulativeSchedule: delays are waits BEFORE each step, so landing times accumulate ---
const steps: DripStep[] = [
  { channel: "email", delay_minutes: 60 * 12, subject: "A", body: "a" },
  { channel: "sms", delay_minutes: 60 * 24, body: "b" },
  { channel: "sms", delay_minutes: 0, body: "c" },
];
const sched = cumulativeSchedule(steps);
assert.deepEqual(
  sched.map((s) => s.cumulativeMinutes),
  [720, 720 + 1440, 720 + 1440],
  "cumulative landing times",
);
assert.deepEqual(sched.map((s) => s.index), [0, 1, 2]);
assert.deepEqual(cumulativeSchedule([]), [], "empty steps");

// --- sequenceSearchText covers name + subjects + bodies + BOTH variant pools ---
const hay = sequenceSearchText("Bank nag", [
  {
    channel: "email",
    delay_minutes: 5,
    subject: "Last step",
    body: "send statements",
    subject_variants: ["Quick reminder"],
    body_variants: ["three months of statements"],
  } as DripStep,
]);
for (const needle of ["bank nag", "last step", "send statements", "quick reminder", "three months"]) {
  assert.ok(hay.includes(needle), `search haystack includes "${needle}"`);
}

// --- extractCopyTokens ---
assert.deepEqual(
  [...extractCopyTokens("Hi {{lead.first_name}}, {{ lead.business_name }} ok {{lead.first_name}}")].sort(),
  ["lead.business_name", "lead.first_name"],
  "tokens deduped + whitespace-tolerant",
);
assert.equal(extractCopyTokens("no tokens").size, 0);

// --- stepCopyJoined includes body_html (codex P1: HTML is what delivers) ---
const htmlStep: DripStep = {
  channel: "email", delay_minutes: 5, subject: "S", body: "plain",
  body_html: "<p>Hi {{lead.first_name}} from our lender network</p>",
} as DripStep;
assert.ok(stepCopyJoined(htmlStep).includes("our lender network"), "body_html is scanned");
assert.ok(extractCopyTokens(stepCopyJoined(htmlStep)).has("lead.first_name"), "body_html tokens count");

// --- sequenceDroppedTokens: SEQUENCE-level (reorder-safe, codex P1) ---
const priorSeq: DripStep[] = [
  { channel: "email", delay_minutes: 5, subject: "Hi {{lead.first_name}}", body: "For {{lead.business_name}}" } as DripStep,
  { channel: "sms", delay_minutes: 60, body: "Link: {{lead.application_url}}. Reply STOP to opt out" } as DripStep,
];
// Reorder + move a token between steps: NOT a drop.
assert.deepEqual(
  sequenceDroppedTokens(priorSeq, [
    { channel: "sms", delay_minutes: 60, body: "{{lead.first_name}}: {{lead.application_url}}. Reply STOP to opt out" } as DripStep,
    { channel: "email", delay_minutes: 5, subject: "Hi", body: "For {{lead.business_name}}" } as DripStep,
  ]),
  [],
  "reorder + token moved across steps passes",
);
// Token gone from the WHOLE sequence: flagged.
assert.deepEqual(
  sequenceDroppedTokens(priorSeq, [
    { channel: "email", delay_minutes: 5, subject: "Hi {{lead.first_name}}", body: "For {{lead.business_name}}" } as DripStep,
    { channel: "sms", delay_minutes: 60, body: "Reply STOP to opt out" } as DripStep,
  ]),
  ["lead.application_url"],
  "sequence-wide token loss flagged",
);

// --- smsStopRemoved: sequence-level ---
assert.equal(
  smsStopRemoved(priorSeq, [
    { channel: "sms", delay_minutes: 60, body: "No opt out text" } as DripStep,
  ]),
  true,
  "all SMS lost the STOP line -> flagged",
);
assert.equal(
  smsStopRemoved(priorSeq, [
    { channel: "sms", delay_minutes: 60, body: "hey" } as DripStep,
    { channel: "sms", delay_minutes: 90, body: "bye. Text STOP to end" } as DripStep,
  ]),
  false,
  "one SMS still carries STOP -> passes",
);
assert.equal(
  smsStopRemoved(priorSeq, [
    { channel: "email", delay_minutes: 5, subject: "s", body: "email only now" } as DripStep,
  ]),
  false,
  "sequence dropped SMS entirely -> nothing to preserve",
);

console.log("drip-template-inventory: ALL PASS");
