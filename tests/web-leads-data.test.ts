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

// ---------------------------------------------------------------------------
// FALLBACK AUDITS MUST NOT SPEAK. Added 2026-08-26 after a live data incident.
//
// CC's seed_cc_leads_turso run wrote 52 leads. On 46 of them the audit never
// fetched the site -- the row says so itself, `audit_source: "fallback"` -- and
// the seeder nevertheless stored `website_condition: "unreachable"`, an
// audit_findings line, and a pitch telling the rep to open with "when I tried to
// look at your website it wouldn't even load properly for me". All 46 URLs were
// refetched on 2026-08-26 and every one returned HTTP 200/202. The finding was
// not merely unverified, it was false, and on 23 of those rows the name was the
// placeholder "Trade Business" so the line rendered as "when I tried to look at
// 's website".
//
// Nothing had been sent and nobody was assigned, so no prospect heard it. The
// rows were repaired in place. This guard is what stops the next seed run from
// reintroducing it: a record that declares its own observation failed may not
// also carry a finding derived from that observation.
//
// WHY A NAMED FAILURE SET AND NOT AN ALLOWLIST OF GOOD SOURCES: measured against
// the live tenant on 2026-08-26, 31,034 of 31,086 leads carry NO audit_source at
// all and 31,021 of those carry a real website_condition -- the OpenStreetMap
// pipeline predates the field entirely. An allowlist would blank a correct
// sentence on 31,021 leads to suppress 46. Absence means "this pipeline had no
// audit concept", which is not the same claim as "an audit ran and failed".
{
  // 1. THE GUARD FIRES. This is the exact shape that shipped.
  const lead = toWebLead({
    id: "l4",
    data: {
      business_name: "Applewood Air Conditioning",
      website: "https://applewoodair.com/",
      audit_source: "fallback",
      website_condition: "unreachable",
      audit_findings: '["Site could not be fetched or audited - may be down, blocking, or JS-only"]',
    },
  });
  assert.equal(lead.websiteCondition, "Not checked");
  assert.equal(lead.auditFindings, "Not audited yet - confirm on the call");
  assert.doesNotMatch(lead.websiteCondition, /unreachable/, "a failed fetch must never render as a verdict about their site");
  assert.doesNotMatch(lead.auditFindings, /could not be fetched/, "our fetch failing is not a finding about them");
}
{
  // 2. A REAL AUDIT STILL SPEAKS. The guard must not over-reach: the 6 leads in
  //    the same seed run that genuinely were audited keep their verdicts.
  const lead = toWebLead({
    id: "l5",
    data: { business_name: "Baulne", audit_source: "claude_haiku", website_condition: "decent", audit_findings: "No online booking" },
  });
  assert.equal(lead.websiteCondition, "decent");
  assert.equal(lead.auditFindings, "No online booking");
}
{
  // 3. THE 31,021-LEAD CASE. No audit_source at all is the OSM pipeline, whose
  //    hedged sentence is correct and load-bearing. Untouched.
  const lead = toWebLead({
    id: "l6",
    data: { business_name: "Evolve Hair Studio", website_condition: "No website found yet, needs checking" },
  });
  assert.equal(lead.websiteCondition, "No website found yet, needs checking");
}
{
  // 4. Case-insensitive and whitespace-tolerant: a seeder writing "Fallback" or
  //    " fallback " must not slip past on a string-equality technicality.
  for (const src of ["Fallback", " fallback ", "FALLBACK"]) {
    const lead = toWebLead({ id: "l7", data: { business_name: "X", audit_source: src, website_condition: "unreachable" } });
    assert.equal(lead.websiteCondition, "Not checked", `audit_source ${JSON.stringify(src)} must be caught`);
  }
}

console.log("web-leads-data fallback-audit guard ok");
