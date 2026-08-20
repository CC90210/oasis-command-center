/**
 * filters.ts — the Web Leads browser's filter state, and its URL encoding.
 *
 * State lives in the URL so a rep can bookmark "my demographic", share an exact
 * slice, and have back/forward behave. Every field is total: no nulls, no
 * undefined, no NaN pages, so consumers never branch on absence.
 *
 * Values are ENCODED individually rather than joined raw, because real industry
 * names carry commas and ampersands ("Food, Drink & Grocery") and a naive
 * comma-join would silently split one industry into two filters that match
 * nothing.
 */

export type WebLeadFilters = {
  provinces: string[];
  cities: string[];
  industries: string[];
  noSiteOnly: boolean;
  query: string;
  page: number;
  leadId: string | null;
};

export const EMPTY_FILTERS: WebLeadFilters = {
  provinces: [], cities: [], industries: [], noSiteOnly: false, query: "", page: 1, leadId: null,
};

/** Split a repeated param into decoded, non-empty values. */
function list(sp: URLSearchParams, key: string): string[] {
  const raw = sp.get(key);
  if (!raw) return [];
  return raw
    .split(",")
    .map((v) => {
      try { return decodeURIComponent(v).trim(); } catch { return v.trim(); }
    })
    .filter((v) => v.length > 0);
}

export function parseFilters(sp: URLSearchParams): WebLeadFilters {
  const pageRaw = Number.parseInt(sp.get("page") || "", 10);
  return {
    provinces: list(sp, "prov"),
    cities: list(sp, "city"),
    industries: list(sp, "ind"),
    noSiteOnly: sp.get("nosite") === "1",
    query: (sp.get("q") || "").trim(),
    page: Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1,
    leadId: sp.get("lead") || null,
  };
}

export function filtersToParams(f: WebLeadFilters): URLSearchParams {
  const sp = new URLSearchParams();
  const put = (key: string, values: string[]) => {
    if (values.length) sp.set(key, values.map((v) => encodeURIComponent(v)).join(","));
  };
  put("prov", f.provinces);
  put("city", f.cities);
  put("ind", f.industries);
  if (f.noSiteOnly) sp.set("nosite", "1");
  if (f.query) sp.set("q", f.query);
  if (f.page > 1) sp.set("page", String(f.page));
  if (f.leadId) sp.set("lead", f.leadId);
  return sp;
}
