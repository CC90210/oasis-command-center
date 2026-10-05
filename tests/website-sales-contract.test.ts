import assert from "node:assert/strict";
import {
  AUTOMATION_ADD_ONS,
  RETIRED_AUTOMATION_ADD_ONS,
  WEBSITE_PACKAGES,
  WEBSITE_SALES_STAGES,
  automationAddOn,
  isSellableAutomation,
  validateQuote,
} from "../lib/website-sales";
import { COMPANY_TRACK_BPS, COMP_VERSION, SELF_TRACK_BPS } from "../lib/website-sales-comp";
import { mapLeadImportHeader } from "../lib/leads-import-parser";
import { OASIS_LEAD_STAGE_KEYS } from "../lib/oasis-stage-meta";

assert.equal(WEBSITE_PACKAGES.starter.setupFloor, 500);
assert.equal(WEBSITE_PACKAGES.starter.monthlyFloor, 150);
assert.equal(WEBSITE_PACKAGES.essential.setupFloor, 2_000);
assert.equal(WEBSITE_PACKAGES.growth.monthlyFloor, 350);
assert.equal(WEBSITE_PACKAGES.authority.includedAutomationCount, 2);
// Menu v2 (2026-08-20): 7 sellable add-ons, 2 retired. Retiring an add-on must
// never orphan a signed deal — every retired id still resolves to a label, and
// every active id carries the "delivers" line a rep reads aloud.
assert.equal(AUTOMATION_ADD_ONS.length, 7);
assert.equal(RETIRED_AUTOMATION_ADD_ONS.length, 2);
for (const item of AUTOMATION_ADD_ONS) {
  assert.ok(item.delivers.length > 0, `${item.id} must state what the client receives`);
  assert.ok(isSellableAutomation(item.id), `${item.id} must be sellable`);
}
for (const item of RETIRED_AUTOMATION_ADD_ONS) {
  assert.equal(isSellableAutomation(item.id), false, `${item.id} must not be quotable`);
  assert.ok(automationAddOn(item.id)?.name, `${item.id} must still resolve for historical deals`);
}
// OASIS sells no voice agents: missed-call recovery is SMS text-back only.
assert.ok(
  automationAddOn("missed_call_recovery")?.delivers.toLowerCase().includes("no voice agent"),
  "missed-call recovery must state it is text-only",
);
assert.equal(isSellableAutomation("ai_voice_receptionist"), false);

// Comp v4 has one active integer rate source: open 15%, close 25%, find+close 35%.
assert.equal(COMP_VERSION, 4);
assert.deepEqual(COMPANY_TRACK_BPS, { opener: 1_500, closer: 2_500 });
assert.equal(SELF_TRACK_BPS.open_close, 3_500);

assert.deepEqual(validateQuote("starter", 500, 150, false), { ok: true });
assert.deepEqual(validateQuote("starter", 499, 150, false), {
  ok: false,
  error: "Setup price is below the Starter floor of 500",
});
assert.deepEqual(validateQuote("starter", 500, 149, false), {
  ok: false,
  error: "Monthly price is below the Starter floor of 150",
});

assert.deepEqual(validateQuote("growth", 3_499, 350, false), {
  ok: false,
  error: "Setup price is below the Growth floor of 3500",
});
assert.deepEqual(validateQuote("growth", 3_000, 300, true), { ok: true });

assert.deepEqual(WEBSITE_SALES_STAGES, [
  "researched",
  "assigned",
  "attempting_contact",
  "connected",
  "qualified",
  "founder_meeting_booked",
  "demo_completed",
  "proposal_sent",
  "won",
  "lost",
  "onboarding",
  "in_build",
  "client_review",
  "launched",
]);
assert.deepEqual(OASIS_LEAD_STAGE_KEYS, WEBSITE_SALES_STAGES);
assert.equal(mapLeadImportHeader("Website Condition"), "website_condition");
assert.equal(mapLeadImportHeader("Audit Findings"), "audit_findings");
assert.equal(mapLeadImportHeader("ICP Track"), "icp_track");

console.log("website-sales-contract ok");
