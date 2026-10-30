import type { Client, InStatement, Row } from "@libsql/client";
import { OASIS_OPERATOR_TENANT_ID, type EnvLike } from "@/lib/cloud-jobs/control";

const ZERNIO_BASE = "https://zernio.com/api";
const PAGE_LIMIT = 100;
const MAX_PAGES = 100;
const DB_READ_LIMIT = 20_000;

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type ZernioPayload = Record<string, unknown> & {
  posts?: unknown[];
  data?: unknown[];
  pagination?: Record<string, unknown>;
  overview?: Record<string, unknown>;
  hasAnalyticsAccess?: boolean;
};

export type PostAnalyticsRow = {
  has_metrics: boolean;
  tenant_id: string;
  zernio_post_id: string;
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
  content_excerpt: string;
  published_at: string | null;
  last_synced_at: string;
  measured_at: string | null;
};

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function integer(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function zernioPostIdentity(value: unknown): string | null {
  const post = object(value);
  for (const candidate of [post._id, post.latePostId]) {
    if (typeof candidate !== "string" && typeof candidate !== "number") continue;
    const identity = String(candidate).trim();
    if (identity) return identity;
  }
  return null;
}

function assertAnalyticsAccess(payload: ZernioPayload): void {
  if (payload.hasAnalyticsAccess === false) {
    throw new Error("zernio_analytics_access_denied");
  }
}

async function fetchZernioPage(path: string, key: string, fetchImpl: FetchLike): Promise<ZernioPayload> {
  const response = await fetchImpl(`${ZERNIO_BASE}${path}`, {
    method: "GET",
    headers: { authorization: `Bearer ${key}`, accept: "application/json" },
    signal: AbortSignal.timeout(90_000),
  });
  if (!response.ok) {
    const body = (await response.text().catch(() => "")).slice(0, 300);
    throw new Error(`zernio_http_${response.status}:${body}`);
  }
  const payload = (await response.json()) as unknown;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("zernio_payload_invalid");
  }
  return payload as ZernioPayload;
}

export async function fetchAllZernioAnalytics(key: string, fetchImpl: FetchLike = fetch): Promise<ZernioPayload> {
  if (!key.trim()) throw new Error("late_api_key_missing");
  const first = await fetchZernioPage(`/v1/analytics?limit=${PAGE_LIMIT}`, key, fetchImpl);
  assertAnalyticsAccess(first);
  const pagination = object(first.pagination);
  const pages = Math.max(1, integer(pagination.pages) || 1);
  if (pages > MAX_PAGES) throw new Error(`zernio_page_count_invalid:${pages}`);
  const firstPosts = list(first.posts);
  const posts = [...(firstPosts.length ? firstPosts : list(first.data))];
  const seenPostIdentities = new Set<string>();
  if (pages > 1 && !posts.length) throw new Error(`zernio_page_empty:1/${pages}`);
  for (const post of posts) {
    const identity = zernioPostIdentity(post);
    if (!identity) throw new Error("zernio_post_identity_missing:1");
    if (seenPostIdentities.has(identity)) {
      throw new Error(`zernio_post_duplicate:1:${identity}`);
    }
    seenPostIdentities.add(identity);
  }
  for (let page = 2; page <= pages; page += 1) {
    const next = await fetchZernioPage(`/v1/analytics?limit=${PAGE_LIMIT}&page=${page}`, key, fetchImpl);
    assertAnalyticsAccess(next);
    const got = list(next.posts).length ? list(next.posts) : list(next.data);
    if (!got.length) throw new Error(`zernio_page_empty:${page}/${pages}`);
    for (const post of got) {
      const identity = zernioPostIdentity(post);
      if (!identity) throw new Error(`zernio_post_identity_missing:${page}`);
      if (seenPostIdentities.has(identity)) {
        throw new Error(`zernio_post_duplicate:${page}:${identity}`);
      }
      seenPostIdentities.add(identity);
    }
    posts.push(...got);
  }
  const total = integer(pagination.total) || posts.length;
  if (posts.length < total) throw new Error(`zernio_incomplete:${posts.length}/${total}`);
  return { ...first, posts };
}

export function rowsFromZernio(
  payload: ZernioPayload,
  assetByExternal: ReadonlyMap<string, string>,
  now: () => Date = () => new Date(),
): { rows: PostAnalyticsRow[]; skipped_no_platform_id: number } {
  const rows: PostAnalyticsRow[] = [];
  let skippedNoPlatformId = 0;
  for (const rawPost of list(payload.posts)) {
    const post = object(rawPost);
    const zernioId = String(post._id ?? post.latePostId ?? "");
    const alternate = String(post.latePostId ?? "");
    const excerpt = String(post.content ?? "").slice(0, 280);
    const publishedRaw = post.publishedAt ?? post.scheduledFor;
    const published = typeof publishedRaw === "string" && publishedRaw ? publishedRaw : null;
    const postAnalytics = object(post.analytics);
    for (const rawEntry of list(post.platforms)) {
      const entry = object(rawEntry);
      const platformPostId = String(entry.platformPostId ?? "");
      if (!platformPostId) {
        skippedNoPlatformId += 1;
        continue;
      }
      const entryAnalytics = object(entry.analytics);
      const metrics = Object.keys(entryAnalytics).length ? entryAnalytics : postAnalytics;
      const hasMetrics = Object.keys(metrics).length > 0;
      const stampedAt = now().toISOString();
      rows.push({
        has_metrics: hasMetrics,
        tenant_id: OASIS_OPERATOR_TENANT_ID,
        zernio_post_id: zernioId,
        platform_post_id: platformPostId,
        platform: String(entry.platform ?? "unknown"),
        account_username: typeof entry.accountUsername === "string" ? entry.accountUsername : null,
        asset_id:
          assetByExternal.get(zernioId) ??
          assetByExternal.get(alternate) ??
          assetByExternal.get(platformPostId) ??
          null,
        impressions: integer(metrics.impressions),
        views: integer(metrics.views),
        likes: integer(metrics.likes),
        comments: integer(metrics.comments),
        shares: integer(metrics.shares),
        saves: integer(metrics.saves),
        clicks: integer(metrics.clicks),
        follows: integer(metrics.follows),
        engagement_rate: numberOrNull(metrics.engagementRate) ?? 0,
        avg_watch_s: numberOrNull(metrics.igReelsAvgWatchTime),
        duration_s: numberOrNull(metrics.videoDurationSeconds),
        content_excerpt: excerpt,
        published_at: published,
        last_synced_at: stampedAt,
        measured_at: hasMetrics ? stampedAt : null,
      });
    }
  }
  return { rows, skipped_no_platform_id: skippedNoPlatformId };
}

function assetExternalMap(rows: Row[]): Map<string, string> {
  const result = new Map<string, string>();
  for (const row of rows) {
    if (typeof row.external_id === "string" && row.external_id) {
      result.set(row.external_id, String(row.id));
    }
  }
  return result;
}

function syncStatement(row: PostAnalyticsRow): InStatement {
  const metricFlag = row.has_metrics ? 1 : 0;
  return {
    sql: `INSERT INTO post_analytics
            (tenant_id, zernio_post_id, platform_post_id, platform, account_username, asset_id,
             impressions, views, likes, comments, shares, saves, clicks, follows, engagement_rate,
             avg_watch_s, duration_s, content_excerpt, published_at, last_synced_at, measured_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(tenant_id, platform_post_id) DO UPDATE SET
            zernio_post_id = excluded.zernio_post_id,
            platform = excluded.platform,
            account_username = excluded.account_username,
            asset_id = COALESCE(excluded.asset_id, post_analytics.asset_id),
            impressions = CASE WHEN ? = 1 THEN excluded.impressions ELSE post_analytics.impressions END,
            views = CASE WHEN ? = 1 THEN excluded.views ELSE post_analytics.views END,
            likes = CASE WHEN ? = 1 THEN excluded.likes ELSE post_analytics.likes END,
            comments = CASE WHEN ? = 1 THEN excluded.comments ELSE post_analytics.comments END,
            shares = CASE WHEN ? = 1 THEN excluded.shares ELSE post_analytics.shares END,
            saves = CASE WHEN ? = 1 THEN excluded.saves ELSE post_analytics.saves END,
            clicks = CASE WHEN ? = 1 THEN excluded.clicks ELSE post_analytics.clicks END,
            follows = CASE WHEN ? = 1 THEN excluded.follows ELSE post_analytics.follows END,
            engagement_rate = CASE WHEN ? = 1 THEN excluded.engagement_rate ELSE post_analytics.engagement_rate END,
            avg_watch_s = CASE WHEN ? = 1 THEN excluded.avg_watch_s ELSE post_analytics.avg_watch_s END,
            duration_s = CASE WHEN ? = 1 THEN excluded.duration_s ELSE post_analytics.duration_s END,
            measured_at = CASE WHEN ? = 1 THEN excluded.measured_at ELSE post_analytics.measured_at END,
            content_excerpt = excluded.content_excerpt,
            published_at = excluded.published_at,
            last_synced_at = excluded.last_synced_at
          WHERE post_analytics.platform = excluded.platform`,
    args: [
      row.tenant_id,
      row.zernio_post_id,
      row.platform_post_id,
      row.platform,
      row.account_username,
      row.asset_id,
      row.impressions,
      row.views,
      row.likes,
      row.comments,
      row.shares,
      row.saves,
      row.clicks,
      row.follows,
      row.engagement_rate,
      row.avg_watch_s,
      row.duration_s,
      row.content_excerpt,
      row.published_at,
      row.last_synced_at,
      row.measured_at,
      ...Array(12).fill(metricFlag),
    ],
  };
}

export async function runPostAnalyticsSync(input: {
  db: Pick<Client, "execute" | "batch">;
  dryRun: boolean;
  env?: EnvLike;
  fetchImpl?: FetchLike;
  now?: () => Date;
}): Promise<{
  ok: boolean;
  dry_run: boolean;
  dry_run_scope: "database_and_provider_read_only" | "live";
  rows: number;
  matched_assets: number;
  with_metrics: number;
  skipped_no_platform_id: number;
  kept_existing_metrics: number;
  wrote: number;
}> {
  const env = input.env ?? process.env;
  const key = env.LATE_API_KEY?.trim();
  if (!key) throw new Error("late_api_key_missing");
  const [assets, existing, payload] = await Promise.all([
    input.db.execute({
      sql: "SELECT id, external_id FROM marketing_asset WHERE tenant_id = ? LIMIT ?",
      args: [OASIS_OPERATOR_TENANT_ID, DB_READ_LIMIT + 1],
    }),
    input.db.execute({
      sql: "SELECT platform_post_id, platform FROM post_analytics WHERE tenant_id = ? LIMIT ?",
      args: [OASIS_OPERATOR_TENANT_ID, DB_READ_LIMIT + 1],
    }),
    fetchAllZernioAnalytics(key, input.fetchImpl ?? fetch),
  ]);
  assertAnalyticsAccess(payload);
  if (assets.rows.length > DB_READ_LIMIT || existing.rows.length > DB_READ_LIMIT) {
    throw new Error("post_analytics_read_limit_exceeded");
  }
  const transformed = rowsFromZernio(payload, assetExternalMap(assets.rows), input.now);
  const existingPlatforms = new Map(
    existing.rows.map((row) => [String(row.platform_post_id), String(row.platform)]),
  );
  const payloadPlatforms = new Map<string, string>();
  for (const row of transformed.rows) {
    const previous = existingPlatforms.get(row.platform_post_id) ?? payloadPlatforms.get(row.platform_post_id);
    if (previous && previous !== row.platform) {
      throw new Error(`post_analytics_platform_collision:${row.platform_post_id}`);
    }
    payloadPlatforms.set(row.platform_post_id, row.platform);
  }
  const summary = {
    ok: true,
    dry_run: input.dryRun,
    dry_run_scope: input.dryRun
      ? ("database_and_provider_read_only" as const)
      : ("live" as const),
    rows: transformed.rows.length,
    matched_assets: transformed.rows.filter((row) => row.asset_id).length,
    with_metrics: transformed.rows.filter((row) => row.has_metrics).length,
    skipped_no_platform_id: transformed.skipped_no_platform_id,
    kept_existing_metrics: transformed.rows.filter(
      (row) => !row.has_metrics && existingPlatforms.has(row.platform_post_id),
    ).length,
    wrote: 0,
  };
  if (input.dryRun || transformed.rows.length === 0) return summary;

  const writes = await input.db.batch(transformed.rows.map(syncStatement), "write");
  if (writes.some((write) => write.rowsAffected !== 1)) {
    throw new Error("post_analytics_scoped_write_missed");
  }
  summary.wrote = writes.length;
  return summary;
}
