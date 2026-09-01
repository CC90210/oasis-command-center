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
  "the opener's full assigned lifecycle is queried without the researched pool",
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

let viewerReads = 0;
const viewerPage = await listOasisPipelineWindow(
  {
    tenantId: "tenant-1",
    stageKeys: OPENER_PIPELINE_STAGE_KEYS,
    assignedTo: "rep-1",
    viewerUserId: "REP-1",
    salesMotion: "cold_outbound",
  },
  {
    list: async () => {
      throw new Error("self-scoped pipeline should use the owned-or-collaborating read");
    },
    listForViewer: async (input) => {
      viewerReads += 1;
      assert.equal(input.userId, "rep-1");
      return {
        total: 4,
        rows: [
          {
            id: "owned-lost",
            tenant_id: input.tenant_id,
            entity_type: "lead",
            data: { stage: "lost", assigned_to: "rep-1", sales_motion: "cold_outbound" },
            created_at: "2026-08-01T00:00:00.000Z",
            updated_at: "2026-08-31T12:00:00.000Z",
          },
          {
            id: "collaborating-launched",
            tenant_id: input.tenant_id,
            entity_type: "lead",
            data: {
              stage: "launched",
              assigned_to: "closer-1",
              collaborators: ["rep-1"],
              sales_motion: "cold_outbound",
            },
            created_at: "2026-08-01T00:00:00.000Z",
            updated_at: "2026-08-30T12:00:00.000Z",
          },
          {
            id: "prospect-pool",
            tenant_id: input.tenant_id,
            entity_type: "lead",
            data: { stage: "researched", assigned_to: "rep-1", sales_motion: "cold_outbound" },
            created_at: "2026-08-01T00:00:00.000Z",
            updated_at: "2026-08-29T12:00:00.000Z",
          },
          {
            id: "wrong-motion",
            tenant_id: input.tenant_id,
            entity_type: "lead",
            data: { stage: "won", assigned_to: "rep-1", sales_motion: "warm_inbound" },
            created_at: "2026-08-01T00:00:00.000Z",
            updated_at: "2026-08-28T12:00:00.000Z",
          },
        ],
      };
    },
  },
);
assert.equal(viewerReads, 1, "one owned-or-collaborating read replaces one query per stage");
assert.deepEqual(
  viewerPage.rows.map((row) => row.id),
  ["owned-lost", "collaborating-launched"],
  "a rep retains own Lost history and collaborator-only launched deals without seeing the prospect pool",
);
assert.equal(viewerPage.stageCounts.lost, 1);
assert.equal(viewerPage.stageCounts.launched, 1);

let builderViewerReads = 0;
let builderFulfillmentReads = 0;
const builderPage = await listOasisPipelineWindow(
  {
    tenantId: "tenant-1",
    stageKeys: ["onboarding", "in_build", "client_review"],
    assignedTo: "builder-1",
    viewerUserId: "builder-1",
    fulfillmentOwnerId: "BUILDER-1",
  },
  {
    listForViewer: async (input) => {
      builderViewerReads += 1;
      return {
        total: 1,
        rows: [{
          id: "builder-owned",
          tenant_id: input.tenant_id,
          entity_type: "lead",
          data: { stage: "onboarding", assigned_to: "builder-1" },
          created_at: "2026-08-01T00:00:00.000Z",
          updated_at: "2026-08-30T12:00:00.000Z",
        }],
      };
    },
    list: async (input) => {
      builderFulfillmentReads += 1;
      assert.equal(input.where?.fulfillment_owner_id, "builder-1");
      return {
        total: 1,
        rows: [{
          id: "builder-delivery",
          tenant_id: input.tenant_id,
          entity_type: "lead",
          data: {
            stage: "in_build",
            assigned_to: "closer-1",
            fulfillment_owner_id: "builder-1",
          },
          created_at: "2026-08-01T00:00:00.000Z",
          updated_at: "2026-08-31T12:00:00.000Z",
        }],
      };
    },
  },
);
assert.equal(builderViewerReads, 1);
assert.equal(builderFulfillmentReads, 1);
assert.deepEqual(
  builderPage.rows.map((row) => row.id),
  ["builder-owned", "builder-delivery"],
  "the builder list includes both sales ownership and fulfillment-only delivery rows",
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
    stageKeys: ["assigned", "lost"],
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
  "one DB-native roster query replaces one remote query per stage or rep",
);
assert.equal(
  teamCalls[0]?.where?.stage,
  undefined,
  "the roster is fetched once and grouped into lifecycle stages in memory",
);
assert.equal(
  teamPage.rows.some((row) => row.data.assigned_to === null || !row.data.assigned_to),
  false,
  "manager union contains no unassigned records",
);

let adminReads = 0;
const adminPage = await listOasisPipelineWindow(
  {
    tenantId: "tenant-1",
    stageKeys: ["assigned", "lost"],
    salesMotion: "cold_outbound",
  },
  {
    list: async (input) => {
      adminReads += 1;
      assert.equal(input.where?.stage, undefined);
      assert.equal(input.where?.sales_motion, "cold_outbound");
      return {
        total: 3,
        rows: [
          { id: "admin-assigned", tenant_id: "tenant-1", entity_type: "lead", data: { stage: "assigned", sales_motion: "cold_outbound" }, created_at: "", updated_at: "3" },
          { id: "admin-lost-1", tenant_id: "tenant-1", entity_type: "lead", data: { stage: "lost", sales_motion: "cold_outbound" }, created_at: "", updated_at: "2" },
          { id: "admin-lost-2", tenant_id: "tenant-1", entity_type: "lead", data: { stage: "lost", sales_motion: "cold_outbound" }, created_at: "", updated_at: "1" },
        ],
      };
    },
  },
);
assert.equal(adminReads, 1, "a bounded admin board is read once, not once per lifecycle stage");
assert.deepEqual(adminPage.stageCounts, { assigned: 1, lost: 2 });

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
