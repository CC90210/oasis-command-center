import "server-only";

/** Cloud adapters for the pure Maven publish state machine. */
import type { Client, InValue, Row } from "@libsql/client";
import { r2Configured, r2StorageSurface } from "@/lib/r2-storage";
import {
  LATE_ACCOUNT_BY_PLATFORM,
  OASIS_TENANT_ID,
  buildLatePayload,
  type MarketingAsset,
  type MarketingMedia,
} from "./maven-publish-contract";
import type {
  GatewayReservationInput,
  MavenPublishGateway,
  MavenPublishProvider,
  MavenPublishQueue,
  MavenPublishStore,
  ProviderPublishInput,
  ProviderPublishResult,
  PublishIntent,
} from "./maven-publish-queue";
import { confirmedLivePlatforms, type LatePost, type ReconciliationWrite } from "./maven-publish-reconcile";

const SOCIAL_HOURLY_CAP = 10;
const SOCIAL_DAILY_CAP = 50;
const LATE_BASE = "https://zernio.com/api";

function jsonRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function text(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function intentFromRow(row: Row): PublishIntent {
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    asset_id: String(row.asset_id),
    platforms: row.platforms,
    state: String(row.state) as PublishIntent["state"],
    result: jsonRecord(row.result),
    attempts: Number(row.attempts ?? 0),
    created_at: String(row.created_at),
    started_at: text(row.started_at),
    finished_at: text(row.finished_at),
    error: text(row.error),
  };
}

function changes(result: { rowsAffected?: number }): number {
  return Number(result.rowsAffected ?? 0);
}

export class TursoMavenPublishStore implements MavenPublishStore {
  constructor(private readonly db: Client) {}

  async reapStale(
    tenantId: string,
    staleBefore: string,
    at: string,
  ): Promise<{ requeued: number; failed: number }> {
    const candidates = await this.db.execute({
      sql: `SELECT id, attempts, started_at, result
              FROM marketing_publish_intent
             WHERE tenant_id = ? AND state = 'running'
               AND started_at IS NOT NULL AND started_at < ?
             ORDER BY started_at ASC LIMIT 25`,
      args: [tenantId, staleBefore],
    });
    let requeued = 0;
    let failed = 0;
    for (const row of candidates.rows) {
      const result = jsonRecord(row.result);
      const dispatched = Boolean(result._dispatch_started_at);
      const attempts = Number(row.attempts ?? 0);
      if (dispatched || attempts >= 3) {
        const reason = dispatched
          ? "worker stopped after dispatch began; the post may already be live — human review required"
          : `worker stopped before dispatch on attempt ${attempts}; retry limit reached`;
        const terminal = dispatched ? JSON.stringify({ ...result, _delivery_unknown: true }) : JSON.stringify(result);
        const update = await this.db.execute({
          sql: `UPDATE marketing_publish_intent
                   SET state = 'failed', result = ?, error = ?, finished_at = ?
                 WHERE tenant_id = ? AND id = ? AND state = 'running' AND started_at = ?`,
          args: [terminal, reason, at, tenantId, String(row.id), String(row.started_at)],
        });
        failed += changes(update);
      } else {
        const update = await this.db.execute({
          sql: `UPDATE marketing_publish_intent
                   SET state = 'queued', result = '{}', error = ?, started_at = NULL, finished_at = NULL
                 WHERE tenant_id = ? AND id = ? AND state = 'running' AND started_at = ?`,
          args: [`worker stopped before dispatch on attempt ${attempts}; safely requeued`, tenantId, String(row.id), String(row.started_at)],
        });
        requeued += changes(update);
      }
    }
    return { requeued, failed };
  }

  async listQueued(tenantId: string, limit: number): Promise<PublishIntent[]> {
    const result = await this.db.execute({
      sql: `SELECT id, tenant_id, asset_id, platforms, state, result, attempts,
                   created_at, started_at, finished_at, error
              FROM marketing_publish_intent
             WHERE tenant_id = ? AND state = 'queued' AND attempts < 3
             ORDER BY created_at ASC
             LIMIT ?`,
      args: [tenantId, limit],
    });
    return result.rows.map(intentFromRow);
  }

  async listReconcileCandidates(tenantId: string, oldest: string, newest: string): Promise<PublishIntent[]> {
    const result = await this.db.execute({
      sql: `SELECT id, tenant_id, asset_id, platforms, state, result, attempts,
                   created_at, started_at, finished_at, error
              FROM marketing_publish_intent
             WHERE tenant_id = ? AND state = 'done'
               AND finished_at >= ? AND finished_at <= ?
             ORDER BY finished_at ASC`,
      args: [tenantId, oldest, newest],
    });
    return result.rows.map(intentFromRow);
  }

  private async distributedElsewhere(intent: PublishIntent): Promise<boolean> {
    const others = await this.db.execute({
      sql: `SELECT id, result FROM marketing_publish_intent
             WHERE tenant_id = ? AND asset_id = ? AND id <> ?`,
      args: [intent.tenant_id, intent.asset_id, intent.id],
    });
    if (others.rows.some((row) => confirmedLivePlatforms(jsonRecord(row.result)).length > 0)) return true;
    const analytics = await this.db.execute({
      sql: `SELECT id FROM post_analytics
             WHERE tenant_id = ? AND asset_id = ? AND measured_at IS NOT NULL LIMIT 1`,
      args: [intent.tenant_id, intent.asset_id],
    });
    return analytics.rows.length > 0;
  }

  async saveReconciliation(input: ReconciliationWrite): Promise<"updated" | "contended"> {
    const assetResult = await this.db.execute({
      sql: `SELECT external_id, platforms, published_at, updated_at
              FROM marketing_asset WHERE tenant_id = ? AND id = ? LIMIT 1`,
      args: [input.intent.tenant_id, input.intent.asset_id],
    });
    const asset = assetResult.rows[0];
    if (asset) {
      const postIds = new Set(Object.values(input.result).flatMap((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return [];
        const id = String((value as Record<string, unknown>).post_id ?? "").trim();
        return id ? [id] : [];
      }));
      const owner = String(asset.external_id ?? "");
      const live = input.livePlatforms;
      let wantedPlatforms: string[] | null = null;
      let wantedPublishedAt: string | null | undefined;
      if (!postIds.has(owner)) {
        if (live.length && !asset.published_at) {
          wantedPlatforms = live;
          wantedPublishedAt = input.firstPublishedAt;
        }
      } else if (live.length) {
        wantedPlatforms = live;
        if (!asset.published_at) wantedPublishedAt = input.firstPublishedAt;
      } else if (!(input.pending && !input.expired)) {
        // A different confirmed distribution wins over clearing this stamp.
        if (!(await this.distributedElsewhere(input.intent))) {
          wantedPlatforms = [];
          wantedPublishedAt = null;
        }
      }

      if (wantedPlatforms !== null || wantedPublishedAt !== undefined) {
        const sets: string[] = [];
        const args: InValue[] = [];
        if (wantedPlatforms !== null) {
          sets.push("platforms = ?");
          args.push(JSON.stringify(wantedPlatforms));
        }
        if (wantedPublishedAt !== undefined) {
          sets.push("published_at = ?");
          args.push(wantedPublishedAt);
        }
        sets.push("updated_at = ?");
        args.push(input.at, input.intent.tenant_id, input.intent.asset_id, owner, asset.updated_at as InValue);
        const projected = await this.db.execute({
          sql: `UPDATE marketing_asset SET ${sets.join(", ")}
                 WHERE tenant_id = ? AND id = ?
                   AND external_id IS ? AND updated_at IS ?`,
          args,
        });
        if (changes(projected) !== 1) return "contended";
      }
    }

    const saved = await this.db.execute({
      sql: `UPDATE marketing_publish_intent
               SET result = ?, error = ?, state = ?
             WHERE tenant_id = ? AND id = ? AND state = 'done' AND finished_at IS ?`,
      args: [
        JSON.stringify(input.result),
        input.error,
        input.state,
        input.intent.tenant_id,
        input.intent.id,
        input.intent.finished_at,
      ],
    });
    return changes(saved) === 1 ? "updated" : "contended";
  }

  async getIntent(tenantId: string, id: string): Promise<PublishIntent | null> {
    const result = await this.db.execute({
      sql: `SELECT id, tenant_id, asset_id, platforms, state, result, attempts,
                   created_at, started_at, finished_at, error
              FROM marketing_publish_intent
             WHERE tenant_id = ? AND id = ? LIMIT 1`,
      args: [tenantId, id],
    });
    return result.rows[0] ? intentFromRow(result.rows[0]) : null;
  }

  async claim(tenantId: string, id: string, token: string, at: string): Promise<PublishIntent | null> {
    const marker = JSON.stringify({ _queue_claim_token: token, _claim_started_at: at });
    const result = await this.db.execute({
      sql: `UPDATE marketing_publish_intent
               SET state = 'running', attempts = attempts + 1, started_at = ?,
                   finished_at = NULL, error = NULL, result = ?
             WHERE tenant_id = ? AND id = ? AND state = 'queued' AND attempts < 3
         RETURNING id, tenant_id, asset_id, platforms, state, result, attempts,
                   created_at, started_at, finished_at, error`,
      args: [at, marker, tenantId, id],
    });
    return result.rows[0] ? intentFromRow(result.rows[0]) : null;
  }

  async getAsset(tenantId: string, id: string): Promise<MarketingAsset | null> {
    const result = await this.db.execute({
      sql: `SELECT id, tenant_id, title, hook, body, cta, landing_url, campaign,
                   asset_type, media_urls, status, external_id, platforms,
                   published_at, updated_at
              FROM marketing_asset
             WHERE tenant_id = ? AND id = ? LIMIT 1`,
      args: [tenantId, id],
    });
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: String(row.id),
      tenant_id: String(row.tenant_id),
      title: text(row.title),
      hook: text(row.hook),
      body: text(row.body),
      cta: text(row.cta),
      landing_url: text(row.landing_url),
      campaign: text(row.campaign),
      asset_type: text(row.asset_type),
      media_urls: row.media_urls,
      status: text(row.status),
      external_id: text(row.external_id),
      platforms: row.platforms,
      published_at: text(row.published_at),
      updated_at: text(row.updated_at),
    };
  }

  async listMedia(tenantId: string, assetId: string): Promise<MarketingMedia[]> {
    const result = await this.db.execute({
      sql: `SELECT tenant_id, asset_id, kind, storage_bucket, storage_path, mime, bytes
              FROM marketing_asset_media
             WHERE tenant_id = ? AND asset_id = ?
             ORDER BY created_at ASC, id ASC`,
      args: [tenantId, assetId],
    });
    return result.rows.map((row) => ({
      tenant_id: String(row.tenant_id),
      asset_id: String(row.asset_id),
      kind: String(row.kind),
      storage_bucket: String(row.storage_bucket ?? "marketing-media"),
      storage_path: String(row.storage_path),
      mime: text(row.mime),
      bytes: row.bytes === null || row.bytes === undefined ? null : Number(row.bytes),
    }));
  }

  async markDispatch(
    tenantId: string,
    id: string,
    token: string,
    at: string,
    platforms: string[],
  ): Promise<boolean> {
    const marker = JSON.stringify({
      _queue_claim_token: token,
      _dispatch_started_at: at,
      platforms,
    });
    const result = await this.db.execute({
      sql: `UPDATE marketing_publish_intent
               SET result = ?
             WHERE tenant_id = ? AND id = ? AND state = 'running'
               AND json_extract(result, '$._queue_claim_token') = ?`,
      args: [marker, tenantId, id, token],
    });
    return changes(result) === 1;
  }

  async finish(
    tenantId: string,
    id: string,
    token: string,
    state: "done" | "failed",
    result: Record<string, unknown>,
    error: string | null,
    at: string,
  ): Promise<boolean> {
    const saved = await this.db.execute({
      sql: `UPDATE marketing_publish_intent
               SET state = ?, result = ?, error = ?, finished_at = ?
             WHERE tenant_id = ? AND id = ? AND state = 'running'
               AND json_extract(result, '$._queue_claim_token') = ?`,
      args: [state, JSON.stringify(result), error, at, tenantId, id, token],
    });
    return changes(saved) === 1;
  }

  async markAssetPublished(
    tenantId: string,
    assetId: string,
    postId: string,
    platforms: string[],
    at: string,
  ): Promise<boolean> {
    const result = await this.db.execute({
      sql: `UPDATE marketing_asset
               SET status = 'published', published_at = ?, external_id = ?,
                   platforms = ?, updated_at = ?
             WHERE tenant_id = ? AND id = ?
               AND (external_id IS NULL OR trim(external_id) = '' OR external_id = ?)`,
      args: [at, postId, JSON.stringify(platforms), at, tenantId, assetId, postId],
    });
    return changes(result) === 1;
  }
}

async function stableUuid(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  const hex = [...bytes.slice(0, 16)].map((byte) => byte.toString(16).padStart(2, "0")).join("").split("");
  hex[12] = "5";
  hex[16] = "8";
  const raw = hex.join("");
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`;
}

function rollingHourStart(at: string): string {
  return new Date(new Date(at).getTime() - 60 * 60_000).toISOString();
}

function floorUtcDay(at: string): string {
  const d = new Date(at);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

/**
 * Cloud equivalent of Maven's send_gateway social lane: same channel, source,
 * 10/hour and 50/day caps, with an atomic reservation before provider I/O.
 */
export class TursoMavenPublishGateway implements MavenPublishGateway {
  constructor(private readonly db: Client) {}

  async reserve(input: GatewayReservationInput): Promise<
    { ok: true; reservationId: string } | { ok: false; reason: string }
  > {
    const reservationId = await stableUuid(`oasis:maven-social:${input.idempotencyKey}`);
    const metadata = JSON.stringify({
      brand: "oasis",
      intent: "commercial",
      gateway_state: "reserved",
      idempotency_key: input.idempotencyKey,
      publish_intent_id: input.intentId,
      marketing_asset_id: input.assetId,
      platforms: input.platforms,
      via: "cloudflare_queue",
    });
    const inserted = await this.db.execute({
      sql: `INSERT OR IGNORE INTO lead_interactions
              (id, tenant_id, type, channel, direction, subject, content,
               agent_source, metadata, created_at)
            SELECT ?, ?, 'social_reserved', 'social', 'outbound', ?, ?,
                   'late_publisher', ?, ?
             WHERE (SELECT COUNT(*) FROM lead_interactions
                     WHERE tenant_id = ? AND channel = 'social' AND created_at >= ?) < ?
               AND (SELECT COUNT(*) FROM lead_interactions
                     WHERE tenant_id = ? AND channel = 'social' AND created_at >= ?) < ?
         RETURNING id`,
      args: [
        reservationId,
        OASIS_TENANT_ID,
        `Maven publish: ${input.platforms.join(", ")}`,
        `marketing asset ${input.assetId}`,
        metadata,
        input.at,
        OASIS_TENANT_ID,
        rollingHourStart(input.at),
        SOCIAL_HOURLY_CAP,
        OASIS_TENANT_ID,
        floorUtcDay(input.at),
        SOCIAL_DAILY_CAP,
      ] as InValue[],
    });
    if (inserted.rows.length === 1) return { ok: true, reservationId };

    const prior = await this.db.execute({
      sql: `SELECT id, type FROM lead_interactions
             WHERE tenant_id = ? AND id = ? AND channel = 'social' LIMIT 1`,
      args: [OASIS_TENANT_ID, reservationId],
    });
    if (prior.rows.length) {
      const type = String(prior.rows[0].type ?? "");
      if (type === "social_reserved") return { ok: true, reservationId };
      return {
        ok: false,
        reason: type === "social_sent"
          ? "idempotency key was already sent"
          : "idempotency key has a terminal failed reservation; human review required",
      };
    }

    const counts = await this.db.execute({
      sql: `SELECT
              SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS hourly_count,
              COUNT(*) AS daily_count
             FROM lead_interactions
            WHERE tenant_id = ? AND channel = 'social' AND created_at >= ?`,
      args: [rollingHourStart(input.at), OASIS_TENANT_ID, floorUtcDay(input.at)],
    });
    const hourly = Number(counts.rows[0]?.hourly_count ?? 0);
    const daily = Number(counts.rows[0]?.daily_count ?? 0);
    return hourly >= SOCIAL_HOURLY_CAP
      ? { ok: false, reason: `hourly cap hit: ${hourly}/${SOCIAL_HOURLY_CAP} social actions in the last hour` }
      : { ok: false, reason: `daily cap hit: ${daily}/${SOCIAL_DAILY_CAP} social actions today` };
  }

  async finalize(reservationId: string, state: "sent" | "failed", reason?: string): Promise<void> {
    const result = await this.db.execute({
      sql: `UPDATE lead_interactions
               SET type = ?,
                   metadata = json_set(COALESCE(metadata, '{}'),
                     '$.gateway_state', ?, '$.gateway_reason', ?)
             WHERE tenant_id = ? AND id = ? AND channel = 'social'
               AND type = 'social_reserved'`,
      args: [state === "sent" ? "social_sent" : "social_failed", state, reason ?? null, OASIS_TENANT_ID, reservationId],
    });
    if (changes(result) !== 1) {
      const prior = await this.db.execute({
        sql: "SELECT type FROM lead_interactions WHERE tenant_id = ? AND id = ? LIMIT 1",
        args: [OASIS_TENANT_ID, reservationId],
      });
      const type = String(prior.rows[0]?.type ?? "");
      const expected = state === "sent" ? "social_sent" : "social_failed";
      if (type !== expected) throw new Error("outbound gateway reservation could not be finalized");
    }
  }
}

type LateJson = Record<string, unknown>;

async function lateRequest(
  key: string,
  path: string,
  body: Record<string, unknown>,
  timeoutMs: number,
  extraHeaders: Readonly<Record<string, string>> = {},
): Promise<{ response: Response; json: LateJson | null; raw: string }> {
  const response = await fetch(`${LATE_BASE}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...extraHeaders },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const raw = await response.text();
  let json: LateJson | null = null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) json = parsed as LateJson;
  } catch {
    // The caller distinguishes a definitive HTTP refusal from an ambiguous 2xx.
  }
  return { response, json, raw };
}

function fileName(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? "media.bin";
}

function fallbackMime(kind: "video" | "image"): string {
  return kind === "video" ? "video/mp4" : "image/jpeg";
}

export class CloudLatePublisher implements MavenPublishProvider {
  private readonly key: string;

  constructor(key: string = process.env.LATE_API_KEY ?? "") {
    this.key = key.trim();
  }

  async fetchPost(postId: string): Promise<LatePost | null> {
    if (!this.key) return null;
    try {
      const response = await fetch(`${LATE_BASE}/v1/posts/${encodeURIComponent(postId)}`, {
        headers: { authorization: `Bearer ${this.key}`, accept: "application/json" },
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        console.error("[maven-publish.reconcile] Late read refused", { postId, status: response.status });
        return null;
      }
      const parsed = await response.json() as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      const body = parsed as Record<string, unknown>;
      const nested = body.post;
      return nested && typeof nested === "object" && !Array.isArray(nested)
        ? nested as LatePost
        : body;
    } catch (error) {
      console.error("[maven-publish.reconcile] Late read failed", {
        postId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private async upload(item: ProviderPublishInput["media"][number]): Promise<{ url: string; kind: "video" | "image" }> {
    if (!r2Configured()) throw new Error("R2 is not configured for marketing media");
    const signed = await r2StorageSurface()
      .from(item.storage_bucket)
      .createSignedUrl(item.storage_path, 900);
    if (signed.error || !signed.data?.signedUrl) {
      throw new Error(`could not sign ${item.storage_path}: ${signed.error?.message ?? "missing URL"}`);
    }
    const source = await fetch(signed.data.signedUrl, { signal: AbortSignal.timeout(300_000) });
    if (!source.ok || !source.body) {
      await source.body?.cancel().catch(() => undefined);
      throw new Error(`R2 read failed for ${item.storage_path}: HTTP ${source.status}`);
    }
    const headerBytes = Number(source.headers.get("content-length") ?? "0");
    const size = Number(item.bytes ?? 0) || headerBytes;
    if (!Number.isSafeInteger(size) || size <= 0) {
      await source.body.cancel().catch(() => undefined);
      throw new Error(`media size is unavailable for ${item.storage_path}`);
    }
    if (item.bytes && headerBytes && Number(item.bytes) !== headerBytes) {
      await source.body.cancel().catch(() => undefined);
      throw new Error(`media size changed for ${item.storage_path}: ledger=${item.bytes}, R2=${headerBytes}`);
    }
    const mime = item.mime || source.headers.get("content-type") || fallbackMime(item.mediaKind);
    const presign = await lateRequest(this.key, "/v1/media/presign", {
      filename: fileName(item.storage_path),
      contentType: mime,
      size,
    }, 60_000).catch(async (error) => {
      await source.body?.cancel().catch(() => undefined);
      throw error;
    });
    const uploadUrl = typeof presign.json?.uploadUrl === "string" ? presign.json.uploadUrl : "";
    const publicUrl = typeof presign.json?.publicUrl === "string" ? presign.json.publicUrl : "";
    if (!presign.response.ok || !uploadUrl || !publicUrl) {
      await source.body.cancel().catch(() => undefined);
      throw new Error(`Late presign failed for ${item.storage_path}: HTTP ${presign.response.status} ${presign.raw.slice(0, 200)}`);
    }
    const uploaded = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "content-type": mime },
      body: source.body,
      signal: AbortSignal.timeout(300_000),
    });
    await uploaded.body?.cancel().catch(() => undefined);
    if (uploaded.status !== 200) {
      throw new Error(`Late media upload failed for ${item.storage_path}: HTTP ${uploaded.status}`);
    }
    return { url: publicUrl, kind: item.mediaKind };
  }

  async publish(input: ProviderPublishInput): Promise<ProviderPublishResult> {
    if (!this.key) return { ok: false, reason: "LATE_API_KEY is missing" };
    let uploaded: Array<{ url: string; kind: "video" | "image" }>;
    try {
      uploaded = [];
      // Serial upload preserves carousel order and bounds Worker memory/streams.
      for (const item of input.media) uploaded.push(await this.upload(item));
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
    let payload: Record<string, unknown>;
    try {
      payload = buildLatePayload(input.group, uploaded);
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
    let created: Awaited<ReturnType<typeof lateRequest>>;
    try {
      created = await lateRequest(
        this.key,
        "/v1/posts",
        payload,
        180_000,
        { "Idempotency-Key": input.group.idempotencyKey },
      );
    } catch (error) {
      return {
        ok: false,
        reason: `Late create request lost its response: ${error instanceof Error ? error.message : String(error)}`,
        deliveryUnknown: true,
      };
    }
    if (!created.response.ok) {
      const unknown = created.response.status >= 500;
      return {
        ok: false,
        reason: `Late create refused: HTTP ${created.response.status} ${created.raw.slice(0, 200)}`,
        ...(unknown ? { deliveryUnknown: true } : {}),
      };
    }
    const nested = created.json?.post;
    const post = nested && typeof nested === "object" && !Array.isArray(nested)
      ? nested as Record<string, unknown>
      : created.json ?? {};
    const postId = String(post._id ?? post.id ?? "").trim();
    if (!postId) {
      return {
        ok: false,
        reason: `Late accepted the create request but returned no post id: ${created.raw.slice(0, 200)}`,
        deliveryUnknown: true,
      };
    }
    return { ok: true, postId };
  }
}

let queueContextWarning = false;

/** The bound Queue, or null outside the Cloudflare Worker. */
export async function mavenPublishQueueBinding(): Promise<MavenPublishQueue | null> {
  try {
    const mod = await import("@opennextjs/cloudflare");
    const context = mod.getCloudflareContext();
    const queue = (context.env as unknown as Record<string, unknown>).MAVEN_PUBLISH_JOBS as MavenPublishQueue | undefined;
    return queue && typeof queue.send === "function" ? queue : null;
  } catch (error) {
    if (!queueContextWarning) {
      queueContextWarning = true;
      console.warn("[maven-publish.queue] Cloudflare Queue binding unavailable", error instanceof Error ? error.message : String(error));
    }
    return null;
  }
}

export function assertLateAccountsComplete(): void {
  const expected = ["instagram", "tiktok", "linkedin", "youtube", "twitter", "threads"];
  const missing = expected.filter((platform) => !LATE_ACCOUNT_BY_PLATFORM[platform]);
  if (missing.length) throw new Error(`Late account map is incomplete: ${missing.join(", ")}`);
}
