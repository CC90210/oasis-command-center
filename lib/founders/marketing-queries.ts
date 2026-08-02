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
import type { AssetFormat, AssetStatus, Channel, Track } from "@/lib/founders-marketing-core";

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

/** Headline counts for the Studio landing. */
export async function getMarketingSummary(tenantId: string): Promise<MarketingSummary> {
  if (!tenantId) return EMPTY_MARKETING_SUMMARY;
  const db = getServiceSupabase();
  try {
    const assets = await db
      .from("marketing_asset")
      .select("track, status")
      .eq("tenant_id", tenantId);
    if (assets.error) {
      if (quiet("summary.assets", assets.error)) return EMPTY_MARKETING_SUMMARY;
    }

    const rows = (assets.data || []) as Array<{ track: Track; status: string }>;
    const by_track: Record<Track, number> = { organic: 0, paid: 0, seo: 0, email: 0 };
    const by_status: Record<string, number> = {};
    for (const r of rows) {
      if (r.track in by_track) by_track[r.track] += 1;
      by_status[r.status] = (by_status[r.status] || 0) + 1;
    }

    const [reviews, requests, corpus] = await Promise.all([
      db
        .from("marketing_review")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", tenantId)
        .is("acted_on_at", null),
      db
        .from("marketing_request")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", tenantId)
        .in("status", ["open", "claimed"]),
      db.from("marketing_corpus").select("state").eq("tenant_id", tenantId),
    ]);

    const corpusRows = (corpus.data || []) as Array<{ state: string }>;
    return {
      total: rows.length,
      by_track,
      by_status,
      open_reviews: reviews.error ? 0 : reviews.count || 0,
      open_requests: requests.error ? 0 : requests.count || 0,
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
  opts: { track?: Track; channel?: Channel; status?: AssetStatus; limit?: number } = {},
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
