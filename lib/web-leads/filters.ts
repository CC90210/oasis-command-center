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

/**
 * The three in-page views the browser can show (2026-08-23 revamp). Pipeline
 * and Territories used to be separate destinations (`/web-leads/pipeline`,
 * an inline-only TerritoryAssignment card) -- the operator never asked for a
 * standalone pipeline page, so both moved in-page behind a segmented control,
 * switched the same way every other filter here is: through the URL, so a
 * view survives a refresh, back/forward, and a shared link.
 */
export type WebLeadView = "leads" | "pipeline" | "territories";
const VALID_VIEWS: readonly WebLeadView[] = ["leads", "pipeline", "territories"];

export type WebLeadFilters = {
  view: WebLeadView;
  provinces: string[];
  cities: string[];
  industries: string[];
  noSiteOnly: boolean;
  query: string;
  page: number;
  leadId: string | null;
};

// Frozen (object AND its arrays): this is a module-level singleton shared by
// every server route in a warm lambda. Without freezing, one accidental
// in-place mutation (e.g. `EMPTY_FILTERS.provinces.push(...)` instead of
// spreading into a new array) would silently contaminate every later request
// that reuses this instance, instead of throwing.
const EMPTY_LIST = Object.freeze([]) as unknown as string[];

export const EMPTY_FILTERS: WebLeadFilters = Object.freeze({
  view: "leads",
  provinces: EMPTY_LIST,
  cities: EMPTY_LIST,
  industries: EMPTY_LIST,
  noSiteOnly: false,
  query: "",
  page: 1,
  leadId: null,
});

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
  const viewRaw = sp.get("view");
  const view: WebLeadView = (VALID_VIEWS as string[]).includes(viewRaw || "")
    ? (viewRaw as WebLeadView)
    : "leads";
  return {
    view,
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
  // "leads" is the default view and stays out of the URL, same convention
  // as page=1 and every other default below -- only a non-default view
  // earns a query param.
  if (f.view !== "leads") sp.set("view", f.view);
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
