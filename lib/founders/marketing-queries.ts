/**
 * Readers for the founders-portal Marketing hub.
 *
 * CONVENTION (matches lib/queries.ts): these NEVER throw. A missing table is a
 * normal state before migration 133 is applied, so it returns the EMPTY_* shape
 * and the page renders its empty state instead of 500ing.
 *
 * TENANT SCOPING IS MANUAL AND MANDATORY. getServiceSupabase() bypasses RLS, so
 * every query below carries an explicit .eq("tenant_id", tenantId). The repo's
 * reviewer rule is to grep new files for `.from(` without a nearby tenant filter;
 * keep it that way.
 */

import { getServiceSupabase } from "@/lib/supabase-server";
import { isMissingTableError } from "@/lib/api-helpers";
import {
  BRAND_GROUPS,
  DEFAULT_BRAND_GROUP,
  FOUNDERS_OWN_BRAND,
  LIBRARY_PAGE_SIZE,
  LIFECYCLE,
  brandFilterAllowed,
  brandGroup,
  claimedBrandSlugs,
  libraryPageCount,
  parseSlideUrls,
  type AssetFormat,
  type AssetStatus,
  type BrandGroupKey,
  type Channel,
  type Lifecycle,
  type Track,
} from "@/lib/founders-marketing-core";

/**
 * Restrict a `marketing_asset` query to one brand tab.
 *
 * THE WHOLE BOUNDARY IS THIS FUNCTION. It replaced a bare
 * `.eq("brand_slug", FOUNDERS_OWN_BRAND)` repeated at four call sites, where the
 * boundary had already been half-applied once — `total` was brand-scoped while
 * `open_reviews` was not, so Studio could have said "9 assets, 3 waiting on you"
 * with the 3 belonging to Warner. One function is one thing to get right and one
 * thing to test.
 *
 * A NAMED group filters `IN (its slugs)`. The residual Clients group filters
 * `NOT IN (every claimed slug)`, which is what makes a brand-new client slug
 * appear on the Clients tab without a deploy instead of vanishing from the UI.
 *
 * `brand_slug` is `not null default 'oasis-ai'` (database/134), so the SQL
 * three-valued-logic trap does not apply — a NULL would silently fail `NOT IN`
 * and drop the row from every tab. Asserted in tests rather than assumed.
 *
 * The `(a,b,c)` string is PostgREST's canonical `not.in` value and is also what
 * lib/turso-postgrest.ts `compileOp` parses, so ONE spelling works on both
 * backends. Slugs are constrained to `^[a-z0-9]+(-[a-z0-9]+)*$` by the CHECK in
 * 134, so no separator or quote can appear inside one.
 */
function scopeToBrandGroup<T extends {
  in: (c: string, v: string[]) => T;
  not: (c: string, op: string, v: string) => T;
}>(q: T, group: BrandGroupKey): T {
  const g = brandGroup(group);
  if (g.slugs) return q.in("brand_slug", [...g.slugs]);
  return q.not("brand_slug", "in", `(${claimedBrandSlugs().join(",")})`);
}

/**
 * The lifecycle buckets as a filter the database runs - for the grid AND the
 * pill counts, and for Studio's "awaiting your verdict" line, which links to
 * the Needs review grid and counts it through getLifecycleCounts().
 *
 * The grid used to filter with its own SQL while the pills bucketed rows in JS
 * through lifecycleOf(), and the two disagreed: "Needs review" counted the
 * scheduled assets nobody had posted (status 'scheduled', no published_at) and
 * the grid behind it did not show them, and "Posted" showed archived rows that
 * the pill filed under Archived. One definition, used by both, ends that.
 *
 * NEEDS REVIEW IS DRAFT OR IN REVIEW, NOT YET POSTED - the grid's meaning since
 * the pills shipped. A scheduled asset is not waiting on a verdict: it has its
 * own place (Studio's Scheduled stage, ?status=scheduled, and the All view), so
 * it is in no lifecycle bucket, and neither is a status 'published' row with no
 * published_at. The pill now counts what the grid shows instead of folding them in.
 *
 * Otherwise the precedence of lifecycleOf(): shelved first, then published_at
 * (the world outranks our bookkeeping), then the approved verdict.
 * tests/library-paging.test.ts runs every status x published_at pair through
 * this against real SQLite and compares it with lifecycleOf().
 */
type LifecycleFilterable = {
  eq: (column: string, value: string) => LifecycleFilterable;
  in: (column: string, values: string[]) => LifecycleFilterable;
  is: (column: string, value: null) => LifecycleFilterable;
  not: (column: string, op: string, value: unknown) => LifecycleFilterable;
};

/** The statuses the working grid hides; the Archived pill is where they live. */
const ARCHIVED_STATUSES = ["archived", "rejected"];

/**
 * The working grid's rule: archived and rejected assets are hidden. ONE
 * definition, used by the All grid, the Live bucket and the tab counts, so a
 * tab's number is always what clicking it shows.
 */
function hideArchived<T>(q: T): T {
  return (q as unknown as LifecycleFilterable).not("status", "in", `(${ARCHIVED_STATUSES.join(",")})`) as unknown as T;
}

function scopeToLifecycle<T>(q: T, lifecycle: Lifecycle): T {
  const f = q as unknown as LifecycleFilterable;
  switch (lifecycle) {
    case "archived":
      return f.in("status", ARCHIVED_STATUSES) as unknown as T;
    case "live":
      return hideArchived(f).not("published_at", "is", null) as unknown as T;
    case "approved":
      return f.eq("status", "approved").is("published_at", null) as unknown as T;
    case "needs_review":
      return f.in("status", ["draft", "in_review"]).is("published_at", null) as unknown as T;
  }
}

export type MarketingMediaRow = {
  id: string;
  kind: string;
  storage_bucket: string;
  storage_path: string;
  mime: string | null;
  bytes: number | null;
  width: number | null;
  height: number | null;
  label: string | null;
};

export type MarketingAssetRow = {
  id: string;
  tenant_id: string;
  title: string;
  brand_slug: string;
  brand_name: string;
  channel: Channel;
  /**
   * Where the asset ACTUALLY went, as a JSON array of platform keys.
   *
   * `channel` holds one value and an asset goes to as many as six places, which
   * is why the Library read INSTAGRAM for everything (CC: "it's only posting to
   * Instagram"). `channel` stays the PRIMARY channel and the input to the
   * generated `track` column the pipeline groups by; this is the distribution.
   * Stamped by scripts/marketing_publish_drain.py with the platforms that
   * accepted the post — a refusal is not a distribution.
   */
  platforms: string[] | string | null;
  /**
   * 'video' | 'single_image' | 'carousel'. Not a database CHECK on purpose —
   * SQLite cannot widen one without a full table rebuild, and this vocabulary
   * will grow. Validated in founders-marketing-core instead.
   */
  asset_type: string;
  /** Ordered storage paths, one per slide. ORDER IS THE PAYLOAD. */
  media_urls: string[] | string | null;
  slide_count: number;
  author_email: string;
  track: Track;
  format: AssetFormat;
  aspect: string | null;
  status: AssetStatus;
  hook: string | null;
  body: string | null;
  cta: string | null;
  landing_url: string | null;
  campaign: string | null;
  duration_s: number | null;
  author_agent: string;
  source: string | null;
  scheduled_for: string | null;
  published_at: string | null;
  created_at: string;
  updated_at: string;
  media?: MarketingMediaRow[];
  open_reviews?: number;
};

export type MarketingSummary = {
  total: number;
  by_track: Record<Track, number>;
  by_status: Record<string, number>;
  open_reviews: number;
  // No corpus counts since 2026-10-01: the training material is the Training
  // tab's own read (getCorpusStats), so the Library's numbers neither wait on
  // it nor degrade when it fails.
  // No request count either (D16): with the Requests card gone nothing shows
  // one, and reading it cost two round trips per Overview and could mark this
  // whole summary degraded over a number no screen draws.
  /**
   * True when a query FAILED, as opposed to returning nothing.
   *
   * Zero and "I could not find out" are different facts and this surface used to
   * render them identically: every error path returned the empty summary, so a
   * timeout on page two of the asset read painted "nothing registered yet" and
   * "Nothing waiting on you" over a library with real work in it. On the screen
   * whose entire job is telling CC what needs him, a made-up zero is the worst
   * possible answer — worse than an error, because it is actionable and wrong.
   *
   * A MISSING TABLE IS NOT DEGRADED. Before migration 133 is applied the tables
   * genuinely do not exist and empty is the honest answer; that stays quiet.
   */
  degraded: boolean;
};

/**
 * The fallback to hand `safe()` — and what an unexpected throw returns.
 *
 * EMPTY_MARKETING_SUMMARY has `degraded: false`, which is correct for "the
 * tables are not there yet" and WRONG for every other way this can fail. The
 * page passes its fallback into safe(), so passing the empty one re-created the
 * exact bug degraded exists to prevent: an exception rendered as a confident
 * "Nothing waiting on you". An exception is never evidence of absence.
 */
export const DEGRADED_MARKETING_SUMMARY: MarketingSummary = {
  total: 0,
  by_track: { organic: 0, paid: 0, seo: 0, email: 0 },
  by_status: {},
  open_reviews: 0,
  degraded: true,
};

export const EMPTY_MARKETING_SUMMARY: MarketingSummary = {
  total: 0,
  by_track: { organic: 0, paid: 0, seo: 0, email: 0 },
  by_status: {},
  open_reviews: 0,
  degraded: false,
};

/**
 * Classify a query error. Returns "absent" when the table has not been created
 * yet (pre-migration, an honest empty), "broken" for anything else.
 *
 * The previous version returned `true` for BOTH, which is why every caller
 * collapsed a real failure into the empty summary — and why the `break` that
 * used to follow one of these checks was unreachable dead code.
 */
function classify(
  label: string,
  err: { code?: string; message?: string } | null,
): "ok" | "absent" | "broken" {
  if (!err) return "ok";
  if (isMissingTableError(err)) return "absent"; // pre-migration, not an incident
  console.warn(`[marketing:${label}]`, err.message);
  return "broken";
}

/**
 * Read every row of a counting query, one page at a time.
 *
 * THREE READERS HAD THEIR OWN COPY of this loop — summary, facets, lifecycle —
 * differing only in the columns selected and what they tallied. The loop is short
 * but every line of it is load-bearing, and this file already records the loop
 * being copied WRONG once: getMarketingSummary's version was lifted from the
 * brands reader without its `.order()`, which CodeRabbit caught. Three copies is
 * three chances to drop the same line, and the failure is silent — pages that
 * overlap or skip, producing counts wrong in an unpredictable direction.
 *
 * The mechanics that have to be right now live in one place:
 *
 *   ORDER BEFORE RANGE. `.range()` on an unordered query has no stable row order,
 *   so page 2 can repeat or skip rows from page 1. `id` because it is the primary
 *   key — unique, so the ordering is total with no ties to break. Ordering by a
 *   non-unique column (an early version used `brand_name`, which 43 rows share)
 *   makes the page boundary arbitrary.
 *
 *   PAGING AT ALL. PostgREST caps a response at max-rows (1,000 on Supabase) and
 *   returns the short page with NO error, while the Turso bridge applies no cap —
 *   so one unpaginated read gives two different answers per backend and the
 *   Supabase one is silently low.
 *
 * `build()` is called PER PAGE rather than once, because the query builders are
 * single-use: reapplying `.range()` to a spent builder is not a fresh query.
 *
 * Returns what happened rather than throwing, so each caller decides what an
 * absent table or a broken read means for ITS shape — they differ, and that
 * difference is the one thing worth keeping per-reader. Rows from pages that DID
 * load are already consumed when "degraded" comes back: a partial count beats a
 * blanked screen, as long as the caller flags it.
 */
// Deliberately NOT recursive (`order` returning PagedQuery<T> again). Written
// that way first, it made tsc give up with TS2589 "type instantiation is
// excessively deep" once the real Supabase builder was assigned to it — its
// method chain is already deeply generic, and a self-referential wrapper
// multiplies it. Two flat shapes describe the only chain this helper uses.
/**
 * The two filter methods scopeToBrandGroup uses, and nothing else.
 *
 * Passing the real Supabase builder straight into that generic makes tsc infer
 * T as the full builder type and give up with TS2589. Casting to this shallow
 * shape first keeps the inference one level deep. It is a compile-time narrowing
 * only — the same object is passed through untouched.
 */
type BrandFilterable = {
  in: (column: string, values: string[]) => BrandFilterable;
  not: (column: string, op: string, value: string) => BrandFilterable;
};

type RangeQuery<T> = {
  range: (from: number, to: number) => PromiseLike<{
    data: T[] | null;
    error: { code?: string; message?: string } | null;
  }>;
};

type PagedQuery<T> = {
  order: (column: string, opts: { ascending: boolean }) => RangeQuery<T>;
};

async function pageAll<T>(
  label: string,
  build: () => PagedQuery<T>,
  consume: (rows: T[]) => void,
): Promise<"ok" | "absent" | "degraded"> {
  for (let from = 0; ; from += PAGE_SIZE) {
    const r = await build()
      .order("id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    const verdict = classify(label, r.error);
    if (verdict === "absent") return "absent";
    if (verdict === "broken") return "degraded";
    const rows = r.data || [];
    consume(rows);
    if (rows.length < PAGE_SIZE) return "ok";
  }
}

/**
 * Page size for the own-brand asset read. Same value and same `.range()` loop as
 * getMarketingBrands further down this file: PostgREST caps a response at
 * `max-rows` (1,000 on Supabase) and returns the short page WITHOUT an error, so
 * one unpaginated select is silently wrong past that point — while the Turso
 * bridge, which applies no cap, returns everything. Paging is what makes the two
 * backends agree, and it is already this file's idiom.
 */
const PAGE_SIZE = 1000;

/**
 * `.in()` list size for the id-scoped counts below. Not a correctness limit like
 * PAGE_SIZE — it keeps the generated URL off the server's request-line ceiling,
 * where the failure would be a 414 swallowed by `error ? 0` and read on screen as
 * "nothing waiting on you".
 */
const ID_CHUNK = 500;

function chunk<T>(xs: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

/**
 * Headline counts for the Studio landing.
 *
 * `db` is injectable for tests ONLY. Every caller in the app omits it and gets
 * the service client. It exists because the brand boundary here is a property of
 * the QUERIES — which rows each count includes — and the previous tests could
 * only read this file as text and count tokens, which is why the half-applied
 * boundary below (assets scoped, reviews and requests not) survived review.
 * See tests/marketing-core.test.ts.
 */
export async function getMarketingSummary(
  tenantId: string,
  db: ReturnType<typeof getServiceSupabase> = getServiceSupabase(),
): Promise<MarketingSummary> {
  if (!tenantId) return EMPTY_MARKETING_SUMMARY;
  try {
    // `id` is selected so the review count below can be scoped to the SAME
    // assets this count describes; without it, that count silently spanned
    // every brand on the tenant. Paged, because a short read here would not
    // just undercount `total` — ownAssetIds is the allowlist that count uses,
    // so it would quietly drop real work from "with the marketing agent" too.
    const rows: Array<{ id: string; track: Track; status: string }> = [];
    const outcome = await pageAll<{ id: string; track: Track; status: string }>(
      "summary.assets",
      () =>
        db
          .from("marketing_asset")
          .select("id, track, status")
          .eq("tenant_id", tenantId)
        // STAYS OASIS-OWN even though the Library now has four brand tabs.
        // This summary drives "Needs you" — CC's own verdict queue — and the
        // publish route is own-brand-only, so a client's ad is not work he can
        // action from here. Counting it would inflate the one number on the
        // dashboard whose entire job is to be trusted about his workload.
        // The per-brand counts CC asked for come from getMarketingFacets, which
        // spans every tab on purpose.
          .eq("brand_slug", FOUNDERS_OWN_BRAND) as unknown as PagedQuery<{
          id: string;
          track: Track;
          status: string;
        }>,
      // ORDER BEFORE RANGE lives in pageAll now, along with the paging itself.
      // This loop was written by copying the brands reader and DROPPING its
      // .order(), which CodeRabbit caught — the reason one shared implementation
      // is worth the indirection.
      (got) => rows.push(...got),
    );
    // Absent table = pre-migration = genuinely empty, and quiet.
    if (outcome === "absent") return EMPTY_MARKETING_SUMMARY;
    // Broken mid-page keeps the pages we DID get so the screen is not blanked,
    // but marks the whole summary degraded — the counts below are scoped by
    // these ids, so a short read makes every one of them an undercount.
    let degraded = outcome === "degraded";

    const ownAssetIds = rows.map((r) => r.id);
    const by_track: Record<Track, number> = { organic: 0, paid: 0, seo: 0, email: 0 };
    const by_status: Record<string, number> = {};
    for (const r of rows) {
      if (r.track in by_track) by_track[r.track] += 1;
      by_status[r.status] = (by_status[r.status] || 0) + 1;
    }

    // BRAND SCOPE APPLIES TO THE ACTION COUNTS TOO, which is the half that was
    // missing: `total` was scoped to OASIS's own brand while `open_reviews` and
    // `open_requests` were scoped only by tenant. A founders surface that says
    // "9 assets" and "3 waiting on you" where the 3 are Warner's is worse than
    // the unscoped version — it looks correct. marketing_review.asset_id is NOT
    // NULL (database/133_marketing_hub.sql), so every review has a brand.
    //
    // `.in()` rather than an embedded `marketing_asset!inner(brand_slug)` filter:
    // the Turso PostgREST bridge resolves embeds with a second query and attaches
    // them (lib/turso-postgrest.ts attachEmbeds), so a filter on an embedded
    // column is not pushed down. `.in()` behaves identically on both backends.
    // The founders library is OASIS's own output and stays small by definition.
    // Chunked: the id lists are disjoint and every row carries exactly one
    // asset_id, so the parts sum to the whole. No ids means no own-brand assets,
    // which means zero — NOT "fall through and count the tenant".
    // A failed chunk keeps the chunks that succeeded and marks the summary
    // degraded. Discarding them and reporting 0 was the same lie as above, at
    // smaller scale: "nothing waiting on you" when the query simply broke.
    //
    // ONE COUNT AFTER THE ASSET PAGES. The open-request counts left with the
    // Requests card (D16): nothing shows them, and a failure on their table
    // marked this whole summary degraded, which hides the Overview's pipeline
    // and says "Couldn't load your queue" over a number no screen draws. The
    // corpus read left on 2026-10-01: the training material is the Training
    // tab's own read (getCorpusStats).
    let openReviews = 0;
    for (const ids of chunk(ownAssetIds, ID_CHUNK)) {
      const r = await db
        .from("marketing_review")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", tenantId)
        .is("acted_on_at", null)
        .in("asset_id", ids);
      const verdict = classify("summary.reviews", r.error);
      if (verdict !== "ok") {
        if (verdict === "broken") degraded = true;
        break;
      }
      openReviews += r.count || 0;
    }

    return {
      total: rows.length,
      by_track,
      by_status,
      open_reviews: openReviews,
      degraded,
    };
  } catch (e) {
    console.warn("[marketing:summary] unexpected", e);
    return DEGRADED_MARKETING_SUMMARY;
  }
}

/** One page of the Library: the rows to render and what is behind them. */
export type MarketingAssetPage = {
  /** At most `pageSize` rows, each with its media and open-review count. */
  assets: MarketingAssetRow[];
  /** Rows matching the filters across EVERY page, from a COUNT, not this page. */
  total: number;
  /** The page actually returned, 1-based. A page past the end lands on the last one. */
  page: number;
  pageSize: number;
};

/**
 * One page of Library rows. Media is fetched in ONE follow-up query for that
 * page's ids only and grouped in JS, so a page is 2 round trips, not 1 + 24.
 *
 * PAGED ON THE SERVER, and that is the fix for "clicking on the library takes
 * way too long". This read used to return up to 200 rows, the page signed media
 * for every one of them and rendered every tile, and the browser then fetched
 * every tile's media. Now the database returns `pageSize` rows (24 by default)
 * plus a COUNT for the pager, and nothing outside the page is read further.
 *
 * `db` is injectable for tests only, as in getMarketingSummary.
 */
export async function getMarketingAssets(
  tenantId: string,
  opts: {
    track?: Track;
    channel?: Channel;
    status?: AssetStatus;
    /** Which brand TAB. Defaults to OASIS's own work, as this page always has. */
    group?: BrandGroupKey;
    /** Sub-filter WITHIN the tab. Ignored if it names a brand from another tab. */
    brand?: string;
    /** `author_email`, for the by-author facet. */
    author?: string;
    /** Review + distribution bucket. The default view excludes archived. */
    lifecycle?: Lifecycle;
    /** 1-based. */
    page?: number;
    pageSize?: number;
  } = {},
  db: ReturnType<typeof getServiceSupabase> = getServiceSupabase(),
): Promise<MarketingAssetPage> {
  const pageSize = Math.max(1, Math.floor(opts.pageSize ?? LIBRARY_PAGE_SIZE));
  const empty: MarketingAssetPage = { assets: [], total: 0, page: 1, pageSize };
  if (!tenantId) return empty;
  try {
    const group = opts.group ?? DEFAULT_BRAND_GROUP;
    const filtered = () => {
      // `count: "exact"` returns the total behind ALL pages with the page itself.
      let q = db
        .from("marketing_asset")
        .select("*", { count: "exact" })
        .eq("tenant_id", tenantId);
      // Every facet the page offers narrows the grid AND the total behind it. The
      // track line was dropped once when this builder was written: ?track=paid lit
      // the Paid pill and printed "N assets - Paid" over every track's assets.
      if (opts.track) q = q.eq("track", opts.track);
      if (opts.channel) q = q.eq("channel", opts.channel);
      if (opts.author) q = q.eq("author_email", opts.author);

      // `status` and `lifecycle` ARE TWO VOCABULARIES FOR ONE COLUMN, so applying
      // both ANDs them into a contradiction: ?status=draft&lifecycle=archived
      // compiles to `status = 'draft' AND status IN ('archived','rejected')`,
      // which matches nothing. The grid would read "Nothing at this stage" while
      // the pills above it show real counts — a dead end with no visible cause,
      // and reachable in two clicks (arrive from a Studio pipeline tile, then
      // press a lifecycle pill).
      //
      // Lifecycle wins because it is the axis the page is organised on; `status`
      // survives only as a deep-link target for Studio's pipeline tiles, which
      // address stages lifecycle deliberately merges (scheduled, draft). The UI
      // also clears one when setting the other, so this guard is the backstop for
      // a hand-typed URL rather than the primary defence.
      if (opts.status && !opts.lifecycle) q = q.eq("status", opts.status);

      // LIFECYCLE, the axis CC actually asked for: "organise this a lot better so
      // that we can differentiate our pieces of content."
      //
      // Pushed into SQL rather than filtered in JS after the fact, because the
      // reader pages — filtering afterwards would silently show fewer than a page
      // of archived assets while claiming to show them all. The SAME predicate
      // feeds the pill counts (getLifecycleCounts), so a pill and the grid
      // behind it cannot disagree. See scopeToLifecycle().
      if (opts.lifecycle) {
        q = scopeToLifecycle(q, opts.lifecycle);
      } else if (!opts.status) {
        // DEFAULT VIEW HIDES ARCHIVED. Archiving something should remove it from
        // the working grid — that is the whole point of the verb — but it must
        // stay reachable, which is what the Archived pill is for. Skipped when an
        // explicit ?status= is set so Studio's pipeline tiles still deep-link to
        // any single stage.
        q = hideArchived(q);
      }

      // The brand boundary. The tab is ALWAYS applied — there is no code path
      // through this reader that returns rows from more than one tab, which is
      // why the group filter is unconditional and the sub-filter is not.
      q = scopeToBrandGroup(q, group);
      // A sub-filter NARROWS the tab and may never widen it. `?brand=warner` on
      // the OASIS tab is dropped rather than honoured — see brandFilterAllowed.
      if (opts.brand && brandFilterAllowed(opts.brand, group)) {
        q = q.eq("brand_slug", opts.brand);
      }
      return q;
    };

    const readPage = async (page: number) => {
      const r = await filtered()
        // ORDER BEFORE RANGE, ending on a UNIQUE key: created_at alone ties (a
        // batch registers many rows in one second), and a tie at a page boundary
        // repeats or skips an asset between page 2 and page 3.
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .range((page - 1) * pageSize, page * pageSize - 1);
      // Absent (pre-migration) is an honest empty library. Broken is NOT: returning
      // [] there makes the page say "The library is empty" about a library that is
      // full, and the caller cannot tell the difference from a shape that is just
      // an array. Throwing is how this reader says "I could not find out" — the
      // caller passes null as its safe() fallback and renders that distinctly.
      const verdict = classify("assets", r.error);
      if (verdict === "absent") return null;
      if (verdict === "broken") throw new Error(`marketing_asset read failed: ${r.error?.message}`);
      return { rows: (r.data || []) as MarketingAssetRow[], total: Number(r.count ?? 0) };
    };

    let page = Math.max(1, Math.floor(opts.page ?? 1));
    let got = await readPage(page);
    if (!got) return empty;
    // A page past the end (a bookmark from before an archive, a hand-typed
    // ?page=99) lands on the LAST page rather than an empty grid that claims the
    // tab is empty while the pager says otherwise.
    if (!got.rows.length && got.total > 0 && page > 1) {
      page = libraryPageCount(got.total, pageSize);
      got = await readPage(page);
      if (!got) return empty;
    }
    const assets = got.rows;
    const total = got.total;
    if (!assets.length) return { assets: [], total, page, pageSize };

    const ids = assets.map((a) => a.id);
    const [media, reviews] = await Promise.all([
      db
        .from("marketing_asset_media")
        .select("id, asset_id, kind, storage_bucket, storage_path, mime, bytes, width, height, label")
        .eq("tenant_id", tenantId)
        .in("asset_id", ids),
      db
        .from("marketing_review")
        .select("asset_id")
        .eq("tenant_id", tenantId)
        .is("acted_on_at", null)
        .in("asset_id", ids),
    ]);

    const byAsset = new Map<string, MarketingMediaRow[]>();
    for (const m of (media.data || []) as Array<MarketingMediaRow & { asset_id: string }>) {
      const list = byAsset.get(m.asset_id) || [];
      list.push(m);
      byAsset.set(m.asset_id, list);
    }
    const openCount = new Map<string, number>();
    for (const rv of (reviews.data || []) as Array<{ asset_id: string }>) {
      openCount.set(rv.asset_id, (openCount.get(rv.asset_id) || 0) + 1);
    }

    for (const a of assets) {
      a.media = byAsset.get(a.id) || [];
      a.open_reviews = openCount.get(a.id) || 0;
    }
    return { assets, total, page, pageSize };
  } catch (e) {
    // Deliberately NOT caught into []: the caller distinguishes "empty" from
    // "could not load" by whether this resolves at all. See the throw above.
    console.warn("[marketing:assets] unexpected", e);
    throw e;
  }
}

/** What one Library tile needs, with its media already signed. */
export type LibraryTile = {
  asset: MarketingAssetRow;
  playbackUrl: string | null;
  posterUrl: string | null;
  /** Measured pixels of the media the tile shows (the video, else the cover). */
  mediaW: number | null;
  mediaH: number | null;
  /** Signed slides in `media_urls` order, or [] when any one failed to sign. */
  slideUrls: string[];
};

export type LibraryPage = Omit<MarketingAssetPage, "assets"> & { tiles: LibraryTile[] };

/**
 * The objects a tile shows: its video (if any) and ONE cover image.
 *
 * A carousel's cover is its first image row; its slides are signed separately,
 * in `media_urls` order, because a carousel read out of order is a different
 * post and media rows carry no order.
 */
function tileMedia(a: MarketingAssetRow) {
  const media = a.media || [];
  return {
    video: media.find((m) => m.kind === "video"),
    poster:
      media.find((m) => m.kind === "poster") ||
      media.find((m) => m.kind === "thumb") ||
      media.find((m) => m.kind === "preview") ||
      media.find((m) => m.kind === "image"),
  };
}

/**
 * One Library page, read and signed: THE data path of /founders/marketing/library.
 *
 * Signing happens here, for the rows getMarketingAssets returned and nothing
 * else, so the page cannot sign more than a page of assets however it renders.
 * Signing for every asset in the tab was half of why the Library took minutes:
 * a signed URL is an invitation for the browser to fetch.
 *
 * `deps` is injectable for tests only (a libSQL-backed client and a counting
 * signer). A signing failure degrades every tile to "no media" rather than
 * failing the page, as before.
 */
export async function loadLibraryPage(
  tenantId: string,
  opts: Parameters<typeof getMarketingAssets>[1] = {},
  deps: {
    db?: ReturnType<typeof getServiceSupabase>;
    sign?: typeof signMediaUrls;
  } = {},
): Promise<LibraryPage> {
  const { assets, ...rest } = await getMarketingAssets(tenantId, opts, deps.db ?? getServiceSupabase());
  const sign = deps.sign ?? signMediaUrls;

  const slidePaths = (a: MarketingAssetRow): string[] => parseSlideUrls(a.media_urls).filter(Boolean);
  const refs = assets.flatMap((a) => {
    const { video, poster } = tileMedia(a);
    const base = [video, poster]
      .filter((m): m is NonNullable<typeof m> => !!m)
      .map((m) => ({ bucket: m.storage_bucket, path: m.storage_path }));
    return [...base, ...slidePaths(a).map((path) => ({ bucket: "marketing-media", path }))];
  });
  let urls = new Map<string, string>();
  try {
    urls = await sign(refs);
  } catch (e) {
    console.warn("[marketing:library.sign] signing failed; tiles render without media", e);
  }

  const tiles = assets.map((a): LibraryTile => {
    const { video, poster } = tileMedia(a);
    const shape = video ?? poster;
    const signedSlides = slidePaths(a).map((path) => urls.get(mediaKey("marketing-media", path)));
    return {
      asset: a,
      playbackUrl: video ? (urls.get(mediaKey(video.storage_bucket, video.storage_path)) ?? null) : null,
      posterUrl: poster ? (urls.get(mediaKey(poster.storage_bucket, poster.storage_path)) ?? null) : null,
      mediaW: shape?.width ?? null,
      mediaH: shape?.height ?? null,
      // ALL SLIDES OR NONE. Mapping then filtering silently renumbers a carousel
      // when one slide fails to sign — 1,2,4,5 rendered as "1/4..4/4" — and a
      // carousel read out of order is a different post. If we cannot show the
      // whole thing we show the cover instead, which is honest rather than
      // confidently wrong.
      slideUrls: signedSlides.every(Boolean) ? (signedSlides as string[]) : [],
    };
  });
  return { ...rest, tiles };
}

/**
 * Signed URL for inline playback. Supabase Storage objects are private; the
 * browser never gets the service key, it gets a short-lived URL per object.
 * Returns null rather than throwing so one bad object cannot blank the grid.
 */
export async function signMediaUrl(
  bucket: string,
  path: string,
  expiresInSeconds = 60 * 60,
): Promise<string | null> {
  if (!bucket || !path) return null;
  try {
    const db = getServiceSupabase();
    const r = await db.storage.from(bucket).createSignedUrl(path, expiresInSeconds);
    if (r.error || !r.data?.signedUrl) return null;
    return r.data.signedUrl;
  } catch {
    return null;
  }
}

/**
 * Batch-sign every media object the library needs, grouped by bucket.
 *
 * The per-object version costs one Storage round-trip each: a 200-asset library
 * with a video and a poster apiece is 400 sequential requests, and that is the
 * page's whole render time. `createSignedUrls` signs a whole bucket's worth in
 * one call, so the same page is one request per bucket.
 *
 * Returns a `bucket\npath` -> url map. Missing entries mean "could not sign",
 * which the caller renders as a tile without playback rather than an error.
 */
export async function signMediaUrls(
  refs: Array<{ bucket: string; path: string }>,
  expiresInSeconds = 60 * 60,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!refs.length) return out;

  const byBucket = new Map<string, Set<string>>();
  for (const r of refs) {
    if (!r.bucket || !r.path) continue;
    if (!byBucket.has(r.bucket)) byBucket.set(r.bucket, new Set());
    byBucket.get(r.bucket)!.add(r.path);
  }

  const db = getServiceSupabase();
  await Promise.all(
    [...byBucket.entries()].map(async ([bucket, pathSet]) => {
      const paths = [...pathSet];
      try {
        const r = await db.storage.from(bucket).createSignedUrls(paths, expiresInSeconds);
        if (r.error || !r.data) return; // whole bucket unsignable: tiles degrade, page renders
        for (const row of r.data) {
          // `path` is echoed back per row; signedUrl is null on a per-object failure.
          if (row.path && row.signedUrl) out.set(`${bucket}\n${row.path}`, row.signedUrl);
        }
      } catch {
        // Same posture as the readers above: never throw from a read path.
      }
    }),
  );
  return out;
}

/**
 * One asset by id, with its media — for the detail page.
 *
 * TENANT-SCOPED. The id alone is not proof of anything — a uuid pasted into the
 * URL must not reach another tenant's row.
 *
 * NO LONGER BRAND-SCOPED, and that is the point of this change. It was
 * `.eq("brand_slug", FOUNDERS_OWN_BRAND)`, which was right while the Library
 * showed one brand and became a bug the moment the Clients tab shipped: every
 * client tile would link to a page that 404s. That is the "wall of dead links"
 * this route was created to fix, reintroduced for four rows.
 *
 * VIEWING IS NOT PUBLISHING. The publish route keeps its own
 * `brand_slug !== "oasis-ai" -> notFound()` check, deliberately un-widened:
 * being able to review a client's ad in our own library is not the same as
 * being able to broadcast it from CC's accounts, and those two boundaries have
 * no reason to move together.
 *
 * Returns null for "no such asset you may see" — the caller renders notFound(),
 * never a 403, so the route does not confirm what exists.
 */
export async function getMarketingAsset(
  tenantId: string,
  id: string,
): Promise<MarketingAssetRow | null> {
  if (!tenantId || !id) return null;
  const db = getServiceSupabase();
  try {
    const q = db.from("marketing_asset").select("*").eq("tenant_id", tenantId).eq("id", id);
    const r = await q.maybeSingle();
    const verdict = classify("asset", r.error);
    if (verdict === "absent") return null;
    if (verdict === "broken") throw new Error(`marketing_asset read failed: ${r.error?.message}`);
    const asset = (r.data || null) as MarketingAssetRow | null;
    if (!asset) return null;

    const [media, reviews] = await Promise.all([
      db
        .from("marketing_asset_media")
        .select("id, asset_id, kind, storage_bucket, storage_path, mime, bytes, width, height, label")
        .eq("tenant_id", tenantId)
        .eq("asset_id", id),
      db
        .from("marketing_review")
        .select("asset_id")
        .eq("tenant_id", tenantId)
        .is("acted_on_at", null)
        .eq("asset_id", id),
    ]);
    asset.media = (media.data || []) as MarketingMediaRow[];
    asset.open_reviews = ((reviews.data || []) as unknown[]).length;
    return asset;
  } catch (e) {
    console.warn("[marketing:asset] unexpected", e);
    throw e;
  }
}

/**
 * The most recent publish request for one asset.
 *
 * The detail page shows it so the operator can see that a publish is already
 * queued or running before firing a second one. There is no unsending, so
 * "did I already click this" has to be answerable on the page.
 */
export async function getLatestPublishIntent(
  tenantId: string,
  assetId: string,
): Promise<{ state: string; platforms: string[]; created_at: string } | null> {
  if (!tenantId || !assetId) return null;
  const db = getServiceSupabase();
  try {
    const r = await db
      .from("marketing_publish_intent")
      .select("state, platforms, created_at")
      .eq("tenant_id", tenantId)
      .eq("asset_id", assetId)
      .order("created_at", { ascending: false })
      .limit(1);
    // Absent table = the migration has not been applied yet; that is a normal
    // pre-migration state and the panel simply shows no history.
    if (classify("publish_intent", r.error) !== "ok") return null;
    const row = (r.data || [])[0] as
      | { state: string; platforms: unknown; created_at: string }
      | undefined;
    if (!row) return null;
    // A malformed `platforms` string must not cost the operator the whole row.
    // JSON.parse throws, the outer catch returns null, and the panel then shows
    // NO publish history at all — including a "running" they need to see before
    // deciding whether to press publish again. The state is the important half;
    // an unreadable platform list degrades to empty, loudly in the log.
    let platforms: string[] = [];
    if (Array.isArray(row.platforms)) {
      platforms = row.platforms as string[];
    } else if (typeof row.platforms === "string") {
      try {
        const parsed = JSON.parse(row.platforms || "[]");
        platforms = Array.isArray(parsed) ? parsed : [];
      } catch {
        console.warn("[marketing:publish_intent] unparseable platforms", row.platforms);
      }
    }
    return { state: row.state, platforms, created_at: row.created_at };
  } catch {
    return null;
  }
}

export const mediaKey = (bucket: string, path: string) => `${bucket}\n${path}`;

export type BrandFacet = { slug: string; name: string; count: number };
export type AuthorFacet = { email: string; count: number };

export type MarketingFacets = {
  /** Every brand on the tenant, with its asset count. Spans all tabs by design. */
  brands: BrandFacet[];
  /** Distinct `author_email` values, with counts. */
  authors: AuthorFacet[];
  /** True when a page failed — counts are then a floor, not a total. */
  degraded: boolean;
};

export const EMPTY_MARKETING_FACETS: MarketingFacets = {
  brands: [],
  authors: [],
  degraded: false,
};

/**
 * The fallback to hand `safe()` — what an unexpected throw returns.
 *
 * Paired with EMPTY_ above for the same reason DEGRADED_MARKETING_SUMMARY is
 * paired with EMPTY_MARKETING_SUMMARY: `degraded: false` is correct for "the
 * table is not there yet" and WRONG for every other failure. Both pages were
 * inlining this object literal, which is one `degraded: false` typo away from
 * painting confident zeros across the whole tab bar — the exact bug the
 * summary constants exist to prevent, re-opened by not following their pattern.
 */
export const DEGRADED_MARKETING_FACETS: MarketingFacets = {
  brands: [],
  authors: [],
  degraded: true,
};

/** A `count: "exact", head: true` read: the number, never the rows. */
type HeadCount = PromiseLike<{ count: number | null; error: { code?: string; message?: string } | null }>;

/**
 * Run COUNT queries in parallel and report them the way the pills need them:
 * an absent table is an honest zero, a failed count is flagged (the number is
 * then a floor), and the counts that did succeed are kept.
 */
async function headCounts<K extends string>(
  label: string,
  keys: readonly K[],
  build: (key: K) => HeadCount,
): Promise<{ counts: Record<K, number>; degraded: boolean; absent: boolean }> {
  const counts = Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;
  const results = await Promise.all(keys.map(async (k) => [k, await build(k)] as const));
  let degraded = false;
  let absent = false;
  for (const [k, r] of results) {
    const verdict = classify(label, r.error);
    if (verdict === "absent") absent = true;
    else if (verdict === "broken") degraded = true;
    else counts[k] = Number(r.count ?? 0);
  }
  return { counts, degraded, absent };
}

/**
 * How many assets sit in each lifecycle bucket, for the pill row.
 *
 * A filter pill that cannot say how much is behind it makes the operator click
 * every one to find out — and an Archived pill showing nothing is exactly how CC
 * concluded an archived video was "completely gone". The count is the difference
 * between a filter and a search.
 *
 * One COUNT per bucket through scopeToLifecycle(), the SAME predicate the grid
 * filters with, so a pill and the grid behind it cannot disagree. It used to
 * read every row of the tab and bucket them in JS, which was both a full read
 * per page view and a second definition of the buckets that had drifted.
 *
 * Studio's "N awaiting your verdict" is this call's needs_review on the OASIS
 * tab, the grid its link opens, so the number and the grid it promises agree.
 */
export async function getLifecycleCounts(
  tenantId: string,
  group: BrandGroupKey = DEFAULT_BRAND_GROUP,
  db: ReturnType<typeof getServiceSupabase> = getServiceSupabase(),
): Promise<{ counts: Record<Lifecycle, number>; degraded: boolean }> {
  const empty: Record<Lifecycle, number> = {
    needs_review: 0, approved: 0, live: 0, archived: 0,
  };
  if (!tenantId) return { counts: empty, degraded: false };
  try {
    const r = await headCounts("lifecycle", LIFECYCLE, (lifecycle) =>
      scopeToLifecycle(
        scopeToBrandGroup(
          db
            .from("marketing_asset")
            .select("id", { count: "exact", head: true })
            .eq("tenant_id", tenantId) as unknown as BrandFilterable,
          group,
        ),
        lifecycle,
      ) as unknown as HeadCount,
    );
    // Absent = pre-migration = genuinely empty, and quiet. Partial counts from a
    // broken read are kept but flagged, because a floor the operator knows is a
    // floor beats a blank pill row.
    if (r.absent) return { counts: empty, degraded: false };
    return { counts: r.counts, degraded: r.degraded };
  } catch {
    return { counts: empty, degraded: true };
  }
}

/**
 * How many assets each brand TAB shows when you click it: one COUNT per tab of
 * its default (All) grid, so archived and rejected assets are left out
 * (hideArchived; the Archived pill holds them). It used to count every status,
 * so the OASIS tab read 103 above an "All 100" grid.
 *
 * DELIBERATELY SPANS EVERY TAB, like getMarketingFacets: "Clients 4" has to read
 * before you click it. COUNTS ONLY, through scopeToBrandGroup, so the numbers
 * are exactly the rows each tab's grid shows.
 */
export async function getBrandTabCounts(
  tenantId: string,
  db: ReturnType<typeof getServiceSupabase> = getServiceSupabase(),
): Promise<{ counts: Record<BrandGroupKey, number>; degraded: boolean }> {
  const keys = BRAND_GROUPS.map((g) => g.key);
  const empty = Object.fromEntries(keys.map((k) => [k, 0])) as Record<BrandGroupKey, number>;
  if (!tenantId) return { counts: empty, degraded: false };
  try {
    const r = await headCounts("brand_tabs", keys, (group) =>
      scopeToBrandGroup(
        hideArchived(
          db
            .from("marketing_asset")
            .select("id", { count: "exact", head: true })
            .eq("tenant_id", tenantId),
        ) as unknown as BrandFilterable,
        group,
      ) as unknown as HeadCount,
    );
    if (r.absent) return { counts: empty, degraded: false };
    return { counts: r.counts, degraded: r.degraded };
  } catch {
    return { counts: empty, degraded: true };
  }
}

/**
 * The facet counts behind the brand tabs and the author filter.
 *
 * DELIBERATELY SPANS EVERY BRAND. This is the one reader that has to see across
 * the boundary, because a tab bar that cannot count the tabs you are not on is
 * useless — the Clients tab has to read "Clients 4" before you click it. It
 * returns COUNTS ONLY; no row content crosses a group here, and the readers that
 * return rows all go through scopeToBrandGroup.
 *
 * Brands and authors come from ONE pass over the same pages rather than two
 * queries, because they are two groupings of identical rows.
 *
 * `degraded` rather than a silent short count: these numbers sit on navigation,
 * and a tab reading "Clients 0" because page two timed out is the same
 * confident lie as "Nothing waiting on you" — it tells CC there is nothing
 * there, and he stops looking.
 *
 * The Library's tab counts now come from getBrandTabCounts (one COUNT per tab);
 * it still reads this for the brand sub-filter inside a tab and the author facet.
 */
export async function getMarketingFacets(tenantId: string): Promise<MarketingFacets> {
  if (!tenantId) return EMPTY_MARKETING_FACETS;
  try {
    const db = getServiceSupabase();
    const brands = new Map<string, BrandFacet>();
    const authors = new Map<string, number>();

    const outcome = await pageAll<{
      brand_slug: string;
      brand_name: string;
      author_email: string | null;
    }>(
      "facets",
      () =>
        db
          .from("marketing_asset")
          .select("brand_slug, brand_name, author_email")
          .eq("tenant_id", tenantId) as unknown as PagedQuery<{
          brand_slug: string;
          brand_name: string;
          author_email: string | null;
        }>,
      (rows) => {
      for (const row of rows) {
        if (row.brand_slug) {
          const prev = brands.get(row.brand_slug);
          if (prev) prev.count += 1;
          // Fall back to the slug rather than rendering an unnamed tab: a brand
          // with a blank brand_name still has to be reachable.
          else brands.set(row.brand_slug, {
            slug: row.brand_slug,
            name: row.brand_name || row.brand_slug,
            count: 1,
          });
        }
        if (row.author_email) {
          authors.set(row.author_email, (authors.get(row.author_email) || 0) + 1);
        }
      }
      },
    );
    // Pre-migration: the table genuinely is not there, and empty is honest.
    if (outcome === "absent") return EMPTY_MARKETING_FACETS;

    return {
      brands: [...brands.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
      authors: [...authors.entries()]
        .map(([email, count]) => ({ email, count }))
        .sort((a, b) => b.count - a.count || a.email.localeCompare(b.email)),
      degraded: outcome === "degraded",
    };
  } catch {
    // Never throw from a read path (the file convention), but do not claim the
    // library has no brands either — that would empty the tab bar.
    return { brands: [], authors: [], degraded: true };
  }
}

/* ─────────────────────────────────────────────────────────── corpus */

export type CorpusRow = {
  id: string;
  kind: string;
  label: string;
  title: string | null;
  source_url: string | null;
  state: string;
  last_error: string | null;
  contributed_by: string;
  created_at: string;
  indexed_at: string | null;
};

export type CorpusStats = {
  total: number;
  queued: number;
  extracting: number;
  indexed: number;
  failed: number;
  exemplars: number;
  counter_examples: number;
  /**
   * True when the read FAILED, as opposed to the corpus being empty: the
   * Training tab and the Content overview's Training card then say they could
   * not read it instead of "nothing yet". Same reason as MarketingSummary.degraded.
   */
  degraded: boolean;
};

export const EMPTY_CORPUS_STATS: CorpusStats = {
  total: 0, queued: 0, extracting: 0, indexed: 0, failed: 0,
  exemplars: 0, counter_examples: 0, degraded: false,
};

/**
 * Counts for the Training tab and the overview's Training card. Never throws;
 * pre-migration (no table) returns honest zeroes, any other failure is degraded.
 *
 * TENANT-SCOPED ONLY, ON PURPOSE — do not "fix" this to match the Library's
 * brand-scoped counts. marketing_corpus is what the marketing agent LEARNS
 * FROM, not what OASIS has shipped, and you learn from everything you have
 * made: a client ad that performed is training signal exactly like our own.
 * The brand boundary exists so the founders LIBRARY shows our own
 * deliverables; it is not a rule about training data. marketing_corpus.asset_id
 * IS nullable, so scoping it here would be perfectly possible — which is
 * exactly why this comment exists. Pinned by tests/marketing-core.test.ts (it
 * pinned the same read inside getMarketingSummary until 2026-10-01).
 *
 * `db` is injectable for tests only, as in getMarketingSummary.
 */
export async function getCorpusStats(
  tenantId: string,
  db: ReturnType<typeof getServiceSupabase> = getServiceSupabase(),
): Promise<CorpusStats> {
  if (!tenantId) return EMPTY_CORPUS_STATS;
  try {
    const r = await db.from("marketing_corpus").select("state, label").eq("tenant_id", tenantId);
    const verdict = classify("corpus.stats", r.error);
    if (verdict === "absent") return EMPTY_CORPUS_STATS;
    if (verdict === "broken") return { ...EMPTY_CORPUS_STATS, degraded: true };
    const rows = (r.data || []) as Array<{ state: string; label: string }>;
    return {
      total: rows.length,
      queued: rows.filter((x) => x.state === "queued").length,
      extracting: rows.filter((x) => x.state === "extracting").length,
      indexed: rows.filter((x) => x.state === "indexed").length,
      failed: rows.filter((x) => x.state === "failed").length,
      exemplars: rows.filter((x) => x.label === "exemplar").length,
      counter_examples: rows.filter((x) => x.label === "counter_example").length,
      degraded: false,
    };
  } catch (e) {
    console.warn("[marketing:corpus.stats] unexpected", e);
    return { ...EMPTY_CORPUS_STATS, degraded: true };
  }
}

/** The newest corpus links, and whether the read failed (a failed read is not an empty list). */
export type CorpusItems = { rows: CorpusRow[]; degraded: boolean };

/**
 * Most recent corpus items, newest first. Unlike the other list readers this
 * one says when it failed: the Training tab prints "Nothing in it yet" for an
 * empty list, so an empty list from a broken read would hide material that is
 * there (the counts read separately and can succeed while this one fails).
 */
export async function getCorpusItems(tenantId: string, limit = 40): Promise<CorpusItems> {
  if (!tenantId) return { rows: [], degraded: false };
  try {
    const db = getServiceSupabase();
    const r = await db
      .from("marketing_corpus")
      .select("id, kind, label, title, source_url, state, last_error, contributed_by, created_at, indexed_at")
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false })
      .limit(limit);
    const verdict = classify("corpus.items", r.error);
    if (verdict === "absent") return { rows: [], degraded: false };
    if (verdict === "broken") return { rows: [], degraded: true };
    return { rows: (r.data || []) as CorpusRow[], degraded: false };
  } catch (e) {
    console.warn("[marketing:corpus.items] unexpected", e);
    return { rows: [], degraded: true };
  }
}
