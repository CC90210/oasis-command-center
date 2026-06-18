import assert from "node:assert/strict";
import {
  isConditionMet,
  isFieldVisible,
  isStepVisible,
  buildAnswerContext,
} from "../lib/forms/visibility";
import { parseFormSteps, FormDefinitionError } from "../lib/forms/types";

// ---------------------------------------------------------------------------
// isConditionMet — predicate semantics
// ---------------------------------------------------------------------------

// includes (the multiselect case the CC funnel keys off)
assert.equal(
  isConditionMet({ field: "interests", includes: "ai" }, { interests: ["ai", "brand"] }),
  true,
  "includes: array contains value",
);
assert.equal(
  isConditionMet({ field: "interests", includes: "music" }, { interests: ["ai", "brand"] }),
  false,
  "includes: array lacks value",
);
assert.equal(
  isConditionMet({ field: "interests", includes: "ai" }, {}),
  false,
  "includes: missing target → false (hidden before answered)",
);
assert.equal(
  isConditionMet({ field: "interests", includes: "ai" }, { interests: "ai" }),
  false,
  "includes: scalar (not array) → false",
);

// equals
assert.equal(isConditionMet({ field: "t", equals: "x" }, { t: "x" }), true, "equals match");
assert.equal(isConditionMet({ field: "t", equals: "x" }, { t: "y" }), false, "equals mismatch");
assert.equal(isConditionMet({ field: "t", equals: "x" }, {}), false, "equals missing → false");

// in
assert.equal(isConditionMet({ field: "t", in: ["a", "b"] }, { t: "b" }), true, "in: member");
assert.equal(isConditionMet({ field: "t", in: ["a", "b"] }, { t: "c" }), false, "in: non-member");

// any_of
assert.equal(
  isConditionMet({ field: "t", any_of: ["a", "z"] }, { t: ["q", "z"] }),
  true,
  "any_of: intersection non-empty",
);
assert.equal(
  isConditionMet({ field: "t", any_of: ["a", "z"] }, { t: ["q", "r"] }),
  false,
  "any_of: no intersection",
);

// multiple predicates AND
assert.equal(
  isConditionMet({ field: "i", includes: "ai", equals: "ai" }, { i: ["ai"] }),
  false,
  "AND: includes passes but equals(scalar) fails on an array → false",
);

// ---------------------------------------------------------------------------
// isFieldVisible / isStepVisible — no show_if = always visible
// ---------------------------------------------------------------------------
assert.equal(isFieldVisible({}, {}), true, "no show_if → visible");
assert.equal(isStepVisible({}, {}), true, "step no show_if → visible");
assert.equal(
  isFieldVisible({ show_if: { field: "interests", includes: "ai" } }, { interests: ["ai"] }),
  true,
  "field show_if met → visible",
);
assert.equal(
  isFieldVisible({ show_if: { field: "interests", includes: "ai" } }, { interests: ["music"] }),
  false,
  "field show_if unmet → hidden",
);

// ---------------------------------------------------------------------------
// parseShowIf (via parseFormSteps) — validation
// ---------------------------------------------------------------------------

// valid show_if round-trips
const parsed = parseFormSteps([
  {
    key: "s",
    title: "S",
    fields: [
      {
        name: "biz",
        label: "Biz",
        type: "text",
        show_if: { field: "interests", includes: "ai" },
      },
    ],
  },
]);
assert.deepEqual(
  parsed[0].fields[0].show_if,
  { field: "interests", includes: "ai" },
  "valid show_if parsed through",
);

// show_if with no predicate → error
assert.throws(
  () =>
    parseFormSteps([
      { key: "s", title: "S", fields: [{ name: "a", label: "A", type: "text", show_if: { field: "x" } }] },
    ]),
  FormDefinitionError,
  "show_if with no predicate rejected",
);

// show_if.field with bad name → error
assert.throws(
  () =>
    parseFormSteps([
      {
        key: "s",
        title: "S",
        fields: [{ name: "a", label: "A", type: "text", show_if: { field: "X-Bad", equals: "y" } }],
      },
    ]),
  FormDefinitionError,
  "show_if.field bad name rejected",
);

// ---------------------------------------------------------------------------
// buildAnswerContext — trust boundary (Codex [critical] regression)
// ---------------------------------------------------------------------------
const FUNNEL = [
  { fields: [{ name: "interests" }] },
  { fields: [{ name: "business_type" }, { name: "event_type" }] },
  { fields: [{ name: "name" }, { name: "email" }] },
];

// Legit: prior step-0 interests + current step-1 answers merge.
assert.deepEqual(
  buildAnswerContext(FUNNEL, [{ step_index: 0, payload: { interests: ["ai"] } }], 1, {
    business_type: "service",
  }),
  { interests: ["ai"], business_type: "service" },
  "context merges prior step-0 + current step-1 (declared keys)",
);

// SPOOF BLOCKED: a crafted step-1 body that tries to override the step-0
// controller (interests) is ignored — interests is not a step-1 field.
const spoof = buildAnswerContext(FUNNEL, [{ step_index: 0, payload: { interests: ["ai"] } }], 1, {
  business_type: "service",
  interests: [], // attacker tries to blank the controller to dodge required
});
assert.deepEqual(
  spoof,
  { interests: ["ai"], business_type: "service" },
  "current-step body cannot override a controller field on another step",
);
assert.equal(
  isConditionMet({ field: "interests", includes: "ai" }, spoof),
  true,
  "AI branch still visible despite the spoof attempt → required check still enforced",
);

// SPOOF BLOCKED: a forged key persisted in a PRIOR row (not declared on its
// step) does not enter the context either.
assert.deepEqual(
  buildAnswerContext(
    FUNNEL,
    [{ step_index: 0, payload: { interests: ["ai"], injected: "x" } }],
    1,
    { business_type: "service" },
  ),
  { interests: ["ai"], business_type: "service" },
  "undeclared keys from a stored prior row are dropped",
);

// Undeclared keys in the current payload are dropped.
assert.deepEqual(
  buildAnswerContext(FUNNEL, [], 0, { interests: ["ai"], evil: "1" }),
  { interests: ["ai"] },
  "undeclared current keys dropped",
);

console.log("forms-visibility ok");
