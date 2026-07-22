import assert from "node:assert/strict";
import {
  cumulativeSchedule,
  formatDelayMinutes,
  sequenceSearchText,
} from "../lib/drips/template-inventory";
import { droppedTokens, extractCopyTokens, stopLineRemoved } from "../lib/drips/edit-guard-core";
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

// --- droppedTokens: variant-pool tokens count on BOTH sides ---
const priorStep: DripStep = {
  channel: "email", delay_minutes: 5, subject: "Hi {{lead.first_name}}",
  body: "For {{lead.business_name}}", body_variants: ["Alt for {{lead.application_url}}"],
};
assert.deepEqual(
  droppedTokens(priorStep, { channel: "email", delay_minutes: 5, subject: "Hi", body: "For {{lead.business_name}}" } as DripStep).sort(),
  ["lead.application_url", "lead.first_name"],
  "dropping subject token + a variant-only token both flagged",
);
assert.deepEqual(
  droppedTokens(priorStep, { ...priorStep, body: "Now {{lead.business_name}} and {{lead.email}}" } as DripStep),
  [],
  "adding a token is fine",
);

// --- stopLineRemoved ---
const smsPrior: DripStep = { channel: "sms", delay_minutes: 5, body: "Hey. Reply STOP to opt out" };
assert.equal(stopLineRemoved(smsPrior, { channel: "sms", delay_minutes: 5, body: "Hey there" } as DripStep), true, "removed STOP flagged");
assert.equal(stopLineRemoved(smsPrior, { channel: "sms", delay_minutes: 5, body: "Yo. Text STOP to end" } as DripStep), false, "alternate STOP phrasing kept");
assert.equal(
  stopLineRemoved({ channel: "sms", delay_minutes: 5, body: "no stop before" } as DripStep, { channel: "sms", delay_minutes: 5, body: "still none" } as DripStep),
  false,
  "no baseline STOP -> nothing to preserve",
);

console.log("drip-template-inventory: ALL PASS");
