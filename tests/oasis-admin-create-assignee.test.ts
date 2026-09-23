import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { OASIS_SEED } from "../lib/manifest/seeds";
import {
  oasisLeadCreateForm,
  planOasisLeadCreate,
} from "../lib/oasis-lead-create";
import { CURRENT_OASIS_PIPELINE_CYCLE } from "../lib/pipeline-cycle";

const ADMIN = "11111111-1111-4111-8111-111111111111";
const REP = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-09-23T12:00:00.000Z");
const seedLead = OASIS_SEED.data_model!.find((entity) => entity.name === "lead")!;
const assignees = [{ userId: REP, label: "Ariel Rep" }];

const adminForm = oasisLeadCreateForm(
  seedLead,
  { isAdmin: true, teamRole: "owner" },
  assignees,
);
const assigneeField = adminForm.entity.fields.find((field) => field.name === "assigned_to");
assert.ok(assigneeField, "an admin create form must require a sales rep destination");
assert.equal(assigneeField!.type, "enum");
assert.equal(assigneeField!.required, true);
assert.deepEqual(assigneeField!.enum_values, [REP]);
assert.equal(adminForm.optionLabels.assigned_to[REP], "Ariel Rep");
assert.equal(adminForm.fieldLabels.assigned_to, "Sales rep");

const repForm = oasisLeadCreateForm(
  seedLead,
  { isAdmin: false, teamRole: "opener" },
  assignees,
);
assert.equal(
  repForm.entity.fields.some((field) => field.name === "assigned_to"),
  false,
  "a rep must not receive an editable ownership field",
);

const planned = planOasisLeadCreate({
  viewer: { isAdmin: true, teamRole: "owner" },
  creatorUserId: ADMIN,
  resolvedAssigneeUserId: REP,
  data: { name: "Admin referral", state: "ON", stage: "assigned" },
  now: NOW,
  requireRegion: true,
});
assert.ok(planned.ok);
if (planned.ok) {
  assert.equal(planned.data.assigned_to, REP, "the roster-resolved rep, not the admin, must own the lead");
  assert.equal(planned.data.lead_source_track, "company");
  assert.equal(planned.data.sourced_by_user_id, null);
  assert.equal(planned.data.claimed_at, NOW.toISOString());
  assert.equal(planned.data.pipeline_cycle, CURRENT_OASIS_PIPELINE_CYCLE.id);
}

const missing = planOasisLeadCreate({
  viewer: { isAdmin: true, teamRole: "owner" },
  creatorUserId: ADMIN,
  resolvedAssigneeUserId: "",
  data: { name: "Ownerless", state: "ON", stage: "assigned" },
  now: NOW,
  requireRegion: true,
});
assert.equal(missing.ok, false, "an admin create cannot silently assign the lead to the admin");
if (!missing.ok) {
  assert.equal(missing.error, "assignee_required");
  assert.deepEqual(missing.fields, ["assigned_to"]);
}

const rawOwner = planOasisLeadCreate({
  viewer: { isAdmin: true, teamRole: "owner" },
  creatorUserId: ADMIN,
  resolvedAssigneeUserId: REP,
  data: { name: "Raw owner", state: "ON", stage: "assigned", assigned_to: REP },
  now: NOW,
  requireRegion: true,
});
assert.equal(rawOwner.ok, false, "the pure planner must continue rejecting raw browser ownership");
if (!rawOwner.ok) assert.equal(rawOwner.error, "protected_lifecycle_fields");

const route = readFileSync("app/api/manifest/[slug]/records/[entity]/route.ts", "utf8");
assert.match(route, /getOasisPipelineAssignmentRoster\(r\.tenant_id\)/, "the API must reload the founder assignment roster");
assert.match(route, /resolveAssignableTarget\(roster, requestedAssignee\)/, "the API must resolve through the canonical roster row");
assert.match(route, /delete\s+plannerData\.assigned_to/, "raw assigned_to must be stripped before planning");
assert.match(route, /resolvedAssigneeUserId:/, "the API must pass the trusted id separately");

const page = readFileSync("app/pipeline/new/page.tsx", "utf8");
assert.match(page, /getOasisPipelineAssignmentRoster\(tenantId\)/, "the admin form must be hydrated from the founder assignment roster");
assert.match(page, /choose its sales rep.+starts in Assigned/is, "admin copy must describe the one valid Pipeline entry point");
assert.match(page, /enters your Pipeline at Assigned/i, "rep copy must distinguish self-sourced direct create from the Leads pool");

console.log("oasis-admin-create-assignee ok");
