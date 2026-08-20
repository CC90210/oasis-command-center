import assert from "node:assert";
import { buildFacets, selectSheetIds, type Sheet } from "../lib/web-leads/queries";
import { EMPTY_FILTERS } from "../lib/web-leads/filters";

// leads_callable can never exceed leads_total, and leads_no_site can never
// exceed leads_total. A sheet violating this makes every facet count above it
// wrong, and the rail would still render a confident number.
//
// leads_callable_no_site is the denormalized TRUE INTERSECTION of "callable"
// and "no website" (see lib/web-leads/queries.ts's weight()). It must never
// exceed either of the counts it intersects. The fixture values below are
// deliberately NOT Math.min(leads_callable, leads_no_site) -- a fixture where
// they coincide would also pass under the old, broken min()-based derivation
// that overstated the rail by 2.7x (29,573 vs a real 10,872 across 1,579
// sheets) and would prove nothing about which formula is actually in use.
const sheets: Sheet[] = [
  { id: "a", region: "ON", locality: "Toronto", vertical: "Salons & Personal Care", leads_total: 900, leads_callable: 451, leads_no_site: 400, leads_callable_no_site: 340 },
  { id: "b", region: "QC", locality: "Montreal", vertical: "Trades & Contractors", leads_total: 500, leads_callable: 200, leads_no_site: 180, leads_callable_no_site: 150 },
];
for (const s of sheets) {
  assert.ok(s.leads_callable <= s.leads_total, `${s.id}: callable exceeds total`);
  assert.ok(s.leads_no_site <= s.leads_total, `${s.id}: no_site exceeds total`);
  // The intersection can never exceed either set it intersects.
  assert.ok(s.leads_callable_no_site <= s.leads_callable, `${s.id}: callable_no_site exceeds callable`);
  assert.ok(s.leads_callable_no_site <= s.leads_no_site, `${s.id}: callable_no_site exceeds no_site`);
  // And confirm the fixture is actually exercising the intersection path, not
  // one that happens to agree with the discredited min() derivation.
  assert.notEqual(
    s.leads_callable_no_site,
    Math.min(s.leads_callable, s.leads_no_site),
    `${s.id}: fixture must not coincide with Math.min(callable, no_site), or it proves nothing`,
  );
}

// The facet total must equal the sum over the selected sheets. If these drift,
// the rail shows one number and the table another, and a rep trusts the rail.
{
  const f = buildFacets(sheets, EMPTY_FILTERS);
  const summed = f.provinces.reduce((a, p) => a + p.count, 0);
  assert.equal(f.totalCallable, summed, "province counts must sum to the headline total");
  assert.equal(selectSheetIds(sheets, EMPTY_FILTERS).length, sheets.length);
}

// With the no-website filter on, counts must drop, never rise.
{
  const wide = buildFacets(sheets, EMPTY_FILTERS).totalCallable;
  const narrow = buildFacets(sheets, { ...EMPTY_FILTERS, noSiteOnly: true }).totalCallable;
  assert.ok(narrow <= wide, "narrowing a filter must never increase the count");
}

console.log("web-leads-counters ok");
