import assert from "node:assert";
import { buildFacets, selectSheetIds, type Sheet } from "../lib/web-leads/queries";
import { EMPTY_FILTERS } from "../lib/web-leads/filters";

const sheets: Sheet[] = [
  { id: "s1", region: "ON", locality: "Toronto",  vertical: "Salons & Personal Care", leads_total: 900, leads_callable: 451, leads_no_site: 400, leads_callable_no_site: 300 },
  { id: "s2", region: "ON", locality: "Toronto",  vertical: "Trades & Contractors",   leads_total: 300, leads_callable: 130, leads_no_site: 120, leads_callable_no_site: 90 },
  { id: "s3", region: "ON", locality: "Ottawa",   vertical: "Salons & Personal Care", leads_total: 200, leads_callable: 100, leads_no_site: 90,  leads_callable_no_site: 70 },
  { id: "s4", region: "QC", locality: "Montreal", vertical: "Trades & Contractors",   leads_total: 500, leads_callable: 200, leads_no_site: 180, leads_callable_no_site: 140 },
];

// No filters: every sheet is in play.
{
  assert.deepEqual(selectSheetIds(sheets, EMPTY_FILTERS).sort(), ["s1", "s2", "s3", "s4"]);
}

// "Plumbing across the board" — an industry with NO city selected. This is the
// case a strict province>city>industry drill-down cannot express, and the whole
// reason the hierarchy is a filter rail rather than a set of pages.
{
  const ids = selectSheetIds(sheets, { ...EMPTY_FILTERS, industries: ["Trades & Contractors"] });
  assert.deepEqual(ids.sort(), ["s2", "s4"], "an industry filter alone must cross every city and province");
}

// "Plumbing in Toronto" — industry AND city.
{
  const ids = selectSheetIds(sheets, { ...EMPTY_FILTERS, industries: ["Trades & Contractors"], cities: ["Toronto"] });
  assert.deepEqual(ids, ["s2"]);
}

// Multi-select within one dimension is OR, across dimensions is AND.
{
  const ids = selectSheetIds(sheets, {
    ...EMPTY_FILTERS,
    industries: ["Trades & Contractors", "Salons & Personal Care"],
    cities: ["Toronto"],
  });
  assert.deepEqual(ids.sort(), ["s1", "s2"], "two industries in one city is OR within, AND across");
}

// Facet counts come from the sheet counters, never from counting leads.
{
  const f = buildFacets(sheets, EMPTY_FILTERS);
  const on = f.provinces.find((p) => p.code === "ON");
  assert.ok(on);
  assert.equal(on.count, 681, "ON callable = 451 + 130 + 100");
  const toronto = on.cities.find((c) => c.name === "Toronto");
  assert.equal(toronto?.count, 581);
  assert.equal(f.totalCallable, 881);
}

// A facet's own dimension is NOT narrowed by its own selection, or selecting
// Toronto would hide every other city and the rep could never widen again.
{
  const f = buildFacets(sheets, { ...EMPTY_FILTERS, cities: ["Toronto"] });
  const on = f.provinces.find((p) => p.code === "ON");
  assert.ok(on?.cities.some((c) => c.name === "Ottawa"), "other cities stay visible so the selection can be widened");
  const trades = f.industries.find((i) => i.name === "Trades & Contractors");
  assert.equal(trades?.count, 130, "industry counts DO reflect the city selection");
}

// noSiteOnly: true uses the intersection counter, not the min of two independent counts.
// With the fixture values, callable_no_site = 300 + 90 + 70 + 140 = 600, while
// min(callable, no_site) would give 400 + 120 + 90 + 180 = 790. The test proves we use
// the real intersection, not the upper-bound estimate.
{
  const f = buildFacets(sheets, { ...EMPTY_FILTERS, noSiteOnly: true });
  assert.equal(f.totalCallable, 600, "noSiteOnly uses callable_no_site intersection counter, not min()");
}

// Narrowing by noSiteOnly never increases the total count.
{
  const wide = buildFacets(sheets, EMPTY_FILTERS);
  const narrow = buildFacets(sheets, { ...EMPTY_FILTERS, noSiteOnly: true });
  assert.ok(narrow.totalCallable <= wide.totalCallable, "noSiteOnly total must be <= wide total");
}

// Per-province and per-industry counts also use the intersection when noSiteOnly is on.
{
  const f = buildFacets(sheets, { ...EMPTY_FILTERS, noSiteOnly: true });
  const on = f.provinces.find((p) => p.code === "ON");
  // ON callable_no_site = 300 + 90 + 70 = 460
  assert.equal(on?.count, 460, "ON province count with noSiteOnly uses intersection");
  const toronto = on?.cities.find((c) => c.name === "Toronto");
  // Toronto callable_no_site = 300 + 90 = 390
  assert.equal(toronto?.count, 390, "Toronto city count with noSiteOnly uses intersection");
  const salons = f.industries.find((i) => i.name === "Salons & Personal Care");
  // Salons callable_no_site = 300 + 70 = 370
  assert.equal(salons?.count, 370, "Salons industry count with noSiteOnly uses intersection");
}

console.log("web-leads-queries ok");
