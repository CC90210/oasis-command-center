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
  /pipelineCycleAssignmentFacts\(/,
  "cloud-tool imports must not bypass the active-cycle assignment stamp",
);

const coldLeadPromotion = readFileSync(
  "app/api/manifest/[slug]/cold-leads/[id]/promote/route.ts",
  "utf8",
);
assert.match(coldLeadPromotion, /isWebsiteSalesTenantSlug\(/);
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
