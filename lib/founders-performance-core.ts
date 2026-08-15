/**
 * The Performance tab's arithmetic, with no server imports.
 *
 * Same split as lib/founders-marketing-core.ts and for the same reason: the
 * interesting behaviour here is what happens when a read FAILS or returns more
 * than we asked for, and a guard whose failure path has never been executed is
 * a guess. Keeping this pure lets the tests drive every one of those paths with
 * no DB, no env, and no native dependency dragged into the bundle.
 *
 * The numbers themselves come from post_analytics, filled by
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
   * True when the read FAILED, as opposed to the table being empty. "Nothing
   * published yet" and "we could not find out" are different facts and a
   * dashboard that renders them identically is worse than one that errors.
   */
  degraded: boolean;
  /**
   * True when there are more rows in the window than we read. The totals are
   * then a partial sum, and the page says so rather than calling them totals.
   */
  truncated: boolean;
};

/** How many rows one page will sum. */
export const ROW_CAP = 500;

export const EMPTY_PERF: PerfSummary = {
  rows: [],
  totals: { posts: 0, views: 0, impressions: 0, likes: 0, comments: 0, shares: 0, saves: 0, follows: 0 },
  byPlatform: [],
  lastSynced: null,
  degraded: false,
  truncated: false,
};

/**
 * Coerce a column to a number.
 *
 * These arrive from SQLite through a PostgREST-compatible shim, and a REAL or
 * INTEGER can come back as a STRING. `acc.views + x.views` then CONCATENATES:
 * 0 + "100" is "0100", and the operator sees a nine-digit view count that is
 * pure nonsense. Same hazard already guarded in retention() with Number(); the
 * totals were missed, and a render test caught it.
 *
 * NaN and Infinity collapse to 0 — a bad cell must not poison the whole sum.
 */
function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Engagements a human would count as "someone did something". */
export function engagements(r: PerfRow): number {
  return num(r.likes) + num(r.comments) + num(r.shares) + num(r.saves);
}

/**
 * Retention, COMPUTED not stored.
 *
 * Zernio returns average watch time and video duration; retention is those two
 * divided. Storing the ratio would freeze a number whose inputs can change, so
 * it is derived here. Returns null when either input is missing — which is most
 * posts, because only Instagram Reels report watch time.
 *
 * Every input is checked, because it arrives from a third-party API through a
 * SQLite column and can be absent, negative, or a string. A truthiness check
 * was wrong twice over: it treated a genuine 0s watch time as "not reported",
 * and it let a negative through to render as "-10% watched".
 */
export function retention(r: PerfRow): number | null {
  if (r.avg_watch_s === null || r.avg_watch_s === undefined) return null;
  if (r.duration_s === null || r.duration_s === undefined) return null;
  const watch = Number(r.avg_watch_s);
  const dur = Number(r.duration_s);
  if (!Number.isFinite(watch) || !Number.isFinite(dur)) return null;
  if (watch < 0 || dur <= 0) return null;
  return Math.min(watch / dur, 1);
}

/**
 * Turns a raw read into what the page renders.
 *
 * Takes the result shape rather than the client so the failure paths are
 * reachable from a test. `data` may hold up to ROW_CAP + 1 rows — the extra one
 * is how we tell "this is all of it" from "this is the first 500 of more".
 */
export function summarize(result: { data?: unknown[] | null; error?: { message?: string } | null }): PerfSummary {
  if (result.error) {
    // EVERY read failure is degraded, including "no such table".
    //
    // The first cut exempted a missing table on the reasoning that it meant
    // pre-migration and therefore genuinely empty. The migration is applied.
    // From here on that error means the table went away — a far louder problem
    // than an empty dashboard, and it must never render as the calm "nothing
    // published yet" state.
    return { ...EMPTY_PERF, degraded: true };
  }

  const all = (result.data || []) as PerfRow[];
  // A capped sum presented as a total is a fabricated number.
  const truncated = all.length > ROW_CAP;
  const rows = truncated ? all.slice(0, ROW_CAP) : all;

  const totals = rows.reduce(
    (acc, x) => ({
      posts: acc.posts + 1,
      views: acc.views + num(x.views),
      impressions: acc.impressions + num(x.impressions),
      likes: acc.likes + num(x.likes),
      comments: acc.comments + num(x.comments),
      shares: acc.shares + num(x.shares),
      saves: acc.saves + num(x.saves),
      follows: acc.follows + num(x.follows),
    }),
    { ...EMPTY_PERF.totals },
  );

  const byMap = new Map<string, { platform: string; posts: number; views: number; engagements: number }>();
  for (const x of rows) {
    const cur = byMap.get(x.platform) || { platform: x.platform, posts: 0, views: 0, engagements: 0 };
    cur.posts += 1;
    cur.views += num(x.views);
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
    truncated,
  };
}
