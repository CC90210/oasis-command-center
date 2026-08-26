/**
 * queries.ts — turning filter state into a sheet selection and facet counts.
 *
 * COUNTS COME FROM THE SHEETS, NOT FROM THE LEADS. leadgen_territories carries
 * denormalized leads_total / leads_callable / leads_no_site for exactly this:
 * the rail renders from ~1,600 small rows instead of aggregating 124,000 lead
 * rows on every click. The obvious implementation (count the leads) is the slow
 * one.
 *
 * Pure functions over an already-fetched sheet list. No network here, so the
 * filter algebra is testable without a database.
 */

import type { WebLeadFilters } from "./filters";

export type Sheet = {
  id: string;
  region: string;
  locality: string;
  vertical: string;
  leads_total: number;
  leads_callable: number;
  leads_no_site: number;
  leads_callable_no_site: number;
};

export type Facets = {
  provinces: { code: string; count: number; cities: { name: string; count: number }[] }[];
  industries: { name: string; count: number }[];
  totalCallable: number;
};

/**
 * Callable leads on a sheet, or no-website-callable when that filter is on.
 *
 * WHY NOT Math.min(leads_callable, leads_no_site)?
 * Two independent counts tell us nothing about their overlap. min() is an upper
 * bound on the intersection, but the actual overlap is unknown — it could be far
 * smaller. A live measurement against 1,579 sheets showed the rail returning 29,573
 * (min-based) while the results table showed 10,872 (real intersection): a 2.7x
 * overstatement on the single filter reps use most. leads_callable_no_site is the
 * denormalized true intersection count.
 */
function weight(s: Sheet, f: WebLeadFilters): number {
  return f.noSiteOnly ? s.leads_callable_no_site : s.leads_callable;
}

/**
 * Match on every dimension EXCEPT the ones named, so a facet can show its own
 * alternatives. Passing an empty array applies all dimensions.
 */
function matches(s: Sheet, f: WebLeadFilters, except: ReadonlyArray<"province" | "city" | "industry">): boolean {
  if (!except.includes("province") && f.provinces.length && !f.provinces.includes(s.region)) return false;
  if (!except.includes("city") && f.cities.length && !f.cities.includes(s.locality)) return false;
  if (!except.includes("industry") && f.industries.length && !f.industries.includes(s.vertical)) return false;
  return true;
}

export function selectSheetIds(sheets: Sheet[], f: WebLeadFilters): string[] {
  return sheets.filter((s) => matches(s, f, [])).map((s) => s.id);
}

export function buildFacets(sheets: Sheet[], f: WebLeadFilters): Facets {
  // Geography facet: ignore BOTH the province and the city selection, so
  // every province and every city in it stays listed regardless of what's
  // already picked. Exempting only "city" (as this used to) leaves province
  // narrowing itself: select Ontario and Quebec disappears from the rail,
  // with no way back to add it. Cities are still grouped under their real
  // province (s.region) either way, so a selected province's own cities
  // continue to reflect that grouping correctly -- this only stops the
  // province/city SELECTION from hiding rows, the same guarantee the
  // industry facet below already gives its own dimension.
  const geo = new Map<string, Map<string, number>>();
  for (const s of sheets) {
    if (!matches(s, f, ["province", "city"])) continue;
    if (!geo.has(s.region)) geo.set(s.region, new Map());
    const cities = geo.get(s.region)!;
    cities.set(s.locality, (cities.get(s.locality) || 0) + weight(s, f));
  }

  const provinces = [...geo.entries()]
    .map(([code, cities]) => ({
      code,
      count: [...cities.values()].reduce((a, b) => a + b, 0),
      cities: [...cities.entries()]
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));

  // Industry facet: ignore the industry selection for the same reason, but DO
  // honour geography, so counts answer "how many salons in the cities I picked".
  const inds = new Map<string, number>();
  for (const s of sheets) {
    if (!matches(s, f, ["industry"])) continue;
    inds.set(s.vertical, (inds.get(s.vertical) || 0) + weight(s, f));
  }
  const industries = [...inds.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => {
      if (a.name === "CC Leads") return -1;
      if (b.name === "CC Leads") return 1;
      return b.count - a.count || a.name.localeCompare(b.name);
    });

  const totalCallable = sheets
    .filter((s) => matches(s, f, []))
    .reduce((a, s) => a + weight(s, f), 0);

  return { provinces, industries, totalCallable };
}
