import assert from "node:assert/strict";
import {
  AGENT_PIPELINE_STAGE_KEYS,
  BUILDER_DELIVERY_STAGE_KEYS,
  CLOSER_PIPELINE_STAGE_KEYS,
  OASIS_WEBSITE_SALES_PROGRAM,
  OPENER_PIPELINE_STAGE_KEYS,
  canOpenOasisSalesRecord,
  filterWebsiteSalesRows,
  mayOperateOasisDeliveryStage,
  resolveOasisDeliveryQueueScope,
  stagesForOasisRole,
} from "../lib/oasis-sales-pipeline-policy";

assert.deepEqual(AGENT_PIPELINE_STAGE_KEYS, [
  "assigned",
  "attempting_contact",
  "connected",
  "qualified",
  "founder_meeting_booked",
  "demo_completed",
  "proposal_sent",
  "won",
  "onboarding",
]);
assert.deepEqual(OPENER_PIPELINE_STAGE_KEYS, [
  "assigned",
  "attempting_contact",
  "connected",
  "qualified",
  "founder_meeting_booked",
]);
assert.deepEqual(CLOSER_PIPELINE_STAGE_KEYS, [
  "founder_meeting_booked",
  "demo_completed",
  "proposal_sent",
  "won",
  "onboarding",
]);
assert.deepEqual(BUILDER_DELIVERY_STAGE_KEYS, ["onboarding", "in_build", "client_review"]);

assert.deepEqual(stagesForOasisRole("agent").map((s) => s.key), AGENT_PIPELINE_STAGE_KEYS);
assert.deepEqual(stagesForOasisRole("opener").map((s) => s.key), OPENER_PIPELINE_STAGE_KEYS);
assert.deepEqual(stagesForOasisRole("closer").map((s) => s.key), CLOSER_PIPELINE_STAGE_KEYS);
assert.deepEqual(
  stagesForOasisRole("builder").map((s) => s.key),
  ["onboarding", "in_build", "client_review", "launched"],
  "builders get an assigned delivery queue, not an empty sales board",
);
assert.equal(stagesForOasisRole("admin").length, 14);
assert.equal(stagesForOasisRole("member").length, 14);

const rows = [
  { id: "fresh", data: { sales_program: OASIS_WEBSITE_SALES_PROGRAM, assigned_to: "REP-1", stage: "assigned" } },
  { id: "legacy", data: { assigned_to: "REP-1", stage: "qualified" } },
  { id: "other-rep", data: { sales_program: OASIS_WEBSITE_SALES_PROGRAM, assigned_to: "rep-2", stage: "assigned" } },
  { id: "post-handoff", data: { sales_program: OASIS_WEBSITE_SALES_PROGRAM, assigned_to: "rep-1", stage: "proposal_sent" } },
];

assert.deepEqual(filterWebsiteSalesRows(rows, { role: "admin", userId: "admin" }).map((r) => r.id), ["fresh", "other-rep", "post-handoff"]);
assert.deepEqual(filterWebsiteSalesRows(rows, { role: "agent", userId: "rep-1" }).map((r) => r.id), ["fresh", "post-handoff"]);
assert.deepEqual(filterWebsiteSalesRows(rows, { role: "opener", userId: "rep-1" }).map((r) => r.id), ["fresh"]);
assert.deepEqual(filterWebsiteSalesRows(rows, { role: "closer", userId: "rep-1" }).map((r) => r.id), ["post-handoff"]);
assert.deepEqual(filterWebsiteSalesRows(rows, { role: "agent", userId: null }), []);

/* ─── opening ONE record is an access question, not a board question ─────────
 * CC, 2026-08-21: every lead on /pipeline returned "Lead not found".
 *
 * Cause: app/pipeline/[id] ran the single record through filterWebsiteSalesRows,
 * a LIST-SHAPING filter, and treated an empty result as "no access". That filter
 * carries two constraints that have no business gating a record read:
 *
 *   programScoped  drops anything not stamped website_sales_v1. Measured in
 *                  production: oasis-ai-cc holds 31,031 leads and ZERO are
 *                  stamped, so EVERY lead on that tenant was unopenable — by
 *                  its owner, by an admin, by anyone.
 *   stage          drops anything outside the five rep stages, so a rep could
 *                  not open the deal they personally closed the moment the
 *                  founder moved it to onboarding.
 *
 * Neither is an authorization rule. Ownership is. This mirrors the split
 * lib/lead-scope.ts already makes between filterRowsByScope (list) and
 * canViewLead (one record). */
const ccsAgencyLead = { id: "cc-lead", data: { stage: "researched", assigned_to: null } };
const owner = { role: "owner", userId: "cc", isOwner: true };

assert.equal(
  canOpenOasisSalesRecord(ccsAgencyLead, owner),
  true,
  "an admin must be able to open an unstamped lead on a non-website-sales tenant — " +
    "31,031 oasis-ai-cc leads were unreachable because a program filter said no",
);

const myClosedDeal = {
  id: "closed",
  data: { sales_program: OASIS_WEBSITE_SALES_PROGRAM, assigned_to: "rep-1", stage: "onboarding" },
};
assert.equal(
  canOpenOasisSalesRecord(myClosedDeal, { role: "closer", userId: "rep-1" }),
  true,
  "a rep must be able to open the deal they closed — stage shapes the BOARD, " +
    "it does not decide who may read a record they own",
);
assert.equal(
  canOpenOasisSalesRecord({ id: "x", data: { assigned_to: "REP-1", stage: "connected" } }, { role: "closer", userId: "rep-1" }),
  true,
  "ownership comparison is case-insensitive, same as filterWebsiteSalesRows",
);

/* The controls. Fixing the false negatives must not open a real one. */
assert.equal(
  canOpenOasisSalesRecord({ id: "theirs", data: { assigned_to: "rep-2", stage: "connected" } }, { role: "closer", userId: "rep-1" }),
  false,
  "a rep must NOT open another rep's lead by guessing its URL",
);
assert.equal(
  canOpenOasisSalesRecord({ id: "any", data: { assigned_to: "rep-2" } }, { role: "closer", userId: null }),
  false,
  "fail closed: an unresolved identity opens nothing",
);
assert.equal(
  canOpenOasisSalesRecord({ id: "unowned", data: { assigned_to: null } }, { role: "closer", userId: "rep-1" }),
  false,
  "an UNASSIGNED lead is not everyone's — a rep must not open one nobody owns",
);
assert.equal(
  canOpenOasisSalesRecord({ id: "unowned", data: { assigned_to: null } }, { role: "opener", userId: "rep-1" }),
  false,
  "same for an opener",
);
/* ─── the two-party sale. An opener who handed off is still owed 20%. ────────
 * Once a closer takes the deal, `assigned_to` is the closer — the opener is
 * only in `collaborators`. An ownership check that ignored that field would
 * lock the opener out of the one deal they are being paid on. */
const handedOff = {
  id: "handed-off",
  data: {
    sales_program: OASIS_WEBSITE_SALES_PROGRAM,
    assigned_to: "closer-1",
    collaborators: ["OPENER-1"],
    stage: "qualified",
  },
};
assert.equal(
  canOpenOasisSalesRecord(handedOff, { role: "closer", userId: "closer-1" }),
  true,
  "the closer owns it",
);

const assignedBuild = {
  id: "build-1",
  data: { sales_program: OASIS_WEBSITE_SALES_PROGRAM, assigned_to: "builder-1", stage: "onboarding" },
};
const anotherBuildersBuild = {
  id: "build-2",
  data: { sales_program: OASIS_WEBSITE_SALES_PROGRAM, assigned_to: "builder-2", stage: "in_build" },
};
const fulfillmentOwnedBuild = {
  id: "build-3",
  data: {
    sales_program: OASIS_WEBSITE_SALES_PROGRAM,
    assigned_to: "closer-1",
    fulfillment_owner_id: "BUILDER-1",
    stage: "client_review",
  },
};
const collaboratorOnlyBuild = {
  id: "build-4",
  data: {
    sales_program: OASIS_WEBSITE_SALES_PROGRAM,
    assigned_to: "builder-2",
    fulfillment_owner_id: "builder-2",
    collaborators: ["builder-1"],
    stage: "in_build",
  },
};
assert.equal(canOpenOasisSalesRecord(assignedBuild, { role: "builder", userId: "builder-1" }), true);
assert.equal(
  canOpenOasisSalesRecord(fulfillmentOwnedBuild, { role: "builder", userId: "builder-1" }),
  true,
  "a builder can open a delivery explicitly allocated through fulfillment_owner_id",
);
assert.equal(
  canOpenOasisSalesRecord(anotherBuildersBuild, { role: "builder", userId: "builder-1" }),
  false,
  "a builder cannot open another builder's client by guessing the lead ID",
);
assert.equal(
  canOpenOasisSalesRecord(collaboratorOnlyBuild, { role: "builder", userId: "builder-1" }),
  false,
  "a sales collaborator flag must not leak another builder's delivery client",
);
assert.deepEqual(
  filterWebsiteSalesRows(
    [assignedBuild, anotherBuildersBuild, fulfillmentOwnedBuild, collaboratorOnlyBuild],
    { role: "builder", userId: "builder-1" },
  ).map((row) => row.id),
  ["build-1", "build-3"],
  "the builder pipeline lists only delivery work assigned directly or through fulfillment ownership",
);
assert.deepEqual(resolveOasisDeliveryQueueScope("builder", " BUILDER-1 "), {
  mode: "owned",
  userId: "builder-1",
});
assert.deepEqual(
  resolveOasisDeliveryQueueScope("builder", null),
  { mode: "none" },
  "an unresolved builder identity must fetch no tenant work, never fall back to the full queue",
);
assert.deepEqual(
  resolveOasisDeliveryQueueScope("member", "worker-1"),
  { mode: "all" },
  "internal/admin delivery viewers retain the complete tenant queue",
);
assert.equal(mayOperateOasisDeliveryStage("builder", "onboarding"), true);
assert.equal(mayOperateOasisDeliveryStage("builder", "launched"), false);
assert.equal(
  canOpenOasisSalesRecord(handedOff, { role: "opener", userId: "opener-1" }),
  true,
  "the opener who sourced it keeps access after handoff — they are paid on this deal",
);
assert.equal(
  canOpenOasisSalesRecord(handedOff, { role: "closer", userId: "rep-9" }),
  false,
  "a rep on neither side of the deal still gets nothing",
);
// Malformed collaborators must fail closed, never throw — normalizeCollaborators
// is what guarantees that, and this asserts we actually delegate to it.
for (const junk of [null, "opener-1", 42, [42, null], {}]) {
  assert.equal(
    canOpenOasisSalesRecord(
      { id: "j", data: { assigned_to: "someone", collaborators: junk } },
      { role: "opener", userId: "opener-1" },
    ),
    false,
    `malformed collaborators (${JSON.stringify(junk)}) must fail closed, not throw`,
  );
}

// The admin-toggle grant is honoured here exactly as it is on the board.
assert.equal(
  canOpenOasisSalesRecord({ id: "theirs", data: { assigned_to: "rep-2" } }, { role: "closer", userId: "rep-1", adminAccess: true }),
  true,
  "an admin_access-toggled viewer reads as admin, consistent with isOasisPipelineAdmin",
);

console.log("oasis sales pipeline policy: ok");
