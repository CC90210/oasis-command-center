import assert from "node:assert/strict";
import {
  AUTOMATION_ADD_ONS,
  COMMISSION_MODEL,
  RETIRED_AUTOMATION_ADD_ONS,
  WEBSITE_PACKAGES,
  WEBSITE_SALES_STAGES,
  automationAddOn,
  calculateCommission,
  isSellableAutomation,
  validateQuote,
} from "../lib/website-sales";
import { mapLeadImportHeader } from "../lib/leads-import-parser";
import { OASIS_LEAD_STAGE_KEYS } from "../lib/oasis-stage-meta";

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

// Comp v2: who closed decides the rate (opener 20% / opener-closer 30%),
// deal size no longer changes it. $2,000 setup floor unchanged.
assert.equal(COMMISSION_MODEL.floorSetup, 2_000);
assert.deepEqual(calculateCommission(2_000, false), { rate: 0.2, amount: 400 });
assert.deepEqual(calculateCommission(2_000, true), { rate: 0.3, amount: 600 });
assert.deepEqual(calculateCommission(3_500, false), { rate: 0.2, amount: 700 });
assert.deepEqual(calculateCommission(5_000, true), { rate: 0.3, amount: 1_500 });
assert.deepEqual(calculateCommission(1_999, false), { rate: 0, amount: 0 });
assert.deepEqual(calculateCommission(1_999, true), { rate: 0, amount: 0 });

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
