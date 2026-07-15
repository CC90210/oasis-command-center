import assert from "node:assert/strict";
import { parseLeadImportCsv } from "@/lib/leads-import-parser";
import { routeSunBizImportStage } from "@/lib/sunbiz-stage-routing";

const csv = `Lead Board,,,,,
Application In,,,,,
Name,Date Submitted,Agent,Stage,Lender List,DBA,Phone,Requested Advance Amount,Application,Bank Statements,DL/VC
ASSIGN ANGELS,Mar 31 2026,jordan Colleson,Application In,,ASSIGN ANGELS,3016644310,35000,https://example.com/app.pdf,https://example.com/bank.pdf,
F.C. PROMOTIONS LLC,Nov 6 2025,jordan Colleson,Application In,,F.C. PROMOTIONS LLC,1111111111,,https://example.com/app2.pdf,https://example.com/bank2.pdf,
Shopping,,,,,
Name,Date Submitted,Agent,Stage,Lender List,DBA,Phone,Requested Advance Amount,Application,Bank Statements,DL/VC
ABCDUMP LLC,Jun 18 2025,jordan Colleson,Shopping,"True Advance, Goose Funding",ABCDUMP LLC,6828038031,200K,https://example.com/abcdump.pdf,https://example.com/bank3.pdf,
Declined,,,,,
Name,Date Submitted,Agent,Stage,Lender List,DBA,Phone,Requested Advance Amount,Application,Bank Statements,DL/VC
Black Diamond paving inc,Jan 16 2025,jordan Colleson,Declined,,Black Diamond paving inc,2086810432,,https://example.com/declined.pdf,,
Dead,,,,,
Name,Date Submitted,Agent,Stage,Lender List,DBA,Phone,Requested Advance Amount,Application,Bank Statements,DL/VC
New Tripoli Hotel,Jan 16 2025,jordan Colleson,Dead,,New Tripoli Hotel,6105550100,50000,https://example.com/dead.pdf,,
`;

const parsed = parseLeadImportCsv(csv);

assert.equal(parsed.mapped.length, 5);
assert.deepEqual(
  parsed.mapped.map((row) => row.stage),
  ["Application In", "Application In", "Shopping", "Declined", "Dead"],
);

const routed = parsed.mapped.map((row) => {
  const hasApplicationEvidence = Boolean(
    row.date_submitted ||
      row.lender_list ||
      row.requested_amount ||
      row.application_url ||
      row.bank_statement_urls ||
      row.dl_vc_urls,
  );

  return routeSunBizImportStage(row.stage, { hasApplicationEvidence });
});

assert.deepEqual(routed, [
  { stage: "application_in", entityType: "application" },
  { stage: "application_in", entityType: "application" },
  { stage: "shopping", entityType: "application" },
  { stage: "declined", entityType: "application" },
  { stage: "dead_file", entityType: "application" },
]);

// 2026-07-15 (Adon): "Inbound" imports route to the new "imported" intake stage.
assert.deepEqual(routeSunBizImportStage("Inbound"), {
  stage: "imported",
  entityType: "lead",
});
// 2026-07-15 (Adon): a bare inbound "Declined" lead (no application evidence)
// routes to follow_up (re-engageable general nurture; ghost removed). A
// "Declined" row WITH an application still routes to the opportunity side
// (declined) — see the CSV batch assertion above.
assert.deepEqual(routeSunBizImportStage("Declined"), {
  stage: "follow_up",
  entityType: "lead",
});
assert.deepEqual(routeSunBizImportStage(null, { hasApplicationEvidence: true }), {
  stage: "application_in",
  entityType: "application",
});
// Migration 064: legacy "Approved" application status now routes to
// shopping (offers live on the Offers page now; an approved deal is
// effectively in the shopping/offer-comparison loop).
assert.deepEqual(routeSunBizImportStage("Approved", { explicitRecordType: "application" }), {
  stage: "shopping",
  entityType: "application",
});

console.log("SunBiz import routing tests passed");
