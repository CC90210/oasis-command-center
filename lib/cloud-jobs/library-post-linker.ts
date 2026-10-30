import type { Client, InStatement, Row } from "@libsql/client";
import { OASIS_OPERATOR_TENANT_ID } from "@/lib/cloud-jobs/control";

export const MIN_LIBRARY_HOOK = 24;
const READ_LIMIT = 20_000;

export type LibraryAsset = {
  id: string;
  tenant_id: string;
  title: string;
  hook: string | null;
  published_at: string | null;
  platforms: string | null;
  status: string;
  brand_slug: string;
  meta: unknown;
};

export type AnalyticsPost = {
  id: string;
  tenant_id: string;
  platform: string;
  platform_post_id: string;
  content_excerpt: string | null;
  published_at: string | null;
  asset_id: string | null;
};

export type LinkPlanRow = {
  asset_id: string;
  title: string;
  already_linked: boolean;
  zernio_tracked: boolean;
  published_at: string | null;
  platforms: string[];
  post_ids: string[];
  views_visible: true;
};

export type LinkConflict = {
  post_id: string;
  planned_asset_id: string;
  existing_asset_id: string | null;
  reason: "already_linked" | "concurrent_change" | "post_missing";
};

export type LinkPlan = {
  assets: number;
  posts: number;
  skipped_short_hook: number;
  ambiguous_posts: number;
  reposts: Array<{ asset_id: string; title: string; days: string[]; platforms: string[] }>;
  linkable_assets: number;
  linked_posts: number;
  written_posts: number;
  conflicts: LinkConflict[];
  executed: boolean;
  plan: LinkPlanRow[];
};

export function normalizePostText(value: string | null | undefined): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

export function isZernioTracked(asset: Pick<LibraryAsset, "meta">): boolean {
  let meta = asset.meta;
  if (typeof meta === "string") {
    try {
      meta = JSON.parse(meta) as unknown;
    } catch {
      return false;
    }
  }
  return Boolean(meta && typeof meta === "object" && "zernio" in meta && (meta as { zernio?: unknown }).zernio);
}

export function planLibraryPostLinks(assets: LibraryAsset[], posts: AnalyticsPost[]): LinkPlan {
  const usable = assets.filter((asset) => normalizePostText(asset.hook).length >= MIN_LIBRARY_HOOK);
  const skippedShort = assets.length - usable.length;
  const hits = new Map<string, LibraryAsset[]>();
  for (const post of posts) {
    const caption = normalizePostText(post.content_excerpt);
    if (!caption) continue;
    for (const asset of usable) {
      if (asset.tenant_id !== post.tenant_id) continue;
      const hook = normalizePostText(asset.hook);
      if (!hook || !caption.includes(hook)) continue;
      hits.set(post.id, [...(hits.get(post.id) ?? []), asset]);
    }
  }
  const ambiguous = new Set(
    [...hits.entries()]
      .filter(([, candidates]) => new Set(candidates.map((asset) => asset.id)).size > 1)
      .map(([postId]) => postId),
  );
  const postsById = new Map(posts.map((post) => [post.id, post]));
  const byAsset = new Map<string, AnalyticsPost[]>();
  const conflicts: LinkConflict[] = [];
  for (const [postId, candidates] of hits) {
    if (ambiguous.has(postId)) continue;
    const post = postsById.get(postId);
    if (!post || !candidates[0]) continue;
    const plannedAssetId = candidates[0].id;
    if (post.asset_id && post.asset_id !== plannedAssetId) {
      conflicts.push({
        post_id: post.id,
        planned_asset_id: plannedAssetId,
        existing_asset_id: post.asset_id,
        reason: "already_linked",
      });
      continue;
    }
    byAsset.set(plannedAssetId, [...(byAsset.get(plannedAssetId) ?? []), post]);
  }
  const assetsById = new Map(assets.map((asset) => [asset.id, asset]));
  const plan: LinkPlanRow[] = [];
  const reposts: LinkPlan["reposts"] = [];
  for (const [assetId, matched] of byAsset) {
    const asset = assetsById.get(assetId);
    if (!asset) continue;
    const timestamps = matched
      .map((post) => post.published_at)
      .filter((value): value is string => Boolean(value))
      .sort();
    if (!timestamps.length) continue;
    const days = [...new Set(timestamps.map((timestamp) => timestamp.slice(0, 10)))].sort();
    const platforms = [...new Set(matched.map((post) => post.platform).filter(Boolean))].sort();
    if (days.length > 1) {
      reposts.push({ asset_id: assetId, title: asset.title, days, platforms });
    }
    plan.push({
      asset_id: assetId,
      title: asset.title,
      already_linked: Boolean(asset.published_at),
      zernio_tracked: isZernioTracked(asset),
      published_at: timestamps[0],
      platforms,
      post_ids: matched.map((post) => post.id),
      views_visible: true,
    });
  }
  plan.sort((a, b) => (a.published_at ?? "").localeCompare(b.published_at ?? ""));
  return {
    assets: assets.length,
    posts: posts.length,
    skipped_short_hook: skippedShort,
    ambiguous_posts: ambiguous.size,
    reposts,
    linkable_assets: plan.length,
    linked_posts: plan.reduce((sum, row) => sum + row.post_ids.length, 0),
    written_posts: 0,
    conflicts: conflicts.sort((a, b) => a.post_id.localeCompare(b.post_id)),
    executed: false,
    plan,
  };
}

function assetFromRow(row: Row): LibraryAsset {
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    title: String(row.title),
    hook: typeof row.hook === "string" ? row.hook : null,
    published_at: typeof row.published_at === "string" ? row.published_at : null,
    platforms: typeof row.platforms === "string" ? row.platforms : null,
    status: String(row.status),
    brand_slug: String(row.brand_slug),
    meta: row.meta,
  };
}

function postFromRow(row: Row): AnalyticsPost {
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    platform: String(row.platform),
    platform_post_id: String(row.platform_post_id),
    content_excerpt: typeof row.content_excerpt === "string" ? row.content_excerpt : null,
    published_at: typeof row.published_at === "string" ? row.published_at : null,
    asset_id: typeof row.asset_id === "string" ? row.asset_id : null,
  };
}

export async function runLibraryPostLinker(input: {
  db: Pick<Client, "execute" | "batch">;
  dryRun: boolean;
}): Promise<LinkPlan> {
  const [assetRead, postRead] = await Promise.all([
    input.db.execute({
      sql: `SELECT id, tenant_id, title, hook, published_at, platforms, status, brand_slug, meta
            FROM marketing_asset WHERE tenant_id = ? LIMIT ?`,
      args: [OASIS_OPERATOR_TENANT_ID, READ_LIMIT + 1],
    }),
    input.db.execute({
      sql: `SELECT id, tenant_id, platform, platform_post_id, content_excerpt, published_at, asset_id
            FROM post_analytics WHERE tenant_id = ? LIMIT ?`,
      args: [OASIS_OPERATOR_TENANT_ID, READ_LIMIT + 1],
    }),
  ]);
  if (assetRead.rows.length > READ_LIMIT || postRead.rows.length > READ_LIMIT) {
    throw new Error("library_post_linker_read_limit_exceeded");
  }
  const posts = postRead.rows.map(postFromRow);
  const result = planLibraryPostLinks(assetRead.rows.map(assetFromRow), posts);
  if (input.dryRun || result.plan.length === 0) return result;

  const postWrites = result.plan.flatMap((row) => row.post_ids.map((postId) => ({
    postId,
    plannedAssetId: row.asset_id,
    statement: {
      sql: `UPDATE post_analytics
            SET asset_id = ?
            WHERE tenant_id = ? AND id = ?
              AND (asset_id IS NULL OR asset_id = ?)`,
      args: [row.asset_id, OASIS_OPERATOR_TENANT_ID, postId, row.asset_id],
    } satisfies InStatement,
  })));
  const postResults = await input.db.batch(postWrites.map((write) => write.statement), "write");
  if (postResults.length !== postWrites.length) {
    throw new Error("library_post_linker_write_result_mismatch");
  }

  const successfulPostIds = new Set<string>();
  const missed = postWrites.filter((write, index) => {
    if (postResults[index]?.rowsAffected === 1) {
      successfulPostIds.add(write.postId);
      return false;
    }
    return true;
  });
  for (let offset = 0; offset < missed.length; offset += 200) {
    const chunk = missed.slice(offset, offset + 200);
    const current = await input.db.execute({
      sql: `SELECT id, asset_id FROM post_analytics
            WHERE tenant_id = ? AND id IN (${chunk.map(() => "?").join(",")})`,
      args: [OASIS_OPERATOR_TENANT_ID, ...chunk.map((write) => write.postId)],
    });
    const currentById = new Map(current.rows.map((row) => [
      String(row.id),
      typeof row.asset_id === "string" ? row.asset_id : null,
    ]));
    for (const write of chunk) {
      if (currentById.get(write.postId) === write.plannedAssetId) {
        // Another replay completed the same link between our read and update.
        // That is idempotent success, not a conflict.
        successfulPostIds.add(write.postId);
        continue;
      }
      result.conflicts.push({
        post_id: write.postId,
        planned_asset_id: write.plannedAssetId,
        existing_asset_id: currentById.get(write.postId) ?? null,
        reason: currentById.has(write.postId) ? "concurrent_change" : "post_missing",
      });
    }
  }

  const postsById = new Map(posts.map((post) => [post.id, post]));
  result.plan = result.plan.flatMap((row) => {
    const postIds = row.post_ids.filter((postId) => successfulPostIds.has(postId));
    if (!postIds.length) return [];
    const linked = postIds.map((postId) => postsById.get(postId)).filter((post): post is AnalyticsPost => Boolean(post));
    const timestamps = linked
      .map((post) => post.published_at)
      .filter((value): value is string => Boolean(value))
      .sort();
    const platforms = [...new Set(linked.map((post) => post.platform).filter(Boolean))].sort();
    return [{
      ...row,
      published_at: timestamps[0] ?? null,
      platforms,
      post_ids: postIds,
    }];
  });

  const assetWrites: InStatement[] = result.plan
    .filter((row) => !row.zernio_tracked && row.published_at)
    .map((row) => ({
      sql: `UPDATE marketing_asset
            SET published_at = ?, platforms = ?
            WHERE tenant_id = ? AND id = ?`,
      args: [
        row.published_at,
        JSON.stringify(row.platforms),
        OASIS_OPERATOR_TENANT_ID,
        row.asset_id,
      ],
    }));
  const assetResults = assetWrites.length ? await input.db.batch(assetWrites, "write") : [];
  if (assetResults.some((write) => write.rowsAffected !== 1)) {
    throw new Error("library_post_linker_scoped_write_missed");
  }
  result.linkable_assets = result.plan.length;
  result.linked_posts = successfulPostIds.size;
  result.written_posts = successfulPostIds.size;
  result.reposts = result.plan.flatMap((row) => {
    const days = [...new Set(row.post_ids
      .map((postId) => postsById.get(postId)?.published_at?.slice(0, 10))
      .filter((value): value is string => Boolean(value)))].sort();
    return days.length > 1
      ? [{ asset_id: row.asset_id, title: row.title, days, platforms: row.platforms }]
      : [];
  });
  result.conflicts.sort((a, b) => a.post_id.localeCompare(b.post_id));
  result.executed = successfulPostIds.size > 0;
  return result;
}
