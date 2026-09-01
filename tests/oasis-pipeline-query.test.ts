import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildRecordSearchOr, type ListRecordsInput, type ListRecordsResult } from "../lib/manifest/data";
import {
  OASIS_PIPELINE_OVERVIEW_LIMIT,
  OASIS_PIPELINE_STAGE_PAGE_SIZE,
  listOasisPipelineWindow,
  normalizeOasisPipelinePage,
  resolveOasisPipelineAssigneeScope,
} from "../lib/oasis-pipeline-query";
import { OPENER_PIPELINE_STAGE_KEYS } from "../lib/oasis-sales-pipeline-policy";

const pipelinePageSource = readFileSync("app/pipeline/page.tsx", "utf8");
const pipelineViewSource = readFileSync("components/manifest/LeadPipelineView.tsx", "utf8");
assert.equal(pipelinePageSource.includes("limit: 500"), false, "the global cap regression stays removed");
assert.equal(
  pipelinePageSource.includes("repScopedRows.filter") || pipelinePageSource.includes("hay.includes"),
  false,
  "rep and search filtering cannot drift back behind an in-memory slice",
);
assert(
  pipelinePageSource.includes("listOasisPipelineWindow") &&
    pipelineViewSource.includes("View all {totalCount}") &&
    pipelineViewSource.includes('aria-label="Pipeline result pages"'),
  "the bounded query is wired to complete stage pagination in the UI",
);

assert.equal(normalizeOasisPipelinePage("3"), 3);
assert.equal(normalizeOasisPipelinePage("-4"), 1);
assert.equal(normalizeOasisPipelinePage("not-a-page"), 1);

assert.deepEqual(
  resolveOasisPipelineAssigneeScope({ isAdmin: true, userId: "admin", repFilter: null }),
  { allowed: true, assignedTo: undefined },
);
assert.deepEqual(
  resolveOasisPipelineAssigneeScope({ isAdmin: true, userId: "admin", repFilter: "unassigned" }),
  { allowed: true, assignedTo: null },
);
assert.deepEqual(
  resolveOasisPipelineAssigneeScope({ isAdmin: false, userId: "REP-1", repFilter: null }),
  { allowed: true, assignedTo: "rep-1" },
);
assert.deepEqual(
  resolveOasisPipelineAssigneeScope({ isAdmin: false, userId: "rep-1", repFilter: "rep-2" }),
  { allowed: false },
  "a rep cannot widen the DB query to a colleague's book",
);
assert.deepEqual(
  resolveOasisPipelineAssigneeScope({
    isAdmin: false,
    userId: "manager-1",
    repFilter: null,
    canReadTeam: true,
    teamRepUserIds: [" REP-1 ", "rep-2", "rep-1"],
  }),
  { allowed: true, assignedTo: undefined, assignedToAny: ["rep-1", "rep-2"] },
  "manager default is the normalized tenant sales roster, not the whole tenant",
);
assert.deepEqual(
  resolveOasisPipelineAssigneeScope({
    isAdmin: false,
    userId: "manager-1",
    repFilter: "REP-2",
    canReadTeam: true,
    teamRepUserIds: ["rep-1", "rep-2"],
  }),
  { allowed: true, assignedTo: "rep-2" },
);
for (const forged of ["unassigned", "founder-1", "foreign-rep", "random-uuid"]) {
  assert.deepEqual(
    resolveOasisPipelineAssigneeScope({
      isAdmin: false,
      userId: "manager-1",
      repFilter: forged,
      canReadTeam: true,
      teamRepUserIds: ["rep-1", "rep-2"],
    }),
    { allowed: false },
    `manager ?rep=${forged} must fail before querying`,
  );
}
assert.deepEqual(
  resolveOasisPipelineAssigneeScope({
    isAdmin: false,
    userId: "manager-1",
    repFilter: null,
    canReadTeam: true,
    teamRepUserIds: [],
  }),
  { allowed: false },
  "a missing roster fails closed",
);

const searchOr = buildRecordSearchOr(["name", "business_city"], "Acme, Inc. (Montréal)");
assert.equal(
  searchOr,
  "data->>name.ilike.*Acme*Inc.*Montréal*,data->>business_city.ilike.*Acme*Inc.*Montréal*",
  "reserved OR-grammar characters become wildcards without losing useful search terms",
);
assert.throws(() => buildRecordSearchOr(["name,stage.eq.researched"], "Acme"), /invalid search field/);

async function main() {
const totals: Record<string, number> = {
  assigned: 145,
  attempting_contact: 3,
  connected: 2,
  qualified: 1,
  founder_meeting_booked: 4,
};
const calls: ListRecordsInput[] = [];
const fakeList = async (input: ListRecordsInput): Promise<ListRecordsResult> => {
  calls.push(input);
  const stage = String(input.where?.stage || "");
  const total = totals[stage] || 0;
  const offset = input.offset || 0;
  const limit = input.limit || 100;
  const size = Math.max(0, Math.min(limit, total - offset));
  return {
    total,
    rows: Array.from({ length: size }, (_, index) => ({
      id: `${stage}-${offset + index}`,
      tenant_id: input.tenant_id,
      entity_type: "lead",
      data: { stage, assigned_to: input.where?.assigned_to },
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-08-24T00:00:00.000Z",
    })),
  };
};

const overview = await listOasisPipelineWindow(
  {
    tenantId: "tenant-1",
    stageKeys: OPENER_PIPELINE_STAGE_KEYS,
    salesProgram: "website_sales_v1",
    salesMotion: "cold_outbound",
    assignedTo: "rep-1",
    query: "Acme, Inc.",
  },
  { list: fakeList },
);

assert.equal(overview.activeStage, null);
assert.equal(overview.stageCounts.assigned, 145, "stage count is the database total, not the 40-row window");
assert.equal(overview.total, 155);
assert.equal(
  overview.rows.filter((row) => row.data.stage === "assigned").length,
  OASIS_PIPELINE_OVERVIEW_LIMIT,
  "overview stays bounded per stage",
);
assert.deepEqual(overview.truncatedStages, ["assigned"]);
assert.deepEqual(
  calls.map((call) => call.where?.stage),
  OPENER_PIPELINE_STAGE_KEYS,
  "the opener's working lifecycle through founder meeting is queried and nothing later is leaked",
);
for (const call of calls) {
  assert.equal(call.where?.sales_program, "website_sales_v1");
  assert.equal(call.where?.sales_motion, "cold_outbound");
  assert.equal(call.where?.assigned_to, "rep-1");
  assert.equal(call.search?.query, "Acme, Inc.");
  assert.equal(call.limit, OASIS_PIPELINE_OVERVIEW_LIMIT);
}

calls.length = 0;
await listOasisPipelineWindow(
  { tenantId: "tenant-1", stageKeys: ["assigned"], assignedTo: null },
  { list: fakeList },
);
assert.deepEqual(calls[0].whereEmpty, ["assigned_to"]);
assert.equal(calls[0].where?.assigned_to, undefined, "unassigned includes both null and legacy empty values");

calls.length = 0;
const clampedPage = await listOasisPipelineWindow(
  {
    tenantId: "tenant-1",
    stageKeys: OPENER_PIPELINE_STAGE_KEYS,
    requestedStage: "assigned",
    requestedPage: "999",
    salesProgram: "website_sales_v1",
    assignedTo: "rep-1",
    query: "old deal",
  },
  { list: fakeList },
);

assert.equal(clampedPage.page, 2, "a stale page URL clamps to the last real page");
assert.equal(clampedPage.rows.length, 45);
assert.equal(clampedPage.shownFrom, 101);
assert.equal(clampedPage.shownTo, 145);
assert.equal(clampedPage.hasPrevious, true);
assert.equal(clampedPage.hasNext, false);
assert(
  calls.some(
    (call) =>
      call.where?.stage === "assigned" &&
      call.offset === OASIS_PIPELINE_STAGE_PAGE_SIZE &&
      call.limit === OASIS_PIPELINE_STAGE_PAGE_SIZE,
  ),
  "the clamped page is re-read from the database at the correct offset",
);
assert(
  calls
    .filter((call) => call.where?.stage !== "assigned")
    .every((call) => call.limit === 1 && call.offset === 0),
  "non-selected stages fetch one row only to obtain exact counts",
);

const teamCalls: ListRecordsInput[] = [];
const teamList = async (input: ListRecordsInput): Promise<ListRecordsResult> => {
  teamCalls.push(input);
  assert.deepEqual(
    input.whereIn?.assigned_to,
    ["rep-1", "rep-2"],
    "the roster must reach the parameterized database IN filter",
  );
  assert.equal(input.where?.assigned_to, undefined);
  const total = 160;
  const offset = input.offset || 0;
  const limit = input.limit || 100;
  const size = Math.max(0, Math.min(limit, total - offset));
  return {
    total,
    rows: Array.from({ length: size }, (_, index) => {
      const rank = offset + index;
      const assignedTo = rank % 2 === 0 ? "rep-1" : "rep-2";
      return {
        id: `${assignedTo}-${rank}`,
        tenant_id: input.tenant_id,
        entity_type: "lead",
        data: { stage: "assigned", assigned_to: assignedTo },
        created_at: "2026-08-31T00:00:00.000Z",
        updated_at: "2026-08-31T12:00:00.000Z",
      };
    }),
  };
};

const teamPage = await listOasisPipelineWindow(
  {
    tenantId: "tenant-1",
    stageKeys: ["assigned"],
    requestedStage: "assigned",
    requestedPage: "2",
    assignedToAny: ["rep-1", "rep-2"],
  },
  { list: teamList },
);
assert.equal(teamPage.total, 160, "manager count is the exact sum of authorized rep books");
assert.equal(teamPage.rows.length, 60, "the second global page includes the union remainder");
assert.equal(teamPage.shownFrom, 101);
assert.equal(teamPage.shownTo, 160);
assert.deepEqual(
  teamCalls.map((call) => call.whereIn?.assigned_to),
  [["rep-1", "rep-2"]],
  "one DB-native stage query replaces one remote query per rep",
);
assert.equal(
  teamPage.rows.some((row) => row.data.assigned_to === null || !row.data.assigned_to),
  false,
  "manager union contains no unassigned records",
);

const conflicting = await listOasisPipelineWindow(
  {
    tenantId: "tenant-1",
    stageKeys: ["assigned"],
    assignedTo: "rep-1",
    assignedToAny: ["rep-2"],
  },
  { list: teamList },
);
assert.equal(conflicting.total, 0, "conflicting assignee scopes fail closed");

console.log("oasis-pipeline-query: ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
