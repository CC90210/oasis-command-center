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
/**
 * `pipeline` was a shared stage board showing every rep's leads mixed together.
 * Adon, 2026-08-23: "You could remove the pipeline feature. I don't see any use
 * for that." He was right, and why it was useless is worth recording: a board
 * of everyone's leads answers a manager's question, and the people on this
 * screen are reps, who only need to know what is in THEIR book. `mine` replaces
 * it. Old `?view=pipeline` links fall through to the default rather than
 * breaking, via the VALID_VIEWS check in parseFilters.
 */
export type WebLeadView = "leads" | "mine" | "team" | "territories";
const VALID_VIEWS: readonly WebLeadView[] = ["leads", "mine", "team", "territories"];

/**
 * Score bands, as RANGES rather than judgements (2026-08-23).
 *
 * The labels are the numbers themselves -- "Under 40", "40 to 59", "60 and up"
 * -- never "weak"/"strong"/"good". This feature's standing rule is that nothing
 * renders a verdict the measurement does not support (see WebsiteComparison.tsx
 * and audit.ts), and a band named "weak sites" would smuggle one in through the
 * filter control. A rep reading a band name aloud reads a range, not a slur
 * about a stranger's business.
 *
 * WHY BANDS AT ALL: the corpus measurement says the real prospects are the
 * ~5,258 under 40, and the ~2,471 at 74+ will win a website-quality argument.
 * Until this existed there was no way for a rep to act on either fact.
 */
export type ScoreBand = "all" | "under40" | "mid" | "sixty_plus" | "unscored";
const VALID_BANDS: readonly ScoreBand[] = ["all", "under40", "mid", "sixty_plus", "unscored"];

/**
 * Sort order for the results list.
 *
 * DEFAULT IS `opportunity`, NOT `name`. An alphabetical list of 31,016
 * businesses is a directory; a sales list has to answer "who do I call first".
 * `opportunity` puts the lowest-scoring sites first (the prospects whose
 * problems we can actually name), with every lead we could not score after
 * them -- unscored leads are not "bad prospects", they are unknown, so they
 * sort last rather than being interleaved as if a missing score were a low one.
 */
/**
 * Canada is spelled by its province codes; anything else on a lead is the US.
 * Derived rather than stored so a lead that already exists does not need a
 * backfill to appear in the right place, and a typo cannot invent a country.
 */
export const CA_REGIONS: readonly string[] = [
  "AB", "BC", "MB", "NB", "NL", "NS", "NT", "NU", "ON", "PE", "QC", "SK", "YT",
];

export type LeadCountry = "ca" | "us";

/** @param region the lead's province/state code */
export function countryOf(region: string | null | undefined): LeadCountry {
  return CA_REGIONS.includes(String(region || "").trim().toUpperCase()) ? "ca" : "us";
}

export type LeadSort = "opportunity" | "name" | "score_desc";
const VALID_SORTS: readonly LeadSort[] = ["opportunity", "name", "score_desc"];

export type WebLeadFilters = {
  view: WebLeadView;
  provinces: string[];
  /**
   * Which country's board a rep is working.
   *
   * Oasis is entering the US (Adon 2026-09-02) and US leads live in the SAME
   * table, distinguished only by their region code. Without this they would
   * interleave with Canadian leads on one list, which is wrong twice over: a
   * rep works one territory at a time, and the two markets have different
   * compliance rules (CASL vs TCPA/DNC) — mixing them on screen is how someone
   * dials a US mobile under Canadian assumptions.
   *
   * Defaults to "ca" so the existing board is unchanged for everyone until a
   * rep deliberately switches.
   */
  country: LeadCountry;
  cities: string[];
  industries: string[];
  noSiteOnly: boolean;
  /**
   * Only leads where we know the OWNER by name.
   *
   * A main line reaches whoever answers; a name lets a rep ask for the person
   * who can actually say yes. The name is read off the business's own About or
   * Team page and stored with the page that proved it, so this filter is
   * "someone verified a human here", not a guess.
   *
   * Off by default: the enriched share of the board is small, and a rep who
   * lands on an empty-looking queue assumes the board is broken.
   */
  ownerOnly: boolean;
  /**
   * Only businesses OPEN RIGHT NOW, in their own time zone.
   *
   * Evaluated per request against a fresh clock (see fetchLeads), never baked
   * into the memoised lead list -- a cached "open now" is a claim that decays
   * into a lie every minute it sits there, and the entire point of this filter
   * is that somebody picks up the phone.
   *
   * A lead whose hours we do not hold is EXCLUDED while this is on, and that
   * direction is deliberate. The filter answers "who can I reach in the next
   * ten minutes", and an unknown is not a maybe, it is not an answer. Roughly
   * three-quarters of the corpus has no hours in the directory (measured
   * 2026-08-24), and all of it stays reachable with the filter off, which is
   * the default.
   */
  openNow: boolean;
  band: ScoreBand;
  sort: LeadSort;
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
  country: "ca",
  provinces: EMPTY_LIST,
  cities: EMPTY_LIST,
  industries: EMPTY_LIST,
  noSiteOnly: false,
  ownerOnly: false,
  openNow: false,
  band: "all",
  sort: "opportunity",
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
      let s = v.trim();
      try {
        while (s.includes("%")) {
          const decoded = decodeURIComponent(s);
          if (decoded === s) break;
          s = decoded;
        }
        return s.trim();
      } catch {
        return s.trim();
      }
    })
    .filter((v) => v.length > 0);
}

export function parseFilters(sp: URLSearchParams): WebLeadFilters {
  const pageRaw = Number.parseInt(sp.get("page") || "", 10);
  const viewRaw = sp.get("view");
  const view: WebLeadView = (VALID_VIEWS as string[]).includes(viewRaw || "")
    ? (viewRaw as WebLeadView)
    : "leads";
  const bandRaw = sp.get("band");
  const sortRaw = sp.get("sort");
  return {
    view,
    country: sp.get("country") === "us" ? "us" : "ca",
    provinces: list(sp, "prov"),
    cities: list(sp, "city"),
    industries: list(sp, "ind"),
    noSiteOnly: sp.get("nosite") === "1",
    ownerOnly: sp.get("owner") === "1",
    openNow: sp.get("open") === "1",
    // Unrecognised values fall back to the default rather than throwing: these
    // come from a URL a rep can hand-edit or a stale bookmark, and a filter
    // page that 500s on a typo is worse than one that shows everything.
    band: (VALID_BANDS as string[]).includes(bandRaw || "") ? (bandRaw as ScoreBand) : "all",
    sort: (VALID_SORTS as string[]).includes(sortRaw || "") ? (sortRaw as LeadSort) : "opportunity",
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
  // Defaults stay out of the URL, same convention as view/page above.
  if (f.band !== "all") sp.set("band", f.band);
  if (f.sort !== "opportunity") sp.set("sort", f.sort);
  if (f.country !== "ca") sp.set("country", f.country);
  put("prov", f.provinces);
  put("city", f.cities);
  put("ind", f.industries);
  if (f.noSiteOnly) sp.set("nosite", "1");
  if (f.ownerOnly) sp.set("owner", "1");
  if (f.openNow) sp.set("open", "1");
  if (f.query) sp.set("q", f.query);
  if (f.page > 1) sp.set("page", String(f.page));
  if (f.leadId) sp.set("lead", f.leadId);
  return sp;
}
