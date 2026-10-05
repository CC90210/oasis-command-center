import assert from "node:assert";
import { resolveEventKeys } from "../lib/web-leads/objections/events";
import { isObjectionResolution, isRequestId } from "../lib/web-leads/objections/types";

// ---------------------------------------------------------------------------
// resolveEventKeys decides which id lands in the NOT NULL business_id column.
// It is pure and exported because the fallback it implements has a consequence
// the scoreboard must know about: when the pointer is missing, business_id
// holds a tenant_records.id and will NOT join to leadgen_businesses. Phase 3
// aggregates therefore outer-join and count unmatched rows in a visible
// bucket. An inner join would silently discard exactly the calls whose lead
// data is weakest, which is the quiet-wrong failure this estate keeps paying
// for. Asserting the fallback here is what makes that requirement checkable.
// ---------------------------------------------------------------------------

// Normal case: the promoted lead carries the pointer, so the event keys on the
// same business_id that leadgen_call_outcomes uses and the two join up.
{
  const keys = resolveEventKeys({ id: "lead-1", businessId: "biz-9" });
  assert.equal(keys.businessId, "biz-9");
  assert.equal(keys.leadRecordId, "lead-1");
  assert.equal(keys.usedFallback, false);
}

// Missing pointer must NEVER make a real objection unloggable. Same decision
// lib/web-leads/outcome.ts documents for call outcomes.
{
  const keys = resolveEventKeys({ id: "lead-2", businessId: null });
  assert.equal(keys.businessId, "lead-2", "must fall back to the lead's own id");
  assert.equal(keys.leadRecordId, "lead-2");
  assert.equal(keys.usedFallback, true, "the fallback must be visible to the caller");
}

// Whitespace is not a pointer.
{
  const keys = resolveEventKeys({ id: "lead-3", businessId: "   " });
  assert.equal(keys.businessId, "lead-3");
  assert.equal(keys.usedFallback, true);
}

// Resolution is a closed set. A free-text resolution would make every Phase 3
// lethality number quietly wrong.
assert.ok(isObjectionResolution("recovered"));
assert.ok(isObjectionResolution("stalled"));
assert.ok(isObjectionResolution("lost"));
for (const bad of ["Recovered", "won", "", null, undefined, 1, {}]) {
  assert.equal(isObjectionResolution(bad), false, `rejected: ${String(bad)}`);
}

// The request id is what makes a double-tap or a tether retry idempotent.
assert.ok(isRequestId("3f2504e0-4f89-41d3-9a0c-0305e82c3301"));
for (const bad of ["", "not-a-uuid", "3f2504e0-4f89-41d3-9a0c", null, 42]) {
  assert.equal(isRequestId(bad), false, `rejected: ${String(bad)}`);
}

// The version nibble (the first character of the third group) is the one
// documented divergence from isCallOutcomeRequestId ([1-8] here vs [1-5]
// there). Both fixtures below are well-formed in every other respect --
// correct length, hex charset, hyphen positions, and a valid [89ab] variant
// nibble -- so the version nibble is the only thing that can make either
// one fail. Without these, a regex loosened to accept any version nibble
// still passes this test.
assert.equal(
  isRequestId("3f2504e0-4f89-01d3-9a0c-0305e82c3301"),
  false,
  "version nibble 0 must be rejected",
);
assert.equal(
  isRequestId("3f2504e0-4f89-91d3-9a0c-0305e82c3301"),
  false,
  "version nibble 9 must be rejected",
);

console.log("objection-events: OK");
