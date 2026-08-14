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
  FOUNDERS_OWN_BRAND,
  type AssetFormat,
  type AssetStatus,
  type Channel,
  type Track,
} from "@/lib/founders-marketing-core";

/**
 * Founders readers show OASIS's OWN work by default. `scope: "all"` is the
 * explicit opt-out for a future client-deliverables surface; nothing in the
 * founders portal passes it today. Scoping here rather than in each page means
 * a new founders page cannot forget and re-introduce the mix.
 */
export type BrandScope = "own" | "all";

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
};

export const EMPTY_MARKETING_SUMMARY: MarketingSummary = {
  total: 0,
  by_track: { organic: 0, paid: 0, seo: 0, email: 0 },
  by_status: {},
  open_reviews: 0,
  open_requests: 0,
  corpus_indexed: 0,
  corpus_pending: 0,
};

function quiet(label: string, err: { code?: string; message?: string } | null): boolean {
  if (!err) return false;
  if (isMissingTableError(err)) return true; // pre-migration, not an incident
  console.warn(`[marketing:${label}]`, err.message);
  return true;
}

/**
 * One page of own-brand assets. Matches Supabase's default PostgREST `max-rows`
 * so the implicit cap becomes an explicit, testable one that both backends share.
 */
const SUMMARY_ASSET_CAP = 1000;

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
    const assets = await db
      .from("marketing_asset")
      // `id` is selected so the review/request counts below can be scoped to the
      // SAME set of assets this count describes. Without it those counts silently
      // spanned every brand on the tenant.
      .select("id, track, status")
      .eq("tenant_id", tenantId)
      .eq("brand_slug", FOUNDERS_OWN_BRAND)
      // Explicit, so the two backends agree. PostgREST applies its own `max-rows`
      // (1,000 on Supabase) and returns the truncated page WITHOUT an error; the
      // Turso bridge applies no cap at all. Left implicit, the same tenant would
      // produce different numbers on different backends, and the Supabase one
      // would be wrong without saying so.
      .limit(SUMMARY_ASSET_CAP);
    if (assets.error) {
      if (quiet("summary.assets", assets.error)) return EMPTY_MARKETING_SUMMARY;
    }

    const rows = (assets.data || []) as Array<{ id: string; track: Track; status: string }>;
    const ownAssetIds = rows.map((r) => r.id);

    // Truncation here does not just undercount `total` — ownAssetIds is the
    // allowlist the review and request counts are scoped by, so a silent short
    // read would quietly drop real work from "waiting on you". Fail loud instead:
    // the founders library is OASIS's own output and is nowhere near this, so if
    // this ever fires the reader needs pagination, not a bigger number.
    if (rows.length >= SUMMARY_ASSET_CAP) {
      console.warn(
        `[marketing:summary] own-brand assets hit the ${SUMMARY_ASSET_CAP}-row cap for ` +
          `tenant ${tenantId}. total, open_reviews and open_requests are now UNDERCOUNTS — ` +
          `paginate this read before trusting them.`,
      );
    }
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
    const scopedReviews =
      ownAssetIds.length > 0
        ? db
            .from("marketing_review")
            .select("id", { count: "exact", head: true })
            .eq("tenant_id", tenantId)
            .is("acted_on_at", null)
            .in("asset_id", ownAssetIds)
        : Promise.resolve({ error: null, count: 0 } as const);

    // marketing_request.asset_id IS nullable — "a request not tied to an asset"
    // is the intended case (see the MATCH SIMPLE note on marketing_request_asset_fk).
    // An unbound request was typed into THIS portal and names no client asset, so
    // it belongs to the founders' own queue and is counted. Bound requests follow
    // their asset's brand. Two counts rather than one `.or()` because the bridge's
    // `.or()` support is not something this reader should depend on.
    const scopedRequestsBound =
      ownAssetIds.length > 0
        ? db
            .from("marketing_request")
            .select("id", { count: "exact", head: true })
            .eq("tenant_id", tenantId)
            .in("status", ["open", "claimed"])
            .in("asset_id", ownAssetIds)
        : Promise.resolve({ error: null, count: 0 } as const);

    const [reviews, requestsBound, requestsUnbound, corpus] = await Promise.all([
      scopedReviews,
      scopedRequestsBound,
      db
        .from("marketing_request")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", tenantId)
        .in("status", ["open", "claimed"])
        .is("asset_id", null),
      db.from("marketing_corpus").select("state").eq("tenant_id", tenantId),
    ]);

    const corpusRows = (corpus.data || []) as Array<{ state: string }>;
    return {
      total: rows.length,
      by_track,
      by_status,
      open_reviews: reviews.error ? 0 : reviews.count || 0,
      open_requests:
        (requestsBound.error ? 0 : requestsBound.count || 0) +
        (requestsUnbound.error ? 0 : requestsUnbound.count || 0),
      corpus_indexed: corpusRows.filter((c) => c.state === "indexed").length,
      corpus_pending: corpusRows.filter((c) => c.state === "queued" || c.state === "extracting")
        .length,
    };
  } catch (e) {
    console.warn("[marketing:summary] unexpected", e);
    return EMPTY_MARKETING_SUMMARY;
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
    brand?: string;
    limit?: number;
    scope?: BrandScope;
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
    // Own-work-only unless a caller deliberately widens the scope. A `brand`
    // filter is only honoured inside the wider scope — otherwise a crafted
    // ?brand=warner query string would walk straight past the boundary.
    if (opts.scope === "all") {
      if (opts.brand) q = q.eq("brand_slug", opts.brand);
    } else {
      q = q.eq("brand_slug", FOUNDERS_OWN_BRAND);
    }

    const r = await q;
    if (r.error) {
      quiet("assets", r.error);
      return [];
    }
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
    console.warn("[marketing:assets] unexpected", e);
    return [];
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

export const mediaKey = (bucket: string, path: string) => `${bucket}\n${path}`;

/** Brand choices for the library filter, deduped from tenant-scoped assets. */
export async function getMarketingBrands(
  tenantId: string,
  scope: BrandScope = "own",
): Promise<Array<{ slug: string; name: string }>> {
  if (!tenantId) return [];
  try {
    const db = getServiceSupabase();
    const unique = new Map<string, string>();
    const pageSize = 1000;
    for (let from = 0; ; from += pageSize) {
      let bq = db
        .from("marketing_asset")
        .select("brand_slug, brand_name")
        .eq("tenant_id", tenantId);
      if (scope !== "all") bq = bq.eq("brand_slug", FOUNDERS_OWN_BRAND);
      const r = await bq.order("brand_name").range(from, from + pageSize - 1);
      if (r.error) return [];
      const rows = (r.data || []) as Array<{ brand_slug: string; brand_name: string }>;
      for (const row of rows) {
        if (row.brand_slug && !unique.has(row.brand_slug)) unique.set(row.brand_slug, row.brand_name);
      }
      if (rows.length < pageSize) break;
    }
    return [...unique].map(([slug, name]) => ({ slug, name }));
  } catch {
    return [];
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
