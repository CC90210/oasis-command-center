import assert from "node:assert";
import { toWebLead } from "../lib/web-leads/data";

// The un-audited wording reaches the screen VERBATIM. OpenStreetMap lacking a
// website tag means nobody mapped one, not that no site exists, and nothing has
// fetched these sites. A rep reading a fabricated finding on a live call is the
// worst thing this system can do, so the mapper must not shorten or re-word.
{
  const lead = toWebLead({
    id: "l1",
    data: {
      business_name: "Evolve Hair Studio",
      phone: "416-555-0142",
      business_city: "Toronto",
      state: "ON",
      industry: "Salons & Personal Care",
      website: null,
      website_condition: "No website found yet, needs checking",
      audit_findings: "Not audited yet - confirm on the call",
      webdev_territory: "Toronto, ON - Salons & Personal Care",
    },
  });
  assert.equal(lead.websiteCondition, "No website found yet, needs checking");
  assert.equal(lead.auditFindings, "Not audited yet - confirm on the call");
  assert.doesNotMatch(lead.websiteCondition, /^No website$/, "must never collapse to a verdict");
}

// A genuinely audited lead keeps its real verdict — the guard above must not
// rewrite in the other direction either.
{
  const lead = toWebLead({ id: "l2", data: { business_name: "X", website_condition: "No website", audit_findings: "Slow, not mobile friendly" } });
  assert.equal(lead.websiteCondition, "No website");
  assert.equal(lead.auditFindings, "Slow, not mobile friendly");
}

// Missing fields must not crash or render "undefined" to a rep.
{
  const lead = toWebLead({ id: "l3", data: {} });
  assert.equal(lead.name, "Unnamed business");
  assert.equal(lead.phone, null);
  assert.equal(lead.websiteCondition, "Not checked");
  assert.equal(lead.auditFindings, "Not audited yet - confirm on the call");
}

console.log("web-leads-data ok");
