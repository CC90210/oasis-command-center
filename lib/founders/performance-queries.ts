import { getServiceSupabase } from "@/lib/supabase-server";

/**
 * Reads for the Performance tab.
 *
 * The numbers come from post_analytics, filled by
 * Business-Empire-Agent/scripts/sync_post_analytics.py polling Zernio. One row
 * per post PER PLATFORM — the same asset on six networks has six different sets
 * of numbers, and averaging them answers no question anyone asks.
 */

export type PerfRow = {
  platform_post_id: string;
  platform: string;
  account_username: string | null;
  asset_id: string | null;
  impressions: number;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  clicks: number;
  follows: number;
  engagement_rate: number;
  avg_watch_s: number | null;
  duration_s: number | null;
  content_excerpt: string | null;
  published_at: string | null;
  last_synced_at: string | null;
};

export type PerfSummary = {
  rows: PerfRow[];
  totals: {
    posts: number;
    views: number;
    impressions: number;
    likes: number;
    comments: number;
    shares: number;
    saves: number;
    follows: number;
  };
  byPlatform: Array<{ platform: string; posts: number; views: number; engagements: number }>;
  lastSynced: string | null;
  /**
   * True when the table is genuinely empty, as opposed to a read that failed.
   * "Nothing published yet" and "we could not find out" are different facts and
   * a dashboard that renders them identically is worse than one that errors.
   */
  degraded: boolean;
};

export const EMPTY_PERF: PerfSummary = {
  rows: [],
  totals: { posts: 0, views: 0, impressions: 0, likes: 0, comments: 0, shares: 0, saves: 0, follows: 0 },
  byPlatform: [],
  lastSynced: null,
  degraded: false,
};

/** Engagements a human would count as "someone did something". */
export function engagements(r: PerfRow): number {
  return (r.likes || 0) + (r.comments || 0) + (r.shares || 0) + (r.saves || 0);
}

/**
 * Retention, COMPUTED not stored.
 *
 * Zernio returns average watch time and video duration; retention is those two
 * divided. Storing the ratio would freeze a number whose inputs can change, so
 * it is derived here. Returns null when either input is missing — which is most
 * posts, because only Instagram Reels report watch time.
 */
export function retention(r: PerfRow): number | null {
  if (!r.avg_watch_s || !r.duration_s || r.duration_s <= 0) return null;
  return Math.min(r.avg_watch_s / r.duration_s, 1);
}

export async function getPerformance(tenantId: string, days = 30): Promise<PerfSummary> {
  if (!tenantId) return EMPTY_PERF;
  const db = getServiceSupabase();

  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const r = await db
    .from("post_analytics")
    .select("*")
    .eq("tenant_id", tenantId)
    .gte("published_at", since)
    .order("published_at", { ascending: false })
    .limit(500);

  if (r.error) {
    // A missing table is pre-migration and genuinely empty; anything else is a
    // failure and must not render as "no data yet".
    const missing = /no such table|does not exist|42P01/i.test(r.error.message || "");
    if (!missing) console.warn("[founders:performance]", r.error.message);
    return { ...EMPTY_PERF, degraded: !missing };
  }

  const rows = (r.data || []) as PerfRow[];
  const totals = rows.reduce(
    (acc, x) => ({
      posts: acc.posts + 1,
      views: acc.views + (x.views || 0),
      impressions: acc.impressions + (x.impressions || 0),
      likes: acc.likes + (x.likes || 0),
      comments: acc.comments + (x.comments || 0),
      shares: acc.shares + (x.shares || 0),
      saves: acc.saves + (x.saves || 0),
      follows: acc.follows + (x.follows || 0),
    }),
    { ...EMPTY_PERF.totals },
  );

  const byMap = new Map<string, { platform: string; posts: number; views: number; engagements: number }>();
  for (const x of rows) {
    const cur = byMap.get(x.platform) || { platform: x.platform, posts: 0, views: 0, engagements: 0 };
    cur.posts += 1;
    cur.views += x.views || 0;
    cur.engagements += engagements(x);
    byMap.set(x.platform, cur);
  }

  const lastSynced = rows.reduce<string | null>(
    (max, x) => (x.last_synced_at && (!max || x.last_synced_at > max) ? x.last_synced_at : max),
    null,
  );

  return {
    rows,
    totals,
    byPlatform: [...byMap.values()].sort((a, b) => b.views - a.views),
    lastSynced,
    degraded: false,
  };
}
