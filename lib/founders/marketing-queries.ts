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
  DEFAULT_BRAND_GROUP,
  FOUNDERS_OWN_BRAND,
  brandFilterAllowed,
  brandGroup,
  claimedBrandSlugs,
  type AssetFormat,
  type AssetStatus,
  type BrandGroupKey,
  type Channel,
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
  open_requests: number;
  corpus_indexed: number;
  corpus_pending: number;
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
  open_requests: 0,
  corpus_indexed: 0,
  corpus_pending: 0,
  degraded: true,
};

export const EMPTY_MARKETING_SUMMARY: MarketingSummary = {
  total: 0,
  by_track: { organic: 0, paid: 0, seo: 0, email: 0 },
  by_status: {},
  open_reviews: 0,
  open_requests: 0,
  corpus_indexed: 0,
  corpus_pending: 0,
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
 * The LIST readers (assets, media, corpus rows) return [] on any error, so
 * "absent" and "broken" are the same decision to them: stop. They keep this
 * shim rather than being rewritten — only getMarketingSummary renders COUNTS,
 * and only a count can lie by saying zero.
 */
function quiet(label: string, err: { code?: string; message?: string } | null): boolean {
  return classify(label, err) !== "ok";
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
    // `id` is selected so the review and request counts below can be scoped to
    // the SAME assets this count describes; without it they silently spanned
    // every brand on the tenant. Paged, because a short read here would not just
    // undercount `total` — ownAssetIds is the allowlist those counts use, so it
    // would quietly drop real work from "waiting on you" too.
    let degraded = false;
    const rows: Array<{ id: string; track: Track; status: string }> = [];
    for (let from = 0; ; from += PAGE_SIZE) {
      const page = await db
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
        .eq("brand_slug", FOUNDERS_OWN_BRAND)
        // ORDER BEFORE RANGE, always. `.range()` on an unordered query has no
        // stable row order, so page 2 can repeat or skip rows from page 1 — the
        // count would then be wrong in either direction, and ownAssetIds (the
        // allowlist for the review/request counts) wrong with it. `id` because it
        // is the primary key: unique, so the ordering is total, with no ties to
        // break. getMarketingBrands below does the same thing with .order() —
        // I copied its paging loop and dropped this line, which CodeRabbit caught.
        .order("id", { ascending: true })
        .range(from, from + PAGE_SIZE - 1);
      const verdict = classify("summary.assets", page.error);
      // Absent table = pre-migration = genuinely empty, and quiet.
      if (verdict === "absent") return EMPTY_MARKETING_SUMMARY;
      // Broken mid-page: keep the pages we DID get so the screen is not blanked,
      // but mark the whole summary degraded — the counts below are scoped by
      // these ids, so a short read makes every one of them an undercount.
      if (verdict === "broken") {
        degraded = true;
        break;
      }
      const got = (page.data || []) as Array<{ id: string; track: Track; status: string }>;
      rows.push(...got);
      if (got.length < PAGE_SIZE) break;
    }

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

    let requestsBound = 0;
    for (const ids of chunk(ownAssetIds, ID_CHUNK)) {
      const r = await db
        .from("marketing_request")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", tenantId)
        .in("status", ["open", "claimed"])
        .in("asset_id", ids);
      const verdict = classify("summary.requests", r.error);
      if (verdict !== "ok") {
        if (verdict === "broken") degraded = true;
        break;
      }
      requestsBound += r.count || 0;
    }

    // marketing_request.asset_id IS nullable — "a request not tied to an asset"
    // is the intended case (see the MATCH SIMPLE note on marketing_request_asset_fk).
    // An unbound request was typed into THIS portal and names no client asset, so
    // it belongs to the founders' own queue and is counted. Bound requests follow
    // their asset's brand. Two counts rather than one `.or()` because the bridge's
    // `.or()` support is not something this reader should depend on.
    const [requestsUnbound, corpus] = await Promise.all([
      db
        .from("marketing_request")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", tenantId)
        .in("status", ["open", "claimed"])
        .is("asset_id", null),
      // TENANT-SCOPED ONLY, ON PURPOSE — do not "fix" this to match the two
      // counts above. marketing_corpus is what Maven LEARNS FROM, not what OASIS
      // has shipped, and you learn from everything you have made: a client ad
      // that performed is training signal exactly like our own. The brand
      // boundary exists so the founders LIBRARY shows our own deliverables; it is
      // not a rule about training data. marketing_corpus.asset_id IS nullable, so
      // scoping it here would be perfectly possible — which is exactly why this
      // comment exists. Pinned by tests/marketing-core.test.ts.
      db.from("marketing_corpus").select("state").eq("tenant_id", tenantId),
    ]);

    if (classify("summary.requests.unbound", requestsUnbound.error) === "broken") degraded = true;
    if (classify("summary.corpus", corpus.error) === "broken") degraded = true;

    const corpusRows = (corpus.data || []) as Array<{ state: string }>;
    return {
      total: rows.length,
      by_track,
      by_status,
      open_reviews: openReviews,
      open_requests: requestsBound + (requestsUnbound.count || 0),
      corpus_indexed: corpusRows.filter((c) => c.state === "indexed").length,
      corpus_pending: corpusRows.filter((c) => c.state === "queued" || c.state === "extracting")
        .length,
      degraded,
    };
  } catch (e) {
    console.warn("[marketing:summary] unexpected", e);
    return DEGRADED_MARKETING_SUMMARY;
  }
}

/**
 * Library rows. Media is fetched in ONE follow-up query and grouped in JS rather
 * than per-asset, so a 200-item library is 2 round trips, not 201.
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
    limit?: number;
  } = {},
): Promise<MarketingAssetRow[]> {
  if (!tenantId) return [];
  const db = getServiceSupabase();
  try {
    let q = db
      .from("marketing_asset")
      .select("*")
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false })
      .limit(opts.limit ?? 200);
    if (opts.track) q = q.eq("track", opts.track);
    if (opts.channel) q = q.eq("channel", opts.channel);
    if (opts.status) q = q.eq("status", opts.status);
    if (opts.author) q = q.eq("author_email", opts.author);

    // The brand boundary. The tab is ALWAYS applied — there is no code path
    // through this reader that returns rows from more than one tab, which is
    // why the group filter is unconditional and the sub-filter is not.
    const group = opts.group ?? DEFAULT_BRAND_GROUP;
    q = scopeToBrandGroup(q, group);
    // A sub-filter NARROWS the tab and may never widen it. `?brand=warner` on
    // the OASIS tab is dropped rather than honoured — see brandFilterAllowed.
    if (opts.brand && brandFilterAllowed(opts.brand, group)) {
      q = q.eq("brand_slug", opts.brand);
    }

    const r = await q;
    // Absent (pre-migration) is an honest empty library. Broken is NOT: returning
    // [] there makes the page say "The library is empty" about a library that is
    // full, and the caller cannot tell the difference from a shape that is just
    // an array. Throwing is how this reader says "I could not find out" — the
    // caller passes null as its safe() fallback and renders that distinctly.
    const verdict = classify("assets", r.error);
    if (verdict === "absent") return [];
    if (verdict === "broken") throw new Error(`marketing_asset read failed: ${r.error?.message}`);
    const assets = (r.data || []) as MarketingAssetRow[];
    if (!assets.length) return [];

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
    return assets;
  } catch (e) {
    // Deliberately NOT caught into []: the caller distinguishes "empty" from
    // "could not load" by whether this resolves at all. See the throw above.
    console.warn("[marketing:assets] unexpected", e);
    throw e;
  }
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
 */
export async function getMarketingFacets(tenantId: string): Promise<MarketingFacets> {
  if (!tenantId) return EMPTY_MARKETING_FACETS;
  try {
    const db = getServiceSupabase();
    const brands = new Map<string, BrandFacet>();
    const authors = new Map<string, number>();
    let degraded = false;

    for (let from = 0; ; from += PAGE_SIZE) {
      const r = await db
        .from("marketing_asset")
        .select("brand_slug, brand_name, author_email")
        .eq("tenant_id", tenantId)
        // ORDER BEFORE RANGE. `.range()` on an unordered query has no stable row
        // order, so page 2 can repeat or skip rows from page 1 — and every number
        // here would then be wrong in an unpredictable direction. `id` is the
        // primary key: unique, so the ordering is total with no ties to break.
        // The old version ordered by `brand_name`, which is NOT unique — 43 rows
        // share one value, so its page boundary was arbitrary.
        .order("id", { ascending: true })
        .range(from, from + PAGE_SIZE - 1);
      const verdict = classify("facets", r.error);
      // Pre-migration: the table genuinely is not there, and empty is honest.
      if (verdict === "absent") return EMPTY_MARKETING_FACETS;
      if (verdict === "broken") {
        degraded = true;
        break;
      }
      const rows = (r.data || []) as Array<{
        brand_slug: string;
        brand_name: string;
        author_email: string | null;
      }>;
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
      if (rows.length < PAGE_SIZE) break;
    }

    return {
      brands: [...brands.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
      authors: [...authors.entries()]
        .map(([email, count]) => ({ email, count }))
        .sort((a, b) => b.count - a.count || a.email.localeCompare(b.email)),
      degraded,
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
};

export const EMPTY_CORPUS_STATS: CorpusStats = {
  total: 0, queued: 0, extracting: 0, indexed: 0, failed: 0,
  exemplars: 0, counter_examples: 0,
};

/** Counts for the Train screen. Never throws; pre-migration returns zeroes. */
export async function getCorpusStats(tenantId: string): Promise<CorpusStats> {
  if (!tenantId) return EMPTY_CORPUS_STATS;
  try {
    const db = getServiceSupabase();
    const r = await db.from("marketing_corpus").select("state, label").eq("tenant_id", tenantId);
    if (r.error) {
      quiet("corpus.stats", r.error);
      return EMPTY_CORPUS_STATS;
    }
    const rows = (r.data || []) as Array<{ state: string; label: string }>;
    return {
      total: rows.length,
      queued: rows.filter((x) => x.state === "queued").length,
      extracting: rows.filter((x) => x.state === "extracting").length,
      indexed: rows.filter((x) => x.state === "indexed").length,
      failed: rows.filter((x) => x.state === "failed").length,
      exemplars: rows.filter((x) => x.label === "exemplar").length,
      counter_examples: rows.filter((x) => x.label === "counter_example").length,
    };
  } catch (e) {
    console.warn("[marketing:corpus.stats] unexpected", e);
    return EMPTY_CORPUS_STATS;
  }
}

/** Most recent corpus items, newest first. */
export async function getCorpusItems(tenantId: string, limit = 40): Promise<CorpusRow[]> {
  if (!tenantId) return [];
  try {
    const db = getServiceSupabase();
    const r = await db
      .from("marketing_corpus")
      .select("id, kind, label, title, source_url, state, last_error, contributed_by, created_at, indexed_at")
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (r.error) {
      quiet("corpus.items", r.error);
      return [];
    }
    return (r.data || []) as CorpusRow[];
  } catch (e) {
    console.warn("[marketing:corpus.items] unexpected", e);
    return [];
  }
}
