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
};

export type Facets = {
  provinces: { code: string; count: number; cities: { name: string; count: number }[] }[];
  industries: { name: string; count: number }[];
  totalCallable: number;
};

/** Callable leads on a sheet, or no-website-callable when that filter is on. */
function weight(s: Sheet, f: WebLeadFilters): number {
  return f.noSiteOnly ? Math.min(s.leads_callable, s.leads_no_site) : s.leads_callable;
}

/**
 * Match on every dimension EXCEPT the one named, so a facet can show its own
 * alternatives. Passing null applies all dimensions.
 */
function matches(s: Sheet, f: WebLeadFilters, except: "province" | "city" | "industry" | null): boolean {
  if (except !== "province" && f.provinces.length && !f.provinces.includes(s.region)) return false;
  if (except !== "city" && f.cities.length && !f.cities.includes(s.locality)) return false;
  if (except !== "industry" && f.industries.length && !f.industries.includes(s.vertical)) return false;
  return true;
}

export function selectSheetIds(sheets: Sheet[], f: WebLeadFilters): string[] {
  return sheets.filter((s) => matches(s, f, null)).map((s) => s.id);
}

export function buildFacets(sheets: Sheet[], f: WebLeadFilters): Facets {
  // Geography facet: ignore the city selection so every city in a selected
  // province stays listed. Narrowing a facet by its own selection would leave a
  // rep who picked Toronto with no way to add Ottawa.
  const geo = new Map<string, Map<string, number>>();
  for (const s of sheets) {
    if (!matches(s, f, "city")) continue;
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
    if (!matches(s, f, "industry")) continue;
    inds.set(s.vertical, (inds.get(s.vertical) || 0) + weight(s, f));
  }
  const industries = [...inds.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  const totalCallable = sheets
    .filter((s) => matches(s, f, null))
    .reduce((a, s) => a + weight(s, f), 0);

  return { provinces, industries, totalCallable };
}
