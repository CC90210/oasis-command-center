import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const pipeline = readFileSync("app/pipeline/page.tsx", "utf8");
const script = readFileSync("app/playbook/script/page.tsx", "utf8");
const lifecycle = readFileSync("app/pipeline/[id]/LeadLifecycleActions.tsx", "utf8");
const playbook = readFileSync("app/playbook/page.tsx", "utf8");
const dealPlaybook = readFileSync("app/playbook/deals/page.tsx", "utf8");
const nav = readFileSync("lib/nav-config.ts", "utf8");
const workflowRoute = readFileSync("app/api/website-sales/[leadId]/route.ts", "utf8");
const repToday = readFileSync("components/today/RepToday.tsx", "utf8");
const nextAction = readFileSync("lib/ai-next-action.ts", "utf8");

assert.equal(existsSync("app/sales-engine/page.tsx"), false, "the duplicate Sales Engine route is removed");
assert.equal(nav.includes('href: "/sales-engine"'), false, "navigation has no duplicate Sales Engine destination");
assert(pipeline.includes("oasis-webdev") || pipeline.includes("OASIS_WEBSITE_TENANT_SLUG"), "Oasis Webdev is an approved website pipeline tenant");
assert(playbook.includes('href: "/playbook/script"') && playbook.includes('title: "Sales Rep Script"'), "playbook links the rep call guide");
assert.ok(
  playbook.includes("WEBSITE_PACKAGES.starter") && playbook.includes("COMPANY_TRACK_BPS.opener"),
  "the Playbook index reads the live Starter offer and commission ladder from the engine",
);
assert.equal(
  playbook.includes("$2K / $3.5K / $5K+ packages"),
  false,
  "the Playbook index no longer advertises the retired entry offer",
);
for (const phrase of ["Your job is not to close", "Say this", "If the conversation gets awkward", "Finish the handoff", "Google Meet"]) {
  assert(script.includes(phrase), `rep guide includes: ${phrase}`);
}
assert.ok(script.includes("$500 setup plus $150/month"), "the rep script states the live Starter price");
assert.equal(script.includes("$2,000"), false, "the rep script does not quote the retired starting price");
assert.ok(
  lifecycle.includes("Open to $500 setup + $150/month"),
  "the Pipeline qualification gate matches the live Starter price",
);
assert.equal(lifecycle.includes("Open to $2,000+"), false, "the retired qualification gate is gone");
assert.match(
  lifecycle,
  /initialOffer\?\.packageId[\s\S]*?\? \(initialOffer\.packageId as WebsitePackageId\)[\s\S]*?: "starter";/,
  "a new proposal defaults to Starter while a valid frozen existing package remains selected",
);
assert(workflowRoute.includes("request_id_required") && workflowRoute.includes('from("lead_interactions")'), "rep actions are idempotent and use the existing interaction ledger");
assert(
  workflowRoute.includes("idempotency_check_failed") &&
    workflowRoute.includes("lifecycle_transition_failed") &&
    workflowRoute.includes("correlationId:requestId"),
  "atomic pipeline failures surface correlation-aware errors",
);
assert.match(
  workflowRoute,
  /p_lead_source_track\s*:\s*leadSourceTrack/,
  "the close RPC receives the source track resolved from the durable lead record",
);
assert.match(workflowRoute, /const finalStage\s*=\s*"won"/, "verified full payment lands the lead in Won");
assert.ok(
  dealPlaybook.includes('stage="Won → Onboarding" owner="Admin or assigned builder"'),
  "the deal playbook names both roles that can activate the paid client's delivery handoff",
);
assert.match(
  workflowRoute,
  /mayAdminSetWebsiteSalesStage\(currentStage,\s*body\.stage\)/,
  "generic admin stage control protects both entry into and exit from paid/delivery stages",
);
assert.match(repToday, /loadWebsiteSalesCommissionSummary/, "Today reads the complete authoritative ledger summary");
assert.equal(repToday.includes(".limit(200)"), false, "Today never presents a capped ledger page as complete pay");
assert.match(
  lifecycle,
  /paymentRequestId[\s\S]*?action:\s*"record_payment"[\s\S]*?requestId:\s*paymentRequestId/,
  "record-payment retries reuse one client-stable request ID until the server confirms success",
);
assert.ok(
  workflowRoute.indexOf("if (requestId)") < workflowRoute.indexOf("builder_delivery_action_only"),
  "idempotency replay runs before the delivery-only builder gate can reject a selling builder after handoff",
);
assert.ok(
  workflowRoute.includes("matchesWebsiteSalesPaymentReplay") &&
    workflowRoute.includes("payment_request_replay_mismatch"),
  "a duplicate payment request validates provider, reference, amount, currency, and builder before returning success",
);
assert.match(
  workflowRoute,
  /select\("manager_user_id"\)[\s\S]*?team_role","manager"[\s\S]*?p_manager_user_id:managerUserId/,
  "the close path resolves and validates the credited closer's manager before writing the payout ledger",
);
for (const role of ["You open it", "You close it", "You find and close it"]) {
  assert.ok(repToday.includes(role), `Today states the exact v4 role card: ${role}`);
}
assert.equal(repToday.includes("Solo threshold"), false, "the old low-ticket split ban is no longer advertised");
assert.ok(
  nextAction.includes("$500 setup + $150/month"),
  "the OASIS next-action agent reasons from the live Starter offer",
);
assert.equal(
  nextAction.includes("$2,500-$10,000 builds"),
  false,
  "the next-action agent no longer steers reps with the retired entry price",
);
assert.equal(
  nextAction.includes("funding CRM, 3-week build"),
  false,
  "the OASIS next-action prompt contains no example from a separately isolated business",
);

console.log("website-sales-surface ok");
