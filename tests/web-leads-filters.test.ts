import assert from "node:assert";
import { parseFilters, filtersToParams, EMPTY_FILTERS } from "../lib/web-leads/filters";

// Empty URL yields empty filters on page 1, never null fields.
{
  const f = parseFilters(new URLSearchParams(""));
  assert.deepEqual(f, EMPTY_FILTERS);
  assert.equal(f.page, 1);
  assert.deepEqual(f.provinces, []);
}

// Multi-select round-trips. This is the whole point of approach A: a rep
// selecting three industries and one city must survive a refresh and a share.
{
  const src = new URLSearchParams("prov=ON,QC&city=Toronto&ind=Trades%20%26%20Contractors,Salons%20%26%20Personal%20Care&nosite=1&q=hair&page=3");
  const f = parseFilters(src);
  assert.deepEqual(f.provinces, ["ON", "QC"]);
  assert.deepEqual(f.cities, ["Toronto"]);
  assert.deepEqual(f.industries, ["Trades & Contractors", "Salons & Personal Care"]);
  assert.equal(f.noSiteOnly, true);
  assert.equal(f.query, "hair");
  assert.equal(f.page, 3);

  const round = parseFilters(filtersToParams(f));
  assert.deepEqual(round, f, "filters must survive a round trip through the URL");
}

// An industry containing a comma would break a comma-joined list. Encode it.
{
  const f = { ...EMPTY_FILTERS, industries: ["Food, Drink & Grocery"] };
  const round = parseFilters(filtersToParams(f));
  assert.deepEqual(round.industries, ["Food, Drink & Grocery"], "a comma inside a value must not split it");
}

// Garbage must not throw or produce NaN pages.
{
  const f = parseFilters(new URLSearchParams("page=abc&nosite=maybe&prov=,,,"));
  assert.equal(f.page, 1, "an unparseable page falls back to 1");
  assert.equal(f.noSiteOnly, false);
  assert.deepEqual(f.provinces, [], "empty segments are dropped, not kept as blanks");
}

// The detail panel follows the existing ?lead=<id> convention.
{
  assert.equal(parseFilters(new URLSearchParams("lead=abc-123")).leadId, "abc-123");
  assert.equal(parseFilters(new URLSearchParams("")).leadId, null);
}

console.log("web-leads-filters ok");
