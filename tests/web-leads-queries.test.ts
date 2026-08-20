import assert from "node:assert";
import { buildFacets, selectSheetIds, type Sheet } from "../lib/web-leads/queries";
import { EMPTY_FILTERS } from "../lib/web-leads/filters";

const sheets: Sheet[] = [
  { id: "s1", region: "ON", locality: "Toronto",  vertical: "Salons & Personal Care", leads_total: 900, leads_callable: 451, leads_no_site: 400 },
  { id: "s2", region: "ON", locality: "Toronto",  vertical: "Trades & Contractors",   leads_total: 300, leads_callable: 130, leads_no_site: 120 },
  { id: "s3", region: "ON", locality: "Ottawa",   vertical: "Salons & Personal Care", leads_total: 200, leads_callable: 100, leads_no_site: 90  },
  { id: "s4", region: "QC", locality: "Montreal", vertical: "Trades & Contractors",   leads_total: 500, leads_callable: 200, leads_no_site: 180 },
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

console.log("web-leads-queries ok");
