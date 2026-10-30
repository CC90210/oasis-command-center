/**
 * Durable state machine for Maven's explicit marketing_publish_intent queue.
 *
 * This module is deliberately infrastructure-free. The cron producer, Turso
 * store, outbound gate, R2 reader, and Late/Zernio adapter are injected at the
 * edges so the claim/dispatch/idempotency contract can be proved without a
 * database or a network.
 */
import {
  OASIS_TENANT_ID,
  buildPublishPlan,
  type MarketingAsset,
  type MarketingMedia,
  type PublishGroup,
  type PublishMedia,
} from "./maven-publish-contract";

export type PublishIntentState = "queued" | "running" | "done" | "failed";

export type PublishIntent = {
  id: string;
  tenant_id: string;
  asset_id: string;
  platforms: unknown;
  state: PublishIntentState;
  result: Record<string, unknown>;
  attempts: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
};

export type MavenPublishJob = {
  version: 1;
  tenantId: string;
  intentId: string;
  enqueuedAt: string;
};

export function isMavenPublishJob(value: unknown): value is MavenPublishJob {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (
    row.version === 1 &&
    row.tenantId === OASIS_TENANT_ID &&
    typeof row.intentId === "string" &&
    /^[0-9a-f-]{36}$/i.test(row.intentId) &&
    typeof row.enqueuedAt === "string" &&
    !Number.isNaN(Date.parse(row.enqueuedAt))
  );
}

export interface MavenPublishStore {
  reapStale?(
    tenantId: string,
    staleBefore: string,
    at: string,
  ): Promise<{ requeued: number; failed: number }>;
  listQueued(tenantId: string, limit: number): Promise<PublishIntent[]>;
  getIntent(tenantId: string, id: string): Promise<PublishIntent | null>;
  claim(tenantId: string, id: string, token: string, at: string): Promise<PublishIntent | null>;
  getAsset(tenantId: string, id: string): Promise<MarketingAsset | null>;
  listMedia(tenantId: string, assetId: string): Promise<MarketingMedia[]>;
  markDispatch(tenantId: string, id: string, token: string, at: string, platforms: string[]): Promise<boolean>;
  finish(
    tenantId: string,
    id: string,
    token: string,
    state: "done" | "failed",
    result: Record<string, unknown>,
    error: string | null,
    at: string,
  ): Promise<boolean>;
  markAssetPublished(
    tenantId: string,
    assetId: string,
    postId: string,
    platforms: string[],
    at: string,
  ): Promise<boolean>;
}

export type GatewayReservationInput = {
  idempotencyKey: string;
  intentId: string;
  assetId: string;
  platforms: string[];
  at: string;
};

export interface MavenPublishGateway {
  reserve(input: GatewayReservationInput): Promise<
    { ok: true; reservationId: string } | { ok: false; reason: string }
  >;
  finalize(reservationId: string, state: "sent" | "failed", reason?: string): Promise<void>;
}

export type ProviderPublishInput = {
  intent: PublishIntent;
  asset: MarketingAsset;
  media: PublishMedia[];
  group: PublishGroup;
};

export type ProviderPublishResult =
  | { ok: true; postId: string }
  | { ok: false; reason: string; deliveryUnknown?: boolean };

export interface MavenPublishProvider {
  publish(input: ProviderPublishInput): Promise<ProviderPublishResult>;
}

export type MavenPublishQueue = { send(job: MavenPublishJob): Promise<unknown> };

export type ProducerResult = {
  mode: "dry" | "live";
  examined: number;
  queued: number;
  wouldQueue: string[];
  reaped: { requeued: number; failed: number };
};

/**
 * Queue explicit intents only. It never reads Maven's cadence/post queue, so a
 * week of missed scheduled posts cannot be replayed by this migration.
 */
export async function runMavenPublishProducer(input: {
  store: MavenPublishStore;
  queue: MavenPublishQueue;
  dryRun?: boolean;
  now?: Date;
  limit?: number;
}): Promise<ProducerResult> {
  const now = input.now ?? new Date();
  const reaped = input.dryRun || !input.store.reapStale
    ? { requeued: 0, failed: 0 }
    : await input.store.reapStale(
      OASIS_TENANT_ID,
      new Date(now.getTime() - 20 * 60 * 1000).toISOString(),
      now.toISOString(),
    );
  const rows = await input.store.listQueued(OASIS_TENANT_ID, Math.max(1, Math.min(input.limit ?? 10, 25)));
  const wouldQueue = rows.map((row) => row.id);
  if (input.dryRun) {
    return { mode: "dry", examined: rows.length, queued: 0, wouldQueue, reaped };
  }
  let queued = 0;
  for (const row of rows) {
    await input.queue.send({
      version: 1,
      tenantId: OASIS_TENANT_ID,
      intentId: row.id,
      enqueuedAt: now.toISOString(),
    });
    queued += 1;
  }
  return { mode: "live", examined: rows.length, queued, wouldQueue, reaped };
}

export type JobResult = {
  status: "done" | "failed" | "duplicate" | "ignored";
  intentId: string;
  error?: string;
};

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function platformResult(
  result: Record<string, unknown>,
  platforms: string[],
  value: Record<string, unknown>,
): void {
  for (const platform of platforms) result[platform] = { ...value };
}

function successfulEntries(result: Record<string, unknown>): Array<[string, Record<string, unknown>]> {
  return Object.entries(result).filter(
    (entry): entry is [string, Record<string, unknown>] => {
      const [key, value] = entry;
      return !key.startsWith("_") && !!value && typeof value === "object" &&
        (value as Record<string, unknown>).ok === true;
    },
  );
}

function projectedPlatforms(value: unknown): string[] | null {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(parsed) || !parsed.every((platform) => typeof platform === "string")) return null;
  return parsed;
}

function projectionComplete(asset: MarketingAsset | null, postId: string, platforms: string[]): boolean {
  const projected = projectedPlatforms(asset?.platforms);
  return asset?.status === "published" &&
    asset.external_id === postId &&
    typeof asset.published_at === "string" && asset.published_at.trim().length > 0 &&
    projected !== null && projected.length === platforms.length &&
    projected.every((platform, index) => platform === platforms[index]);
}

async function projectCompletedIntent(
  store: MavenPublishStore,
  intent: PublishIntent,
  result: Record<string, unknown>,
  at: string,
): Promise<void> {
  const successful = successfulEntries(result);
  if (!successful.length) return;
  const platforms = successful.map(([platform]) => platform).sort();
  const firstId = successful
    .map(([, value]) => String(value.post_id ?? ""))
    .find(Boolean) ?? "";
  if (!firstId) throw new Error("accepted publish result has no provider post id");
  const asset = await store.getAsset(intent.tenant_id, intent.asset_id);
  if (projectionComplete(asset, firstId, platforms)) return;
  const currentPostId = asset?.external_id?.trim();
  // The asset projection is owned by whichever completed intent stamped it
  // first. A delayed duplicate must never replace that provider result.
  if (currentPostId && asset?.external_id !== firstId) return;
  const stamped = await store.markAssetPublished(intent.tenant_id, intent.asset_id, firstId, platforms, at);
  if (stamped) return;

  // A concurrent completion can win between the read and the CAS update. Its
  // non-empty provider id is authoritative; only a still-unstamped/missing row
  // is a real projection failure.
  const winner = await store.getAsset(intent.tenant_id, intent.asset_id);
  if (projectionComplete(winner, firstId, platforms)) return;
  const winnerPostId = winner?.external_id?.trim();
  if (winnerPostId && winner?.external_id !== firstId) return;
  throw new Error("published asset could not be stamped");
}

async function closeIntent(input: {
  store: MavenPublishStore;
  intent: PublishIntent;
  token: string;
  result: Record<string, unknown>;
  errors: string[];
  at: string;
}): Promise<JobResult> {
  const successful = successfulEntries(input.result);
  const state = successful.length ? "done" : "failed";
  const error = input.errors.length ? input.errors.join("; ") : null;
  const finished = await input.store.finish(
    input.intent.tenant_id,
    input.intent.id,
    input.token,
    state,
    input.result,
    error,
    input.at,
  );
  if (!finished) throw new Error("publish intent lost its claim before completion");

  if (successful.length) {
    await projectCompletedIntent(input.store, input.intent, input.result, input.at);
  }
  return { status: state, intentId: input.intent.id, ...(error ? { error } : {}) };
}

/**
 * Claim exactly once, reserve the outbound lane, stamp a dispatch marker, then
 * call the provider. A failure after that marker is terminal and explicit:
 * retrying a post that may already be live is less safe than human review.
 */
export async function runMavenPublishJob(input: {
  job: MavenPublishJob;
  store: MavenPublishStore;
  gateway: MavenPublishGateway;
  provider: MavenPublishProvider;
  now?: Date;
  claimToken?: () => string;
}): Promise<JobResult> {
  const { job } = input;
  if (job.version !== 1 || job.tenantId !== OASIS_TENANT_ID) {
    return { status: "ignored", intentId: job.intentId };
  }
  const at = (input.now ?? new Date()).toISOString();
  const existing = await input.store.getIntent(OASIS_TENANT_ID, job.intentId);
  if (!existing) return { status: "ignored", intentId: job.intentId };
  if (existing.state === "done") {
    // A prior attempt can commit the intent and then lose its response while
    // projecting the Library row. Queue retry repairs that projection without
    // ever calling the provider again.
    await projectCompletedIntent(input.store, existing, existing.result, at);
    return { status: "duplicate", intentId: job.intentId };
  }
  const token = (input.claimToken ?? crypto.randomUUID)();
  const claimed = await input.store.claim(OASIS_TENANT_ID, job.intentId, token, at);
  if (!claimed) return { status: "duplicate", intentId: job.intentId };

  const results: Record<string, unknown> = {};
  const errors: string[] = [];
  let completionAttempted = false;
  try {
    const asset = await input.store.getAsset(OASIS_TENANT_ID, claimed.asset_id);
    if (!asset) {
      errors.push("asset no longer exists");
      completionAttempted = true;
      return await closeIntent({ store: input.store, intent: claimed, token, result: results, errors, at });
    }
    const media = await input.store.listMedia(OASIS_TENANT_ID, claimed.asset_id);
    const plan = buildPublishPlan(claimed, asset, media);
    if (plan.droppedPlatforms.length) {
      for (const platform of plan.droppedPlatforms) {
        results[platform] = {
          ok: false,
          error: `${plan.media.length}-image post exceeds ${platform}'s image cap`,
        };
      }
    }

    for (const group of plan.groups) {
      const reservation = await input.gateway.reserve({
        idempotencyKey: group.idempotencyKey,
        intentId: claimed.id,
        assetId: claimed.asset_id,
        platforms: [...group.platforms],
        at,
      });
      if (!reservation.ok) {
        const reason = `gateway refused ${group.id}: ${reservation.reason}`;
        errors.push(reason);
        platformResult(results, group.platforms, { ok: false, error: reservation.reason });
        continue;
      }

      const marked = await input.store.markDispatch(
        OASIS_TENANT_ID,
        claimed.id,
        token,
        at,
        group.platforms,
      );
      if (!marked) {
        await input.gateway.finalize(reservation.reservationId, "failed", "intent claim lost before dispatch");
        throw new Error("publish intent lost its claim before dispatch");
      }

      try {
        const published = await input.provider.publish({ intent: claimed, asset, media: plan.media, group });
        if (published.ok) {
          platformResult(results, group.platforms, { ok: true, post_id: published.postId });
          await input.gateway.finalize(reservation.reservationId, "sent");
        } else {
          const unknown = published.deliveryUnknown === true;
          const reason = unknown
            ? `${published.reason}; delivery is unknown and the post may already be live — human review required`
            : published.reason;
          platformResult(results, group.platforms, { ok: false, error: reason, ...(unknown ? { delivery_unknown: true } : {}) });
          errors.push(`${group.id}: ${reason}`);
          if (unknown) results._delivery_unknown = true;
          await input.gateway.finalize(reservation.reservationId, "failed", reason);
          if (unknown) {
            // The provider may already have accepted this group. Do not expose
            // another group to a second possible send until a person reconciles it.
            break;
          }
        }
      } catch (error) {
        const reason = `${message(error)}; delivery is unknown and the post may already be live — human review required`;
        platformResult(results, group.platforms, { ok: false, error: reason, delivery_unknown: true });
        results._delivery_unknown = true;
        errors.push(`${group.id}: ${reason}`);
        await input.gateway.finalize(reservation.reservationId, "failed", reason);
        // Once delivery is ambiguous, do not send a second group. The intent is
        // terminal and a person reconciles the provider before any new action.
        break;
      }
    }
    completionAttempted = true;
    return await closeIntent({ store: input.store, intent: claimed, token, result: results, errors, at });
  } catch (error) {
    // Pre-dispatch errors are also persisted. If persistence itself fails, let
    // the route return 500 so Queue retry/DLQ policy can preserve the evidence.
    if (completionAttempted) throw error;
    const reason = message(error);
    errors.push(reason);
    completionAttempted = true;
    return await closeIntent({ store: input.store, intent: claimed, token, result: results, errors, at });
  }
}
