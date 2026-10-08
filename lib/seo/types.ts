/**
 * The SEO screen's view of the oasis-seo-measure /v1 API (oasis-seo-aeo worker/src/reads.js,
 * access.js). Field names match the wire format exactly; nothing here is OCC-specific, so
 * this module can move to another product (Gritly) unchanged.
 */

export type SeoRange = "28d" | "3m" | "16m";
export const SEO_RANGES: readonly SeoRange[] = ["28d", "3m", "16m"];

export type SiteStatus = "current" | "behind" | "waiting" | "collecting" | "access_removed";

export type Period = { start: string; end: string };

/** ctr and position are null when impressions are 0: there is nothing to average. */
export type Totals = Period & { clicks: number; impressions: number; ctr: number | null; position: number | null };

export type SiteHeader = {
  id: string;
  domain: string | null;
  display_name: string;
  is_test: boolean;
  status: SiteStatus;
  status_detail: string | null;
};

export type SiteListRow = SiteHeader & {
  settled_through: string | null;
  /** complete=false: stored history does not cover the whole 28 days yet. */
  current: (Totals & { complete: boolean }) | null;
  previous: Totals | null;
};

export type SitesList = { generated_at: string; sites: SiteListRow[] };

export type Freshness = {
  property: string | null;
  last_attempt_at: string | null;
  last_status: string | null;
  last_error: string | null;
  settled_through: string | null;
  history_start: string | null;
  backfill_done: boolean | null;
  detail_capped: boolean;
};

/** at = YYYY-MM-DD (grain day) or YYYY-MM (grain month). */
export type TrendPoint = { at: string; days: number; clicks: number; impressions: number; ctr: number; position: number };

export type SiteSummary = {
  site: SiteHeader;
  range: SeoRange;
  grain: "day" | "month" | null;
  rollups_pending: boolean;
  current: (Totals & { complete: boolean }) | null;
  previous: Totals | null;
  prior_year: Totals | null;
  trend: TrendPoint[];
  freshness: Freshness;
};

export type TopRow = {
  key: string;
  clicks: number;
  impressions: number;
  ctr: number | null;
  position: number | null;
  clicks_change: number | null;
};

export type TopRows = {
  site: SiteHeader;
  range: SeoRange;
  period: Period | null;
  previous_period: Period | null;
  approximate: boolean;
  rollups_pending: boolean;
  note: string;
  rows: TopRow[] | null;
};

export type AddSiteResult =
  | { created: true; site: { id: string; domain: string; is_test: boolean; status: SiteStatus } }
  | { created: false; site: { id: string; domain: string; is_test: boolean } };

export type AccessResult =
  | { result: "ok"; property: string; permission: string }
  | { result: "blocked" | "failed"; reason: string };

/** The identity a client adds as a Search Console user. Not a secret. */
export const SERVICE_ACCOUNT_EMAIL = "oasis-seo-measure@oasis-ai-508017.iam.gserviceaccount.com";
