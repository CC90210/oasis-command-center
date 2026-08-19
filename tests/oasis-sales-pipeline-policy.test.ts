import assert from "node:assert/strict";
import {
  AGENT_PIPELINE_STAGE_KEYS,
  OASIS_WEBSITE_SALES_PROGRAM,
  filterWebsiteSalesRows,
  stagesForOasisRole,
} from "../lib/oasis-sales-pipeline-policy";

assert.deepEqual(AGENT_PIPELINE_STAGE_KEYS, [
  "assigned",
  "attempting_contact",
  "connected",
  "qualified",
  "founder_meeting_booked",
]);

assert.deepEqual(stagesForOasisRole("agent").map((s) => s.key), AGENT_PIPELINE_STAGE_KEYS);
assert.equal(stagesForOasisRole("admin").length, 14);
assert.equal(stagesForOasisRole("member").length, 14);

const rows = [
  { id: "fresh", data: { sales_program: OASIS_WEBSITE_SALES_PROGRAM, assigned_to: "REP-1", stage: "assigned" } },
  { id: "legacy", data: { assigned_to: "REP-1", stage: "qualified" } },
  { id: "other-rep", data: { sales_program: OASIS_WEBSITE_SALES_PROGRAM, assigned_to: "rep-2", stage: "assigned" } },
  { id: "post-handoff", data: { sales_program: OASIS_WEBSITE_SALES_PROGRAM, assigned_to: "rep-1", stage: "proposal_sent" } },
];

assert.deepEqual(filterWebsiteSalesRows(rows, { role: "admin", userId: "admin" }).map((r) => r.id), ["fresh", "other-rep", "post-handoff"]);
assert.deepEqual(filterWebsiteSalesRows(rows, { role: "agent", userId: "rep-1" }).map((r) => r.id), ["fresh"]);
assert.deepEqual(filterWebsiteSalesRows(rows, { role: "agent", userId: null }), []);

console.log("oasis sales pipeline policy: ok");
