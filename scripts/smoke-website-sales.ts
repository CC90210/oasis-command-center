import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { AGENT_PIPELINE_STAGE_KEYS, filterWebsiteSalesRows } from "../lib/oasis-sales-pipeline-policy";
import { OASIS_WEBSITE_TENANT_SLUG, dispositionPatch } from "../lib/website-sales-workflow";
import { BOOKING_URL } from "../lib/marketing/routes";

assert.equal(OASIS_WEBSITE_TENANT_SLUG, "oasis-webdev");
assert.equal(existsSync("app/sales-engine/page.tsx"), false);
assert.deepEqual(AGENT_PIPELINE_STAGE_KEYS, [
  "assigned",
  "attempting_contact",
  "connected",
  "qualified",
  "founder_meeting_booked",
  "demo_completed",
  "proposal_sent",
  "won",
  "onboarding",
]);
assert(BOOKING_URL.startsWith("https://calendar.app.google/"));

const rows = [
  { id: "legacy", data: { stage: "qualified", assigned_to: "rep-a" } },
  { id: "mine", data: { sales_program: "website_sales_v1", stage: "assigned", assigned_to: "rep-a" } },
  { id: "theirs", data: { sales_program: "website_sales_v1", stage: "assigned", assigned_to: "rep-b" } },
  { id: "internal", data: { sales_program: "website_sales_v1", stage: "proposal_sent", assigned_to: "rep-a" } },
];
assert.deepEqual(filterWebsiteSalesRows(rows, { role: "agent", userId: "rep-a" }).map((row) => row.id), ["mine", "internal"]);
assert.deepEqual(filterWebsiteSalesRows(rows, { role: "admin", userId: "admin" }).map((row) => row.id), ["mine", "theirs", "internal"]);

const now = "2026-08-19T12:00:00.000Z";
assert.equal(dispositionPatch("voicemail", "2026-08-20T12:00:00.000Z", now).stage, "attempting_contact");
assert.throws(() => dispositionPatch("voicemail", "2026-08-18T12:00:00.000Z", now));

const route = readFileSync("app/api/website-sales/[leadId]/route.ts", "utf8");
assert(route.includes("request_id_required"));
assert(route.includes("idempotency_check_failed"));
assert(route.includes("lifecycle_transition_failed"));
assert(route.includes('rpc("transition_pipeline_lead"'));
assert(route.includes('from("lead_interactions")'));

const intake = readFileSync("lib/leads-import-service.ts", "utf8");
assert(intake.includes('sales_program: "website_sales_v1"'));
assert.equal(intake.includes("send_gateway"), false, "lead intake must not trigger outbound");

console.log("website sales production smoke: ok");
