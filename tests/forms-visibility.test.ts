import assert from "node:assert/strict";
import { isConditionMet, isFieldVisible, isStepVisible } from "../lib/forms/visibility";
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

console.log("forms-visibility ok");
