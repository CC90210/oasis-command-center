import assert from "node:assert/strict";
import {
  REGISTERED_STAGE_HOOKS,
  planDripCancellations,
} from "../lib/portals/stage-hooks";

/**
 * The drip-cancel logic moved out of lib/manifest/data.ts and behind the
 * composition root on 2026-08-03, so the shared multi-tenant record layer no
 * longer imports SunBiz's engine.
 *
 * MOVING IT IS ONLY SAFE IF IT BEHAVES IDENTICALLY. cancelStaleDripRunsForLead
 * is what stops a merchant being texted after they convert; a subtle change in
 * WHICH transitions trigger it, or with what arguments, is a silent
 * production regression that emails real people.
 *
 * These assertions pin the exact behaviour the inline code had — the branch
 * conditions, the lead-vs-application exclusivity, and the literal reason
 * strings, which are written to drip_runs.last_error and are how an operator
 * later explains why a run was cancelled.
 */

// ── lead stage change ────────────────────────────────────────────────
{
  const plan = planDripCancellations({
    entity: "lead",
    recordId: "lead-1",
    data: {},
    transitions: [{ field: "stage", from: "new_contact", to: "qualified" }],
  });
  assert.equal(plan.length, 1, "a lead stage change cancels");
  assert.deepEqual(plan[0], {
    leadId: "lead-1",
    newStage: "qualified",
    reason: "stage_changed_eager: lead moved to qualified",
  });
}

// Cancels against the LEAD's own id, not some other record.
{
  const plan = planDripCancellations({
    entity: "lead",
    recordId: "lead-42",
    data: { lead_id: "some-other-lead" },
    transitions: [{ field: "stage", to: "signed_application" }],
  });
  assert.equal(plan[0].leadId, "lead-42", "uses the record id, never data.lead_id, for a lead");
}

// A non-stage field changing on a lead must NOT cancel drips.
{
  const plan = planDripCancellations({
    entity: "lead",
    recordId: "lead-1",
    data: {},
    transitions: [{ field: "owner", from: "a", to: "b" }],
  });
  assert.deepEqual(plan, [], "a non-stage transition on a lead cancels nothing");
}

// A stage transition whose `to` is not a string is ignored — matches the
// original `typeof t.to === "string"` guard. A null `to` here would otherwise
// mean "cancel EVERY stage run", which is the shopped-out semantic and would
// wipe a lead's whole sequence on a malformed write.
for (const badTo of [null, undefined, 42, {}, []]) {
  const plan = planDripCancellations({
    entity: "lead",
    recordId: "lead-1",
    data: {},
    transitions: [{ field: "stage", to: badTo }],
  });
  assert.deepEqual(
    plan,
    [],
    `stage transition with non-string to=${JSON.stringify(badTo)} is ignored`,
  );
}

// ── application shopped out ──────────────────────────────────────────
{
  const plan = planDripCancellations({
    entity: "application",
    recordId: "app-1",
    data: { lead_id: "lead-7" },
    transitions: [{ field: "status", from: "draft", to: "shopping" }],
  });
  assert.equal(plan.length, 1);
  assert.deepEqual(plan[0], {
    leadId: "lead-7",
    newStage: null, // null = cancel EVERY stage-triggered run
    reason: "shopped_out_eager: application moved to shopping",
  });
}

// Shopped out but no linked lead: nothing to cancel.
{
  const plan = planDripCancellations({
    entity: "application",
    recordId: "app-1",
    data: {},
    transitions: [{ field: "status", to: "shopping" }],
  });
  assert.deepEqual(plan, [], "no lead_id means nothing is cancelled");
}

// A non-string lead_id must not be coerced into a lookup key.
{
  const plan = planDripCancellations({
    entity: "application",
    recordId: "app-1",
    data: { lead_id: 123 },
    transitions: [{ field: "status", to: "shopping" }],
  });
  assert.deepEqual(plan, [], "a numeric lead_id is not coerced");
}

// An application moving to any OTHER status must not cancel.
{
  const plan = planDripCancellations({
    entity: "application",
    recordId: "app-1",
    data: { lead_id: "lead-7" },
    transitions: [{ field: "status", to: "approved" }],
  });
  assert.deepEqual(plan, [], "only the 'shopping' status cancels");
}

// The original used `else if`: a lead never evaluates the application branch.
{
  const plan = planDripCancellations({
    entity: "lead",
    recordId: "lead-1",
    data: { lead_id: "lead-9" },
    transitions: [{ field: "status", to: "shopping" }],
  });
  assert.deepEqual(plan, [], "a lead does not fall through to the application branch");
}

// ── no transitions, and unknown entities ─────────────────────────────
assert.deepEqual(
  planDripCancellations({ entity: "lead", recordId: "l", data: {}, transitions: [] }),
  [],
  "no transitions cancels nothing (the original's transitions.length > 0 guard)",
);
assert.deepEqual(
  planDripCancellations({
    entity: "property", // a future real-estate portal's entity
    recordId: "p-1",
    data: { lead_id: "lead-1" },
    transitions: [{ field: "stage", to: "listed" }],
  }),
  [],
  "an unrelated portal's entity never touches SunBiz drips — the whole point of the fix",
);

// ── the wiring is not empty ──────────────────────────────────────────
// A composition root that silently registers nothing would make every
// assertion above meaningless: the plan would be correct and never run.
assert.ok(REGISTERED_STAGE_HOOKS.length > 0, "at least one stage hook is wired");
assert.ok(
  REGISTERED_STAGE_HOOKS.some((h) => h.portal === "sunbiz" && h.name === "drip-stage-cancel"),
  "SunBiz's drip-stage-cancel hook is still registered — if this disappears, merchants get texted after they convert",
);

console.log(
  `portal-stage-hooks: all assertions passed (${REGISTERED_STAGE_HOOKS.length} hook(s) wired: ` +
    `${REGISTERED_STAGE_HOOKS.map((h) => `${h.portal}/${h.name}`).join(", ")})`,
);
