import assert from "node:assert/strict";
import {
  AUTOMATION_ADD_ONS,
  WEBSITE_PACKAGES,
  WEBSITE_SALES_STAGES,
  calculateCommission,
  validateQuote,
} from "../lib/website-sales";
import { mapLeadImportHeader } from "../lib/leads-import-parser";
import { OASIS_LEAD_STAGE_KEYS } from "../lib/oasis-stage-meta";

assert.equal(WEBSITE_PACKAGES.essential.setupFloor, 2_000);
assert.equal(WEBSITE_PACKAGES.growth.monthlyFloor, 350);
assert.equal(WEBSITE_PACKAGES.authority.includedAutomationCount, 2);
assert.equal(AUTOMATION_ADD_ONS.length, 9);

assert.deepEqual(calculateCommission(2_000), { rate: 0.1, amount: 200 });
assert.deepEqual(calculateCommission(3_500), { rate: 0.125, amount: 437.5 });
assert.deepEqual(calculateCommission(5_000), { rate: 0.15, amount: 750 });
assert.deepEqual(calculateCommission(1_999), { rate: 0, amount: 0 });

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
