/**
 * Cloud Maven publish-drain contract. Everything here is in memory: no Turso,
 * R2, Late/Zernio, Queue, or social-network call is possible from this test.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  MAVEN_PUBLISH_QUEUE_NAME,
  OASIS_MAVEN_PUBLISH_SWITCH,
  OASIS_TENANT_ID,
  buildLatePayload,
  buildPublishPlan,
  mavenPublishEnabled,
  mavenPublishLiveReadiness,
  type MarketingAsset,
  type MarketingMedia,
} from "../lib/marketing/maven-publish-contract";
import {
  runMavenPublishJob,
  runMavenPublishProducer,
  type MavenPublishGateway,
  type MavenPublishJob,
  type MavenPublishProvider,
  type MavenPublishStore,
  type PublishIntent,
} from "../lib/marketing/maven-publish-queue";
import { reconcileMavenPublishes, type ReconciliationWrite } from "../lib/marketing/maven-publish-reconcile";

const NOW = new Date("2026-10-30T02:30:00.000Z");

function intent(overrides: Partial<PublishIntent> = {}): PublishIntent {
  return {
    id: crypto.randomUUID(),
    tenant_id: OASIS_TENANT_ID,
    asset_id: crypto.randomUUID(),
    platforms: ["instagram", "twitter", "linkedin"],
    state: "queued",
    result: {},
    attempts: 0,
    created_at: "2026-10-30T02:00:00.000Z",
    started_at: null,
    finished_at: null,
    error: null,
    ...overrides,
  };
}

function asset(row: PublishIntent, overrides: Partial<MarketingAsset> = {}): MarketingAsset {
  return {
    id: row.asset_id,
    tenant_id: row.tenant_id,
    title: "A useful post",
    hook: "Stop losing hours to admin.",
    body: "The workflow handles the repetitive part while you keep the judgment.",
    cta: "book the audit",
    landing_url: "https://oasisai.work/ai-audit",
    campaign: "free-ai-audit",
    asset_type: "video",
    media_urls: [],
    ...overrides,
  };
}

function media(row: PublishIntent, overrides: Partial<MarketingMedia> = {}): MarketingMedia {
  return {
    tenant_id: row.tenant_id,
    asset_id: row.asset_id,
    kind: "video",
    storage_bucket: "marketing-media",
    storage_path: `${row.tenant_id}/${row.asset_id}/clip.mp4`,
    mime: "video/mp4",
    bytes: 12_345,
    ...overrides,
  };
}

class MemoryStore implements MavenPublishStore {
  readonly intents = new Map<string, PublishIntent>();
  readonly assets = new Map<string, MarketingAsset>();
  readonly media = new Map<string, MarketingMedia[]>();
  mutations = 0;

  constructor(rows: PublishIntent[]) {
    for (const row of rows) {
      this.intents.set(row.id, structuredClone(row));
      this.assets.set(row.asset_id, asset(row));
      this.media.set(row.asset_id, [media(row)]);
    }
  }

  async listQueued(tenantId: string, limit: number): Promise<PublishIntent[]> {
    return [...this.intents.values()]
      .filter((row) => row.tenant_id === tenantId && row.state === "queued")
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .slice(0, limit)
      .map((row) => structuredClone(row));
  }

  async getIntent(tenantId: string, id: string): Promise<PublishIntent | null> {
    const row = this.intents.get(id);
    return row?.tenant_id === tenantId ? structuredClone(row) : null;
  }

  async claim(tenantId: string, id: string, token: string, at: string): Promise<PublishIntent | null> {
    const row = this.intents.get(id);
    if (!row || row.tenant_id !== tenantId || row.state !== "queued") return null;
    const next: PublishIntent = {
      ...row,
      state: "running",
      attempts: row.attempts + 1,
      started_at: at,
      result: { _queue_claim_token: token, _claim_started_at: at },
    };
    this.intents.set(id, next);
    this.mutations += 1;
    return structuredClone(next);
  }

  async getAsset(tenantId: string, id: string): Promise<MarketingAsset | null> {
    const row = this.assets.get(id);
    return row?.tenant_id === tenantId ? structuredClone(row) : null;
  }

  async listMedia(tenantId: string, assetId: string): Promise<MarketingMedia[]> {
    return (this.media.get(assetId) ?? [])
      .filter((row) => row.tenant_id === tenantId)
      .map((row) => structuredClone(row));
  }

  async markDispatch(tenantId: string, id: string, token: string, at: string, platforms: string[]): Promise<boolean> {
    const row = this.intents.get(id);
    if (!row || row.tenant_id !== tenantId || row.state !== "running" || row.result._queue_claim_token !== token) return false;
    this.intents.set(id, { ...row, result: { ...row.result, _dispatch_started_at: at, platforms } });
    this.mutations += 1;
    return true;
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
    const row = this.intents.get(id);
    if (!row || row.tenant_id !== tenantId || row.state !== "running" || row.result._queue_claim_token !== token) return false;
    this.intents.set(id, { ...row, state, result: structuredClone(result), error, finished_at: at });
    this.mutations += 1;
    return true;
  }

  async markAssetPublished(
    tenantId: string,
    assetId: string,
    postId: string,
    platforms: string[],
    at: string,
  ): Promise<boolean> {
    const row = this.assets.get(assetId);
    if (!row || row.tenant_id !== tenantId || (row.external_id?.trim() && row.external_id !== postId)) return false;
    this.assets.set(assetId, { ...row, status: "published", external_id: postId, platforms, published_at: at });
    this.mutations += 1;
    return true;
  }
}

class MemoryGateway implements MavenPublishGateway {
  reservations: string[] = [];
  finalized: Array<{ id: string; state: "sent" | "failed"; reason?: string }> = [];
  blockReason: string | null = null;

  async reserve(input: { idempotencyKey: string }): Promise<{ ok: true; reservationId: string } | { ok: false; reason: string }> {
    if (this.blockReason) return { ok: false, reason: this.blockReason };
    this.reservations.push(input.idempotencyKey);
    return { ok: true, reservationId: `gate:${input.idempotencyKey}` };
  }

  async finalize(reservationId: string, state: "sent" | "failed", reason?: string): Promise<void> {
    this.finalized.push({ id: reservationId, state, reason });
  }
}

class MemoryProvider implements MavenPublishProvider {
  calls = 0;
  throwAfterDispatch = false;
  returnUnknownOnCall: number | null = null;

  async publish(input: { group: { platforms: string[] } }): Promise<{ ok: true; postId: string } | { ok: false; reason: string; deliveryUnknown?: boolean }> {
    this.calls += 1;
    if (this.throwAfterDispatch) throw new Error("connection vanished after POST");
    if (this.returnUnknownOnCall === this.calls) {
      return { ok: false, reason: "provider lost the accepted response", deliveryUnknown: true };
    }
    return { ok: true, postId: `post-${input.group.platforms.join("-")}` };
  }
}

async function run(): Promise<void> {
assert.equal(OASIS_MAVEN_PUBLISH_SWITCH, "OASIS_MAVEN_PUBLISH_QUEUE_FORWARD");
assert.equal(MAVEN_PUBLISH_QUEUE_NAME, "oasis-maven-publish-jobs");
for (const value of ["on", "true", "1", "yes", " ON "]) {
  assert.equal(mavenPublishEnabled({ [OASIS_MAVEN_PUBLISH_SWITCH]: value }), true);
}
for (const value of [undefined, "", "off", "false", "enabled", "onn"]) {
  assert.equal(mavenPublishEnabled({ [OASIS_MAVEN_PUBLISH_SWITCH]: value }), false);
}
assert.deepEqual(mavenPublishLiveReadiness({}), { ready: false, reason: "MAVEN_FORCE_DRY_RUN is missing (fail closed)" });
assert.deepEqual(
  mavenPublishLiveReadiness({ MAVEN_FORCE_DRY_RUN: "1", LATE_API_KEY: "present" }),
  { ready: false, reason: "MAVEN_FORCE_DRY_RUN is engaged" },
);
assert.deepEqual(
  mavenPublishLiveReadiness({ MAVEN_FORCE_DRY_RUN: "0" }),
  { ready: false, reason: "LATE_API_KEY is missing" },
);
assert.deepEqual(
  mavenPublishLiveReadiness({ MAVEN_FORCE_DRY_RUN: "0", LATE_API_KEY: "present" }),
  { ready: false, reason: "R2 account id is missing" },
);
assert.deepEqual(
  mavenPublishLiveReadiness({
    MAVEN_FORCE_DRY_RUN: "0",
    BRAVO_FORCE_DRY_RUN: "1",
    LATE_API_KEY: "present",
    CLOUDFLARE_ACCOUNT_ID: "account",
    R2_ACCESS_KEY_ID: "access",
    R2_SECRET_ACCESS_KEY: "secret",
    R2_BUCKET: "bucket",
  }),
  { ready: false, reason: "BRAVO_FORCE_DRY_RUN is engaged" },
);
assert.deepEqual(
  mavenPublishLiveReadiness({
    MAVEN_FORCE_DRY_RUN: "0",
    LATE_API_KEY: "present",
    CLOUDFLARE_ACCOUNT_ID: "account",
    R2_ACCESS_KEY_ID: "access",
    R2_SECRET_ACCESS_KEY: "secret",
    R2_BUCKET: "bucket",
  }),
  { ready: false, reason: "OASIS_MAVEN_PUBLISH_JOB_SIGNING_SECRET is missing" },
);
assert.deepEqual(
  mavenPublishLiveReadiness({
    MAVEN_FORCE_DRY_RUN: "0",
    LATE_API_KEY: "present",
    CLOUDFLARE_ACCOUNT_ID: "account",
    R2_ACCESS_KEY_ID: "access",
    R2_SECRET_ACCESS_KEY: "secret",
    R2_BUCKET: "bucket",
    OASIS_MAVEN_PUBLISH_JOB_SIGNING_SECRET: "queue-secret",
  }),
  { ready: true },
);

{
  const a = intent({ id: "00000000-0000-4000-8000-000000000001", created_at: "2026-10-29T20:00:00.000Z" });
  const b = intent({ id: "00000000-0000-4000-8000-000000000002", created_at: "2026-10-29T21:00:00.000Z" });
  const foreign = intent({ id: "00000000-0000-4000-8000-000000000003", tenant_id: "aa04fa1f-ad6a-44b0-ac4b-2ff5d1067110" });
  const store = new MemoryStore([a, b, foreign]);
  const jobs: MavenPublishJob[] = [];
  const dry = await runMavenPublishProducer({
    store,
    queue: { send: async (job) => { jobs.push(job); } },
    dryRun: true,
    now: NOW,
  });
  assert.deepEqual(dry.wouldQueue, [a.id, b.id]);
  assert.equal(jobs.length, 0, "dry-run must make zero Queue calls");
  assert.equal(store.mutations, 0, "dry-run must make zero state changes");

  const live = await runMavenPublishProducer({
    store,
    queue: { send: async (job) => { jobs.push(job); } },
    now: NOW,
  });
  assert.equal(live.queued, 2);
  assert.deepEqual(jobs.map((job) => job.intentId), [a.id, b.id]);
  assert.ok(jobs.every((job) => job.tenantId === OASIS_TENANT_ID && job.version === 1));
}

{
  const row = intent();
  const cover = media(row, { kind: "image", storage_path: "slides/cover.png", mime: "image/png" });
  const middle = media(row, { kind: "image", storage_path: "slides/middle.png", mime: "image/png" });
  const cta = media(row, { kind: "image", storage_path: "slides/cta.png", mime: "image/png" });
  const plan = buildPublishPlan(
    row,
    asset(row, {
      asset_type: "carousel",
      media_urls: [cta.storage_path, cover.storage_path, middle.storage_path],
    }),
    [cover, middle, cta],
  );
  assert.deepEqual(
    plan.media.map((item) => item.storage_path),
    [cta.storage_path, cover.storage_path, middle.storage_path],
    "carousel order is the recorded media_urls order, never row order",
  );
  assert.deepEqual(plan.droppedPlatforms, [], "a three-slide deck fits every image-capable requested surface");
  assert.deepEqual(plan.groups.map((group) => group.platforms), [["instagram", "twitter"], ["linkedin"]]);
  assert.match(plan.groups[0].caption, /^Stop losing hours/);
  assert.match(plan.groups[1].caption, /^The workflow handles/);
}

{
  const row = intent({ platforms: ["instagram", "twitter", "tiktok", "youtube", "linkedin"] });
  const slides = Array.from({ length: 5 }, (_, index) => media(row, {
    kind: "image",
    storage_path: `slides/${index + 1}.png`,
    mime: "image/png",
  }));
  const plan = buildPublishPlan(
    row,
    asset(row, { asset_type: "carousel", media_urls: slides.map((item) => item.storage_path) }),
    slides,
  );
  assert.deepEqual(plan.droppedPlatforms.sort(), ["tiktok", "twitter", "youtube"]);
  assert.deepEqual(plan.groups.flatMap((group) => group.platforms).sort(), ["instagram", "linkedin"]);
}

{
  const row = intent({ platforms: ["instagram", "tiktok", "youtube", "twitter"] });
  const image = media(row, { kind: "image", storage_path: "single/cover.png", mime: "image/png" });
  const plan = buildPublishPlan(row, asset(row, { asset_type: "single_image" }), [image]);
  assert.deepEqual(plan.droppedPlatforms.sort(), ["tiktok", "youtube"], "video-only surfaces refuse even one image");
  assert.deepEqual(plan.groups[0].platforms, ["instagram", "twitter"]);
}

{
  const row = intent({ platforms: ["instagram", "youtube", "linkedin"] });
  const plan = buildPublishPlan(row, asset(row), [media(row)]);
  const short = plan.groups.find((group) => group.id === "short")!;
  const payload = buildLatePayload(short, [{ kind: "video", url: "https://media.test/clip.mp4" }]);
  assert.equal(payload.publishNow, true, "an immediate publish must never become a Late draft");
  assert.deepEqual(payload.mediaItems, [{ type: "video", url: "https://media.test/clip.mp4" }]);
  const platforms = payload.platforms as Array<Record<string, unknown>>;
  assert.deepEqual(platforms.map((entry) => entry.platform), ["instagram", "youtube"]);
  assert.deepEqual(platforms[0].platformSpecificData, { contentType: "reel" });
  assert.deepEqual(platforms[1].platformSpecificData, {
    title: "A useful post",
    visibility: "public",
    madeForKids: false,
    categoryId: "28",
  });
}

{
  const row = intent();
  const store = new MemoryStore([row]);
  const gateway = new MemoryGateway();
  const provider = new MemoryProvider();
  const job: MavenPublishJob = {
    version: 1,
    tenantId: OASIS_TENANT_ID,
    intentId: row.id,
    enqueuedAt: NOW.toISOString(),
  };
  const [first, second] = await Promise.all([
    runMavenPublishJob({ job, store, gateway, provider, now: NOW, claimToken: () => "claim-a" }),
    runMavenPublishJob({ job, store, gateway, provider, now: NOW, claimToken: () => "claim-b" }),
  ]);
  assert.equal(provider.calls, 2, "one winning intent has two canonical groups: short-form and LinkedIn");
  assert.equal([first.status, second.status].filter((status) => status === "done").length, 1);
  assert.equal([first.status, second.status].filter((status) => status === "duplicate").length, 1);
  assert.equal(store.intents.get(row.id)?.state, "done");
  assert.deepEqual((store.intents.get(row.id)?.result.instagram as { ok: boolean }).ok, true);
  assert.equal(gateway.reservations.length, 2);
  assert.ok(gateway.reservations.every((key) => key.startsWith(`maven-publish:${row.id}:`)));
}

{
  const row = intent({
    state: "done",
    result: { instagram: { ok: true, post_id: "accepted-before-response-loss" } },
    finished_at: NOW.toISOString(),
  });
  const store = new MemoryStore([row]);
  const gateway = new MemoryGateway();
  const provider = new MemoryProvider();
  const out = await runMavenPublishJob({
    job: { version: 1, tenantId: OASIS_TENANT_ID, intentId: row.id, enqueuedAt: NOW.toISOString() },
    store,
    gateway,
    provider,
    now: NOW,
  });
  assert.equal(out.status, "duplicate");
  assert.equal(provider.calls, 0, "a committed intent retry repairs projection without re-posting");
  assert.deepEqual(store.assets.get(row.asset_id), {
    ...asset(row),
    status: "published",
    external_id: "accepted-before-response-loss",
    platforms: ["instagram"],
    published_at: NOW.toISOString(),
  }, "an unstamped asset receives the complete projection");
}

{
  const row = intent({
    platforms: ["instagram"],
    state: "done",
    result: { instagram: { ok: true, post_id: "post-same" } },
    finished_at: "2026-10-30T02:00:00.000Z",
  });
  const store = new MemoryStore([row]);
  store.assets.set(row.asset_id, asset(row, {
    status: "approved",
    external_id: "post-same",
    platforms: [],
    published_at: null,
  }));
  const provider = new MemoryProvider();
  const out = await runMavenPublishJob({
    job: { version: 1, tenantId: OASIS_TENANT_ID, intentId: row.id, enqueuedAt: NOW.toISOString() },
    store,
    gateway: new MemoryGateway(),
    provider,
    now: NOW,
  });
  assert.equal(out.status, "duplicate");
  assert.equal(provider.calls, 0);
  assert.deepEqual(store.assets.get(row.asset_id), {
    ...asset(row),
    status: "published",
    external_id: "post-same",
    platforms: ["instagram"],
    published_at: NOW.toISOString(),
  }, "the same provider post repairs an incomplete status/platform/timestamp projection");
  const afterRepair = store.mutations;
  assert.equal((await runMavenPublishJob({
    job: { version: 1, tenantId: OASIS_TENANT_ID, intentId: row.id, enqueuedAt: NOW.toISOString() },
    store,
    gateway: new MemoryGateway(),
    provider,
    now: NOW,
  })).status, "duplicate");
  assert.equal(store.mutations, afterRepair, "the same complete projection returns without another write");
}

{
  const assetId = crypto.randomUUID();
  const old = intent({
    asset_id: assetId,
    platforms: ["instagram"],
    state: "done",
    result: { instagram: { ok: true, post_id: "post-old" } },
    finished_at: "2026-10-30T02:00:00.000Z",
  });
  const newer = intent({
    asset_id: assetId,
    platforms: ["linkedin"],
    state: "done",
    result: { linkedin: { ok: true, post_id: "post-new" } },
    finished_at: "2026-10-30T02:10:00.000Z",
  });
  const store = new MemoryStore([old, newer]);
  const gateway = new MemoryGateway();
  const provider = new MemoryProvider();
  const job = (row: PublishIntent): MavenPublishJob => ({
    version: 1,
    tenantId: OASIS_TENANT_ID,
    intentId: row.id,
    enqueuedAt: NOW.toISOString(),
  });

  assert.equal((await runMavenPublishJob({ job: job(newer), store, gateway, provider, now: NOW })).status, "duplicate");
  const afterNew = store.mutations;
  assert.deepEqual(store.assets.get(assetId), {
    ...asset(newer),
    status: "published",
    external_id: "post-new",
    platforms: ["linkedin"],
    published_at: NOW.toISOString(),
  });

  assert.equal((await runMavenPublishJob({ job: job(old), store, gateway, provider, now: NOW })).status, "duplicate");
  assert.equal(provider.calls, 0, "DONE intent replays never call the provider");
  assert.equal(store.mutations, afterNew, "a delayed old DONE intent must not mutate the newer asset projection");
  assert.equal(store.assets.get(assetId)?.external_id, "post-new");
  assert.deepEqual(store.assets.get(assetId)?.platforms, ["linkedin"]);
}

{
  const row = intent({ platforms: ["instagram"] });
  const store = new MemoryStore([row]);
  const gateway = new MemoryGateway();
  gateway.blockReason = "daily cap hit: 50/50 social actions today";
  const provider = new MemoryProvider();
  const out = await runMavenPublishJob({
    job: { version: 1, tenantId: OASIS_TENANT_ID, intentId: row.id, enqueuedAt: NOW.toISOString() },
    store,
    gateway,
    provider,
    now: NOW,
    claimToken: () => "claim-cap",
  });
  assert.equal(out.status, "failed");
  assert.equal(provider.calls, 0, "a Maven cap refusal must happen before any provider call");
  assert.match(store.intents.get(row.id)?.error ?? "", /daily cap hit/);
}

{
  const row = intent({ platforms: ["instagram"] });
  const store = new MemoryStore([row]);
  const gateway = new MemoryGateway();
  const provider = new MemoryProvider();
  provider.throwAfterDispatch = true;
  const out = await runMavenPublishJob({
    job: { version: 1, tenantId: OASIS_TENANT_ID, intentId: row.id, enqueuedAt: NOW.toISOString() },
    store,
    gateway,
    provider,
    now: NOW,
    claimToken: () => "claim-unknown",
  });
  assert.equal(out.status, "failed");
  assert.match(store.intents.get(row.id)?.error ?? "", /may already be live/i);
  assert.equal((store.intents.get(row.id)?.result._delivery_unknown as boolean), true);
  assert.equal(gateway.finalized.at(-1)?.state, "failed");
}

{
  const row = intent();
  const store = new MemoryStore([row]);
  const gateway = new MemoryGateway();
  const provider = new MemoryProvider();
  provider.returnUnknownOnCall = 1;
  const out = await runMavenPublishJob({
    job: { version: 1, tenantId: OASIS_TENANT_ID, intentId: row.id, enqueuedAt: NOW.toISOString() },
    store,
    gateway,
    provider,
    now: NOW,
    claimToken: () => "claim-returned-unknown",
  });
  assert.equal(out.status, "failed");
  assert.equal(provider.calls, 1, "a returned delivery-unknown verdict must stop before the second provider group");
  assert.equal(gateway.reservations.length, 1, "no outbound reservation is opened for a group after ambiguous delivery");
  assert.equal((store.intents.get(row.id)?.result._delivery_unknown as boolean), true);
}

{
  const store = new MemoryStore([]);
  const gateway = new MemoryGateway();
  const provider = new MemoryProvider();
  const out = await runMavenPublishJob({
    job: {
      version: 1,
      tenantId: "aa04fa1f-ad6a-44b0-ac4b-2ff5d1067110",
      intentId: crypto.randomUUID(),
      enqueuedAt: NOW.toISOString(),
    },
    store,
    gateway,
    provider,
    now: NOW,
  });
  assert.equal(out.status, "ignored");
  assert.equal(provider.calls, 0);
  assert.equal(store.mutations, 0);
}

{
  const row = intent({
    state: "done",
    platforms: ["instagram", "twitter"],
    result: {
      instagram: { ok: true, post_id: "late-post-1" },
      twitter: { ok: true, post_id: "late-post-1" },
    },
    finished_at: "2026-10-30T02:00:00.000Z",
  });
  const writes: ReconciliationWrite[] = [];
  let reads = 0;
  const summary = await reconcileMavenPublishes({
    store: {
      listReconcileCandidates: async () => [structuredClone(row)],
      saveReconciliation: async (write) => { writes.push(structuredClone(write)); return "updated"; },
    },
    reader: {
      fetchPost: async (postId) => {
        reads += 1;
        assert.equal(postId, "late-post-1");
        return {
          _id: postId,
          platforms: [
            { platform: "instagram", status: "published", platformPostUrl: "https://instagram.test/p/1", publishedAt: "2026-10-30T02:03:00.000Z" },
            { platform: "twitter", status: "failed", errorMessage: "network refused media" },
          ],
        };
      },
    },
    now: NOW,
  });
  assert.equal(reads, 1, "one Late post shared by two platforms is read once");
  assert.deepEqual(summary, { candidates: 1, postsRead: 1, readFailures: 0, updated: 1, contended: 0 });
  assert.deepEqual(writes[0].livePlatforms, ["instagram"]);
  assert.equal(writes[0].state, "done", "a partial network refusal cannot make an accepted live post retryable");
  assert.equal((writes[0].result.instagram as Record<string, unknown>).status, "published");
  assert.equal((writes[0].result.twitter as Record<string, unknown>).ok, false);
  assert.match(writes[0].error ?? "", /twitter: network refused media/);
}

{
  const route = readFileSync("app/api/cron/maven-publish-queue/route.ts", "utf8");
  const switchAt = route.indexOf("mavenPublishEnabled()");
  const dbAt = route.indexOf("getTursoClient()");
  const queueAt = route.indexOf("mavenPublishQueueBinding()");
  assert.ok(switchAt >= 0 && switchAt < dbAt && switchAt < queueAt,
    "the job off-switch must be checked before database or Queue access");

  const jobRoute = readFileSync("app/api/internal/maven-publish/jobs/route.ts", "utf8");
  const jobSwitchAt = jobRoute.indexOf("mavenPublishEnabled()");
  const jobDbAt = jobRoute.indexOf("getTursoClient()");
  const providerAt = jobRoute.indexOf("CloudLatePublisher");
  assert.ok(jobSwitchAt >= 0 && jobSwitchAt < jobDbAt && jobSwitchAt < providerAt,
    "the consumer off-switch must be checked before database or provider access");

  const wrangler = readFileSync("wrangler.jsonc", "utf8");
  assert.match(wrangler, /"MAVEN_PUBLISH_JOBS"[\s\S]*"oasis-maven-publish-jobs"/);
  assert.match(wrangler, /"dead_letter_queue"\s*:\s*"oasis-maven-publish-jobs-dlq"/);

  const source = [
    readFileSync("lib/marketing/maven-publish-queue.ts", "utf8"),
    route,
    jobRoute,
  ].join("\n");
  assert.doesNotMatch(source, /data[\\/]post_queue|schedule_posts\.py|missed.?post/i,
    "the Cloud queue owns explicit marketing_publish_intent rows only; it must never replay Maven's missed cadence");
}

console.log("maven-publish-queue: all assertions passed (zero production/network calls)");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
