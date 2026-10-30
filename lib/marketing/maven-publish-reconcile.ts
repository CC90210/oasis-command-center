/** Read-only Late reconciliation for recently accepted Maven publishes. */
import { OASIS_TENANT_ID } from "./maven-publish-contract";
import type { PublishIntent } from "./maven-publish-queue";

const FINAL_STATUSES = new Set(["published", "failed"]);
const ERROR_FIELDS = ["errorMessage", "error", "failureReason", "lastError", "message"] as const;
const AFTER_MINUTES = 2;
const FOR_HOURS = 48;
const EXPIRE_AFTER_HOURS = 47;
const MAX_POSTS = 10;

export type LatePost = Record<string, unknown>;

export interface MavenPostReader {
  fetchPost(postId: string): Promise<LatePost | null>;
}

export type ReconciliationWrite = {
  intent: PublishIntent;
  result: Record<string, unknown>;
  state: "done" | "failed";
  error: string | null;
  livePlatforms: string[];
  pending: boolean;
  expired: boolean;
  firstPublishedAt: string;
  at: string;
};

export interface MavenReconcileStore {
  listReconcileCandidates(tenantId: string, oldest: string, newest: string): Promise<PublishIntent[]>;
  saveReconciliation(input: ReconciliationWrite): Promise<"updated" | "contended">;
}

export function pendingPublishPlatforms(result: Record<string, unknown>): Record<string, string> {
  const pending: Record<string, string> = {};
  for (const [platform, value] of Object.entries(result)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const entry = value as Record<string, unknown>;
    const postId = String(entry.post_id ?? "").trim();
    const status = String(entry.status ?? "").trim().toLowerCase();
    if (entry.ok === true && postId && !FINAL_STATUSES.has(status)) pending[platform] = postId;
  }
  return pending;
}

export function applyLatePostStatus(result: Record<string, unknown>, post: LatePost): boolean {
  const postId = String(post._id ?? post.id ?? "").trim();
  const rows = Array.isArray(post.platforms) ? post.platforms : [];
  const byPlatform = new Map<string, Record<string, unknown>>();
  for (const raw of rows) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const entry = raw as Record<string, unknown>;
    const platform = String(entry.platform ?? "").trim();
    if (platform) byPlatform.set(platform, entry);
  }
  let changed = false;
  for (const [platform, value] of Object.entries(result)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const current = value as Record<string, unknown>;
    if (current.ok !== true || String(current.post_id ?? "") !== postId) continue;
    const provider = byPlatform.get(platform);
    if (!provider) continue;
    const status = String(provider.status ?? "").trim().toLowerCase();
    if (status && current.status !== status) {
      current.status = status;
      changed = true;
    }
    const url = String(provider.platformPostUrl ?? "").trim();
    if (url && current.url !== url) {
      current.url = url;
      changed = true;
    }
    const publishedAt = String(provider.publishedAt ?? "").trim();
    if (publishedAt && current.published_at !== publishedAt) {
      current.published_at = publishedAt;
      changed = true;
    }
    if (status === "failed") {
      const reason = ERROR_FIELDS
        .map((name) => String(provider[name] ?? "").trim())
        .find(Boolean) ?? "the network refused it (Zernio gave no reason)";
      current.ok = false;
      current.error = reason.slice(0, 500);
      changed = true;
    }
  }
  return changed;
}

export function confirmedLivePlatforms(result: Record<string, unknown>): string[] {
  return Object.entries(result)
    .filter(([, value]) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      const row = value as Record<string, unknown>;
      return row.ok === true && String(row.status ?? "").toLowerCase() === "published";
    })
    .map(([platform]) => platform)
    .sort();
}

function firstPublishedAt(result: Record<string, unknown>, fallback: string): string {
  const times = Object.values(result).flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const raw = String((value as Record<string, unknown>).published_at ?? "");
    const time = Date.parse(raw);
    return Number.isNaN(time) ? [] : [time];
  });
  return times.length ? new Date(Math.min(...times)).toISOString() : fallback;
}

export type ReconcileSummary = {
  candidates: number;
  postsRead: number;
  readFailures: number;
  updated: number;
  contended: number;
};

/**
 * Read each selected post at most once. It never retries, republishes, deletes,
 * or asks Late to retry a failed platform.
 */
export async function reconcileMavenPublishes(input: {
  store: MavenReconcileStore;
  reader: MavenPostReader;
  now?: Date;
}): Promise<ReconcileSummary> {
  const now = input.now ?? new Date();
  const newest = new Date(now.getTime() - AFTER_MINUTES * 60_000).toISOString();
  const oldest = new Date(now.getTime() - FOR_HOURS * 60 * 60_000).toISOString();
  const expireBefore = new Date(now.getTime() - EXPIRE_AFTER_HOURS * 60 * 60_000).toISOString();
  const rows = await input.store.listReconcileCandidates(OASIS_TENANT_ID, oldest, newest);
  const candidates = rows.flatMap((intent) => {
    const open = pendingPublishPlatforms(intent.result);
    return Object.keys(open).length ? [{ intent, result: structuredClone(intent.result), open }] : [];
  });
  const ids = [...new Set(candidates.flatMap((candidate) => Object.values(candidate.open)))].sort();
  if (!ids.length) return { candidates: 0, postsRead: 0, readFailures: 0, updated: 0, contended: 0 };
  const take = Math.min(MAX_POSTS, ids.length);
  const start = (Math.floor(now.getTime() / 60_000) * take) % ids.length;
  const selected = Array.from({ length: take }, (_, index) => ids[(start + index) % ids.length]);
  const posts = new Map<string, LatePost | null>();
  for (const id of selected) {
    try {
      posts.set(id, await input.reader.fetchPost(id));
    } catch (error) {
      console.error("[maven-publish.reconcile] post read failed", { id, error: error instanceof Error ? error.message : String(error) });
      posts.set(id, null);
    }
  }

  let updated = 0;
  let contended = 0;
  for (const candidate of candidates) {
    const beforeOk = new Set(Object.entries(candidate.result)
      .filter(([, value]) => !!value && typeof value === "object" && !Array.isArray(value) && (value as Record<string, unknown>).ok === true)
      .map(([platform]) => platform));
    let changed = false;
    for (const id of [...new Set(Object.values(candidate.open))].sort()) {
      const post = posts.get(id);
      if (post && applyLatePostStatus(candidate.result, post)) changed = true;
    }
    const readAll = [...new Set(Object.values(candidate.open))].every((id) => posts.has(id) && posts.get(id) !== null);
    const expired = String(candidate.intent.finished_at ?? "") <= expireBefore && readAll;
    const live = confirmedLivePlatforms(candidate.result);
    if (!changed && !(expired && live.length === 0)) continue;
    const refused = [...beforeOk].filter((platform) => {
      const value = candidate.result[platform];
      return !!value && typeof value === "object" && !Array.isArray(value) && (value as Record<string, unknown>).ok !== true;
    }).sort();
    const anyOk = Object.values(candidate.result).some(
      (value) => !!value && typeof value === "object" && !Array.isArray(value) && (value as Record<string, unknown>).ok === true,
    );
    const refusal = refused.map((platform) => {
      const row = candidate.result[platform] as Record<string, unknown>;
      return `${platform}: ${String(row.error ?? "network refused")}`;
    }).join("; ");
    const earlier = String(candidate.intent.error ?? "").trim();
    const error = refusal
      ? `${earlier ? `${earlier}; ` : ""}refused after Zernio accepted it - ${refusal}`.slice(0, 2000)
      : candidate.intent.error;
    const verdict = await input.store.saveReconciliation({
      intent: candidate.intent,
      result: candidate.result,
      state: anyOk ? "done" : "failed",
      error,
      livePlatforms: live,
      pending: Object.keys(pendingPublishPlatforms(candidate.result)).length > 0,
      expired,
      firstPublishedAt: firstPublishedAt(candidate.result, now.toISOString()),
      at: now.toISOString(),
    });
    if (verdict === "updated") updated += 1;
    else contended += 1;
  }
  return {
    candidates: candidates.length,
    postsRead: [...posts.values()].filter(Boolean).length,
    readFailures: [...posts.values()].filter((post) => post === null).length,
    updated,
    contended,
  };
}
