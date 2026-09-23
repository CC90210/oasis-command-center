import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  CURRENT_OASIS_PIPELINE_CYCLE,
  isInPipelineCycle,
  pipelineCycleAssignmentFacts,
} from "../lib/pipeline-cycle";
import { oasisLeadCreateStamp } from "../lib/oasis-lead-create";
import { claimPatch, releasePatch } from "../lib/web-leads/claim";

const assignedAt = "2026-09-23T08:00:00.000Z";
const priorCycleRow = {
  id: "prior-cycle",
  data: {
    stage: "assigned",
    assigned_to: "cc",
    assigned_at: "2026-09-01T00:00:00.000Z",
    pipeline_cycle: "revenue-2026-08",
  },
};
assert.equal(isInPipelineCycle(priorCycleRow), false);

const reassigned = {
  ...priorCycleRow,
  data: {
    ...priorCycleRow.data,
    ...pipelineCycleAssignmentFacts("adon", assignedAt),
  },
};
assert.equal(
  isInPipelineCycle(reassigned),
  true,
  "a prior-cycle row reassigned in the active cycle must become visible immediately",
);
assert.deepEqual(
  {
    assigned_to: reassigned.data.assigned_to,
    assigned_at: reassigned.data.assigned_at,
    pipeline_cycle: reassigned.data.pipeline_cycle,
  },
  {
    assigned_to: "adon",
    assigned_at: assignedAt,
    pipeline_cycle: CURRENT_OASIS_PIPELINE_CYCLE.id,
  },
);

for (const [name, patch] of [
  ["claim", claimPatch("adon", assignedAt)],
  [
    "create",
    oasisLeadCreateStamp({
      stage: "assigned",
      ownerUserId: "adon",
      sourceTrack: "company",
      now: new Date(assignedAt),
    }),
  ],
] as const) {
  assert.equal(patch.assigned_to, "adon", `${name} stamps the owner`);
  assert.equal(patch.assigned_at, assignedAt, `${name} stamps the assignment clock`);
  assert.equal(
    patch.pipeline_cycle,
    CURRENT_OASIS_PIPELINE_CYCLE.id,
    `${name} replaces any stale explicit cycle in the same ownership patch`,
  );
}

assert.deepEqual(
  releasePatch(),
  {
    assigned_to: null,
    assigned_at: null,
    claimed_at: null,
    pipeline_cycle: null,
    collaborators: [],
  },
  "release clears the owner and every cycle clock together",
);

const lifecycleAssignment = readFileSync("lib/lifecycle-assignment.ts", "utf8");
assert.match(lifecycleAssignment, /cycleOwnershipPatch[\s\S]*pipelineCycleAssignmentFacts\(/);
assert.match(
  lifecycleAssignment,
  /p_patch:\s*{\s*\.\.\.cycleOwnershipPatch/,
  "the owner, clocks, and cycle id must share one patch_tenant_record_data call",
);

const websiteSales = readFileSync("app/api/website-sales/[leadId]/route.ts", "utf8");
assert.ok(
  (websiteSales.match(/pipelineCycleAssignmentFacts\(/g) || []).length >= 2,
  "founder and builder ownership handoffs must both stamp the active cycle inside their atomic patches",
);

const cloudImport = readFileSync("lib/leads-import-service.ts", "utf8");
assert.match(cloudImport, /isWebsiteSalesTenantSlug\(/);
assert.match(
  cloudImport,
  /getOasisPipelineAssignmentRoster\(/,
  "cloud-tool OASIS imports must load the same CC + Adon roster as HTTP imports",
);
assert.match(
  cloudImport,
  /resolveAssignableTarget\(assignmentRoster,\s*assignedTo\)/,
  "cloud-tool OASIS imports must reject an owner outside the CC + Adon roster",
);
assert.match(
  cloudImport,
  /error:\s*"assignee_required"/,
  "cloud-tool OASIS imports must fail closed when an owner is absent",
);
assert.match(
  cloudImport,
  /pipelineCycleAssignmentFacts\(/,
  "cloud-tool imports must not bypass the active-cycle assignment stamp",
);
assert.match(cloudImport, /sales_motion:\s*OASIS_COLD_OUTBOUND_MOTION/);
assert.match(cloudImport, /const rowEntityType = assignmentRoster \? "lead"/);
assert.match(
  cloudImport,
  /assignmentRoster && rowEntityType === "lead"[\s\S]*?"assigned"/,
  "cloud-tool OASIS imports must enter the active Assigned board, never SunBiz application routing",
);

const legacyImport = readFileSync("app/api/leads/import/route.ts", "utf8");
assert.match(legacyImport, /sales_motion:\s*OASIS_COLD_OUTBOUND_MOTION/);
assert.match(legacyImport, /const rowEntityType = assignmentRoster \? "lead"/);
assert.match(legacyImport, /stage:\s*assignmentRoster && rowEntityType === "lead" \? "assigned"/);

const genericImportRoute = readFileSync("app/api/import/[entity]/route.ts", "utf8");
const genericImportService = readFileSync("lib/import/service.ts", "utf8");
const quickAddRoute = readFileSync("app/api/leads/quick-add/route.ts", "utf8");
assert.match(genericImportRoute, /resolveSessionContext\(\)/);
assert.match(genericImportRoute, /!canWriteCrm\(session\.teamRole\)/);
assert.match(genericImportRoute, /getOasisPipelineAssignmentRoster\(/);
assert.match(genericImportRoute, /resolveAssignableTarget\(/);
assert.match(genericImportRoute, /oasisAssigneeUserId/);
assert.match(genericImportService, /pipelineCycleAssignmentFacts\(oasisAssigneeUserId!/);
assert.match(genericImportService, /sales_motion:\s*OASIS_COLD_OUTBOUND_MOTION/);
assert.match(genericImportService, /stage:\s*"assigned"/);
assert.match(genericImportRoute, /!tenantSlug[\s\S]*?error:\s*"tenant_scope_unresolved"/);
assert.match(legacyImport, /!importTenantSlug[\s\S]*?error:\s*"tenant_scope_unresolved"/);
assert.match(quickAddRoute, /!quickAddSlug[\s\S]*?error:\s*"tenant_scope_unresolved"/);

const genericImportUi = readFileSync("components/import/ImportWizard.tsx", "utf8");
const legacyImportUi = readFileSync("components/leads/LeadsImportClient.tsx", "utf8");
for (const [name, source] of [
  ["generic import", genericImportUi],
  ["legacy import", legacyImportUi],
] as const) {
  assert.match(source, /Choose CC or Adon/, `${name} has no current-cycle owner picker`);
  assert.match(source, /disabled=.*missingLeadAssignee|disabled=.*needsAssignee/s);
}
assert.match(genericImportUi, /assignee_user_id:/);
assert.match(legacyImportUi, /assigned_to:\s*assigneeUserId/);

const nativeCloudTools = readFileSync("lib/cloud-tool-runner.ts", "utf8");
const markerCloudTools = readFileSync("lib/cloud-tools.ts", "utf8");
for (const [name, source] of [
  ["native", nativeCloudTools],
  ["marker", markerCloudTools],
] as const) {
  assert.match(source, /assignee:/, `${name} chat import has no CC\/Adon owner argument`);
  assert.match(
    source,
    /assignee:\s*String\(input\.assignee \|\| ctx\.userId\)\.trim\(\)/,
    `${name} chat import does not default safely to the signed-in operator`,
  );
}

const bulkRoute = readFileSync("app/api/leads/bulk/route.ts", "utf8");
assert.match(
  bulkRoute,
  /if \(isOasisBulkLead\)[\s\S]*?error:\s*"use_web_leads_claim"/,
  "raw bulk stage changes must not create ownerless/off-cycle OASIS work",
);

const bridgeRecords = readFileSync("app/api/bridge/records/[entity]/route.ts", "utf8");
assert.match(bridgeRecords, /rejectUnsafeOasisLeadWrite\(/);
assert.match(bridgeRecords, /error:\s*"canonical_sales_workflow_required"/);

assert.match(websiteSales, /getOasisPipelineAssignmentRoster\(session\.tenantId\)/);
assert.match(websiteSales, /resolveAssignableTarget\(roster,\s*founderUserId\)/);
assert.match(websiteSales, /error:"audit_host_not_on_cycle_roster"/);

const coldLeadPromotion = readFileSync(
  "app/api/manifest/[slug]/cold-leads/[id]/promote/route.ts",
  "utf8",
);
assert.match(coldLeadPromotion, /isWebsiteSalesTenantSlug\(/);
assert.match(coldLeadPromotion, /resolveSessionContext\(\)/);
assert.match(coldLeadPromotion, /!canWriteCrm\(session\.teamRole\)/);
assert.match(
  coldLeadPromotion,
  /isOasisPromotion\s*&&\s*!assigneeUserId[\s\S]*error:\s*"assignee_required"/,
  "an OASIS cold-list promotion without a CC/Adon owner must fail before insert",
);
assert.match(
  coldLeadPromotion,
  /resolveAssignableTarget\(/,
  "an OASIS cold-list promotion may only assign to the active CC + Adon roster",
);
assert.match(
  coldLeadPromotion,
  /pipelineCycleAssignmentFacts\(assigneeUserId,\s*promotedAt\)/,
  "an assigned OASIS cold-list promotion must enter the active cycle in the same insert",
);
assert.match(
  coldLeadPromotion,
  /claimed_at:\s*promotedAt/,
  "an assigned OASIS cold-list promotion must carry the claim clock with its owner",
);

console.log("pipeline-cycle-ownership.test.ts: OK");
