import assert from "node:assert";
import { buildFacets, selectSheetIds, type Sheet } from "../lib/web-leads/queries";
import { readFileSync } from "node:fs";
import { fetchSheetsScopedToViewer } from "../lib/web-leads/data";
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

// ---------------------------------------------------------------------------
// The rail must count the ROWS, not a stored column.
//
// leadgen_territories carries denormalized leads_total/callable/no_site,
// written when a lead is promoted and never recomputed when one leaves. After
// the board went from ~27,000 rows to ~1,800 the rail advertised 133,599 leads
// against 1,846 that existed -- "Toronto, ON - Restaurants & Bars" offered
// 6,225 where 37 remained, so a rep picked a sheet and got a near-empty table.
// That is precisely the drift the comment above warns about, arriving through
// the one path that was not derived.
//
// Wrapped in main() because this file is transformed to CJS, which has no
// top-level await.
// ---------------------------------------------------------------------------
async function main() {
  const STALE: Sheet[] = [
    { id: "terr_1", region: "ON", locality: "Toronto", vertical: "Restaurants & Bars",
      leads_total: 6225, leads_callable: 5000, leads_no_site: 4000, leads_callable_no_site: 3000 },
  ];
  // Two real claimable rows in that territory; one of them has no website.
  const rows = [
    { id: "l1", data: { webdev_territory_id: "terr_1", phone: "+15550100", website: "https://x.test",
                        stage: "researched", assigned_to: null, claimed_at: null } },
    { id: "l2", data: { webdev_territory_id: "terr_1", phone: "+15550101", website: null,
                        stage: "researched", assigned_to: null, claimed_at: null } },
  ];
  const viewer = { userId: "u1", teamRole: "admin", isAdmin: true };
  const derived = await fetchSheetsScopedToViewer(viewer, {
    scope: "pool", now: Date.parse("2026-09-02T12:00:00.000Z"),
    projectedRows: rows as never, baseSheets: STALE,
  });
  assert.equal(derived.length, 1);
  assert.equal(derived[0]!.leads_total, 2, "the stored 6,225 must be replaced by the 2 rows that exist");
  assert.equal(derived[0]!.leads_callable, 2, "both rows carry a phone");
  assert.equal(derived[0]!.leads_no_site, 1, "exactly one row has no website");
  // Labels still come from the territory row -- only the counts are re-derived.
  assert.equal(derived[0]!.locality, "Toronto");
  assert.equal(derived[0]!.vertical, "Restaurants & Bars");

  // Neither endpoint may take the stored-counter shortcut for ANY viewer. This
  // was gated on isScopedContractor, which left admins and managers -- the
  // people who trust the number most -- reading the stale column.
  for (const route of ["app/api/web-leads/route.ts", "app/api/web-leads/facets/route.ts"]) {
    const src = readFileSync(route, "utf8");
    assert.ok(
      src.includes("fetchSheetsScopedToViewer("),
      `${route} must derive its counts from the rows`,
    );
    assert.ok(
      !src.includes("? await fetchSheetsScopedToViewer"),
      `${route} must not branch facet counts on the viewer's role`,
    );
  }

  console.log("web-leads-counters ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
