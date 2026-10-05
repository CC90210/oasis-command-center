/**
 * The four qualification gates: new wording, unchanged stored key, and every
 * record written before the wording change still reads as qualified.
 *
 * Run: node --conditions=react-server --import tsx tests/sales-qualification.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  PAIN_WORDS_MAX,
  QUALIFICATION_GATES,
  QUALIFICATION_GATE_KEYS,
  isCompleteQualificationPayload,
  normalizeQualificationForStorage,
  readStoredQualification,
} from "../lib/sales-qualification";

// 1. The stored/wire keys did NOT change. Renaming one would break every open
//    Pipeline tab across a deploy and strand every stored record.
assert.deepEqual(
  [...QUALIFICATION_GATE_KEYS],
  ["authorityConfirmed", "websiteProblemConfirmed", "timingConfirmed", "minimumInvestmentConfirmed"],
);
assert.deepEqual(
  QUALIFICATION_GATES.map((g) => g.key),
  [...QUALIFICATION_GATE_KEYS],
  "gate order must match the key order Pipeline's checks[] uses",
);

// 2. The wording (Adon, 2026-10-01). Gate 4 keeps the live Starter price until
//    the price surface (rep script, AI prompt, gate) moves together.
assert.deepEqual(
  QUALIFICATION_GATES.map((g) => g.label),
  [
    "Owner or decision-maker",
    "Operations pain named in their own words",
    "Would act within 90 days",
    "Open to $500 setup + $150/month",
  ],
);
for (const gate of QUALIFICATION_GATES) {
  assert.doesNotMatch(gate.label, /website/i, `gate "${gate.label}" still frames the sale as a website`);
  assert.doesNotMatch(`${gate.label} ${gate.hint}`, /—/, `gate "${gate.label}" contains an em dash`);
  assert.ok(gate.hint.trim().length > 0, `gate "${gate.label}" needs a hint`);
}

// 3. Legacy records still read as complete, in every shape libSQL hands back.
const legacy = {
  authorityConfirmed: true,
  websiteProblemConfirmed: true,
  timingConfirmed: true,
  minimumInvestmentConfirmed: true,
  notes: "",
};
assert.equal(readStoredQualification(legacy).complete, true, "a pre-change record must still read as qualified");
assert.equal(readStoredQualification(JSON.stringify(legacy)).complete, true, "JSON text from libSQL must read");
assert.equal(
  readStoredQualification({
    authorityConfirmed: 1,
    websiteProblemConfirmed: 1,
    timingConfirmed: 1,
    minimumInvestmentConfirmed: 1,
  }).complete,
  true,
  "libSQL booleans arrive as 1",
);
assert.equal(readStoredQualification({ ...legacy, timingConfirmed: false }).complete, false);
assert.equal(readStoredQualification(null).complete, false);
assert.equal(readStoredQualification("not json").complete, false);
assert.equal(
  readStoredQualification({ ...legacy, operationsPainInTheirWords: "  quotes go out late  " }).operationsPainInTheirWords,
  "quotes go out late",
);

// 4. The wire check stays strict (true only), exactly as route.ts did before.
assert.equal(isCompleteQualificationPayload(legacy), true);
assert.equal(isCompleteQualificationPayload({ ...legacy, websiteProblemConfirmed: 1 }), false, "the wire accepts only literal true");
assert.equal(
  isCompleteQualificationPayload({ ...legacy, websiteProblemConfirmed: undefined, operationsPainConfirmed: true }),
  false,
  "a renamed key must not pass",
);
assert.equal(isCompleteQualificationPayload("x"), false);
assert.equal(isCompleteQualificationPayload(null), false);
assert.equal(isCompleteQualificationPayload([true, true, true, true]), false);

// 5. Storage is normalized: four booleans plus optional words, nothing else.
assert.deepEqual(
  normalizeQualificationForStorage({
    ...legacy,
    injected: "<script>",
    operationsPainInTheirWords: " jobs fall through the cracks ",
  }),
  {
    authorityConfirmed: true,
    websiteProblemConfirmed: true,
    timingConfirmed: true,
    minimumInvestmentConfirmed: true,
    operationsPainInTheirWords: "jobs fall through the cracks",
  },
);
assert.equal(
  normalizeQualificationForStorage({ operationsPainInTheirWords: "x".repeat(900) }).operationsPainInTheirWords?.length,
  PAIN_WORDS_MAX,
);

// 6. Pipeline renders the labels from this module and no longer says the old words.
const pipeline = readFileSync("app/pipeline/[id]/LeadLifecycleActions.tsx", "utf8");
assert.match(pipeline, /QUALIFICATION_GATES\.map\(/, "Pipeline must render the gate labels from lib/sales-qualification.ts");
assert.doesNotMatch(pipeline, /Website problem confirmed/, "Pipeline still shows the old gate wording");

// 7. The route validates with the shared helpers, not its own key lists.
const route = readFileSync("app/api/website-sales/[leadId]/route.ts", "utf8");
assert.match(route, /isCompleteQualificationPayload\(body\.qualification\)/);
assert.match(route, /normalizeQualificationForStorage\(/);
assert.doesNotMatch(route, /\["authorityConfirmed","websiteProblemConfirmed"/, "the route must not keep its own copy of the key list");

console.log("sales-qualification: OK");
