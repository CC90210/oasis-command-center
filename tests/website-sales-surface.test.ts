import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const pipeline = readFileSync("app/pipeline/page.tsx", "utf8");
const script = readFileSync("app/playbook/script/page.tsx", "utf8");
const playbook = readFileSync("app/playbook/page.tsx", "utf8");
const nav = readFileSync("lib/nav-config.ts", "utf8");
const workflowRoute = readFileSync("app/api/website-sales/[leadId]/route.ts", "utf8");

assert.equal(existsSync("app/sales-engine/page.tsx"), false, "the duplicate Sales Engine route is removed");
assert.equal(nav.includes('href: "/sales-engine"'), false, "navigation has no duplicate Sales Engine destination");
assert(pipeline.includes("oasis-webdev") || pipeline.includes("OASIS_WEBSITE_TENANT_SLUG"), "Oasis Webdev is an approved website pipeline tenant");
assert(playbook.includes('href: "/playbook/script"') && playbook.includes('title: "Sales Rep Script"'), "playbook links the rep call guide");
for (const phrase of ["Your job is not to close", "Say this", "If the conversation gets awkward", "Finish the handoff", "Google Meet"]) {
  assert(script.includes(phrase), `rep guide includes: ${phrase}`);
}
assert(workflowRoute.includes("request_id_required") && workflowRoute.includes('from("lead_interactions")'), "rep actions are idempotent and use the existing interaction ledger");
assert(
  workflowRoute.includes("idempotency_check_failed") &&
    workflowRoute.includes("lifecycle_transition_failed") &&
    workflowRoute.includes("correlationId:requestId"),
  "atomic pipeline failures surface correlation-aware errors",
);

console.log("website-sales-surface ok");
