import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  canMutateOasisSalesRecord,
  canOpenOasisSalesRecord,
  roleMayOperateOasisSalesLead,
} from "../lib/oasis-sales-pipeline-policy";
import { resolvePerLeadAccessPolicy } from "../lib/leads/rep-lead-access";

const REP = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const assigned = { id: "lead-assigned", data: { assigned_to: REP } };
const collaborated = { id: "lead-shared", data: { collaborators: [REP] } };
const unrelated = { id: "lead-other", data: { assigned_to: OTHER } };

assert.equal(resolvePerLeadAccessPolicy("crm", "oasis-ai-cc"), "crm");
assert.equal(resolvePerLeadAccessPolicy("owned_oasis_sales", "oasis-ai-cc"), "owned_oasis_sales");
assert.equal(resolvePerLeadAccessPolicy("owned_oasis_sales", "oasis-webdev"), "owned_oasis_sales");
assert.equal(resolvePerLeadAccessPolicy("owned_oasis_sales", "sun"), "crm");
assert.equal(
  resolvePerLeadAccessPolicy("owned_oasis_sales", null),
  "owned_oasis_sales",
  "an unresolved tenant cannot widen the route to legacy CRM permissions",
);

for (const role of ["agent", "opener", "closer", "manager"]) {
  assert.equal(roleMayOperateOasisSalesLead(role), true, `${role} is an OASIS sales operator`);
  assert.equal(
    canMutateOasisSalesRecord(assigned, { role, userId: REP }),
    true,
    `${role} can work an assigned lead`,
  );
  assert.equal(
    canMutateOasisSalesRecord(collaborated, { role, userId: REP }),
    true,
    `${role} can work a collaborative handoff`,
  );
  assert.equal(
    canMutateOasisSalesRecord(unrelated, { role, userId: REP }),
    false,
    `${role} cannot mutate another rep's lead`,
  );
}

assert.equal(roleMayOperateOasisSalesLead(" OpEnEr "), true, "role matching is normalized");
for (const role of ["read_only", "member", "marketing", "builder", "loan_officer", "processor", "unknown", ""]) {
  assert.equal(roleMayOperateOasisSalesLead(role), false, `${role || "empty"} is not an OASIS sales operator`);
  assert.equal(
    canMutateOasisSalesRecord(assigned, { role, userId: REP }),
    false,
    `${role || "empty"} cannot turn assignment into write authority`,
  );
}

assert.equal(
  canOpenOasisSalesRecord(assigned, { role: "read_only", userId: REP }),
  true,
  "an attached read-only viewer can still review the lead",
);
assert.equal(
  canMutateOasisSalesRecord(unrelated, { role: "admin", userId: REP }),
  true,
  "admin retains tenant-wide lead operations",
);
assert.equal(
  canMutateOasisSalesRecord(unrelated, { role: "member", userId: REP, adminAccess: true }),
  true,
  "explicit admin_access retains tenant-wide operations",
);

const read = (path: string) => readFileSync(path, "utf8");
const page = read("app/pipeline/[id]/page.tsx");
const toolbar = read("components/leads/LeadActionToolbar.tsx");
const strictRoutes = [
  "app/api/leads/[id]/email/route.ts",
  "app/api/leads/[id]/texttorrent/route.ts",
  "app/api/leads/[id]/call/route.ts",
  "app/api/leads/[id]/drip-toggle/route.ts",
  "app/api/leads/[id]/compose-checkin/route.ts",
  "app/api/leads/[id]/next-action/route.ts",
  "app/api/leads/[id]/score/route.ts",
  "app/api/leads/[id]/notes/route.ts",
  "app/api/conversations/reply/route.ts",
];

assert.match(page, /canMutateOasisSalesRecord\(activeRecord,/);
assert.match(page, /canMutateLead \? \(\s*<LeadActionToolbar/);
assert.match(page, /canMutateLead && ownedSlug \? \(\s*<LeadContextEditor/);
assert.match(page, /canMutateLead \? <LeadNoteComposer/);
assert.match(page, /Read-only lead file/);

assert.match(toolbar, /Schedule founder audit/);
assert.match(toolbar, /Call now/);
assert.match(toolbar, /\/api\/leads\/\$\{leadId\}\/call/);
for (const removed of ["Send check-in", "Pause auto follow-ups", "AI tools", "Suggest next move"]) {
  assert.equal(toolbar.includes(removed), false, `${removed} is removed from the OASIS lead UI`);
}
assert.equal(page.includes("NextActionButton"), false, "AI next-action control is not mounted on the lead file");

for (const path of strictRoutes) {
  const source = read(path);
  assert.match(source, /assertMayWorkLead\(\{/s, `${path} uses centralized per-lead authorization`);
  assert.match(
    source,
    /accessMode: "owned_oasis_sales"/,
    `${path} requires an OASIS sales role plus ownership, or admin`,
  );
}
assert.match(
  read("app/api/conversations/reply/route.ts"),
  /else if \(!session\.isAdmin\)[\s\S]*?error: "lead_required"/,
  "a non-admin inbox reply cannot bypass ownership by omitting lead_id",
);

const bulk = read("app/api/leads/bulk/route.ts");
assert.match(
  bulk,
  /if \(!sess\.isAdmin && !canWriteCrm\(sess\.teamRole\)\)/,
  "template and custom bulk sends share the writable-role gate",
);
assert.match(
  bulk,
  /canViewLead\(viewer, data, true, "isolate"\)/,
  "bulk email always enforces owned/collaborating lead scope",
);
assert.match(bulk, /lead_id: canonicalLeadId/);
assert.match(bulk, /created_at: new Date\(\)\.toISOString\(\)/);

const tursoGuard = read("database/turso/159_bulk_email_atomic_touch.turso.sql");
assert.match(tursoGuard, /BEFORE INSERT ON "lead_interactions"/);
assert.match(tursoGuard, /NEW\."agent_source" = 'dashboard_bulk_email_v2'/);
assert.match(tursoGuard, /RAISE\(ABORT, 'bulk_email_touch_target_missing'\)/);

console.log("pipeline-lead-mutation-access: OK");
