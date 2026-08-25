import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path: string): string => readFileSync(path, "utf8");

const stageEvent = read("app/api/leads/[id]/stage-event/route.ts");
const cloudRunner = read("lib/cloud-tool-runner.ts");
const personas = read("lib/agent-personas.ts");
const agentActions = read("lib/agent-actions.ts");
const setField = read("app/api/leads/[id]/set-field/route.ts");
const assign = read("app/api/leads/[id]/assign/route.ts");
const bulk = read("app/api/leads/bulk/route.ts");

assert.equal(
  stageEvent.includes("dispatchOasisOnlyEvent"),
  false,
  "the legacy event endpoint must not expose OASIS lifecycle transitions",
);
assert.match(stageEvent, /COMMON_OPERATOR_TRIGGERABLE/);
assert.match(stageEvent, /assertMayWorkLead/);

for (const source of [cloudRunner, personas]) {
  assert.equal(
    source.includes("advance_lead_stage"),
    false,
    "the cloud agent must neither expose nor be instructed to use the retired lifecycle bypass",
  );
}
assert(
  (cloudRunner.match(/!ctx\.isAdmin \|\| leadScopingEnabled\(\)/g) || []).length >= 3,
  "native cloud list, get, and search tools must always scope non-admin lead reads",
);
assert.match(
  cloudRunner,
  /toolListLeadDocuments[\s\S]*?recordMatchesViewer/,
  "a guessed lead id must not expose another rep's documents through cloud chat",
);

assert.match(agentActions, /isWebsiteSalesTenantSlug/);
assert.match(agentActions, /rejectedOasisGenericPatchKeys/);
assert.match(agentActions, /use_website_sales_workflow/);
assert.match(agentActions, /ownsOasisSalesRecord/);
assert.match(
  agentActions,
  /SCOPED_ENTITIES\.has\(entityName\)[\s\S]*?!ctx\.isAdmin/,
  "non-admin record reads remain owner-scoped even when the rollout flag is off",
);

assert.match(setField, /rejectedOasisGenericPatchKeys/);
assert.match(setField, /use_website_sales_workflow/);
assert.match(setField, /ownsOasisSalesRecord/);
assert.match(setField, /roleMayOperateOasisSalesLead/);

assert.match(assign, /assertMayWorkLead/);
assert.match(assign, /accessMode: "owned_oasis_sales"/);
assert.match(assign, /use_website_sales_workflow/);
assert.match(assign, /OASIS_REP_ASSIGNABLE_STAGES/);
assert.match(bulk, /isOasisBulkWorkspace[\s\S]*?!sess\.isAdmin[\s\S]*?use_individual_sales_workflow/);

console.log("oasis-mutation-bypass-guards: OK");
